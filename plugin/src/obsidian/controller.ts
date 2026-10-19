import { Code, ConnectError } from "@connectrpc/connect";

import { VaultEncryption, type Vault } from "../gen/vaultsync/v1/types_pb";
import { jwtSubject } from "../core/auth/oidc";
import type { AuthState } from "../core/auth/tokens";
import type { Journal } from "../core/journal/journal";
import type { ProtocolClient } from "../core/protocol/client";
import type { VaultAdapter } from "../core/vault/adapter";
import type { PathRules } from "../core/vaultpath/platform";
import { oidcConfig, serverBaseUrl, type ConnectedVault, type PluginData } from "./data";
import type { JournalKey } from "./journal";
import { SyncSession, type SyncSessionOptions, type VaultHistory } from "./session";
import { errorMessage, isOffline, type SyncStatus } from "./status";

// What decides whether this vault syncs, and with what: the account, the
// registered device, and the connected server vault. No Obsidian import, so
// it is unit-tested against in-memory servers; main.ts wires it to Obsidian.

/** RegisterDevice was refused because the account has as many devices as the server allows. */
export class DeviceLimitError extends Error {
  override readonly name = "DeviceLimitError";
  constructor(serverMessage: string) {
    super(
      `This device cannot be registered: your account has reached the server's limit on registered devices (${serverMessage}). Sync cannot start on this device. Registered devices cannot be removed yet, so ask the server's operator; your local files are untouched.`,
    );
  }
}

/** The account a device registration belongs to. */
interface Account {
  serverUrl: string;
  issuer: string;
  subject: string;
}

export interface DeviceRegistrationOptions {
  data: PluginData;
  save: () => Promise<void>;
  client: ProtocolClient;
  /** The current access token, to tell which account is signed in. */
  accessToken: () => Promise<string>;
  /** The name to register when the user set none (data.deviceName). */
  defaultDeviceName: string;
}

/**
 * This install's device id for the signed-in account, registering the device
 * the first time (SPEC.md §6.2: one device per plugin install). The id is
 * stored in plugin data before it is used, and reused on every later start,
 * so restarts and sign-ins never register again: the server's device limit
 * counts every registration. A different account (or server) gets a device
 * of its own, because the server refuses commits with another user's device.
 */
export async function ensureDevice(options: DeviceRegistrationOptions): Promise<string> {
  const { data } = options;
  const account = await currentAccount(data, options.accessToken);
  const stored = data.device;
  if (stored !== undefined && stored.serverUrl === account.serverUrl && stored.issuer === account.issuer && stored.subject === account.subject) return stored.id;
  const name = data.deviceName.trim() === "" ? options.defaultDeviceName : data.deviceName.trim();
  let id: string | undefined;
  try {
    id = (await options.client.devices.registerDevice({ name })).device?.id;
  } catch (error) {
    if (isDeviceLimit(error)) throw new DeviceLimitError(errorMessage(error));
    throw error;
  }
  if (id === undefined || id === "") throw new Error("the server registered the device but returned no id");
  data.device = { id, ...account };
  await options.save();
  return id;
}

/**
 * RESOURCE_EXHAUSTED from RegisterDevice is the per-user device limit, except
 * when it comes from the server's per-user limit on concurrent requests, which
 * passes once earlier requests finish.
 */
function isDeviceLimit(error: unknown): error is ConnectError {
  return error instanceof ConnectError && error.code === Code.ResourceExhausted && !/concurrent/i.test(error.rawMessage);
}

async function currentAccount(data: PluginData, accessToken: () => Promise<string>): Promise<Account> {
  const subject = jwtSubject(await accessToken());
  if (subject === undefined) throw new Error("the access token names no user (no sub claim)");
  return {
    serverUrl: serverBaseUrl(data),
    issuer: oidcConfig(data).issuer,
    subject,
  };
}

/** Upper bound on ListVaults pages read for the vault picker. */
const maxVaultPages = 100;

