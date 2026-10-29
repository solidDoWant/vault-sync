import { RealtimeClient, type RealtimeClientOptions } from "../core/realtime/client";
import { SyncEngine, type RefusedName, type SyncApi, type TooLargeFile } from "../core/sync/engine";
import { commitRestore, documentHistory, readRevision, type HistoryEntry, type HistoryPage } from "../core/sync/history";
import type { SkippedEntry, SyncJournal } from "../core/sync/journal";
import type { RemoteRevision } from "../core/sync/remote";
import { v7 as uuidv7 } from "uuid";
import type { VaultAdapter } from "../core/vault/adapter";
import type { PathRules } from "../core/vaultpath/platform";
import { visiblePath } from "./display-text";
import { errorMessage, isOffline } from "./status";

// No Obsidian import: the plugin passes the Obsidian adapter and its
// layout-ready signal, and the unit tests pass in-memory ones.

export interface SyncSessionOptions {
  vaultId: string;
  /** This install's registered device, recorded with every commit. */
  deviceId: string;
  /** The device's name in conflict-copy names (docs/design/engine.md §5, rule C); the engine falls back to the device id. */
  deviceName?: string;
  /** The signed-in user's display name in conflict-copy names (docs/design/sharing.md, Attribution). */
  userName?: string;
  api: SyncApi;
  /**
   * The device's durable journal for this vault and server vault
   * (`openVaultJournal`, ./journal.ts); it is what lets a restarted session
   * resume. The caller owns it and closes it once `stop()` has resolved.
   */
  journal: SyncJournal;
  /** The open vault (ObsidianVaultAdapter in the plugin). */
  vault: VaultAdapter;
  /** Resolves once the vault may be synced: in Obsidian, when the workspace layout is ready, after startup indexing. */
  ready?: () => Promise<void>;
  /** How long after the last local change a sync starts, in milliseconds; null: only on the timer, the realtime channel and syncNow. */
  pushDebounceMs: number | null;
  /** The fallback interval between syncs, in milliseconds; null turns the timer off. */
  syncIntervalMs: number | null;
  /** The local platform's file-name rules: a remote path this device cannot hold is skipped (docs/design/engine.md §6). */
  pathRules?: PathRules;
  /** The largest file this device uploads or downloads (docs/design/engine.md §7). */
  maxDownloadBytes?: number;
  /** Receives every change of the session's status. */
  onStatus?: (status: SessionStatus) => void;
  /** Whether the device may only pull, read at the start of every sync cycle (SyncEngineOptions.readOnly). */
  readOnly?: () => Promise<boolean>;
  /** Keeps a local version a read-only device does not push (SyncEngineOptions.keepLocalCopy). */
  keepLocalCopy?: (path: string, content: Uint8Array) => Promise<void>;
  /**
   * The realtime channel (SPEC.md §6.4). When set, the started session
   * subscribes to the vault and syncs after every (re)subscribe and every
   * notification of it. The fallback timer runs either way.
   */
  realtime?: Omit<RealtimeClientOptions, "vaultId" | "onChange">;
}

export interface SessionStatus {
  state: "syncing" | "idle" | "offline" | "error";
  /** Local changes the server has not acknowledged: the journal's pending operations. */
  pending: number;
  /** Conflict copies this device created that are still on disk. */
  conflicts: number;
  message?: string;
}

