import { openConflicts, type OpenConflict } from "../core/engine/conflicts";
import { deferredDocuments, type DeferredDocument } from "../core/engine/deferred";
import { SyncEngine, type PullSummary, type PushSummary, type RejectedOperation, type TooLargeDocument, type UnmaterializableDocument } from "../core/engine/engine";
import type { HistoryEntry, HistoryPage } from "../core/engine/history";
import type { MergeHook } from "../core/engine/merge";
import type { PullApi } from "../core/engine/remote";
import { RealtimeClient, type RealtimeClientOptions } from "../core/realtime/client";
import type { DocumentState, Journal, RemoteRevision } from "../core/journal/journal";
import type { VaultAdapter, VaultEvent } from "../core/vault/adapter";
import type { PathRules } from "../core/vaultpath/platform";
import { rejectedReasonText, visiblePath } from "./conflict-text";
import { errorMessage, isOffline } from "./status";
import { UnsavedEditsError } from "./unsaved-edits";

// No Obsidian import: the plugin passes the Obsidian adapter and its
// layout-ready signal, and the unit tests pass in-memory ones.

export interface SyncSessionOptions {
  vaultId: string;
  /** This install's registered device, recorded with every commit. */
  deviceId: string;
  /** The device's name in conflict-copy names (SPEC.md §7); the engine falls back to the device id. */
  deviceName?: string;
  api: PullApi;
  /**
   * The device's durable journal for this vault and server vault
   * (`openVaultJournal`, ./journal.ts); it is what lets a restarted session
   * resume. The caller owns it and closes it once `stop()` has resolved.
   */
  journal: Journal;
  /** The open vault (ObsidianVaultAdapter in the plugin). */
  vault: VaultAdapter;
  /** Resolves once the vault may be synced: in Obsidian, when the workspace layout is ready, after startup indexing. */
  ready?: () => Promise<void>;
  merge?: MergeHook;
  /** The user's vault changes, to be pushed (SPEC.md §8). */
  onLocalChange?: (event: VaultEvent) => void;
  /** How long after the last local change of a burst the engine pushes (SyncEngineOptions.pushDebounceMs); null turns that off. */
  pushDebounceMs: number | null;
  /**
   * How often to push (which pulls first) on a timer, in milliseconds, so
   * remote changes arrive and a pending operation is retried without waiting
   * for the user's next edit; null turns the timer off.
   */
  syncIntervalMs: number | null;
  /** The local platform's file-name rules (SyncEngineOptions.pathRules); the engine defaults to POSIX. */
  pathRules?: PathRules;
  /** The largest remote content the engine downloads (SyncEngineOptions.maxDownloadBytes); the engine defaults to 1 GiB. */
  maxDownloadBytes?: number;
  /** Receives every change of the session's status. */
  onStatus?: (status: SessionStatus) => void;
  /**
   * The realtime channel (SPEC.md §6.4). When set, the started session
   * subscribes to the vault and pulls after every (re)subscribe and every
   * notification of it whose head is above the journal's cursor (not, then,
   * for its own commits, nor for a subscribe with nothing new). The pull
   * timer runs either way.
   */
  realtime?: Omit<RealtimeClientOptions, "vaultId" | "onChange">;
}

export interface SessionStatus {
  state: "syncing" | "idle" | "offline" | "error";
  /**
   * Local changes the server has not acknowledged: the journal's pending
   * operations, and the paths of local changes seen since the last push that
   * succeeded which no pending operation covers yet (a push that failed
   * before recording them, while the server was unreachable, say).
   */
  pending: number;
  /** Unresolved conflicts (see SyncStatus.conflicts). */
  conflicts: number;
  message?: string;
}