/** Every vault the signed-in user is a member of. */
export async function listRemoteVaults(client: ProtocolClient): Promise<Vault[]> {
  const vaults: Vault[] = [];
  let pageToken = "";
  for (let page = 0; page < maxVaultPages; page++) {
    const response = await client.vaults.listVaults({ pageToken });
    vaults.push(...response.vaults);
    if (response.nextPageToken === "") break;
    pageToken = response.nextPageToken;
  }
  return vaults;
}

/** Why `vault` cannot be synced by this plugin, or undefined if it can. */
export function connectProblem(vault: Vault): string | undefined {
  if (vault.encryption !== VaultEncryption.NONE) return "End-to-end encrypted vaults cannot be synced yet.";
  return undefined;
}

/**
 * Whether connecting needs the user's confirmation first: both this vault and
 * the remote vault have files. Nothing is overwritten then either, but every
 * file at a path both sides have, with different content, becomes a conflict
 * copy, which the user should expect.
 */
export function connectNeedsConfirmation(localFiles: number, remote: Pick<Vault, "headSeq">): boolean {
  return localFiles > 0 && remote.headSeq > 0n;
}

/** The connected vault, if it is on the configured server. */
export function connectedVault(data: PluginData): ConnectedVault | undefined {
  const vault = data.vault;
  return vault !== undefined && vault.serverUrl === serverBaseUrl(data) ? vault : undefined;
}

/** The journal a session runs over; closed by the controller once the session stopped. */
export type ClosableJournal = Journal & { close(): void };

export interface SyncControllerOptions {
  data: () => PluginData;
  save: () => Promise<void>;
  authState: () => AuthState;
  /** The authenticated protocol client. */
  client: () => ProtocolClient;
  accessToken: () => Promise<string>;
  defaultDeviceName: string;
  /** Opens the journal for `key`; `onBlocked` hears that it waits for another connection. */
  openJournal: (key: JournalKey, onBlocked: () => void) => Promise<ClosableJournal>;
  vault: () => VaultAdapter;
  ready?: () => Promise<void>;
  pushDebounceMs: number | null;
  syncIntervalMs: number | null;
  /** The local platform's file-name rules, passed to every session (SyncSessionOptions.pathRules). */
  pathRules?: PathRules;
  /** The realtime channel to the session's server (serverBaseUrl), if any (SyncSessionOptions.realtime). */
  realtime?: (serverUrl: string) => SyncSessionOptions["realtime"];
  onStatus: (status: SyncStatus) => void;
  /** Builds the session; tests replace it to observe sessions. Defaults to `new SyncSession(options)`. */
  createSession?: (options: SyncSessionOptions) => SyncSession;
}

interface Running {
  key: string;
  session: SyncSession;
  journal: ClosableJournal;
}

/**
 * Runs a sync session exactly while the device is signed in and this vault is
 * connected to a server vault. `update()` is called after every change of
 * either; it stops the running session first (and waits for it, so two
 * engines never share the journal) and then starts the one now wanted, if
 * any. Sign-in-required stops sync: every call would fail. Local changes
 * stay on disk and in the journal and are pushed by the session that starts
 * after the next sign-in.
 */
