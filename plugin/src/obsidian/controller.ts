import { Code, ConnectError } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../gen/vaultsync/v1/errors_pb";
import { VaultEncryption, VaultRole, type Vault } from "../gen/vaultsync/v1/types_pb";
import { jwtDisplayName, jwtSubject } from "../core/auth/oidc";
import type { AuthState } from "../core/auth/tokens";
import type { ProtocolClient } from "../core/protocol/client";
import type { SyncJournal } from "../core/sync/journal";
import type { VaultAdapter } from "../core/vault/adapter";
import { uuidv7 } from "../core/uuid";
import type { PathRules } from "../core/vaultpath/platform";
import { oidcConfig, serverBaseUrl, type ConnectedVault, type PluginData } from "./data";
import { DeviceNameError, deviceNameOf } from "./device-name";
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
      `This device cannot be registered: your account has reached the server's limit on registered devices (${serverMessage}). Sync cannot start on this device. Remove a device you no longer use from the device list in Vault Sync's settings on another device, then try again; your local files are untouched.`,
    );
  }
}

/**
 * This installation's device was removed from the account (from another
 * device's device list): the server refuses its commits (#590). Sync waits
 * for the user to register the installation again (SyncController.registerAgain);
 * local files and changes not synced yet are kept and pushed after that.
 */
export class DeviceRemovedError extends Error {
  override readonly name = "DeviceRemovedError";
  constructor() {
    super(
      "This device was removed from your account, so it cannot sync. Your files and the changes not synced yet are kept on this device. To sync again, register this device again in Vault Sync's settings; the changes are pushed then.",
    );
  }
}

/**
 * Whether `error` is the server's refusal of a commit because the device is
 * not (or no longer) one of the caller's: NOT_FOUND with the
 * DEVICE_NOT_FOUND reason. A NOT_FOUND without it (the vault is gone, say)
 * is something else; the message text is never matched.
 */
export function isDeviceNotFound(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    error.code === Code.NotFound &&
    error.findDetails(ErrorDetailSchema).some((detail) => detail.reason === ErrorReason.DEVICE_NOT_FOUND)
  );
}