/** A conflict copy, with the document it was taken from, for the conflict view. */
export interface ListedConflict {
  /** The conflict copy's path. */
  copy: string;
  /** The path of the document the copy was taken from, or null if it no longer exists here. */
  original: string | null;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** What the conflict view lists (docs/design/engine.md §10). */
export interface SyncProblemList {
  conflicts: ListedConflict[];
  /** Local files whose names the server refused (rule P3). */
  refused: RefusedName[];
  /** Remote documents this device skipped: over the size limit, or at a path it cannot hold (§6, §7). */
  skipped: SkippedEntry[];
  /** Local files over the size limit, not uploaded (§7). */
  tooLarge: TooLargeFile[];
}

/** A running session's history browsing and restore (docs/design/engine.md §10), what the history views use. */
export interface VaultHistory {
  /** The id of the synced document at `path`, if a live one is there. */
  documentAt(path: string): Promise<string | undefined>;
  history(documentId: string, pageToken?: string): Promise<HistoryPage>;
  /** `entry`'s content; with `limit`, only its first `limit` bytes when it is larger, for a preview. */
  readRevision(entry: HistoryEntry, limit?: number): Promise<Uint8Array>;
  /** Restores `entry` as the document's new head revision; `content` is its preview, if the user saw one; `path` restores it there instead of at its own path. */
  restore(entry: HistoryEntry, content?: Uint8Array, path?: string): Promise<RemoteRevision>;
  /**
   * Whether the signed-in user may restore versions in this vault: false for
   * a `viewer`, whom the server refuses. Resolves true when the role cannot
   * be read (the server still decides). Absent: true.
   */
  canRestore?(): Promise<boolean>;
}

/** What a stopped session's engine gets for every vault, journal and server call it makes after the stop. */
export class SessionStoppedError extends Error {
  override readonly name = "SessionStoppedError";
  constructor() {
    super("the sync session was stopped");
  }
}

/**
 * One running sync of the open vault: the sync engine (docs/design/engine.md)
 * over the device's journal. It starts once `ready` resolves, resumes from
 * the journal's cursor, and syncs: at the start, after local changes
 * (debounced), when the realtime channel reports a remote change, and on a
 * fallback timer.
 *
 * Stopping never loses a local change: an edit the session had not pushed
 * yet stays on disk, and the next session's first cycle detects it.
 */
export class SyncSession {
  private engine: SyncEngine | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private starting: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private realtime: RealtimeClient | undefined;
  private counts = { pending: 0, conflicts: 0 };
  /** Bumped by every report, so only the latest one's counts are kept. */
  private reports = 0;
  private readonly onStatus: (status: SessionStatus) => void;