export class SyncController {
  private running: Running | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by every update and stop, so a start that an update overtook gives up. */
  private generation = 0;
  private current: SyncStatus = {
    state: "signed-out",
    conflicts: 0,
    pending: 0,
  };
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SyncControllerOptions) {}

  get status(): SyncStatus {
    return this.current;
  }

  /** Brings sync in line with the current account and vault. Resolves once the session is started (not synced) or stopped. */
  update(): Promise<void> {
    this.cancelRetry();
    const generation = ++this.generation;
    const run = this.queue.then(() => this.apply(generation));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Stops the running session, if any, and starts the one now wanted, even if
   * the account and vault did not change: for settings that the session's
   * vault is built from, such as config sync (SPEC.md §8).
   */
  restart(): Promise<void> {
    this.cancelRetry();
    const generation = ++this.generation;
    const run = this.queue.then(async () => {
      if (generation !== this.generation) return;
      await this.stopRunning();
      await this.apply(generation);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops sync, and resolves once the session's engine has settled. */
  stop(): Promise<void> {
    this.cancelRetry();
    ++this.generation;
    const run = this.queue.then(() => this.stopRunning());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The running session, if any. */
  get session(): SyncSession | undefined {
    return this.running?.session;
  }

  /** Pulls and pushes now, if a session runs. */
  async syncNow(): Promise<void> {
    await this.running?.session.syncNow();
  }

  /** History browsing and restore, while a session runs. */
  history(): VaultHistory | undefined {
    return this.running?.session.history();
  }

  private async apply(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const data = this.options.data();
    const authState = this.options.authState();
    const vault = connectedVault(data);
    const wanted = authState === "signed-in" && vault !== undefined ? { vault, key: `${serverBaseUrl(data)}\n${vault.id}` } : undefined;
    if (this.running !== undefined && this.running.key === wanted?.key) return;
    await this.stopRunning();
    if (wanted === undefined) {
      this.publish({
        state: authState === "signed-in" ? "not-connected" : authState,
        conflicts: 0,
        pending: 0,
      });
      return;
    }
    this.publish({ state: "starting", conflicts: 0, pending: 0 });
    const live = () => generation === this.generation;
    let journal: ClosableJournal | undefined;
    try {
      const client = this.options.client();
      const deviceId = await ensureDevice({
        data,
        save: this.options.save,
        client,
        accessToken: this.options.accessToken,
        defaultDeviceName: this.options.defaultDeviceName,
      });
      if (!live()) return;
      journal = await this.options.openJournal({ serverUrl: serverBaseUrl(data), vaultId: wanted.vault.id }, () => {
        if (live())
          this.publish({
            state: "waiting-for-journal",
            conflicts: 0,
            pending: 0,
          });
      });
      if (!live()) {
        journal.close();
        return;
      }
      const deviceName = data.deviceName.trim() === "" ? this.options.defaultDeviceName : data.deviceName.trim();
      const realtime = this.options.realtime?.(serverBaseUrl(data));
      const sessionOptions: SyncSessionOptions = {
        ...(realtime === undefined ? {} : { realtime }),
        vaultId: wanted.vault.id,
        deviceId,
        deviceName,
        api: client,
        journal,
        vault: this.options.vault(),
        ...(this.options.ready === undefined ? {} : { ready: this.options.ready }),
        pushDebounceMs: this.options.pushDebounceMs,
        syncIntervalMs: this.options.syncIntervalMs,
        ...(this.options.pathRules === undefined ? {} : { pathRules: this.options.pathRules }),
        onStatus: (status) => {
          if (this.running?.session === session) this.publish(status);
        },
      };
      const session = this.options.createSession?.(sessionOptions) ?? new SyncSession(sessionOptions);
      this.running = { key: wanted.key, session, journal };
      void session.start();
    } catch (error) {
      journal?.close();
      // Signed out (or the session ended) meanwhile: the next update shows that instead.
      if (!live()) return;
      console.warn(`vault-sync: sync could not start: ${errorMessage(error)}`);
      this.publish({
        state: isOffline(error) ? "offline" : "error",
        conflicts: 0,
        pending: 0,
        message: errorMessage(error),
      });
      // Offline at startup, say: try again later. The device limit does not
      // lift by itself, so that waits for the user (a restart or reconnect).
      if (!(error instanceof DeviceLimitError) && this.options.syncIntervalMs !== null) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (live()) void this.update();
        }, this.options.syncIntervalMs);
      }
    }
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private async stopRunning(): Promise<void> {
    const running = this.running;
    if (running === undefined) return;
    this.running = undefined;
    await running.session.stop();
    running.journal.close();
  }

  private publish(status: SyncStatus): void {
    this.current = status;
    this.options.onStatus(status);
  }
}
