import { FileSystemAdapter, Notice, Platform, Plugin, setIcon, TFile, type App, type TAbstractFile } from "obsidian";

import { VaultEncryption, VaultRole, type Vault } from "./gen/vaultsync/v1/types_pb";
import { oidcRefresher, signInWithDeviceFlow } from "./core/auth/oidc";
import { TokenManager, type AuthState } from "./core/auth/tokens";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "./core/protocol/client";
import type { PathRules } from "./core/vaultpath/platform";
import type { VaultAdapter } from "./core/vault/adapter";
import { PROTOCOL_VERSION } from "./core/version";
import { ConflictView, conflictViewType } from "./obsidian/conflict-view";
import { connectedVault, connectNeedsConfirmation, connectProblem, currentAccount, listRemoteVaults, SyncController } from "./obsidian/controller";
import { loadDeviceSecrets, refreshTokenLost, savePluginData } from "./obsidian/device-storage";
import { oidcConfig, parsePluginData, persistRefreshToken, serialized, serverBaseUrl, signInProblem, type ConnectedVault, type IdentityProvider, type PluginData } from "./obsidian/data";
import { currentDeviceId, deviceRows, listDevices, removeOtherDevice, type DeviceRow } from "./obsidian/devices";
import { discoverIdentityProvider } from "./obsidian/discovery";
import { createEncryptedVault, escrowOffer, type EscrowOffer } from "./core/keys/encrypted-vault";
import { changePassphraseOnDevice, enableOnDevice, encryptionState, forgetEncryptionKeys, pluginDataEpochKeyStore, unlockedUserKey, unlockOnDevice, type EncryptionOptions, type EncryptionState } from "./obsidian/encryption";
import { HistoryModal } from "./obsidian/history-modal";
import { requestUrlFetch, requestUrlHttpClient } from "./obsidian/http";
import { openVaultJournal } from "./obsidian/journal";
import { longPathWarning, SkipNotices } from "./obsidian/path-notices";
import { pathRulesFor } from "./obsidian/platform-rules";
import { webSocketConnector } from "./obsidian/realtime-socket";
import { SyncSession, type SyncSessionOptions, type VaultHistory } from "./obsidian/session";
import { VaultSyncSettingTab, type SettingsHost } from "./obsidian/settings";
import {
  createInvitation,
  deleteVault,
  joinVault,
  leaveVault,
  loadSharing,
  removeMember,
  revokeInvitation,
  setMemberRole,
  type CreatedInvitation,
  type EncryptedSharing,
  type Sharing,
} from "./obsidian/sharing";
import { VaultKeyManager } from "./core/keys/vault-keys";
import { SignInCancelledError, SignInModal } from "./obsidian/sign-in-modal";
import { initialStatus, isStoppedState, statusDescription, statusIcon, statusText, type SyncStatus } from "./obsidian/status";
import { ObsidianVaultAdapter } from "./obsidian/vault-adapter";
import { keepLocalCopy } from "./obsidian/local-copies";
import { ViewerMode } from "./obsidian/viewer-mode";

/** How long after the last local change of a burst the engine pushes (#167 item 5: chosen here, not left to the engine's default). */
const pushDebounceMs = 2000;
/**
 * How often the plugin pulls and pushes on its own. Remote changes normally
 * arrive at once over the realtime channel; this is the fallback when it is
 * down (correctness never depends on it, SPEC.md §6.4), and it retries
 * pending operations that no edit would trigger.
 */
const syncIntervalMs = 30_000;

/** A time as the settings show it, in the user's locale. */
const formatDate = (date: Date) => date.toLocaleString();

export default class VaultSyncPlugin extends Plugin implements SettingsHost {
  data: PluginData = parsePluginData(undefined);
  private tokens: TokenManager | undefined;
  private controller: SyncController | undefined;
  /** A session started directly with startSync (the e2e harness), outside the controller. */
  private session: SyncSession | undefined;
  private settingTab: VaultSyncSettingTab | undefined;
  private signInModal: SignInModal | undefined;
  private statusBar: HTMLElement | undefined;
  /** The status on mobile, which has no status bar (#420). */
  private statusRibbon: HTMLElement | undefined;
  private signingIn = false;
  private status: SyncStatus = initialStatus;
  private readonly skipNotices = new SkipNotices();

