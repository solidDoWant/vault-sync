import { Notice, Plugin } from "obsidian";

import { oidcRefresher, signInWithDeviceFlow } from "./core/auth/oidc";
import { TokenManager, type AuthState } from "./core/auth/tokens";
import type { PullSummary } from "./core/engine/engine";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "./core/protocol/client";
import { isProtocolCompatible, PROTOCOL_VERSION } from "./core/version";
import { oidcConfig, parsePluginData, serverBaseUrl, signInProblem, type PluginData } from "./obsidian/data";
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  /**
   * Signs in with the OAuth device flow (SPEC.md §9.1): checks that the
   * server speaks a compatible protocol, shows the verification URL and user
   * code in a dialog, polls the identity provider, and stores the refresh
   * token in plugin data. Resolves whether the sign-in succeeded; closing the
   * dialog cancels it.
   */
  async signIn(): Promise<boolean> {
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
      // The identity provider settings cannot change while signed in, so a
      // manager made now refreshes against the provider that issues these tokens.
      this.tokens = this.createTokenManager();
      const tokens = await signInWithDeviceFlow(requestUrlHttpClient, oidcConfig(this.data), {
        signal: modal.signal,
        onAuthorization: (authorization) => {
          modal.showAuthorization(authorization);
        },
      });
      await this.tokens.signIn(tokens);
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

  private createTokenManager(): TokenManager {
    return new TokenManager({
      ...(this.data.refreshToken === undefined ? {} : { refreshToken: this.data.refreshToken }),
      refresh: oidcRefresher(requestUrlHttpClient, oidcConfig(this.data)),
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