/** The account a device registration belongs to. */
export interface Account {
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
 * so restarts and sign-ins never register again: every registration takes a
 * place under the server's device limit. A different account (or server) gets
 * a device of its own, because the server refuses commits with another user's
 * device.
 *
 * Before calling RegisterDevice it saves a registration id (with the name to
 * register), and every retry sends the same one, so a crash or a lost
 * response between the server registering the device and the plugin saving
 * it does not use a second place (#428): the server returns the device the
 * first call registered.
 */
export async function ensureDevice(options: DeviceRegistrationOptions): Promise<string> {
  const { data } = options;
  const account = await currentAccount(data, options.accessToken);
  const stored = data.device;
  if (stored !== undefined && sameAccount(stored, account)) {
    // Registering again takes the user's say-so: the device may have been
    // removed on purpose (a lost laptop, say).
    if (stored.removed === true) throw new DeviceRemovedError();
    return stored.id;
  }
  let pending = data.pendingDevice;
  if (pending === undefined || !sameAccount(pending, account)) {
    pending = { registrationId: uuidv7(), name: deviceNameOf(data.deviceName, options.defaultDeviceName), ...account };
    data.pendingDevice = pending;
    await options.save();
  }
  let id: string | undefined;
  try {
    id = (await options.client.devices.registerDevice({ name: pending.name, registrationId: pending.registrationId })).device?.id;
  } catch (error) {
    if (isDeviceLimit(error)) throw new DeviceLimitError(errorMessage(error));
    if (isRefusal(error)) {
      // The server registered nothing under this request, so the next attempt
      // mints a new registration id and takes the current Device name: a name
      // the server refuses must not stay stuck in plugin data (#428).
      delete data.pendingDevice;
      await options.save();
      if (error.code === Code.InvalidArgument) throw new DeviceNameError(errorMessage(error));
    }
    throw error;
  }
  if (id === undefined || id === "") throw new Error("the server registered the device but returned no id");
  data.device = { id, ...account };
  delete data.pendingDevice;
  await options.save();
  return id;
}

/**
 * A RegisterDevice error meaning the server registered nothing under the
 * request: INVALID_ARGUMENT (a refused name or a malformed registration id)
 * or ALREADY_EXISTS (the registration id is taken by a device with another
 * name or key). Transient or ambiguous errors (UNAVAILABLE,
 * DEADLINE_EXCEEDED, network errors, a RESOURCE_EXHAUSTED without the
 * device-limit reason) are not refusals: the first call may have registered
 * the device, so a retry must send the same registration id.
 */
function isRefusal(error: unknown): error is ConnectError {
  return error instanceof ConnectError && (error.code === Code.InvalidArgument || error.code === Code.AlreadyExists);
}

export function sameAccount(stored: Account, account: Account): boolean {
  return stored.serverUrl === account.serverUrl && stored.issuer === account.issuer && stored.subject === account.subject;
}

/**
 * RESOURCE_EXHAUSTED from RegisterDevice is the per-user device limit only
 * when the server says so with its machine-readable reason (#428). Without it
 * (the per-user limit on concurrent requests, which passes once earlier
 * requests finish, a request over the size limit, or a server too old to send
 * reasons) the error is treated as transient. The message text is never
 * matched: the server may reword it.
 */
function isDeviceLimit(error: unknown): error is ConnectError {
  return (
    error instanceof ConnectError &&
    error.code === Code.ResourceExhausted &&
    error.findDetails(ErrorDetailSchema).some((detail) => detail.reason === ErrorReason.DEVICE_LIMIT)
  );
}

export async function currentAccount(data: PluginData, accessToken: () => Promise<string>): Promise<Account> {
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
export type ClosableJournal = SyncJournal & { close(): void };

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
  /** The download cap, passed to every session (SyncSessionOptions.maxDownloadBytes). */
  maxDownloadBytes?: number;
  /** The realtime channel to the session's server (serverBaseUrl), if any (SyncSessionOptions.realtime). */
  realtime?: (serverUrl: string) => SyncSessionOptions["realtime"];
  onStatus: (status: SyncStatus) => void;
  /**
   * Hears whether the device is read-only in the connected vault (the user
   * is a `viewer`, docs/design/sharing.md), when that changes. Read from
   * ListVaults at the start of every sync cycle.
   */
  onReadOnly?: (readOnly: boolean) => void;
  /** Keeps a local version a read-only device does not push (SyncSessionOptions.keepLocalCopy). */
  keepLocalCopy?: (path: string, content: Uint8Array) => Promise<void>;
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
  /** The connected vault the device last read its role in, and whether it is read-only there. */
  private role: { key: string; readOnly: boolean } | undefined;

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

  /**
   * Whether the device is read-only (a `viewer`) in the connected vault, as
   * last read from ListVaults; false until it was read. It is kept while the
   * session is stopped (offline, signed out), until another vault is connected.
   */
  get readOnly(): boolean {
    const vault = connectedVault(this.options.data());
    const key = vault === undefined ? undefined : `${serverBaseUrl(this.options.data())}\n${vault.id}`;
    return this.role !== undefined && this.role.key === key && this.role.readOnly;
  }

  /** The running session, if any. */
  get session(): SyncSession | undefined {
    return this.running?.session;
  }

  /**
   * Registers this installation as a new device after its device was
   * removed (DeviceRemovedError), and starts sync again with it: the changes
   * not synced yet are pushed under the new device. Does nothing else when
   * the device is not marked removed.
   */
  registerAgain(): Promise<void> {
    const data = this.options.data();
    if (data.device?.removed !== true) return this.update();
    delete data.device;
    delete data.pendingDevice;
    return this.options.save().then(() => this.restart());
  }

  /** Pulls and pushes now, if a session runs. */
  async syncNow(): Promise<void> {
    await this.running?.session.syncNow();
  }

  /**
   * History browsing and restore, while a session runs. `canRestore` reads
   * the signed-in user's role in the connected vault from ListVaults: a
   * `viewer` cannot restore (the server refuses it), so the history modal
   * offers no restore then (#417). When the role cannot be read it resolves
   * true and the server decides.
   */
  history(): VaultHistory | undefined {
    const history = this.running?.session.history();
    const vault = connectedVault(this.options.data());
    if (history === undefined || vault === undefined) return history;
    return {
      ...history,
      canRestore: async () => {
        try {
          const member = (await listRemoteVaults(this.options.client())).find((candidate) => candidate.id === vault.id);
          return member?.role !== VaultRole.VIEWER;
        } catch {
          return true;
        }
      },
    };
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
      const deviceName = deviceNameOf(data.deviceName, this.options.defaultDeviceName);
      const userName = jwtDisplayName(await this.options.accessToken()) ?? "";
      if (!live()) {
        journal.close();
        return;
      }
      const realtime = this.options.realtime?.(serverBaseUrl(data));
      const sessionOptions: SyncSessionOptions = {
        ...(realtime === undefined ? {} : { realtime }),
        vaultId: wanted.vault.id,
        deviceId,
        deviceName,
        userName,
        api: this.watchDevice(client, deviceId, generation),
        journal,
        vault: this.options.vault(),
        ...(this.options.ready === undefined ? {} : { ready: this.options.ready }),
        pushDebounceMs: this.options.pushDebounceMs,
        syncIntervalMs: this.options.syncIntervalMs,
        ...(this.options.pathRules === undefined ? {} : { pathRules: this.options.pathRules }),
        ...(this.options.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: this.options.maxDownloadBytes }),
        readOnly: () => this.readRole(client, wanted.key, wanted.vault.id, live),
        ...(this.options.keepLocalCopy === undefined ? {} : { keepLocalCopy: this.options.keepLocalCopy }),
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
        state: error instanceof DeviceRemovedError ? "device-removed" : isOffline(error) ? "offline" : "error",
        conflicts: 0,
        pending: 0,
        message: errorMessage(error),
      });
      // Offline at startup, say: try again later. The device limit does not
      // lift by itself, so that waits for the user (a restart or reconnect),
      // and a removed device waits for the user to register it again.
      if (!(error instanceof DeviceLimitError) && !(error instanceof DeviceRemovedError) && this.options.syncIntervalMs !== null) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (live()) void this.update();
        }, this.options.syncIntervalMs);
      }
    }
  }

  /**
   * Whether the signed-in user is a `viewer` of vault `vaultId`, from
   * ListVaults; called by the session at the start of every sync cycle
   * (docs/design/sharing.md, Viewer devices). A vault missing from the list
   * is not read-only here: the server refuses that device's requests anyway.
   */
  private async readRole(client: ProtocolClient, key: string, vaultId: string, live: () => boolean): Promise<boolean> {
    const member = (await listRemoteVaults(client)).find((candidate) => candidate.id === vaultId);
    const readOnly = member?.role === VaultRole.VIEWER;
    if (live() && (this.role?.key !== key || this.role.readOnly !== readOnly)) {
      const changed = this.readOnly !== readOnly;
      this.role = { key, readOnly };
      if (changed) this.options.onReadOnly?.(readOnly);
    }
    return readOnly;
  }

  /**
   * The session's server client: a commit refused because `deviceId` was
   * removed (isDeviceNotFound) marks the device removed in plugin data and
   * stops the session, which leaves its pending operations in the journal
   * (#590). The error still reaches the engine, which keeps the operation
   * pending. The stop is queued, not awaited: the session waits for the
   * engine, which waits for this call.
   */
  private watchDevice(client: ProtocolClient, deviceId: string, generation: number): ProtocolClient {
    const { sync } = client;
    return {
      ...client,
      sync: {
        ...sync,
        commitRevision: async (request, options) => {
          try {
            return await sync.commitRevision(request, options);
          } catch (error) {
            if (isDeviceNotFound(error)) void this.deviceRemoved(deviceId, generation);
            throw error;
          }
        },
      },
    };
  }

  /** Marks `deviceId` removed and stops sync until the user registers again, unless an update overtook the session that saw it. */
  private deviceRemoved(deviceId: string, generation: number): Promise<void> {
    if (generation !== this.generation) return Promise.resolve();
    this.cancelRetry();
    const next = ++this.generation;
    const run = this.queue.then(async () => {
      if (next !== this.generation) return;
      const data = this.options.data();
      if (data.device?.id === deviceId && data.device.removed !== true) {
        data.device = { ...data.device, removed: true };
        await this.options.save();
      }
      await this.stopRunning();
      await this.apply(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
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