  constructor(private readonly options: SyncSessionOptions) {
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  /** Starts syncing. Resolves once the first sync finished (or failed: the status says why, and the engine retries), or the session was stopped first. */
  start(): Promise<void> {
    const run = this.run();
    this.starting = run.catch(() => undefined);
    return run;
  }

  /** Syncs now, unless the session is stopped. Resolves once the sync finished: with its failure, which the status also shows, or undefined. */
  async syncNow(): Promise<{ error: unknown } | undefined> {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return undefined;
    try {
      await engine.sync();
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  /** History browsing and restore for the session's vault, once its engine runs; undefined before that and after the stop. */
  history(): VaultHistory | undefined {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return undefined;
    const { vaultId, deviceId } = this.options;
    const api = this.gatedApi();
    return {
      documentAt: (path) => engine.documentAt(path),
      history: (documentId, pageToken) => documentHistory(api, vaultId, deviceId, documentId, pageToken),
      readRevision: (entry, limit) => readRevision(api, vaultId, entry, limit),
      restore: async (entry, content, path) => {
        const revision = await commitRestore(api, vaultId, deviceId, entry, uuidv7(), content, path);
        // The restore is a new head revision: the next pull brings it here like any other.
        engine.notifyRemoteChange();
        return revision;
      },
    };
  }

  /**
   * Stops the session and resolves once its engine has settled: from then on
   * it neither touches the vault or the journal nor calls the server, so a new
   * session can start over the same journal. A call still waiting for the
   * server is not waited for; its response is dropped.
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    this.abort.abort(new SessionStoppedError());
    this.realtime?.stop();
    this.engine?.stop();
    this.stopping = (async () => {
      await this.starting;
      await this.engine?.settled();
    })();
    return this.stopping;
  }

  private async run(): Promise<void> {
    const stoppedFirst = new Promise<void>((resolve) => {
      this.abort.signal.addEventListener("abort", () => {
        resolve();
      });
    });
    await Promise.race([this.options.ready?.() ?? Promise.resolve(), stoppedFirst]);
    if (this.stopped) return;
    const { options } = this;
    const engine = new SyncEngine({
      vaultId: options.vaultId,
      deviceId: options.deviceId,
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      ...(options.userName === undefined ? {} : { userName: options.userName }),
      api: this.gatedApi(),
      vault: this.gateLocal(options.vault, ["list", "read", "write", "rename", "delete", "stat", "replace"]),
      journal: this.gateLocal(options.journal),
      debounceMs: options.pushDebounceMs,
      intervalMs: options.syncIntervalMs,
      ...(options.pathRules === undefined ? {} : { pathRules: options.pathRules }),
      ...(options.maxDownloadBytes === undefined ? {} : { maxFileBytes: options.maxDownloadBytes }),
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      ...(options.keepLocalCopy === undefined ? {} : { keepLocalCopy: options.keepLocalCopy }),
      onChange: () => {
        void this.report();
      },
    });
    this.engine = engine;
    const first = engine.start();
    if (options.realtime !== undefined) {
      this.realtime = new RealtimeClient({
        ...options.realtime,
        vaultId: options.vaultId,
        onChange: () => engine.sync().catch(() => undefined),
      });
      this.realtime.start();
    }
    await first.catch(() => undefined);
  }

  /** The server client, refused once the session stopped (gateNetwork). */
  private gatedApi(): SyncApi {
    const { api } = this.options;
    return { sync: this.gateNetwork(api.sync), blobs: this.gateNetwork(api.blobs) };
  }

  /** Emits the current status, with the journal's counts as they are now. */
  private async report(): Promise<void> {
    if (this.stopped) return;
    const engine = this.engine;
    if (engine === undefined) return;
    const report = ++this.reports;
    if (engine.status === "syncing") {
      this.onStatus({ state: "syncing", ...this.counts });
      return;
    }
    let problems: SyncProblemList | undefined;
    try {
      problems = await this.listProblems();
      const counts = { pending: await engine.pendingCount(), conflicts: problems.conflicts.length };
      if (report === this.reports) this.counts = counts;
    } catch {
      // Stopped, or the journal is gone; keep the last counts.
    }
    if (this.isStopped() || report !== this.reports) return;
    this.onStatus(this.status(engine, problems));
  }

  /** Read through a call, so a check after an await is not narrowed away by the one before it. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private status(engine: SyncEngine, problems: SyncProblemList | undefined): SessionStatus {
    if (engine.status === "syncing") return { state: "syncing", ...this.counts };
    if (engine.status === "error") {
      const failure = engine.lastError;
      return { state: isOffline(failure) ? "offline" : "error", ...this.counts, message: errorMessage(failure) };
    }
    const [first] = problems?.refused ?? [];
    if (first !== undefined) {
      const refused = problems?.refused.length ?? 1;
      const path = visiblePath(first.path);
      const message =
        refused === 1
          ? `Cannot sync "${path}": the server refused its name (${first.reason}). Rename or move it to sync it.`
          : `Cannot sync ${String(refused)} local files, among them "${path}": the server refused their names. The Sync conflicts view lists them all.`;
      return { state: "error", ...this.counts, message };
    }
    return { state: "idle", ...this.counts };
  }

  /** What the conflict view lists. Empty before the session started and once it is stopped (its journal may be closed). */
  async listProblems(): Promise<SyncProblemList> {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return { conflicts: [], refused: [], skipped: [], tooLarge: [] };
    const problems = await engine.problems();
    const conflicts: ListedConflict[] = [];
    for (const entry of problems.conflicts) {
      conflicts.push({ copy: entry.path, original: (await engine.pathOf(entry.documentId)) ?? null, createdAt: entry.createdAt });
    }
    return { conflicts, refused: problems.refused, skipped: problems.skipped, tooLarge: problems.tooLarge };
  }

  /**
   * `target` with every method in `methods` (all methods if omitted) refused
   * once the session stopped. Calls already running finish: vault and journal
   * steps are short and atomic, and stop() waits for them.
   */
  private gateLocal<T extends object>(target: T, methods?: readonly string[]): T {
    return new Proxy(target, {
      get: (object, property, receiver) => {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== "function" || (methods !== undefined && !methods.includes(String(property)))) return value;
        return (...args: unknown[]) => {
          if (this.stopped) return Promise.reject(new SessionStoppedError());
          return (value as (...values: unknown[]) => unknown).apply(object, args);
        };
      },
    });
  }

  /**
   * A server client whose calls are refused once the session stopped, and
   * whose calls in flight reject at the stop instead of keeping the engine
   * waiting on the network (requestUrl cannot be cancelled; the late response
   * is dropped). The engine is crash-safe at every step, so an abandoned call
   * is resumed by the next session like an interrupted one.
   */
  private gateNetwork<T extends object>(client: T): T {
    const signal = this.abort.signal;
    return new Proxy(client, {
      get: (object, property, receiver) => {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (signal.aborted) return Promise.reject(new SessionStoppedError());
          const call = Promise.resolve((value as (...values: unknown[]) => unknown).apply(object, args));
          call.catch(() => undefined);
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              reject(new SessionStoppedError());
            };
            signal.addEventListener("abort", onAbort, { once: true });
            call.then(resolve, reject).finally(() => {
              signal.removeEventListener("abort", onAbort);
            });
          });
        };
      },
    });
  }
}