/** A running session's history browsing and restore (SPEC.md §11), what the history views use. */
export interface VaultHistory {
  /** The id of the synced document at `path`, if a live one is there. */
  documentAt(path: string): Promise<string | undefined>;
  history(documentId: string, pageToken?: string): Promise<HistoryPage>;
  readRevision(entry: HistoryEntry): Promise<Uint8Array>;
  /** Restores `entry` as the document's new head revision; `content` is its preview, if the user saw one; `path` restores it there instead of at its own path (#420). */
  restore(entry: HistoryEntry, content?: Uint8Array, path?: string): Promise<RemoteRevision>;
  /**
   * The deleted documents the user can restore here (SyncEngine.deletedDocuments),
   * without those at a path this vault does not sync now: a config file
   * restored while config sync (or its category) is off would be deferred as
   * `out-of-scope` and not show up (#417).
   */
  deletedDocuments(): Promise<DocumentState[]>;
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
 * One running sync of the open vault: the vault adapter and the sync engine
 * over the device's journal. It starts once `ready` resolves, resumes from
 * the journal's cursor (so disabling and re-enabling the plugin, or
 * restarting Obsidian, never starts a full resync), pulls, and pushes. It
 * then pushes after local changes (debounced) and on a timer, and pulls when
 * the realtime channel reports a remote change.
 *
 * Stopping never loses a local change: an edit the session had not pushed
 * yet stays on disk, and the next session's first push scans the whole vault
 * (the engine does that after every start), so it is found and pushed then.
 */
export class SyncSession {
  private engine: SyncEngine | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private starting: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private realtime: RealtimeClient | undefined;
  private timerRun: Promise<unknown> | undefined;
  private busy = false;
  /** The last pull or push's failure; undefined after a success. */
  private failure: unknown;
  /** The local operations the last push reported as refused for good (#100). */
  private refused: RejectedOperation[] = [];
  /** The file whose open view refused the last pull's write (UnsavedEditsError), until a pull or push succeeds. */
  private heldByView: string | undefined;
  /**
   * Vault events received so far. The session numbers them as they arrive
   * (`received`, the latest number per path); the engine classifies them
   * later, and a push classifies every event received before it was called
   * before it looks for changes.
   */
  private events = 0;
  private readonly received = new Map<string, number>();
  private unwatch: (() => void) | undefined;
  /** Local changes the engine reported since the last push that succeeded, by path, with the number of their latest event. */
  private readonly unpushed = new Map<string, number>();
  /** `events` when the engine's current pull or push was called, at the latest: a push that succeeds has seen every event numbered below it. */
  private pushMark = 0;
  private counts = { pending: 0, conflicts: 0 };
  /** Bumped by every report, so only the latest one's counts are kept. */
  private reports = 0;
  private readonly onStatus: (status: SessionStatus) => void;

