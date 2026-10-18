import { Notice, Plugin } from "obsidian";

import { oidcRefresher, signInWithDeviceFlow } from "./core/auth/oidc";
import { TokenManager, type AuthState } from "./core/auth/tokens";
import type { PullSummary } from "./core/engine/engine";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "./core/protocol/client";
import { isProtocolCompatible, PROTOCOL_VERSION } from "./core/version";
import { oidcConfig, parsePluginData, serialized, serverBaseUrl, signInProblem, type PluginData } from "./obsidian/data";
import { requestUrlFetch, requestUrlHttpClient } from "./obsidian/http";
import { SyncSession, type SyncSessionOptions } from "./obsidian/session";
import { VaultSyncSettingTab, type SettingsHost } from "./obsidian/settings";
import { SignInCancelledError, SignInModal } from "./obsidian/sign-in-modal";

export default class VaultSyncPlugin extends Plugin implements SettingsHost {
  data: PluginData = parsePluginData(undefined);
  private tokens: TokenManager | undefined;
  private session: SyncSession | undefined;
  private settingTab: VaultSyncSettingTab | undefined;
  private signInModal: SignInModal | undefined;

  override async onload(): Promise<void> {
    console.debug(`vault-sync loaded (protocol v${String(PROTOCOL_VERSION)})`);
    this.data = parsePluginData(await this.loadData());
    this.tokens = this.createTokenManager();
    this.settingTab = new VaultSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({ id: "sign-in", name: "Sign in", callback: () => void this.signIn() });
    this.addCommand({ id: "sign-out", name: "Sign out", callback: () => void this.signOut() });
  }

  override onunload(): void {
    this.signInModal?.close();
    this.stopSync();
  }

  get authState(): AuthState {
    return this.tokens?.state ?? "signed-out";
  }

  /** Saves the plugin data. Saves never overlap, so the last one called is the one left on disk. */
  saveSettings(): Promise<void> {
    return this.saveQueued();
  }

  private readonly saveQueued = serialized(() => this.saveData(this.data));

  /**
   * Signs in with the OAuth device flow (SPEC.md §9.1): checks that the
   * server speaks a compatible protocol, shows the verification URL and user
   * code in a dialog, polls the identity provider, and stores the refresh
   * token in plugin data. Resolves whether the sign-in succeeded; closing the
   * dialog cancels it and leaves the state as it was. A signed-in device must
   * sign out first: that is what unlocks the server and identity provider
   * settings.
   */
  async signIn(): Promise<boolean> {
    if (this.authState === "signed-in") {
      new Notice("Vault Sync: already signed in. Sign out first to sign in again.");
      return false;
    }
    const problem = signInProblem(this.data);
    if (problem !== undefined) {
      new Notice(`Vault Sync: ${problem}`);
      return false;
    }
    this.signInModal?.close();
    const modal = new SignInModal(this.app);
    this.signInModal = modal;
    modal.open();
    try {
      const info = await this.unauthenticatedClient().serverInfo.getServerInfo({});
      if (!isProtocolCompatible(info.protocolVersion)) {
        throw new Error(`the server speaks protocol v${String(info.protocolVersion)}, but this plugin needs v${String(PROTOCOL_VERSION)} or later; update the server`);
      }
      modal.signal.throwIfAborted();
      const config = oidcConfig(this.data);
      const tokens = await signInWithDeviceFlow(requestUrlHttpClient, config, {
        signal: modal.signal,
        onAuthorization: (authorization) => {
          modal.showAuthorization(authorization);
        },
      });
      // Another sign-in started meanwhile closes this one's dialog, so only one gets past here.
      modal.signal.throwIfAborted();
      // Only now, with the user's tokens in hand, is the manager replaced, so
      // a cancelled or failed device flow leaves the state as it was. The
      // replaced manager is signed out or needs a sign-in: it holds no
      // refresh token and runs no refresh, so it never writes the plugin
      // data again. It is replaced before the new tokens are stored, so a
      // sign-out from here on reaches the new manager, which drops the
      // sign-in. The new manager refreshes against the provider that issued
      // these tokens (its settings are locked while signed in).
      const manager = this.createTokenManager(config, { stored: false });
      this.tokens = manager;
      await manager.signIn(tokens);
      modal.close();
      new Notice("Vault Sync: signed in");
      return true;
    } catch (error) {
      if (error instanceof SignInCancelledError) return false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`vault-sync: sign-in failed: ${message}`);
      modal.showError(message);
      return false;
    } finally {
      if (this.signInModal === modal) this.signInModal = undefined;
      this.settingTab?.render();
    }
  }

  /** Forgets the device's tokens. */
  async signOut(): Promise<void> {
    this.stopSync();
    await this.tokens?.signOut();
    this.settingTab?.render();
  }

  /**
   * The protocol client for the configured server, authenticated with the
   * device's tokens: they are refreshed ahead of expiry, and an RPC refused
   * as unauthenticated is retried once with a fresh token.
   */
  protocolClient(): ProtocolClient {
    // Resolved on every call: a sign-in replaces the token manager, and a
    // client made before it (a paused sync's) must use the new tokens.
    return createProtocolClient({
      transport: this.transport(),
      auth: {
        accessToken: () => (this.tokens === undefined ? Promise.reject(new Error("vault-sync is not loaded")) : this.tokens.accessToken()),
        invalidate: (token) => {
          this.tokens?.invalidate(token);
        },
      },
    });
  }

  /**
   * Starts syncing the open vault, replacing any running session, and
   * resolves with the first pull's summary. Called once the device is signed
   * in and has opened its journal (`openVaultJournal`); nothing starts sync
   * before that.
   */
  startSync(options: SyncSessionOptions): Promise<PullSummary | undefined> {
    this.stopSync();
    const session = new SyncSession(this.app, options);
    this.session = session;
    return session.start();
  }

  stopSync(): void {
    this.session?.stop();
    this.session = undefined;
  }

  /** A token manager for `config`'s provider, starting from the stored refresh token unless `stored` is false. */
  private createTokenManager(config = oidcConfig(this.data), options: { stored: boolean } = { stored: true }): TokenManager {
    const stored = options.stored ? this.data.refreshToken : undefined;
    return new TokenManager({
      ...(stored === undefined ? {} : { refreshToken: stored }),
      refresh: oidcRefresher(requestUrlHttpClient, config),
      persist: async (refreshToken) => {
        if (refreshToken === undefined) delete this.data.refreshToken;
        else this.data.refreshToken = refreshToken;
        await this.saveSettings();
      },
      onStateChange: (state) => {
        if (state === "sign-in-required") {
          new Notice("Vault Sync: your session ended. Sync is paused until you sign in again; your local changes are kept.", 0);
        }
        this.settingTab?.render();
      },
    });
  }

  private unauthenticatedClient(): ProtocolClient {
    return createProtocolClient({ transport: this.transport() });
  }

  private transport() {
    return createHttpTransport(serverBaseUrl(this.data), { fetch: requestUrlFetch });
  }
}
