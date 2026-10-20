import { FileSystemAdapter, normalizePath, Notice, Platform, Plugin, setIcon, TFile, type App } from "obsidian";

import { VaultEncryption, type Vault } from "./gen/vaultsync/v1/types_pb";
import { oidcRefresher, signInWithDeviceFlow } from "./core/auth/oidc";
import { TokenManager, type AuthState } from "./core/auth/tokens";
import { ConfigSyncVault } from "./core/config/config-vault";
import type { ConfigSyncSettings } from "./core/config/policy";
import type { PullSummary } from "./core/engine/engine";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "./core/protocol/client";
import type { PathRules } from "./core/vaultpath/platform";
import type { VaultAdapter } from "./core/vault/adapter";
import { PROTOCOL_VERSION } from "./core/version";
import { ConflictView, conflictViewType } from "./obsidian/conflict-view";
import { configFolderHost, ObsidianConfigAdapter, reloadNotifier } from "./obsidian/config-adapter";
import { connectedVault, connectNeedsConfirmation, connectProblem, listRemoteVaults, SyncController } from "./obsidian/controller";
import { configSyncSettings, oidcConfig, parsePluginData, persistRefreshToken, serialized, serverBaseUrl, signInProblem, type ConnectedVault, type IdentityProvider, type PluginData } from "./obsidian/data";
import { discoverIdentityProvider } from "./obsidian/discovery";
import { DeletedFilesModal, HistoryModal } from "./obsidian/history-modal";
import { requestUrlFetch, requestUrlHttpClient } from "./obsidian/http";
import { openVaultJournal } from "./obsidian/journal";
import { webSocketConnector } from "./obsidian/realtime-socket";
import { SyncSession, type SyncSessionOptions, type VaultHistory } from "./obsidian/session";
import { VaultSyncSettingTab, type SettingsHost } from "./obsidian/settings";
import { SignInCancelledError, SignInModal } from "./obsidian/sign-in-modal";
import { initialStatus, statusDescription, statusIcon, statusText, type SyncStatus } from "./obsidian/status";
import { ObsidianVaultAdapter } from "./obsidian/vault-adapter";

/** How long after the last local change of a burst the engine pushes (#167 item 5: chosen here, not left to the engine's default). */
const pushDebounceMs = 2000;
/**
 * How often the plugin pulls and pushes on its own. Remote changes normally
 * arrive at once over the realtime channel; this is the fallback when it is
 * down (correctness never depends on it, SPEC.md §6.4), and it retries
 * pending operations that no edit would trigger.
 */
const syncIntervalMs = 30_000;

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

  override async onload(): Promise<void> {
    console.debug(`vault-sync loaded (protocol v${String(PROTOCOL_VERSION)})`);
    this.data = parsePluginData(await this.loadData());
    this.tokens = this.createTokenManager();
    this.controller = new SyncController({
      data: () => this.data,
      save: () => this.saveSettings(),
      authState: () => this.authState,
      client: () => this.protocolClient(),
      accessToken: () => (this.tokens === undefined ? Promise.reject(new Error("vault-sync is not loaded")) : this.tokens.accessToken()),
      defaultDeviceName: platformName(),
      openJournal: (key, onBlocked) => openVaultJournal(this.app, key, window.indexedDB, { onBlocked }),
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
    this.addCommand({ id: "browse-deleted-files", name: "Browse deleted files", callback: () => void this.browseDeletedFiles() });
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

  private readonly saveQueued = serialized(() => this.saveData(this.data));

  /**
   * Signs in with the OAuth device flow (SPEC.md §9.1): checks that the
   * server speaks a compatible protocol and takes the identity provider it
   * advertises (the settings may override it), shows the verification URL and user
   * code in a dialog, polls the identity provider, and stores the refresh
   * token in plugin data. Resolves whether the sign-in succeeded; closing the
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

  /** Stops sync and forgets the device's tokens. The connected vault and the device registration are kept for the next sign-in. */
  async signOut(): Promise<void> {
    await this.controller?.stop();
    await this.stopSync();
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

  /** Lists the deleted files this device knows of, to find one and restore it (SPEC.md §11). */
  async browseDeletedFiles(): Promise<void> {
    const history = this.vaultHistory();
    if (history === undefined) {
      new Notice("Vault Sync: deleted files can be restored while this vault syncs.");
      return;
    }
    new DeletedFilesModal(this.app, history, await history.deletedDocuments()).open();
  }

  /** The vaults the signed-in user may connect this vault to. */
  listRemoteVaults(): Promise<Vault[]> {
    return listRemoteVaults(this.protocolClient());
  }

  /** Creates a plaintext vault on the server, owned by the signed-in user. */
  async createRemoteVault(name: string): Promise<Vault> {
    const response = await this.protocolClient().vaults.createVault({ name: name.trim(), encryption: VaultEncryption.NONE });
    if (response.vault === undefined) throw new Error("the server created the vault but returned none");
    return response.vault;
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
   * one has stopped, and resolves with the first pull's summary.
   */
  async startSync(options: Omit<SyncSessionOptions, "vault" | "ready" | "pushDebounceMs" | "syncIntervalMs"> & Partial<SyncSessionOptions>): Promise<PullSummary | undefined> {
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

  /** The open vault's config folder. */
  get configDir(): string {
    return this.app.vault.configDir;
  }

  /** Stores this device's config sync settings for this vault (never synced or set by the server) and restarts sync with them. */
  async setConfigSync(settings: ConfigSyncSettings): Promise<void> {
    this.data.configSync = settings;
    await this.saveSettings();
    await this.controller?.restart();
  }

  /** Tells the user to reload once sync changed config files (Obsidian reads them only at startup); never reloads by itself. */
  private readonly configChanged = reloadNotifier((message) => {
    new Notice(`Vault Sync: ${message}`, 0);
  }, 1000);

  /**
   * What a session syncs: the notes, plus the config folder files this
   * device's config sync settings select (SPEC.md §8). Built for every
   * session start, so a settings change applies from the next one.
   */
  private syncedVault(): VaultAdapter {
    const configPrefix = `${this.app.vault.configDir}/`;
    const own = this.manifest.dir;
    return new ConfigSyncVault({
      notes: new ObsidianVaultAdapter(this.app),
      config: new ObsidianConfigAdapter(configFolderHost(this.app, normalizePath)),
      settings: configSyncSettings(this.data),
      // Where Obsidian installed this plugin, as well as plugins/vault-sync.
      ownFolders: own?.startsWith(configPrefix) === true ? [own.slice(configPrefix.length)] : [],
      onConfigChange: this.configChanged,
    });
  }

  private layoutReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.app.workspace.onLayoutReady(resolve);
    });
  }

  private showStatus(status: SyncStatus): void {
    this.status = status;
    this.statusBar?.setText(statusText(status));
    this.statusBar?.setAttribute("aria-label", statusDescription(status));
    if (this.statusRibbon !== undefined) {
      setIcon(this.statusRibbon, statusIcon(status));
      this.statusRibbon.setAttribute("aria-label", statusText(status));
    }
    this.settingTab?.showStatus();
    this.refreshConflictViews();
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

/**
 * The file-name rules of the device Obsidian runs on (SPEC.md §8), with the
 * vault folder's absolute path where Obsidian exposes it (desktop), so the
 * length limits count it. Android follows the POSIX rules.
 */
function localPathRules(app: App): PathRules {
  const platform = Platform.isWin ? "windows" : Platform.isMacOS || Platform.isIosApp ? "macos" : "posix";
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? { platform, root: adapter.getBasePath() } : { platform };
}