  constructor(private readonly options: SyncSessionOptions) {
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  /**
   * Starts syncing: pulls, then pushes every local change since the last
   * session. Resolves with the pull's summary, or undefined if the session
   * was stopped first or the pull failed (the status says why, and the timer
   * tries again).
   */
  start(): Promise<PullSummary | undefined> {
    const run = this.run();
    this.starting = run.catch(() => undefined);
    return run;
  }

  /** Pulls and pushes now, unless the session is stopped. Resolves with the push's summary, or undefined if it failed. */
  async syncNow(): Promise<PushSummary | undefined> {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return undefined;
    return this.attempt(() => engine.push());
  }

  /**
   * History browsing and restore for the session's vault (SPEC.md §11), once
   * its engine runs; undefined before that and after the stop.
   */
  history(): VaultHistory | undefined {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return undefined;
    const { journal } = this.options;
    return {
      documentAt: async (path) => {
        const state = await journal.findDocumentByPath(path);
        return state === undefined || state.deleted ? undefined : state.documentId;
      },
      history: (documentId, pageToken) => engine.history(documentId, pageToken),
      readRevision: (entry) => engine.readRevision(entry),
      restore: async (entry, content, path) => {
        try {
          return await engine.restore(entry, content, path);
        } finally {
          void this.report();
        }
      },
      deletedDocuments: async () => {
        const { vault } = this.options;
        return (await engine.deletedDocuments()).filter((state) => vault.isSynced?.(state.path) ?? true);
      },
    };
  }

  /**
   * Stops the session and resolves once its engine has settled: from then on
   * it neither touches the vault or the journal nor calls the server, so a new
   * session can start over the same journal. A call still waiting for the
   * server is not waited for; its response is dropped. A scheduled push is
   * cancelled; what it would have pushed is found by the next session's scan.
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    this.abort.abort(new SessionStoppedError());
    if (this.timer !== undefined) clearInterval(this.timer);
    this.realtime?.stop();
    this.unwatch?.();
    this.engine?.dispose();
    this.stopping = (async () => {
      await this.starting;
      await this.engine?.settled();
    })();
    return this.stopping;
  }

  private async run(): Promise<PullSummary | undefined> {
    const stoppedFirst = new Promise<void>((resolve) => {
      this.abort.signal.addEventListener("abort", () => {
        resolve();
      });
    });
    await Promise.race([this.options.ready?.() ?? Promise.resolve(), stoppedFirst]);
    if (this.stopped) return undefined;
    const { options } = this;
    // Numbered before the engine sees them (it subscribes below).
    this.unwatch = options.vault.watch((event) => {
      this.received.set(event.path, this.events++);
    });
    const engine = new SyncEngine({
      vaultId: options.vaultId,
      deviceId: options.deviceId,
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      api: {
        sync: this.gateNetwork(options.api.sync),
        blobs: this.gateNetwork(options.api.blobs),
      },
      vault: this.gateLocal(options.vault, ["list", "read", "write", "rename", "delete", "stat"]),
      journal: this.gateLocal(options.journal),
      ...(options.merge === undefined ? {} : { merge: options.merge }),
      onLocalChange: (event) => {
        this.localChange(event);
        options.onLocalChange?.(event);
      },
      pushDebounceMs: options.pushDebounceMs,
      ...(options.pathRules === undefined ? {} : { pathRules: options.pathRules }),
      ...(options.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: options.maxDownloadBytes }),
      onBusyChange: (busy) => {
        this.busy = busy;
        if (busy) this.pushMark = this.events;
        void this.report();
      },
      onPushComplete: (summary) => {
        this.succeeded(summary);
      },
      onPushError: (error) => {
        this.failed(error);
      },
    });
    this.engine = engine;
    const pulled = await this.attempt(() => engine.pull());
    if (this.isStopped()) return undefined;
    // Push at startup too: a pending operation (one left after its commit
    // retries ran out, say) must not wait for the user's next edit.
    await this.attempt(() => engine.push());
    if (this.isStopped()) return undefined;
    if (options.realtime !== undefined) {
      this.realtime = new RealtimeClient({
        ...options.realtime,
        vaultId: options.vaultId,
        onChange: (seq) => this.attempt(() => engine.pullIfBehind(seq)),
      });
      this.realtime.start();
    }
    if (options.syncIntervalMs !== null) {
      this.timer = setInterval(() => {
        // One timer push at a time: on a slow network ticks never pile up.
        if (this.timerRun !== undefined) return;
        this.timerRun = this.attempt(() => engine.push()).finally(() => {
          this.timerRun = undefined;
        });
      }, options.syncIntervalMs);
    }
    return pulled;
  }

  /** Read through a call, so a check after an await is not narrowed away by the one before it. */
  private isStopped(): boolean {
    return this.stopped;
  }

  /** Runs a pull or push, recording its outcome for the status; a task that resolves with undefined did nothing and changes no status. */
  private async attempt<T extends PullSummary | PushSummary>(task: () => Promise<T | undefined>): Promise<T | undefined> {
    try {
      const result = await task();
      if (result !== undefined) this.succeeded(result);
      return result;
    } catch (error) {
      this.failed(error);
      return undefined;
    }
  }

  /** Counts a local change as pending until a push called after its event arrived succeeds. */
  private localChange(event: VaultEvent): void {
    if (this.stopped) return;
    this.unpushed.set(event.path, this.received.get(event.path) ?? this.events);
    void this.report();
  }

  private succeeded(result: PullSummary | PushSummary): void {
    if (this.stopped) return;
    this.failure = undefined;
    this.heldByView = undefined;
    if ("rejected" in result) {
      // Recorded in the journal (or parked, or committed) by this push.
      for (const [path, event] of this.unpushed) if (event < this.pushMark) this.unpushed.delete(path);
      for (const [path, event] of this.received) if (event < this.pushMark) this.received.delete(path);
    }
    // The engine's next pull or push begins after this one ended.
    this.pushMark = this.events;
    // A pull says nothing about refused operations; a push does, every time
    // (it looks at every pending operation), so a file the user renamed or
    // removed drops off the list with the next push.
    if ("rejected" in result) this.refused = result.rejected;
    void this.report();
  }

  private failed(error: unknown): void {
    if (this.stopped) return;
    this.failure = error;
    if (error instanceof UnsavedEditsError) this.heldByView = error.path;
    this.pushMark = this.events;
    void this.report();
  }

  /** Emits the current status, with the journal's counts as they are now. */
  private async report(): Promise<void> {
    if (this.stopped) return;
    const report = ++this.reports;
    if (this.busy) {
      this.onStatus({ state: "syncing", ...this.counts });
      return;
    }
    try {
      const counts = await this.countJournal();
      if (report === this.reports) this.counts = counts;
    } catch {
      // Stopped, or the journal is gone; keep the last counts.
    }
    if (this.isStopped() || report !== this.reports) return;
    this.onStatus(this.status());
  }

  private status(): SessionStatus {
    if (this.busy) return { state: "syncing", ...this.counts };
    if (this.failure !== undefined) {
      return {
        state: isOffline(this.failure) ? "offline" : "error",
        ...this.counts,
        message: errorMessage(this.failure),
      };
    }
    const [first] = this.refused;
    if (first !== undefined) {
      const path = visiblePath(first.operation.path);
      const reason = rejectedReasonText(first.reason, errorMessage(first.error));
      const message =
        this.refused.length === 1
          ? `Cannot sync "${path}": ${reason} Rename or move it to sync it.`
          : `Cannot sync ${String(this.refused.length)} local files, among them "${path}": ${reason} The Sync conflicts view lists them all.`;
      return { state: "error", ...this.counts, message };
    }
    return { state: "idle", ...this.counts };
  }

  private async countJournal(): Promise<{
    pending: number;
    conflicts: number;
  }> {
    const { journal, vault } = this.options;
    const operations = await journal.listPending();
    const covered = new Set(operations.map((operation) => operation.path));
    const unrecorded = [...this.unpushed.keys()].filter((path) => !covered.has(path)).length;
    const conflicts = (await openConflicts(journal, vault)).length;
    return { pending: operations.length + unrecorded, conflicts };
  }

  /**
   * The conflicts the user has not resolved yet, newest first: what the
   * conflict view lists. Empty once the session is stopped (its journal may
   * be closed).
   */
  async conflicts(): Promise<OpenConflict[]> {
    if (this.stopped) return [];
    return openConflicts(this.options.journal, this.options.vault);
  }

  /** The documents the local platform cannot hold at their server paths (SPEC.md §8), for the conflict view. Empty before the session started and once it is stopped. */
  async unmaterializable(): Promise<UnmaterializableDocument[]> {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return [];
    return engine.unmaterializable();
  }

  /** The documents whose remote revision is larger than the download cap (SPEC.md §8), for the conflict view. Empty before the session started and once it is stopped. */
  async tooLarge(): Promise<TooLargeDocument[]> {
    const engine = this.engine;
    if (engine === undefined || this.stopped) return [];
    return engine.tooLarge();
  }

  /**
   * The remote revisions deferred for their path (an invalid path, a path the
   * vault refuses, a move out of scope of a document with a file here; #417),
   * for the conflict view. Empty before the session started and once it is
   * stopped.
   */
  async deferred(): Promise<DeferredDocument[]> {
    if (this.engine === undefined || this.stopped) return [];
    return deferredDocuments(this.options.journal, this.options.vault);
  }

  /**
   * The file whose open view refused the last pull's write (#417), so sync
   * waits at that change until the view is saved or closed; undefined once a
   * pull or push succeeds, and once the session is stopped.
   */
  heldByOpenView(): string | undefined {
    return this.stopped ? undefined : this.heldByView;
  }

  /**
   * The local files the server refuses for good, as the last push found
   * them (#100), for the conflict view: each stays on disk, unsynced, until
   * the user renames or removes it. Empty once the session is stopped.
   */
  rejected(): Promise<RejectedOperation[]> {
    return Promise.resolve(this.stopped ? [] : [...this.refused]);
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