  override async onload(): Promise<void> {
    console.debug(`vault-sync loaded (protocol v${String(PROTOCOL_VERSION)})`);
    this.data = parsePluginData(await this.loadData());
    if (loadDeviceSecrets(this.data, this.app)) {
      // data.json still holds a secret (refresh token or keys): move it to local storage.
      // If this fails, it stays in memory and the next save moves it.
      await this.saveSettings().catch((error: unknown) => {
        console.warn(`vault-sync: could not move secrets out of data.json: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.tokens = this.createTokenManager();
    const viewerMode = new ViewerMode(this);
    this.controller = new SyncController({
      data: () => this.data,
      save: () => this.saveSettings(),
      authState: () => this.authState,
      client: () => this.protocolClient(),
      accessToken: () => (this.tokens === undefined ? Promise.reject(new Error("vault-sync is not loaded")) : this.tokens.accessToken()),
      defaultDeviceName: platformName(),
      openJournal: (key) => openVaultJournal(this.app, key),
      vault: () => this.syncedVault(),
      ready: () => this.layoutReady(),
      pushDebounceMs,
      syncIntervalMs,
      pathRules: localPathRules(this.app),
      maxDownloadBytes: localMaxDownloadBytes(),
      realtime: (serverUrl) => ({
        connect: webSocketConnector(serverUrl),
        accessToken: () => (this.tokens === undefined ? Promise.reject(new Error("vault-sync is not loaded")) : this.tokens.accessToken()),
        invalidate: (token) => {
          this.tokens?.invalidate(token);
        },
      }),
      onStatus: (status) => {
        this.showStatus(status);
      },
      onReadOnly: (readOnly) => {
        viewerMode.set(readOnly);
      },
      keepLocalCopy: async (path, content) => {
        const copy = await keepLocalCopy(this.app.vault.adapter, path, content);
        new Notice(`Vault Sync: this vault is shared with you as a viewer, so ${path} was not synced. The shared version is restored, and your version is kept in ${copy}.`, 0);
      },
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("vault-sync-status");
    this.statusBar.onClickEvent(() => {
      this.noticeStatus();
    });
    // Mobile has no status bar: a ribbon icon shows the status there, and
    // tapping it shows the details (#420).
    if (Platform.isMobile) {
      this.statusRibbon = this.addRibbonIcon(statusIcon(this.status), statusText(this.status), () => {
        this.noticeStatus();
      });
      this.statusRibbon.addClass("vault-sync-status-ribbon");
    }
    this.settingTab = new VaultSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({ id: "sign-in", name: "Sign in", callback: () => void this.signIn() });
    this.addCommand({ id: "sign-out", name: "Sign out", callback: () => void this.signOut() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.controller?.syncNow() });
    this.registerView(conflictViewType, (leaf) => new ConflictView(leaf, { problems: () => this.controller?.session ?? this.session }));
    this.addCommand({ id: "show-conflicts", name: "Show conflicts", callback: () => void this.showConflicts() });
    // The status bar is desktop-only; on mobile this and the ribbon icon show the status.
    this.addCommand({
      id: "show-status",
      name: "Show sync status",
      callback: () => {
        this.noticeStatus();
      },
    });
    this.addCommand({
      id: "show-file-history",
      name: "Show file history",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file === null) return false;
        if (!checking) void this.showHistory(file.path);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("Show sync history")
            .setIcon("history")
            .onClick(() => void this.showHistory(file.path)),
        );
      }),
    );
    // A long new path may not fit on every device (docs/design/engine.md §6).
    // Registered once the vault is indexed, so the files already there are not new.
    this.app.workspace.onLayoutReady(() => {
      const warn = (file: TAbstractFile) => {
        const warning = longPathWarning(file.path);
        if (warning !== undefined) new Notice(warning, 0);
      };
      this.registerEvent(this.app.vault.on("create", warn));
      this.registerEvent(this.app.vault.on("rename", warn));
    });
    this.showStatus(this.status);
    // Not awaited: registering the device and opening the journal may wait
    // for the network, and Obsidian waits for onload.
    void this.controller.update();
  }

  override onunload(): void {
    this.signInModal?.close();
    // Not awaited (Obsidian does not wait for onunload): the sessions refuse
    // every vault, journal and server call from here on, so the next load
    // does not race them.
    void this.controller?.stop();
    void this.stopSync();
  }

  get authState(): AuthState {
    return this.tokens?.state ?? "signed-out";
  }

  /** Whether the server and identity provider settings are locked: while signed in (the refresh token belongs to them) and while a sign-in runs. */
  get settingsLocked(): boolean {
    return this.authState === "signed-in" || this.signingIn;
  }

  /** What the status bar shows. */
  get syncStatus(): SyncStatus {
    return this.status;
  }

  /** The server vault this vault syncs with, if any. */
  get connectedVault(): ConnectedVault | undefined {
    return connectedVault(this.data);
  }

  /** Saves the plugin data. Saves never overlap, so the last one called is the one left on disk. */
  saveSettings(): Promise<void> {
    return this.saveQueued();
  }

  private readonly saveQueued = serialized(() => savePluginData(this.data, this.app, (file) => this.saveData(file)));

  /**
   * Signs in with the OAuth device flow (SPEC.md §9.1): checks that the
   * server speaks a compatible protocol and takes the identity provider it
   * advertises (the settings may override it), shows the verification URL and user
   * code in a dialog, polls the identity provider, and stores the refresh
   * token in device-local storage. Resolves whether the sign-in succeeded; closing the
   * dialog cancels it and leaves the state as it was. A signed-in device must
   * sign out first: that is what unlocks the server and identity provider
   * settings, which also stay locked while the sign-in runs. Sync starts once
   * signed in, if this vault is connected.
   */
  async signIn(): Promise<boolean> {
    if (this.authState === "signed-in") {
      new Notice("Vault Sync: already signed in. Sign out first to sign in again.");
      return false;
    }
    if (this.signingIn) {
      new Notice("Vault Sync: a sign-in is already in progress.");
      return false;
    }
    const problem = signInProblem(this.data);
    if (problem !== undefined) {
      new Notice(`Vault Sync: ${problem}`);
      return false;
    }
    this.signingIn = true;
    this.settingTab?.render();
    this.signInModal?.close();
    const modal = new SignInModal(this.app);
    this.signInModal = modal;
    modal.open();
    try {
      const config = await discoverIdentityProvider(this.unauthenticatedClient(), this.data);
      modal.signal.throwIfAborted();
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
      // these tokens (its settings are locked from the start of the sign-in).
      // The provider is stored with the refresh token (and only if that is
      // saved), so later refreshes (after a restart too) go to this provider
      // without asking the server again.
      const manager = this.createTokenManager(config, { stored: false, provider: { issuer: config.issuer, clientId: config.clientId } });
      this.tokens = manager;
      await manager.signIn(tokens);
      modal.close();
      new Notice("Vault Sync: signed in");
      void this.controller?.update();
      return true;
    } catch (error) {
      if (error instanceof SignInCancelledError) return false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`vault-sync: sign-in failed: ${message}`);
      modal.showError(message);
      return false;
    } finally {
      this.signingIn = false;
      if (this.signInModal === modal) this.signInModal = undefined;
      this.settingTab?.render();
    }
  }

  /**
   * Stops sync and forgets the device's tokens, its unlocked encryption
   * key and its vault epoch keys. The connected vault and the device
   * registration are kept for the next sign-in.
   */
  async signOut(): Promise<void> {
    await this.controller?.stop();
    await this.stopSync();
    if (forgetEncryptionKeys(this.data)) await this.saveSettings();
    await this.tokens?.signOut();
    await this.controller?.update();
    this.settingTab?.render();
  }

  /** History browsing and restore of the running sync session, if one runs. */
  vaultHistory(): VaultHistory | undefined {
    return this.session?.history() ?? this.controller?.history();
  }

  /** Opens the history of the synced file at `path` (SPEC.md §11). */
  async showHistory(path: string): Promise<void> {
    const history = this.vaultHistory();
    if (history === undefined) {
      new Notice("Vault Sync: history is available while this vault syncs.");
      return;
    }
    const documentId = await history.documentAt(path);
    if (documentId === undefined) {
      new Notice(`Vault Sync: ${path} has not been synced yet, so it has no history.`);
      return;
    }
    new HistoryModal(this.app, history, documentId, path).open();
  }

  /** The signed-in user's devices, as the settings list them (#590). */
  async listDevices(): Promise<DeviceRow[]> {
    return deviceRows(await listDevices(this.protocolClient()), currentDeviceId(this.data), (date) => date.toLocaleString());
  }

  /** Removes another of the user's devices; it can no longer sync until it registers again. */
  removeDevice(deviceId: string): Promise<void> {
    return removeOtherDevice(this.protocolClient(), this.data, deviceId);
  }

  /** Registers this installation again after its device was removed, and pushes the changes kept meanwhile. */
  async registerAgain(): Promise<void> {
    await this.controller?.registerAgain();
    this.settingTab?.render();
  }

  /** Whether end-to-end encryption is enabled for the signed-in account, and unlocked on this device. */
  encryptionState(): Promise<EncryptionState> {
    return encryptionState(this.encryptionOptions());
  }

  /** Enables end-to-end encryption for the signed-in account (docs/plugin.md); resolves whether this device created the key. */
  enableEncryption(passphrase: string): Promise<boolean> {
    return enableOnDevice(this.encryptionOptions(), passphrase);
  }

  /** Unlocks the signed-in account's encryption key on this device. */
  unlockEncryption(passphrase: string): Promise<void> {
    return unlockOnDevice(this.encryptionOptions(), passphrase);
  }

  /** Changes the signed-in account's recovery passphrase (docs/plugin.md). */
  changePassphrase(current: string, next: string): Promise<void> {
    return changePassphraseOnDevice(this.encryptionOptions(), current, next);
  }

  private encryptionOptions(): EncryptionOptions {
    return {
      data: this.data,
      save: () => this.saveSettings(),
      client: this.protocolClient().userKeys,
      accessToken: () => (this.tokens === undefined ? Promise.reject(new Error("vault-sync is not loaded")) : this.tokens.accessToken()),
    };
  }

  /** The vaults the signed-in user may connect this vault to. */
  listRemoteVaults(): Promise<Vault[]> {
    return listRemoteVaults(this.protocolClient());
  }

  /** The server's escrow key and default, for the escrow choice of a new encrypted vault. */
  async escrowOffer(): Promise<EscrowOffer> {
    return escrowOffer(await this.protocolClient().serverInfo.getServerInfo({}));
  }

  /**
   * Creates a vault on the server, owned by the signed-in user: plaintext,
   * or end-to-end encrypted when `encryption` is given. An encrypted vault
   * needs the account's key unlocked on this device, which wraps its first
   * epoch key to the user and, with `encryption.escrow`, to the server's
   * escrow key.
   */
  async createRemoteVault(name: string, encryption?: { escrow: boolean }): Promise<Vault> {
    if (encryption !== undefined) return this.createEncryptedRemoteVault(name, encryption.escrow);
    const response = await this.protocolClient().vaults.createVault({ name: name.trim(), encryption: VaultEncryption.NONE });
    if (response.vault === undefined) throw new Error("the server created the vault but returned none");
    return response.vault;
  }

  private async createEncryptedRemoteVault(name: string, escrow: boolean): Promise<Vault> {
    const options = this.encryptionOptions();
    const userKey = await unlockedUserKey(options);
    const account = await currentAccount(this.data, options.accessToken);
    const client = this.protocolClient();
    const recipient = escrow ? (await this.escrowOffer()).recipient : undefined;
    if (escrow && recipient === undefined) throw new Error("this server has no escrow key");
    return createEncryptedVault({
      name: name.trim(),
      escrow: recipient,
      userKey,
      vaults: client.vaults,
      anchors: client.userKeys,
      keys: client.vaultKeys,
      membership: client.membership,
      store: (vaultId) => pluginDataEpochKeyStore(this.data, () => this.saveSettings(), account, vaultId),
    });
  }

  /**
   * Connects this vault to `vault` and starts syncing it. When both this
   * vault and the remote one have files, nothing happens unless `confirmed`:
   * it resolves "needs-confirmation" so the user can be warned that files at
   * the same path with different content become conflict copies.
   */
  async connectVault(vault: Vault, confirmed = false): Promise<"connected" | "needs-confirmation"> {
    const problem = connectProblem(vault);
    if (problem !== undefined) throw new Error(problem);
    if (!confirmed && connectNeedsConfirmation((await new ObsidianVaultAdapter(this.app).list()).length, vault)) return "needs-confirmation";
    this.data.vault = { id: vault.id, name: vault.name, serverUrl: serverBaseUrl(this.data) };
    await this.saveSettings();
    await this.controller?.update();
    this.settingTab?.render();
    return "connected";
  }

  /** The connected vault's Sharing section (#34): its members and invitations for an owner, the user's role otherwise. */
  loadSharing(): Promise<Sharing> {
    return loadSharing(this.protocolClient(), this.sharedVaultId(), formatDate);
  }

  /** Creates an invitation to the connected vault; its code is shown once and never stored. */
  async createInvitation(role: VaultRole, days: number | undefined): Promise<CreatedInvitation> {
    return createInvitation(this.protocolClient(), this.sharedVaultId(), role, days, formatDate, await this.encryptedSharing());
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    return revokeInvitation(this.protocolClient(), this.sharedVaultId(), invitationId, await this.encryptedSharing());
  }

  async setMemberRole(userId: string, role: VaultRole): Promise<void> {
    return setMemberRole(this.protocolClient(), this.sharedVaultId(), userId, role, await this.encryptedSharing());
  }

  async removeMember(userId: string): Promise<void> {
    return removeMember(this.protocolClient(), this.sharedVaultId(), userId, await this.encryptedSharing());
  }

  /**
   * What a membership change of the connected vault needs when it is end-to-end
   * encrypted: the unlocked user key, which signs the change's log entry,
   * and the vault's key manager. Undefined for a plaintext vault.
   */
  private async encryptedSharing(): Promise<EncryptedSharing | undefined> {
    const vaultId = this.sharedVaultId();
    const client = this.protocolClient();
    const vault = (await listRemoteVaults(client)).find((listed) => listed.id === vaultId);
    if (vault === undefined || vault.encryption !== VaultEncryption.E2EE) return undefined;
    const options = this.encryptionOptions();
    const userKey = await unlockedUserKey(options);
    const account = await currentAccount(this.data, options.accessToken);
    const escrow = vault.escrow ? (await this.escrowOffer()).recipient : undefined;
    if (vault.escrow && escrow === undefined) throw new Error("this server has no escrow key");
    const manager = new VaultKeyManager({
      vaultId,
      userKey,
      owner: vault.role === VaultRole.OWNER,
      keys: client.vaultKeys,
      membership: client.membership,
      store: pluginDataEpochKeyStore(this.data, () => this.saveSettings(), account, vaultId),
      escrow,
    });
    return { context: { vaultId, userKey, membership: client.membership, log: client.vaultKeys }, manager };
  }

  /**
   * Leaves the connected vault on the server, then syncs, which finds the
   * membership gone: sync stops and the status says "no longer a member".
   * The vault stays connected and the local files stay.
   */
  async leaveVault(): Promise<void> {
    await leaveVault(this.protocolClient(), this.sharedVaultId(), await this.encryptedSharing());
    await this.controller?.syncNow();
  }

  /** Deletes the connected vault on the server (owners only), then syncs, which stops sync with "vault deleted". The local files stay. */
  async deleteVault(): Promise<void> {
    await deleteVault(this.protocolClient(), this.sharedVaultId());
    await this.controller?.syncNow();
  }

  /** Redeems an invite code; resolves with the vault joined, which the caller then connects. */
  joinVault(code: string): Promise<Vault> {
    return joinVault(this.protocolClient(), code);
  }

  /** The connected vault's id, for the Sharing section, which is shown only while one is connected. */
  private sharedVaultId(): string {
    const vault = connectedVault(this.data);
    if (vault === undefined) throw new Error("no vault is connected");
    return vault.id;
  }

  /** Stops syncing this vault. Its journal stays, so connecting the same vault again resumes where it left off. */
  async disconnectVault(): Promise<void> {
    delete this.data.vault;
    await this.saveSettings();
    await this.controller?.update();
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
   * Starts a sync session of the open vault with explicit options, outside
   * the account and vault settings (the e2e harness uses it with an
   * in-memory server). It replaces such a session started before, once that
   * one has stopped, and resolves once the first sync finished.
   */
  async startSync(options: Omit<SyncSessionOptions, "vault" | "ready" | "pushDebounceMs" | "syncIntervalMs"> & Partial<SyncSessionOptions>): Promise<void> {
    await this.stopSync();
    const session = new SyncSession({ vault: this.syncedVault(), ready: () => this.layoutReady(), pushDebounceMs, syncIntervalMs: null, pathRules: localPathRules(this.app), maxDownloadBytes: localMaxDownloadBytes(), ...options });
    this.session = session;
    return session.start();
  }

  /** Stops a session startSync started, and resolves once it settled. */
  async stopSync(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.stop();
  }

  /** Opens the conflict view in the right sidebar, or reveals it if it is open. */
  async showConflicts(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(conflictViewType)[0];
    if (leaf === undefined) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await leaf.setViewState({ type: conflictViewType, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  private refreshConflictViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(conflictViewType)) if (leaf.view instanceof ConflictView) void leaf.view.refresh();
  }

  /** What a session syncs: the notes. Config-folder sync is not part of this engine (docs/design/engine.md §1). */
  private syncedVault(): VaultAdapter {
    return new ObsidianVaultAdapter(this.app);
  }

  private layoutReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.app.workspace.onLayoutReady(resolve);
    });
  }

  private showStatus(status: SyncStatus): void {
    const stopped = isStoppedState(status.state);
    const changed = status.state !== this.status.state && (stopped || isStoppedState(this.status.state));
    this.status = status;
    if (stopped && changed) new Notice(`Vault Sync: ${status.message ?? statusDescription(status)}`, 0);
    this.statusBar?.setText(statusText(status));
    this.statusBar?.setAttribute("aria-label", statusDescription(status));
    if (this.statusRibbon !== undefined) {
      setIcon(this.statusRibbon, statusIcon(status));
      this.statusRibbon.setAttribute("aria-label", statusText(status));
    }
    // The settings offer to register again only while the device is removed, and tell why sync stopped.
    if (changed) this.settingTab?.render();
    else this.settingTab?.showStatus();
    this.refreshConflictViews();
    if (status.state === "idle" || status.state === "error") void this.noticeSkipped();
  }

  /** A notice for each remote document this device newly skipped (§6, §7). */
  private async noticeSkipped(): Promise<void> {
    const session = this.controller?.session;
    if (session === undefined) return;
    let skipped;
    try {
      ({ skipped } = await session.listProblems());
    } catch {
      return;
    }
    for (const notice of this.skipNotices.fresh(skipped)) new Notice(notice, 0);
  }

  private noticeStatus(): void {
    new Notice(`${statusText(this.status)}\n${statusDescription(this.status)}`);
  }

  /**
   * A token manager for `config`'s provider, starting from the stored
   * refresh token unless `stored` is false. Its refresh tokens are stored
   * with `provider`, if given (see persistRefreshToken).
   */
  private createTokenManager(config = oidcConfig(this.data), options: { stored: boolean; provider?: IdentityProvider } = { stored: true }): TokenManager {
    const stored = options.stored ? this.data.refreshToken : undefined;
    return new TokenManager({
      ...(stored === undefined ? {} : { refreshToken: stored }),
      signInRequired: options.stored && refreshTokenLost(this.data),
      refresh: oidcRefresher(requestUrlHttpClient, config),
      persist: (refreshToken) => persistRefreshToken(this.data, refreshToken, options.provider, () => this.saveSettings()),
      onStateChange: (state) => {
        if (state === "sign-in-required") {
          new Notice("Vault Sync: your session ended. Sync is paused until you sign in again; your local changes are kept.", 0);
        }
        // Pauses sync on sign-in-required; the next sign-in starts it again.
        void this.controller?.update();
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

/** The device name registered when the user set none. */
function platformName(): string {
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return "iOS";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  return "Obsidian";
}

/**
 * The largest remote content this device downloads (SPEC.md §8): 1 GiB on
 * desktop, 256 MiB on mobile, whose memory is far smaller. A download is
 * held in memory whole, so a larger revision is deferred instead.
 */
function localMaxDownloadBytes(): number {
  return Platform.isMobile ? 256 * 1024 * 1024 : 1024 * 1024 * 1024;
}

/** The file-name rules of the device Obsidian runs on (pathRulesFor). */
function localPathRules(app: App): PathRules {
  const adapter = app.vault.adapter;
  return pathRulesFor(Platform, adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined);
}
