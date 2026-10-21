import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { sha256Hex } from "../hash";
import type { Absence, ConflictReason, ConflictRecord, DeferReason, DocumentKindName, DocumentState, Journal, PendingOperation, RemoteRevision } from "../journal/journal";
import { uuidv7 } from "../uuid";
import { isVaultError, type DeletePrecondition, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { posixPathRules, unmaterializableReason, type PathRules, type UnmaterializableCause } from "../vaultpath/platform";
import { isVaultRelativePath, pathProblem, type PathProblem } from "../vaultpath/vaultpath";
import { EchoSuppressor } from "./echo";
import { blobMissing, errorCode, headMoved } from "./errors";
import { commitRestore, documentHistory, readRevision, restorePathProblem, type HistoryEntry, type HistoryPage } from "./history";
import { threeWayMerge, type MergeHook, type MergeOutcome } from "./merge";
import { Bindings, hasBase, liveHere, type BindingChange, type LocalMove } from "./bindings";
import { PathClaims, type CopyNaming, type Exempt } from "./claims";
import { PathSpace } from "./pathspace";
import { movedBeforeDelete, ruleW } from "./decide";
import { Intents } from "./intents";
import { busyClaims, planPush, type Busy, type DirtyPaths } from "./push-plan";
import { baseContent, classifyByExtension, downloadContent, kindValue, RemoteContentError, toIncoming, type IncomingRevision, type PullApi } from "./remote";
import { uploadContent } from "./upload";

export interface SyncEngineOptions {
  /** The vault to sync. Plaintext vaults only until end-to-end encryption exists (SPEC.md §9.3). */
  vaultId: string;
  /** This install's registered device, recorded with every commit (SPEC.md §6.2). */
  deviceId: string;
  api: PullApi;
  vault: VaultAdapter;
  journal: Journal;
  /**
   * The device's name as the user knows it, used in the names of conflict
   * copies (SPEC.md §7). Defaults to `deviceId`.
   */
  deviceName?: string;
  /** Receives remote revisions that would overwrite unsynced local content. Defaults to threeWayMerge (SPEC.md §7). */
  merge?: MergeHook;
  /**
   * Called, in order, for every vault change that is not an echo of the
   * engine's own writes (SPEC.md §8): the user's edits, which the engine pushes.
   */
  onLocalChange?: (event: VaultEvent) => void;
  /** ListChanges page size; the server caps it (SPEC.md §6.1). */
  pageSize?: number;
  /**
   * How long after the last local change of a burst the engine pushes on its
   * own, in milliseconds. Every change restarts the wait, and the push reads
   * the disk when it runs, so a burst of edits becomes one revision holding
   * the last of them. null turns automatic pushes off (call push()).
   * Defaults to 2000.
   */
  pushDebounceMs?: number | null;
  /** Receives the error of an automatic push. Its operations stay pending and are retried by the next push. */
  onPushError?: (error: unknown) => void;
  /** Receives the summary of an automatic push that succeeded. */
  onPushComplete?: (summary: PushSummary) => void;
  /**
   * Called with true when a pull or push is queued while none is queued or
   * running, and with false once the last one has settled (just before its
   * caller sees the outcome), so a status display can show sync in progress.
   */
  onBusyChange?: (busy: boolean) => void;
  /** Called for every revision of this device the server acknowledged (SPEC.md §6.2). */
  onAcknowledged?: (revision: RemoteRevision) => void;
  /** The kind of a new document, by path (SPEC.md §7). Defaults to classifyByExtension. */
  classify?: (path: string) => DocumentKindName;
  /** Generates document and revision ids. Defaults to random UUIDv7s. */
  newId?: () => string;
  /** The clock for conflict-copy names and the conflict log. Defaults to the system clock. */
  now?: () => Date;
  /**
   * The local platform's file-name rules (SPEC.md §8). A remote document
   * whose path they forbid is tracked as unmaterializable instead of being
   * written, and conflict copies get names they allow. Under `windows` and
   * `macos` rules the vault is taken to match paths ignoring case and Unicode
   * form, as those filesystems do. Defaults to POSIX rules.
   */
  pathRules?: PathRules;
  /** Called whenever a remote revision is tracked as unmaterializable (SPEC.md §8): what the UI shows. */
  onUnmaterializable?: (document: UnmaterializableDocument) => void;
  /**
   * How long the engine waits after the server refused a call with
   * RESOURCE_EXHAUSTED (its per-user limits, SPEC.md §12) before its next
   * pull or push calls the server: backoffDelay of the consecutive refusals,
   * reset by a pull or push that succeeds. Defaults to defaultRateLimitBackoff.
   */
  rateLimitBackoff?: Backoff;
  /** The timers of that wait. Defaults to the global ones. */
  timers?: Timers;
  /**
   * The largest remote content, in bytes, the engine downloads (SPEC.md §8):
   * a revision whose content is larger is deferred as `too-large`, never
   * downloaded, and listed by tooLarge(). Defaults to defaultMaxDownloadBytes.
   */
  maxDownloadBytes?: number;
  /** Uniform in [0, 1); spreads the waits of a user's devices out. Defaults to Math.random. */
  random?: () => number;
}

/** The engine's wait after RESOURCE_EXHAUSTED: 0.5 to 1 s after the first refusal, doubling up to 30 to 60 s. */
export const defaultRateLimitBackoff: Readonly<Backoff> = { initialMs: 1000, maxMs: 60_000 };

/** The engine's download cap unless SyncEngineOptions.maxDownloadBytes sets one: 1 GiB. */
export const defaultMaxDownloadBytes = 1024 * 1024 * 1024;

/**
 * A document whose binding (design §4.1) disagrees with the ownership the
 * engine derives today (SyncEngine.bindingShadow, refactor step R4).
 */
export interface BindingDivergence {
  documentId: string;
  /** The binding's spelling; null for none, undefined if the row records no binding. */
  binding: string | null | undefined;
  /** Why the document has no binding, if it has none. */
  absence: Absence | null | undefined;
  /** The file the engine's derived ownership takes to be the document's, or null for none. */
  derived: string | null;
}

/**
 * A document whose remote revision is larger than the engine's download cap
 * (SPEC.md §8): deferred, never downloaded, and never dropped. A later
 * revision within the cap applies it. Until then its local changes are not
 * pushed.
 */
export interface TooLargeDocument {
  documentId: string;
  /** The path the server has for the document. */
  path: string;
  /** The revision's content size in bytes. */
  size: bigint;
  /** The remote revision that was not downloaded. */
  revision: RemoteRevision;
  /** Where the document's earlier version stays on disk, if this device had one. */
  localPath: string | undefined;
}

/** What a pull or push waiting out a RESOURCE_EXHAUSTED backoff rejects with when the engine is disposed. */
export class EngineDisposedError extends Error {
  override readonly name = "EngineDisposedError";
  constructor() {
    super("the sync engine was disposed");
  }
}

/**
 * A document the local platform cannot hold at the path the server has for
 * it (SPEC.md §8, platform path rules). It is tracked, never dropped, and
 * never renamed on the server: a later remote revision with a path the
 * platform can hold (or a delete) materializes it. Until then its local
 * changes are not pushed.
 */
export interface UnmaterializableDocument {
  documentId: string;
  /** The path the server has for the document. */
  path: string;
  reason: UnmaterializableCause;
  /** The remote revision that could not be written. */
  revision: RemoteRevision;
  /** Where the document's earlier version stays on disk, if this device had one. */
  localPath: string | undefined;
}

export interface PullSummary {
  /** The journal cursor after the pull. */
  cursor: bigint;
  /** Remote revisions written to (or already reflected on) disk. */
  applied: number;
  /** Remote revisions recorded as pending in the journal instead of applied. */
  deferred: number;
  /** Remote revisions the merge hook merged with local changes. */
  merged: number;
  /** Whether the server's history had diverged from the cursor and a resync ran. */
  resynced: boolean;
}

/**
 * Why a local operation cannot be synced (#100): a rule of the server's that
 * its path breaks, found before anything is sent (SPEC.md §6.2); `path-taken`
 * when another document holds its path and no conflict-copy name fits the
 * path limits or the server refused the name it was moved to (§6.3); or
 * `refused` when the server refused it as invalid for a reason the engine did
 * not foresee (the error says which).
 */
export type RejectedReason = PathProblem | "path-taken" | "refused";

/**
 * A local operation the server refuses for good. It stays pending in the
 * journal and its file where it is, and every push reports it again (sending
 * nothing for a refused path) until the user renames or removes the file.
 */
export interface RejectedOperation {
  operation: PendingOperation;
  reason: RejectedReason;
  error: ConnectError;
}

export interface PushSummary {
  /** Revisions of this device the server acknowledged. */
  committed: number;
  /** Commits refused because the document's head had moved or another document held its path; each pulled and went to the merge path. */
  conflicts: number;
  /** Local operations still waiting in the journal after the push. */
  pending: number;
  /** Operations refused for good. */
  rejected: RejectedOperation[];
}

/** What the disk shows for a document, relative to its base and a remote revision. */
type Inspection =
  /** The disk already shows the remote revision (e.g. an apply interrupted after its disk step). */
  | { kind: "applied" }
  /** The disk shows the synced base; `source` is the document's file to move or replace, if any. */
  | { kind: "clean"; source: string | undefined; sourceHash: string | undefined }
  /** Applying would overwrite or lose local content. */
  | { kind: "dirty"; path: string; content: Uint8Array | null };

/**
 * The document's local version for the merge path: its own file (design
 * §4.5 step 4), or, with `absent`, none because the user deleted it, so
 * the file at `path` (if any) is not the document's.
 */
interface LocalVersion {
  path: string;
  content: Uint8Array | null;
  absent?: boolean;
}

type ApplyOutcome = "applied" | "deferred" | "merged" | "skipped";

const defaultPageSize = 500;
const defaultPushDebounceMs = 2000;
/** Rounds of one push: a merge or a superseded upload leaves changes the next round pushes. */
const maxPushRounds = 4;
/** Attempts of one CommitRevision within a push after transient failures (UNAVAILABLE, DEADLINE_EXCEEDED). */
const maxCommitAttempts = 3;
/** Numbered conflict-copy names tried before giving up on finding a free one. */
const maxConflictNameAttempts = 100;

/**
 * The platform-independent sync engine (SPEC.md §4). It pulls the change feed
 * from the journal's cursor and applies it to the vault without ever
 * overwriting unsynced local edits (§6.1, §8), and pushes local changes with
 * optimistic concurrency (§6.2).
 *
 * Every step is resumable from the journal. A pulled revision's disk changes
 * are made first, then its journal state, then the cursor, and each disk
 * check compares content hashes (never mtimes), so a revision interrupted at
 * any point is recognized and finished when it is pulled again. A local change
 * is recorded as a pending operation, with its revision id, before anything is
 * sent; it is retried with identical fields until the commit is acknowledged,
 * and only then removed (§8).
 */
export class SyncEngine {
  private readonly vaultId: string;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly api: PullApi;
  private readonly vault: VaultAdapter;
  private readonly journal: Journal;
  private readonly merge: MergeHook;
  private readonly onLocalChange: (event: VaultEvent) => void;
  private readonly pageSize: number;
  private readonly pushDebounceMs: number | null;
  private readonly onPushError: (error: unknown) => void;
  private readonly onPushComplete: (summary: PushSummary) => void;
  private readonly onBusyChange: (busy: boolean) => void;
  /** Pulls and pushes queued or running. */
  private queued = 0;
  private readonly onAcknowledged: (revision: RemoteRevision) => void;
  private readonly classify: (path: string) => DocumentKindName;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly pathRules: PathRules;
  private readonly onUnmaterializable: (document: UnmaterializableDocument) => void;
  private readonly maxDownloadBytes: bigint;
  /** How paths compare: server keys, file keys, filesystem names and folders. */
  private readonly pathSpace: PathSpace;
  /** Which local file is each document (design §4.1). The local moves and deletes the push and the merge path look at are read from it. */
  private readonly bindings: Bindings;
  private readonly echoes = new EchoSuppressor();
  /** Revisions deferred for a refused path that retryRefusedPaths already tried again. */
  private readonly retried = new Set<string>();
  /** Documents being merged right now, so rule W's resolving a holder first (W(b)) never loops back to another. */
  private readonly resolving = new Set<string>();
  /** The displace and detach intents of rule W (design §4.4). */
  private readonly intents: Intents;
  private readonly unsubscribe: () => void;
  private events: Promise<void> = Promise.resolve();
  /** Pulls and pushes, one at a time. */
  private work: Promise<unknown> = Promise.resolve();
  /**
   * Changed paths not yet looked at by a push, each with the clock value of
   * its last change. Events are lost when the app dies, so the first push
   * scans everything (`all`). A path leaves only once a push round has
   * decided it, unchanged since: one that waits for a busy document (an
   * outbox, the merge path) stays for every later push (#167), and a
   * round that fails leaves them all.
   */
  private readonly dirty = { all: true, paths: new Map<string, number>() };
  private dirtyClock = 0;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly rateLimitBackoff: Backoff;
  private readonly timers: Timers;
  private readonly random: () => number;
  /** Consecutive pulls and pushes the server refused with RESOURCE_EXHAUSTED. */
  private throttled = 0;
  /** The running RESOURCE_EXHAUSTED backoff: the next pull or push waits for `over` before it calls the server. */
  private backoff: { timer: unknown; over: Promise<void>; abandon: () => void } | undefined;

  constructor(options: SyncEngineOptions) {
    this.vaultId = options.vaultId;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName ?? options.deviceId;
    this.api = options.api;
    this.vault = options.vault;
    this.journal = options.journal;
    this.merge = options.merge ?? threeWayMerge;
    this.onLocalChange = options.onLocalChange ?? (() => undefined);
    this.pageSize = options.pageSize ?? defaultPageSize;
    this.pushDebounceMs = options.pushDebounceMs === undefined ? defaultPushDebounceMs : options.pushDebounceMs;
    this.onPushError =
      options.onPushError ??
      ((error) => {
        setTimeout(() => {
          throw error;
        });
      });
    this.onPushComplete = options.onPushComplete ?? (() => undefined);
    this.onBusyChange = options.onBusyChange ?? (() => undefined);
    this.onAcknowledged = options.onAcknowledged ?? (() => undefined);
    this.classify = options.classify ?? classifyByExtension;
    this.newId = options.newId ?? (() => uuidv7());
    this.now = options.now ?? (() => new Date());
    this.pathRules = options.pathRules ?? posixPathRules;
    this.onUnmaterializable = options.onUnmaterializable ?? (() => undefined);
    this.maxDownloadBytes = BigInt(options.maxDownloadBytes ?? defaultMaxDownloadBytes);
    this.pathSpace = new PathSpace(this.pathRules);
    this.bindings = new Bindings(this.journal, this.vault, this.pathSpace);
    this.intents = new Intents({
      journal: this.journal,
      bindings: this.bindings,
      space: this.pathSpace,
      read: (path) => this.readOrNull(path),
      rename: async (from, to) => this.echoed(this.echoes.expectRename(await this.heldSpelling(from), to), () => this.vault.rename(from, to)),
      newId: this.newId,
      markDirty: (path) => {
        this.markDirty(path);
      },
    });
    this.rateLimitBackoff = options.rateLimitBackoff ?? defaultRateLimitBackoff;
    this.timers = options.timers ?? globalTimers;
    this.random = options.random ?? Math.random;
    this.unsubscribe = this.vault.watch((event) => {
      // Whether the start-up scan may have read the disk after this event (Bindings.renamed).
      const duringScan = this.bindings.scanning;
      this.events = this.events.then(() => this.handleEvent(event, duringScan));
      // A failed transition rejects every later push (pushOnce awaits the
      // chain); the chain itself is handled here, so it is no unhandled rejection.
      this.events.catch(() => undefined);
    });
  }

  /** Stops watching the vault and cancels a scheduled push; a pull or push waiting out a backoff rejects with EngineDisposedError. */
  dispose(): void {
    this.disposed = true;
    this.cancelScheduledPush();
    this.backoff?.abandon();
    this.unsubscribe();
  }

  /**
   * Resolves once every vault event received so far has been classified (and
   * reported if it is a local change), and every pull and push started so far
   * has finished.
   */
  async settled(): Promise<void> {
    // After a failed transition the chain stays rejected; settling only waits for it.
    await this.events.catch(() => undefined);
    await this.work;
    await this.bindings.idle();
  }

  /**
   * Pulls and applies every remote change since the cursor. Pulls and pushes
   * run one after another. Rejects if a call fails; the cursor then stands at
   * the last revision that was fully applied, and the next pull resumes there.
   */
  pull(): Promise<PullSummary> {
    return this.serialize(() => this.pullOnce());
  }

  /**
   * Pulls only if the durable cursor is below `seq`, the seq a realtime
   * notification announced (SPEC.md §6.4); resolves with undefined, having
   * called the server for nothing, if it is not. The cursor is checked before
   * the pull is queued, so a device that is caught up (its own commit's
   * notification, say) never becomes busy, and again once the pull's turn
   * comes, so a notification that arrived before its commit's response was
   * handled finds the cursor the push advanced.
   */
  async pullIfBehind(seq: bigint): Promise<PullSummary | undefined> {
    if ((await this.journal.getCursor()) >= seq) return undefined;
    return this.serialize(async () => ((await this.journal.getCursor()) >= seq ? undefined : this.pullOnce()));
  }

  /**
   * Pushes every local change (SPEC.md §6.2). It pulls first, so the bases are
   * fresh and interrupted applies are finished, then resumes the journal's
   * pending operations with their original revision ids, then records and
   * commits an operation for each changed file. When a commit finds the head
   * moved, it pulls, which hands the document to the merge hook, and pushes
   * the merge result against the new head.
   *
   * Rejects on a failed call (a network failure, for example); what was not
   * acknowledged stays pending in the journal and is retried, with the same
   * revision ids, by the next push.
   */
  push(): Promise<PushSummary> {
    this.cancelScheduledPush();
    return this.serialize(() => this.pushOnce());
  }

  /** The documents the local platform cannot hold at their server paths (SPEC.md §8), for the UI. */
  async unmaterializable(): Promise<UnmaterializableDocument[]> {
    const documents: UnmaterializableDocument[] = [];
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason === "unmaterializable") documents.push(await this.unmaterializableDocument(deferred.revision, deferred.unmaterializable ?? "refused-by-vault"));
    }
    return documents;
  }

  /** The documents whose remote revision is larger than the download cap (SPEC.md §8), for the UI. */
  async tooLarge(): Promise<TooLargeDocument[]> {
    const documents: TooLargeDocument[] = [];
    for (const { revision, reason } of await this.journal.listDeferred()) {
      if (reason !== "too-large") continue;
      const localPath = await this.keptFile(await this.journal.getDocument(revision.documentId));
      documents.push({ documentId: revision.documentId, path: revision.path, size: revision.size, revision, localPath });
    }
    return documents;
  }

  /** One page of a document's retained history, newest first, with each revision's time and device (SPEC.md §11). */
  history(documentId: string, pageToken = ""): Promise<HistoryPage> {
    return documentHistory(this.api, this.vaultId, this.deviceId, documentId, pageToken);
  }

  /** A history entry's content, for a preview; with `limit`, at most its first `limit` bytes, unverified when cut (#656). */
  readRevision(entry: HistoryEntry, limit?: number): Promise<Uint8Array> {
    return readRevision(this.api, this.vaultId, entry, limit);
  }

  /**
   * Restores `entry`: commits its content as a new head revision of its
   * document, at the document's current path, bringing a deleted document
   * back (SPEC.md §11). It runs between pulls and pushes. It pushes first,
   * so local edits not yet pushed are in the document's history rather than
   * overwritten, and pulls afterwards, so the disk shows the restored
   * content. Pass the content of a preview as `content`: if garbage
   * collection removed the revision's blob since, it is uploaded again.
   * Rejects with RestoreError when the restore cannot be done (nothing is
   * committed then). Pass `path` to restore the document there instead of
   * at its current path, when another document took that (#420).
   */
  restore(entry: HistoryEntry, content?: Uint8Array, path?: string): Promise<RemoteRevision> {
    const invalid = path === undefined ? undefined : restorePathProblem(path, this.pathRules, (candidate) => this.inScope(candidate));
    if (invalid !== undefined) return Promise.reject(invalid);
    this.cancelScheduledPush();
    return this.serialize(async () => {
      await this.pushOnce();
      const restored = await commitRestore(this.api, this.vaultId, this.deviceId, entry, this.newId(), content, path);
      await this.pullOnce();
      return restored;
    });
  }

  /**
   * The documents deleted on the server that this device knows of, most
   * recently deleted first: what the user can find and restore (SPEC.md
   * §11). One being brought back by a local change still to be pushed is not
   * listed. A document whose file this device released (§8) is live, not
   * deleted (design §6.4 item 5).
   */
  async deletedDocuments(): Promise<DocumentState[]> {
    const pending = new Set((await this.journal.listPending()).map((operation) => operation.documentId));
    return (await this.journal.listDocuments())
      .filter((state) => state.deleted && hasBase(state) && !pending.has(state.documentId))
      .sort((left, right) => (left.seq > right.seq ? -1 : left.seq < right.seq ? 1 : 0));
  }

  private async unmaterializableDocument(revision: RemoteRevision, reason: UnmaterializableCause): Promise<UnmaterializableDocument> {
    const localPath = await this.keptFile(await this.journal.getDocument(revision.documentId));
    return { documentId: revision.documentId, path: revision.path, reason, revision, localPath };
  }

  /** The file a document keeps on this device while its remote revision waits: its bound file, if the vault has it. */
  private async keptFile(state: DocumentState | undefined): Promise<string | undefined> {
    const spelling = state?.binding?.spelling;
    if (state === undefined || state.deleted || spelling === undefined || !this.inScope(spelling)) return undefined;
    return (await this.vault.stat(spelling)) !== null ? spelling : undefined;
  }

  /**
   * Tracks `remote` as unmaterializable: deferred, with nothing written, and
   * reported. Recorded before the document's file is looked at
   * (leaveBlockedFile), so the deferral, which blocks the document, is there
   * first.
   */
  private async deferUnmaterializable(remote: RemoteRevision, reason: UnmaterializableCause): Promise<"deferred"> {
    await this.journal.putDeferred({ revision: remote, reason: "unmaterializable", unmaterializable: reason });
    await this.leaveBlockedFile(remote.documentId);
    const document = await this.unmaterializableDocument(remote, reason);
    try {
      this.onUnmaterializable(document);
    } catch (error) {
      setTimeout(() => {
        throw error;
      });
    }
    return "deferred";
  }

  /**
   * The local file of a document whose remote revision is unmaterializable
   * (design §4.5 step 2, PO-11). A blocker never claims a path on disk, and
   * the document keeps its file, with its local changes, as long as no
   * server claim needs the path (rule W detaches it once one does). Only an
   * unchanged file at its synced path, with no outbox, goes: the server has
   * its content, and the document's newest server claim is elsewhere
   * (SPEC.md §8). The delete expects the synced content, so a file saved
   * since stays (#163). Removed, or already gone, the file is given up
   * (`absence = released`): the document materializes later as a new
   * document would. A document whose file the user moved keeps it (#690).
   */
  private async leaveBlockedFile(documentId: string): Promise<void> {
    const state = await this.journal.getDocument(documentId);
    if (!liveHere(state) || (await this.journal.listPending()).some((operation) => operation.documentId === documentId)) return;
    const binding = state.binding;
    if (binding !== null && binding !== undefined) {
      if (binding.spelling !== state.path) return;
      const content = await this.readOrNull(binding.spelling);
      if (content !== null) {
        if (sha256Hex(content) !== state.baseHash) return;
        try {
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(binding.spelling)), () => this.vault.delete(binding.spelling, { expectedHash: state.baseHash }));
        } catch (error) {
          // Saved locally since the check (#163): a local edit, so the file stays, as above.
          if (isVaultError(error, "changed")) return;
          throw error;
        }
      }
    }
    await this.putDocument(state, { kind: "released" });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    if (this.queued++ === 0) this.onBusyChange(true);
    const run = this.work.then(() => this.throttle(task)).finally(() => {
      if (--this.queued === 0) this.onBusyChange(false);
    });
    this.work = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs `task` once a RESOURCE_EXHAUSTED backoff is over. If the server
   * refuses one of its calls with RESOURCE_EXHAUSTED, a backoff starts. The
   * server refuses such a call before doing anything (SPEC.md §12), and what
   * was not acknowledged stays pending in the journal, so the next pull or
   * push only waits before it tries again. A pull or push that succeeds
   * resets the backoff's doubling.
   */
  private async throttle<T>(task: () => Promise<T>): Promise<T> {
    if (this.backoff !== undefined) await this.backoff.over;
    try {
      const result = await task();
      this.throttled = 0;
      return result;
    } catch (error) {
      if (errorCode(error) === Code.ResourceExhausted) this.startBackoff();
      throw error;
    }
  }

  /** Starts the next backoff. Once it is over the engine pushes, if it pushes on its own and no pull or push is queued. */
  private startBackoff(): void {
    if (this.disposed) return;
    this.throttled++;
    const delay = backoffDelay(this.throttled, this.rateLimitBackoff, this.random());
    let end: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const over = new Promise<void>((resolve, reject) => {
      end = resolve;
      fail = reject;
    });
    // Rejected only by dispose(), for a task that waits on it.
    over.catch(() => undefined);
    const backoff = {
      over,
      timer: this.timers.setTimeout(() => {
        if (this.backoff === backoff) this.backoff = undefined;
        end();
        if (this.queued === 0 && this.pushDebounceMs !== null && !this.disposed) this.automaticPush();
      }, delay),
      abandon: () => {
        this.timers.clearTimeout(backoff.timer);
        if (this.backoff === backoff) this.backoff = undefined;
        fail(new EngineDisposedError());
      },
    };
    this.backoff = backoff;
  }

  private async pullOnce(): Promise<PullSummary> {
    // Rule W's moves a crash interrupted are finished first (design §4.4).
    await this.intents.recover();
    const summary: PullSummary = { cursor: await this.journal.getCursor(), applied: 0, deferred: 0, merged: 0, resynced: false };
    let anchor = summary.cursor > 0n ? await this.journal.getCursorAnchor() : undefined;
    const own = await this.ownCommitAbove(summary.cursor);
    for (;;) {
      // This device's latest acknowledged commit above the cursor, which the
      // cursor's anchor does not cover (SPEC.md §6.1, #494), until the pull
      // passes it.
      const ownCommit = own !== undefined && own.seq > summary.cursor ? own : undefined;
      const response = await this.api.sync.listChanges({
        vaultId: this.vaultId,
        sinceSeq: summary.cursor,
        sinceAnchor: anchor ?? new Uint8Array(),
        ownCommitSeq: ownCommit?.seq ?? 0n,
        ownCommitAnchor: ownCommit?.anchor ?? new Uint8Array(),
        pageSize: this.pageSize,
      });
      if (response.diverged || response.headSeq < summary.cursor) {
        // The server lost history this device already applied (e.g. a
        // database restore): it no longer holds the revision this device
        // applied at the cursor or its own commit above it (their anchors
        // differ, SPEC.md §6.1), or its head fell below the cursor. That is
        // divergence, not "nothing new".
        await this.resync(summary);
        return summary;
      }
      for (const revision of response.revisions) {
        if (revision.seq <= summary.cursor) {
          throw new RemoteContentError(`change feed went from seq ${String(summary.cursor)} back to ${String(revision.seq)}`);
        }
        this.count(summary, await this.applyRevision(toIncoming(revision)));
        anchor = cursorAnchor(revision);
        await this.journal.setCursor(revision.seq, anchor);
        summary.cursor = revision.seq;
      }
      if (!response.hasMore) return summary;
      if (response.revisions.length === 0) throw new RemoteContentError("change feed page claims more revisions but has none");
    }
  }

  /**
   * The seq and anchor of this device's latest acknowledged commit above
   * `cursor`, if the journal has its anchor. Only a device's own commit is
   * recorded above the cursor (a pull moves the cursor onto what it
   * applies, and a resync renumbers below the cursor it sets).
   */
  private async ownCommitAbove(cursor: bigint): Promise<{ seq: bigint; anchor: Uint8Array } | undefined> {
    let latest: { seq: bigint; anchor: Uint8Array } | undefined;
    for (const state of await this.journal.listDocuments()) {
      if (state.anchor === undefined || state.seq <= cursor || (latest !== undefined && state.seq <= latest.seq)) continue;
      latest = { seq: state.seq, anchor: state.anchor };
    }
    return latest;
  }

  private count(summary: PullSummary, outcome: ApplyOutcome): void {
    if (outcome === "applied") summary.applied++;
    if (outcome === "deferred") summary.deferred++;
    if (outcome === "merged") summary.merged++;
  }

  /**
   * Applies one remote revision, or defers it. Idempotent: a revision whose
   * apply was interrupted at any step is finished, not repeated.
   */
  private async applyRevision(incoming: IncomingRevision): Promise<ApplyOutcome> {
    const { remote } = incoming;
    const state = await this.journal.getDocument(remote.documentId);
    const pending = (await this.journal.listPending()).filter((operation) => operation.documentId === remote.documentId);
    if (pending.some((operation) => operation.revisionId === remote.revisionId)) {
      // This device's own commit, whose response was lost. The disk already
      // holds it, or a newer local edit, which the next push sends on top.
      if (state?.revisionId !== remote.revisionId) await this.putDocument(syncedState(remote), { kind: "acknowledged", hash: remote.contentHash });
      await this.removeOperation(remote.revisionId);
      // Changes left for after the operation (a newer edit, a rename that
      // waited for it) are pushed now, as after an acknowledged commit.
      this.markDirty(remote.path);
      this.schedulePush();
      return "applied";
    }
    const rebased = (operation: PendingOperation) => operation.baseRevisionId === "" || operation.baseRevisionId === remote.revisionId;
    if ((state === undefined || !hasBase(state)) && !remote.deleted && remote.parentRevisionId === "" && pending.length > 0 && pending.every(rebased)) {
      // This device's own create, which it moved on (to a path-taken copy,
      // #286) before learning that the commit had landed: document ids are
      // this device's own. The moved create becomes the document's next
      // revision, a rename, on top of it; then the document is taken as
      // created. Interrupted in between, the pull finds it here again.
      for (const operation of pending) {
        if (operation.baseRevisionId !== "") continue;
        await this.journal.addPending({ ...operation, revisionId: this.newId(), baseRevisionId: remote.revisionId });
        await this.removeOperation(operation.revisionId);
      }
      await this.putDocument(syncedState(remote), { kind: "acknowledged", hash: remote.contentHash });
      for (const operation of pending) this.markDirty(operation.path);
      this.schedulePush();
      return "applied";
    }
    const deferred = await this.journal.getDeferred(remote.documentId);
    if (state?.revisionId === remote.revisionId) {
      // Applied before an interruption that came before its deferral was
      // removed. A merge of this very revision interrupted after its rebase
      // is finished too: its result is on disk as an ordinary local edit
      // (applyMerge), and kept, the deferral would wait for good once another
      // document takes the path (#453).
      const finished = deferred?.reason === "local-changes" ? deferred.revision.revisionId === remote.revisionId : deferred !== undefined && deferred.revision.seq <= remote.seq;
      if (finished) await this.journal.removeDeferred(remote.documentId);
      return "skipped";
    }
    if (this.outOfScope(remote, state)) {
      // Not this device's to sync now (e.g. a config file with config sync
      // off): nothing touches the disk, and the revision waits for an engine
      // start that finds it in scope (retryRefusedPaths).
      if (state !== undefined && remote.seq <= state.seq) return "skipped";
      if (deferred !== undefined && remote.seq < deferred.revision.seq) return "skipped";
      return this.defer(remote, !remote.deleted && !incoming.pathAllowed ? "invalid-path" : "out-of-scope");
    }
    if (this.overCap(remote)) {
      // Never downloaded, so never allocated (#316): nothing touches the
      // disk, the cursor moves on, and a later revision within the cap
      // applies the document.
      if (state !== undefined && remote.seq <= state.seq) return "skipped";
      if (deferred !== undefined && remote.seq < deferred.revision.seq) return "skipped";
      // A merge result written for the revision deferred before is finished
      // first: the deferral that records it is about to be replaced.
      if (deferred?.merging !== undefined) await this.resumeMerge(deferred.revision, state, deferred.merging);
      return this.defer(remote, "too-large");
    }
    if (deferred?.reason === "local-changes" || pending.length > 0) {
      return this.handToMerge(remote, state, await this.localFile(state, remote));
    }
    if (state !== undefined && remote.seq <= state.seq) return "skipped";
    // A resync found the server had lost this document (seq 0): the content
    // here may exist nowhere else, so a new revision is merged, not applied.
    if (state !== undefined && state.seq === 0n && liveHere(state)) return this.handToMerge(remote, state, await this.localFile(state, remote));
    if (!remote.deleted && !incoming.pathAllowed) return this.defer(remote, "invalid-path");
    const unmaterializable = remote.deleted ? undefined : unmaterializableReason(remote.path, this.pathRules);
    if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);

    // The path claim (design §4.5 step 3): another document's file in the
    // way of the revision's path moves by rule W, or the revision waits for
    // it, listed. Not for a document whose file a local move put elsewhere:
    // its local rename wins, so the merge path decides where its result
    // lands, and claims that path (applyMerge, #473).
    if (!remote.deleted && !movedLocally(state) && (await this.claimPath(remote.path, remote.documentId))) return this.defer(remote, "path-conflict");

    // Download before looking at the disk, so the check-then-write window is short.
    const needsContent = !remote.deleted && (!liveHere(state) || state.baseHash !== remote.contentHash);
    const content = needsContent ? await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size) : undefined;

    const inspection = await this.inspect(state, remote);
    if (inspection.kind === "dirty") return this.handToMerge(remote, state, inspection);
    try {
      if (inspection.kind === "clean") await this.writeToDisk(remote, inspection, content);
      else if (!remote.deleted) await this.matchSpelling(remote.path, remote.documentId);
    } catch (error) {
      if (isVaultError(error, "path-conflict") || isVaultError(error, "already-exists")) return this.defer(remote, "path-conflict");
      if (isVaultError(error, "unmaterializable")) return this.deferUnmaterializable(remote, "refused-by-vault");
      if (isVaultError(error, "changed") && inspection.kind === "clean") {
        // Saved locally after inspect() checked it (Obsidian's autosave,
        // say; #163): a local change, so the merge path gets what is there now.
        const path = remote.deleted ? (inspection.source ?? remote.path) : remote.path;
        return this.handToMerge(remote, state, { path, content: await this.readOrNull(path) });
      }
      throw error;
    }
    if (inspection.kind === "applied" && !remote.deleted) {
      // The file is taken for the document as it is: a local create that put
      // identical content there (on a case-insensitive platform, possibly
      // under another spelling) is superseded. Left pending, it would later
      // claim this document's file and move it away under its own id (#242).
      // Dropped before the journal update: interrupted in between, the pull
      // applies the revision again and finds the file applied.
      await this.dropCreatesAt(remote.path);
    }
    // A newer revision supersedes one deferred for its path (or this is the
    // deferred one, applied by a retry after the cursor passed it). Removed
    // after the journal update: interrupted in between, the revision is found
    // applied and its deferral removed then, so it is never dropped unapplied.
    const before = remote.deleted ? await this.journal.getDocument(remote.documentId) : undefined;
    await this.putDocument(syncedState(remote), { kind: "applied" });
    // A local rename of the deleted document is a rename of nothing now.
    this.forgetRenamesFrom(before);
    if (deferred !== undefined) await this.journal.removeDeferred(remote.documentId);
    return "applied";
  }

  /**
   * The path claim of design §4.5 step 3, for `path`, which the server gives
   * `documentId`: rule W (decide.ts, ruleW; PO-4) for every other known
   * document whose file is in the way (PathClaims.fileHolders: one file
   * key, folders included), and for every document the server lost whose
   * synced path collides with it under the server's key. A document moved
   * aside keeps its bytes, under its own id (displace) or as an untracked
   * copy (detach); no file is ever deleted to free a path. Returns true if
   * the path stays another document's (W(c)), or no copy name fits: the
   * revision then waits, listed as `path-conflict`.
   *
   * A create not acknowledged yet holds its file as an untracked file does:
   * the merge path keeps it as a conflict copy, or takes it if its content
   * is the revision's (dropCreatesAt).
   */
  private async claimPath(path: string, documentId: string): Promise<boolean> {
    const resolved = new Set<string>();
    // Each turn moves one holder away, or resolves one once.
    for (let turn = 0; turn < 16; turn++) {
      const holder = await this.nextHolder(path, documentId);
      if (holder === undefined) {
        await this.dropStaleOutboxes(path, documentId);
        return false;
      }
      const { state, spelling } = holder;
      const ahead = await this.journal.getDeferred(state.documentId);
      const outbox = (await this.journal.listPending()).filter((operation) => operation.documentId === state.documentId);
      const move = ruleW(state, ahead, outbox, path, this.pathSpace);
      if (move === "keep") return true;
      if (move === "resolve") {
        // W(b): the holder's own remote revision first, which may move its
        // file away. If the merge path cannot finish it now (the hook
        // deferred, or it is being merged further up), the holder keeps the
        // path and this revision waits, listed: the merge is retried on
        // every push, and detaching would cut the holder's local edit off
        // its history (design §4.5, as amended in R7b).
        if (ahead === undefined || resolved.has(state.documentId) || this.resolving.has(state.documentId)) return true;
        resolved.add(state.documentId);
        await this.handToMerge(ahead.revision, state, await this.localFile(state, ahead.revision));
        continue;
      }
      if (spelling === undefined) {
        // The server lost it and this device holds no file of it: nothing is left of it.
        await this.bindings.transact(async () => ({
          removeDocuments: [state.documentId],
          removeDeferred: [state.documentId],
          removePending: (await this.journal.listPending()).filter((operation) => operation.documentId === state.documentId).map((operation) => operation.revisionId),
        }));
        continue;
      }
      // A document the server lost keeps its file where it is if that is not in the way.
      const inTheWay = move !== "recreate" || this.pathSpace.collides(spelling, path, "server") || this.pathSpace.collides(spelling, path, "file");
      const keeps = move === "displace" || move === "recreate";
      let copy: string | null = spelling;
      if (inTheWay) {
        // The copy name stays clear of the path too, which the journal does not hold yet.
        const claims = (await PathClaims.load(this.pathSpace, this.journal, this.vault)).with([{ kind: "server-newer", path, documentId }]);
        copy = await claims.freeCopyName(spelling, this.copyNaming(), { documentId: keeps ? state.documentId : "", file: spelling, result: null });
      }
      if (copy === null) return true;
      const record = this.conflictRecord(state.documentId, spelling, "path-taken", copy, "", "");
      const moved = keeps ? await this.intents.displace(state.documentId, spelling, copy, record, move === "recreate") : await this.intents.detach(state.documentId, spelling, copy, record);
      if (!moved) return true;
      this.schedulePush();
    }
    return true;
  }

  /**
   * C3 once no file holds `path`: another known document's live outbox at
   * `path` (under the server's key) would be refused for sure, the server
   * having given the path to `documentId`. Its file is gone or elsewhere
   * (rule W moved every file holder away), so the outbox is stale: a commit
   * the server refused before the user deleted or moved the file (#398). It
   * goes, and the push derives the document's next operation from its
   * binding (design §4.1, R5b).
   */
  private async dropStaleOutboxes(path: string, documentId: string): Promise<void> {
    const key = this.pathSpace.fileKey(path);
    await this.bindings.transact(async () => {
      const stale = (await this.journal.listPending()).filter((operation) => operation.documentId !== documentId && operation.baseRevisionId !== "" && !operation.deleted && this.pathSpace.fileKey(operation.path) === key);
      for (const operation of stale) {
        const binding = (await this.journal.getDocument(operation.documentId))?.binding;
        if (binding !== undefined && binding !== null) this.markDirty(binding.spelling);
      }
      return stale.length === 0 ? undefined : { removePending: stale.map((operation) => operation.revisionId) };
    });
  }

  /**
   * The next document rule W looks at for `path` (design §4.2, fileHolder):
   * a document other than `documentId` bound to a file in the way (one
   * file key, folders included), with the spelling it is bound at; or
   * a document the server lost (seq 0 after a resync) whose synced path
   * collides with `path` under the server's key, with its file if it has
   * one.
   */
  private async nextHolder(path: string, documentId: string): Promise<{ state: DocumentState; spelling: string | undefined } | undefined> {
    const documents = await this.journal.listDocuments();
    // A create not acknowledged yet holds its file as an untracked file does
    // (the merge path keeps it as a conflict copy, or takes it if its
    // content is the revision's, dropCreatesAt), unless a local rename moved
    // it: that is a local move of a document, as a known one's is (#286).
    const created = new Map<string, string>();
    for (const operation of await this.journal.listPending()) if (operation.baseRevisionId === "" && !operation.deleted) created.set(operation.documentId, operation.path);
    for (const state of documents) {
      const binding = state.binding;
      if (state.documentId === documentId || binding === undefined || binding === null || !this.pathSpace.collides(binding.spelling, path, "file")) continue;
      if (!hasBase(state) && created.get(state.documentId) === binding.spelling) continue;
      if ((await this.vault.stat(binding.spelling)) === null) continue;
      return { state, spelling: binding.spelling };
    }
    for (const state of documents) {
      if (state.documentId === documentId || !hasBase(state) || state.deleted || state.seq !== 0n || !this.pathSpace.collides(state.path, path, "server")) continue;
      const spelling = state.binding?.spelling;
      return { state, spelling: spelling !== undefined && (await this.vault.stat(spelling)) !== null ? spelling : undefined };
    }
    return undefined;
  }

  /** Classifies the disk by content hash against the base (`state`) and the remote revision. */
  private async inspect(state: DocumentState | undefined, remote: RemoteRevision): Promise<Inspection> {
    const inspection = await this.inspectPaths(state, remote);
    // The file the revision would replace, move or delete is the document's
    // own: the one its binding names, or, for a document whose file the user
    // deleted, an untracked one (a crash may have hidden the engine's own
    // move of it, which the disk shows). A file another document's binding
    // names (one a local rename brought to this document's synced path after
    // its file moved away) is never this revision's to replace or delete;
    // the merge path takes the document's own file (localVersion).
    if (inspection.kind === "clean" && inspection.source !== undefined && liveHere(state)) {
      const binding = state.binding;
      const owner = await this.journal.documentByFileKey(this.pathSpace.filesystemKey(inspection.source));
      const another = owner !== undefined && owner.documentId !== state.documentId;
      const elsewhere = binding !== undefined && binding !== null && this.pathSpace.fileKey(binding.spelling) !== this.pathSpace.fileKey(inspection.source);
      if (another || elsewhere) return { kind: "dirty", path: inspection.source, content: await this.readOrNull(inspection.source) };
    }
    return inspection;
  }

  /** inspect's classification by the paths the base and the revision name. */
  private async inspectPaths(state: DocumentState | undefined, remote: RemoteRevision): Promise<Inspection> {
    const basePath = liveHere(state) ? state.path : undefined;
    const baseContent = basePath === undefined ? null : await this.readOrNull(basePath);
    const baseHash = state?.baseHash;
    const baseOnDisk = baseContent !== null && sha256Hex(baseContent) === baseHash;

    if (remote.deleted) {
      // A local rename not pushed yet wins over the remote delete (PO-9).
      const moved = movedBeforeDelete(state, remote);
      if (moved !== undefined) {
        const content = await this.readOrNull(moved);
        if (content !== null) return { kind: "dirty", path: moved, content };
      }
      // Nothing there: the engine already deleted it, or the user deleted it too. Both agree.
      if (basePath === undefined || baseContent === null) return { kind: "applied" };
      // The user deleted its file, and another document's binding holds the
      // file there now (a local rename onto the path, #267): nothing of this
      // document is left to delete.
      if (state !== undefined && this.userDeleted(state)) {
        const holder = await this.journal.documentByFileKey(this.pathSpace.filesystemKey(basePath));
        if (holder !== undefined && holder.documentId !== state.documentId) return { kind: "applied" };
      }
      if (baseOnDisk) return { kind: "clean", source: basePath, sourceHash: baseHash };
      return { kind: "dirty", path: basePath, content: baseContent };
    }

    const target = remote.path;
    const targetContent = target === basePath ? baseContent : await this.readOrNull(target);
    const targetHash = targetContent === null ? null : sha256Hex(targetContent);

    if (basePath === undefined) {
      // A new document here (or a deleted one coming back).
      if (targetContent === null) return { kind: "clean", source: undefined, sourceHash: undefined };
      if (targetHash === remote.contentHash) return { kind: "applied" };
      return { kind: "dirty", path: target, content: targetContent };
    }
    // The same file, also when only its spelling changes on a case-insensitive
    // platform, but only if the vault holds the two spellings as one file:
    // on NTFS or APFS `straße/` and `STRASSE/` are two folders, so that is a
    // rename, and an edit at the synced path is the note's (#447).
    if (await this.heldAsOne(basePath, target)) {
      if (targetHash === remote.contentHash) return { kind: "applied" };
      if (baseOnDisk) return { kind: "clean", source: basePath, sourceHash: baseHash };
      // Edited, or deleted or moved away locally (content null): a local
      // change either way. A file gone is looked for from the synced path,
      // where a local rename took it from: a remote rename into a folder of
      // another spelling (`NOTES/` for `notes/`) never hides the user's
      // rename, which wins (SPEC.md §7, #375).
      return { kind: "dirty", path: targetContent === null ? basePath : target, content: targetContent };
    }
    // A rename, possibly with an edit.
    if (baseContent === null) {
      // The engine moved the file before an interruption, or the user moved or deleted it.
      if (targetHash === remote.contentHash) return { kind: "applied" };
      if (targetHash === baseHash) return { kind: "clean", source: target, sourceHash: baseHash };
      return { kind: "dirty", path: basePath, content: null };
    }
    if (!baseOnDisk) return { kind: "dirty", path: basePath, content: baseContent };
    if (targetContent === null) return { kind: "clean", source: basePath, sourceHash: baseHash };
    // Another file holds the target path. It is not this document's (that is
    // at basePath), so the merge path gets this document's own file, and
    // applyMerge decides about the file in the way.
    return { kind: "dirty", path: basePath, content: baseContent };
  }

  /**
   * Makes the disk show `remote`, given a clean inspection. Every change is
   * registered for echo suppression first. The write or delete names the
   * content the inspection found, so the vault refuses it with "changed" if
   * the file was saved since (SPEC.md §8).
   */
  private async writeToDisk(remote: RemoteRevision, inspection: Extract<Inspection, { kind: "clean" }>, content: Uint8Array | undefined): Promise<void> {
    const { source } = inspection;
    const expectedHash = inspection.sourceHash ?? null;
    if (remote.deleted) {
      if (source === undefined) return;
      if (expectedHash === null) throw new Error(`no base hash for ${source}`);
      await this.echoed(this.echoes.expectDelete(await this.heldSpelling(source)), () => this.deleteFile(source, { expectedHash }));
      return;
    }
    if (source !== undefined && source !== remote.path) {
      await this.echoed(this.echoes.expectRename(await this.heldSpelling(source), remote.path), () => this.renameFile(source, remote.path));
    }
    if (inspection.sourceHash === remote.contentHash) return;
    if (content === undefined) throw new Error(`content of ${remote.revisionId} was not downloaded`);
    await this.matchSpelling(remote.path, remote.documentId);
    await this.echoed(this.echoes.expectWrite(await this.heldSpelling(remote.path), remote.contentHash), () => this.vault.write(remote.path, content, { expectedHash }));
  }

  /**
   * On a case-insensitive platform, renames the file the vault holds as
   * `path` under another spelling (`Notes.md` for `notes.md`) to `path`, so
   * the vault names it as the journal does. A write would otherwise keep the
   * old spelling, and the file would look like another document's.
   *
   * A spelling the user gave the document's file (a case-only rename not
   * yet pushed, or one a pending operation of the document commits) is
   * kept: undone here, the push would still commit it, and the vault would
   * never match the server (#304).
   */
  private async matchSpelling(path: string, documentId: string): Promise<void> {
    if (this.pathRules.platform === "posix" || (await this.vault.stat(path)) === null) return;
    const key = this.pathSpace.fileKey(path);
    const actual = (await this.vault.list()).find((candidate) => candidate !== path && this.pathSpace.fileKey(candidate) === key);
    if (actual === undefined || (await this.localSpelling(actual, documentId))) return;
    await this.echoed(this.echoes.expectRename(actual, path), () => this.renameFile(actual, path));
  }

  /** Whether a local rename of `documentId` not yet pushed, or a pending operation of it, put its file at exactly `path`. */
  private async localSpelling(path: string, documentId: string): Promise<boolean> {
    for (const move of await this.localRenames()) {
      if (move.to === path && move.documentId === documentId && !move.created) return true;
    }
    return (await this.journal.listPending()).some((operation) => operation.documentId === documentId && operation.path === path && !operation.deleted);
  }

  /**
   * The spelling the vault holds the file at `path` under, for an echo
   * expectation of a change the engine is about to make there (SPEC.md §8):
   * `path` itself if the vault lists it, otherwise the one listed spelling
   * the vault takes as the same file, otherwise `path`. The expectation then
   * matches events exactly, so a user's change of another file whose spelling
   * merely has the same path key is never taken for the engine's (#380).
   */
  private async heldSpelling(path: string): Promise<string> {
    if (this.pathRules.platform === "posix") return path;
    const listed = await this.vault.list();
    if (listed.includes(path)) return path;
    const key = this.pathSpace.fileKey(path);
    const candidates = listed.filter((candidate) => this.pathSpace.fileKey(candidate) === key);
    return candidates.length === 1 ? (candidates[0] ?? path) : path;
  }

  private async echoed(cancel: () => void, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      cancel();
      throw error;
    }
  }

  private async handToMerge(remote: RemoteRevision, state: DocumentState | undefined, found: { path: string; content: Uint8Array | null }): Promise<"deferred" | "merged"> {
    this.resolving.add(remote.documentId);
    try {
      return await this.mergeRevision(remote, state, found);
    } finally {
      this.resolving.delete(remote.documentId);
    }
  }

  private async mergeRevision(remote: RemoteRevision, state: DocumentState | undefined, found: { path: string; content: Uint8Array | null }): Promise<"deferred" | "merged"> {
    const deferred = await this.journal.getDeferred(remote.documentId);
    // A merge of the previous revision that was interrupted after its result
    // reached the disk is finished first, so this revision is merged against
    // that result on its own base, not the older one.
    if (deferred?.merging !== undefined && deferred.revision.revisionId !== remote.revisionId && remote.parentRevisionId === deferred.revision.revisionId) {
      if (await this.resumeMerge(deferred.revision, state, deferred.merging)) {
        state = await this.journal.getDocument(remote.documentId);
        found = await this.localFile(state, remote);
      }
    }
    const local = await this.localVersion(state, found);
    // A merge of this revision that was interrupted after its result reached
    // the disk is finished as it was, without asking the hook again.
    if (deferred?.revision.revisionId === remote.revisionId && deferred.merging !== undefined && (await this.resumeMerge(remote, state, deferred.merging))) return "merged";
    const outcome = await this.merge({
      remote,
      base: state,
      local: { path: local.path, content: local.content },
      readRemoteContent: () => (remote.deleted ? Promise.resolve(null) : downloadContent(this.api, this.vaultId, remote.contentHash, remote.size)),
      // A tombstone has no content of its own to merge against, nor has a
      // document whose file this device released, and a base retention
      // purged has none any more (SPEC.md §11): never a reason to stop the
      // pull.
      readBaseContent: () => (!liveHere(state) ? Promise.resolve(null) : baseContent(this.api, this.vaultId, state.revisionId)),
    });
    if (outcome.status === "merged" && outcome.content !== null) {
      // The result cannot be written here: the remote path never touches the
      // disk, and the local changes stay as they are until a later revision
      // gives the document a path the platform can hold.
      if (outcome.path === remote.path && !isVaultRelativePath(outcome.path)) return this.defer(remote, "invalid-path");
      const unmaterializable = unmaterializableReason(outcome.path, this.pathRules);
      if (unmaterializable !== undefined && outcome.path !== remote.path && liveHere(state) && state.binding?.spelling === local.path && local.path === outcome.path) {
        // The result keeps a local rename to a path this platform cannot
        // hold (the vault took the file there, the rules forbid it): a
        // blocker that would hold the document for good. Its file is
        // detached where it is, a new document's (design §6.4 item 3), and
        // the revision is merged again without it, at the server's path.
        const record = this.conflictRecord(state.documentId, local.path, "path-taken", local.path, "", remote.revisionId);
        if (await this.intents.detach(state.documentId, local.path, local.path, record)) {
          this.schedulePush();
          const detached = await this.journal.getDocument(remote.documentId);
          return this.mergeRevision(remote, detached, await this.localFile(detached, remote));
        }
      }
      if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);
    }
    try {
      const applied = outcome.status === "merged" ? await this.applyMerge(remote, state, local, outcome) : false;
      // Rule W left the result's path another document's (W(c)): the revision waits, listed.
      if (applied === "held") return await this.defer(remote, "path-conflict");
      if (applied) return "merged";
    } catch (error) {
      if (isVaultError(error, "unmaterializable")) return this.deferUnmaterializable(remote, "refused-by-vault");
      throw error;
    }
    return this.defer(remote, "local-changes");
  }

  /** Finishes a recorded merge of `remote` if the disk already shows its result. */
  private async resumeMerge(remote: RemoteRevision, state: DocumentState | undefined, merging: { path: string; contentHash: string | null }): Promise<boolean> {
    const there = await this.readOrNull(merging.path);
    if ((there === null ? null : sha256Hex(there)) !== merging.contentHash) return false;
    const resumed = { path: merging.path, content: there };
    return (await this.applyMerge(remote, state, resumed, { status: "merged", ...resumed })) === true;
  }

  /**
   * The document's local version for the merge path (design §4.5 step 4):
   * its own file, the one its binding names (a local rename moved it there,
   * the user's spelling included), or none if the user deleted it. A
   * document with no file of its own here (a new one, a tombstone, one whose
   * file the engine released) has the file `found` at the remote path, if
   * any: an untracked file, since rule W moved every other document's away.
   */
  private async localVersion(state: DocumentState | undefined, found: { path: string; content: Uint8Array | null }): Promise<LocalVersion> {
    if (!liveHere(state)) return found;
    // The binding as it is now: the engine's own rename of the file (a
    // clean apply interrupted by a save) moved it since `state` was read.
    const binding = (await this.journal.getDocument(state.documentId))?.binding ?? state.binding;
    if (binding === undefined) return this.followRename(state, found);
    if (binding === null) {
      // The user deleted its file, or a crash hid the engine's own move of
      // it (a merge result recorded on its deferral, found where the record
      // says). A file another document's binding names is that document's
      // (a local rename brought it there, #473); an untracked one is taken
      // as the document's local version (R7c decides it from the binding
      // alone, R8 from the merge intent).
      const followed = await this.followRename(state, found);
      const owner = followed.content === null ? undefined : await this.journal.documentByFileKey(this.pathSpace.filesystemKey(followed.path));
      if (followed.content === null || (owner !== undefined && owner.documentId !== state.documentId)) return { path: state.path, content: null, absent: true };
      return followed;
    }
    return { path: binding.spelling, content: await this.readOrNull(binding.spelling) };
  }

  /**
   * Looks again at the file a local rename not pushed yet moved the
   * document's file to (its binding in `before`, the state the engine just
   * replaced), once the document has no live state any more (#486): the
   * write unbound it (a tombstone applied, a release), so that file is no
   * document's and is pushed as it is (a create, if a file is there). Kept
   * as the document's, the next push would take a document a later pull
   * brings to its old path for the moved one and rename it, with the moved
   * file's content.
   */
  private forgetRenamesFrom(before: DocumentState | undefined): void {
    const spelling = before?.binding?.spelling;
    if (before === undefined || spelling === undefined || spelling === before.path) return;
    this.markDirty(spelling);
  }

  /**
   * The known document other than `documentId` that a local move put at
   * `path`, and the path it put it at: one with a pending operation there, or
   * a local rename there not yet pushed. Paths are compared as the vault
   * compares them, so on a case-insensitive platform a move to `Notes/C.md`
   * is found at `notes/c.md` (#242). A document the journal has at `path` is
   * not a move, and while it stays there, the file is its own; once a local
   * move took it away from `path` (a pending operation elsewhere, or a local
   * rename not yet pushed), or the user deleted its file (#254), another
   * document's move there is found (#267).
   */
  private async localMoveAt(path: string, documentId: string): Promise<{ documentId: string; path: string } | undefined> {
    const key = this.pathSpace.fileKey(path);
    const synced = await this.documentAt(path);
    if (synced !== undefined && !(await this.movedAway(synced))) return undefined;
    for (const operation of await this.journal.listPending()) {
      if (this.pathSpace.fileKey(operation.path) === key && !operation.deleted && operation.documentId !== documentId && (await this.known(operation.documentId))) {
        return { documentId: operation.documentId, path: operation.path };
      }
    }
    // A local rename moved a known document's file there, or a create's
    // whose commit is not acknowledged yet (#286): its binding says so.
    for (const move of await this.localRenames()) {
      if (this.pathSpace.fileKey(move.to) === key && move.documentId !== documentId) return { documentId: move.documentId, path: move.to };
    }
    return undefined;
  }

  /** Whether the journal has a server revision of the document (not only the row of a create not acknowledged yet). */
  private async known(documentId: string): Promise<boolean> {
    const state = await this.journal.getDocument(documentId);
    return state !== undefined && hasBase(state);
  }

  /**
   * Whether a local move took the document away from its synced path: it
   * has a pending operation at another path, or a local rename from that
   * path not yet pushed, or the user deleted its file since the last push.
   * Paths are compared as the vault compares them.
   */
  private async movedAway(state: DocumentState): Promise<boolean> {
    // The user deleted its file: a file at its path since then is another one (#254).
    if (this.userDeleted(state)) return true;
    const key = this.pathSpace.fileKey(state.path);
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId === state.documentId && !operation.deleted && this.pathSpace.fileKey(operation.path) !== key) return true;
    }
    for (const move of await this.localRenames()) {
      if (move.documentId === state.documentId && this.pathSpace.fileKey(move.to) !== key) return true;
      // Another file renamed onto its path, and still there (its binding
      // says so): its own file was gone by then (#526).
      if (move.documentId !== state.documentId && this.pathSpace.fileKey(move.to) === key && this.renamedOnto(move.to, move.from)) return true;
    }
    return false;
  }

  /**
   * Whether a local rename from `from` brought another file to `to`. The
   * vault refuses a rename onto an existing file, so whatever file was at
   * `to` before was gone by then. A rename to another spelling of the same
   * path (a case-only rename on a case-insensitive platform) moved the file
   * that was there, so it tells nothing of another file.
   */
  private renamedOnto(to: string, from: string): boolean {
    return this.pathSpace.fileKey(from) !== this.pathSpace.fileKey(to);
  }

  /** The local renames not pushed yet: the documents bound elsewhere than their synced path (Bindings.moves). */
  private localRenames(): Promise<LocalMove[]> {
    return this.bindings.moves();
  }

  /** Whether the user deleted the document's file (E3) and nothing bound it again since: a file at its path now is another one (#254). */
  private userDeleted(state: DocumentState): boolean {
    return !state.deleted && state.binding === null && state.absence === "user-deleted";
  }

  /**
   * The live document whose file the vault holds at `path`, compared as the
   * vault compares paths (its own spelling first). A document at another
   * spelling with the same file key is not found if the filesystem holds the
   * two spellings as two files (decision #52, #399): with `bySpelling`, when
   * the filesystem does not fold one into the other (for a vault event, which
   * may arrive after later changes are on disk); otherwise, when the vault
   * lists both now.
   */
  private async documentAt(path: string, bySpelling = false): Promise<DocumentState | undefined> {
    const exact = await this.journal.findDocumentByPath(path);
    if (exact !== undefined || this.pathRules.platform === "posix") return exact;
    const key = this.pathSpace.fileKey(path);
    const state = (await this.journal.listDocuments()).find((candidate) => !candidate.deleted && this.pathSpace.fileKey(candidate.path) === key);
    if (state === undefined || this.pathSpace.oneFile(state.path, path)) return state;
    if (bySpelling || (await this.heldApart(state.path, path))) return undefined;
    return state;
  }

  /**
   * Whether the vault holds `a` and `b`, two spellings with one file key, as
   * two files: it lists both. Path keys fold `ß`/`SS`, and NFC/NFD on
   * Windows, which the filesystem does not (decision #52).
   */
  private async heldApart(a: string, b: string, listed?: ReadonlySet<string>): Promise<boolean> {
    if (this.pathSpace.oneFile(a, b)) return false;
    const files = listed ?? new Set(await this.vault.list());
    return files.has(a) && files.has(b);
  }

  /**
   * Whether `a` and `b` name one file the vault holds now: the same file by
   * their spellings, or two spellings with one path key of which the vault
   * lists one and finds a file at the other too (it folds them as path keys
   * do). On NTFS or APFS the other spelling of `straße/b.md`, `STRASSE/b.md`,
   * is another file or none (decision #52, #447). For the engine's own
   * changes, which look at the vault as they act.
   */
  private async heldAsOne(a: string, b: string): Promise<boolean> {
    if (this.pathSpace.fileKey(a) !== this.pathSpace.fileKey(b)) return false;
    if (this.pathSpace.oneFile(a, b)) return true;
    const listed = new Set(await this.vault.list());
    if (listed.has(a) === listed.has(b)) return false;
    return (await this.vault.stat(listed.has(a) ? b : a)) !== null;
  }

  /**
   * Makes the disk show a merge result and rebases the document onto the
   * remote revision, so that the next push commits the result with the remote
   * revision as its base (SPEC.md §6.2 step 3). Returns false, writing
   * nothing, if the local file no longer holds what the merge hook was given
   * (the user changed it meanwhile), if it or the file at the result's new
   * path belongs to another document, or if a conflict copy has no name that
   * fits the path limits; and false, keeping whatever it already wrote, if the
   * vault refuses a path. A file at the result's new path that is no
   * document's is first kept as a conflict copy and removed.
   *
   * Crash-safe, journal before act, whether the merge came from a pull or a
   * push: a file in the way at the result's new path is cleared (logged and
   * copied first, as below), so a file found there after a crash is this
   * document's; then the result's path and hash are recorded on the document's
   * deferral; then a conflict, if any, is recorded in the conflict log and its
   * copy written; then the result is written; then the superseded pending
   * operations are dropped, the base moves to the remote revision, and the
   * deferral is removed. Until the base moves, the remote revision counts as
   * unapplied: a pull does not advance the cursor past it before this returns,
   * and the deferral keeps it with the merge path, so the next pull or push
   * hands it to handToMerge again. That finishes the merge from the record if
   * the disk already shows the result, and otherwise asks the hook again,
   * which reuses the logged copy's name. Interrupted after the rebase, the
   * result is an ordinary local edit on top of the remote revision, and a
   * conflict copy an ordinary new file, and both are pushed as such.
   */
  private async applyMerge(remote: RemoteRevision, state: DocumentState | undefined, local: LocalVersion, outcome: Extract<MergeOutcome, { status: "merged" }>): Promise<boolean | "held"> {
    if (outcome.content !== null && !isVaultRelativePath(outcome.path)) throw new Error(`the merge hook returned a path that is not vault-relative: ${outcome.path}`);
    // The document's own file, as the merge hook was given it. A document
    // whose file the user deleted has none: a file at `local.path` now is
    // another one, never this merge's to replace or move.
    const current = local.absent === true ? null : await this.readOrNull(local.path);
    if (!sameContent(current, local.content)) return false;
    const copyPaths: string[] = [];
    // A result path that is the document's own file under another spelling
    // (a remote case-only rename on a case-insensitive platform) is no file
    // in the way: the vault holds one file there, the document's, which the
    // rename below respells (#343). Only if the vault holds the two as one:
    // on NTFS or APFS a file at `STRASSE/b.md` is another one than
    // `straße/b.md`, so it is in the way (#447).
    const respelled = outcome.content !== null && current !== null && outcome.path !== local.path && (await this.heldAsOne(outcome.path, local.path));
    // The document's own file, which the result moves away from (or
    // deletes), and its synced path, where the result does not go: neither
    // takes a name from a conflict copy (#319, #299).
    const merged: Exempt = {
      documentId: remote.documentId,
      file: current !== null && (outcome.content === null || outcome.path !== local.path) ? local.path : undefined,
      result: outcome.content === null ? null : outcome.path,
    };
    try {
      if (outcome.content !== null && !respelled) {
        // The path claim where the result lands (design §4.5 step 3, PO-4):
        // another document's file in the way moves by rule W, or the result
        // waits. Never at a path the result leaves (#473).
        if (await this.claimPath(outcome.path, remote.documentId)) return "held";
      }
      // A file in the way at the result's new path is no document's now: it
      // was created here concurrently with the remote document's move there,
      // so the remote document takes the path and the file is kept as a
      // conflict copy. Cleared before the merge is recorded, so a file at the
      // recorded path is always this document's.
      if (outcome.content !== null && (current === null || outcome.path !== local.path) && !respelled) {
        const occupant = await this.readOrNull(outcome.path);
        if (occupant !== null && !sameContent(occupant, outcome.content)) {
          const copyPath = await this.writeConflictCopy(remote, outcome.path, { reason: "concurrent-create", content: occupant }, merged);
          if (copyPath === null) return false;
          copyPaths.push(copyPath);
          this.markDirty(copyPath);
          await this.renameFollowsCopy(outcome.path, copyPath);
          // The copy now holds the file's content, so its unacknowledged
          // operations (a create not yet committed) are superseded. They go
          // before the file does, so none is ever left pointing at the merged
          // document's file.
          await this.dropOperationsAt(outcome.path, remote.documentId);
          if (!sameContent(await this.readOrNull(outcome.path), occupant)) return false;
          const expectedHash = sha256Hex(occupant);
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(outcome.path)), () => this.deleteFile(outcome.path, { expectedHash }));
        }
      }
      await this.journal.putDeferred({
        revision: remote,
        reason: "local-changes",
        merging: { path: outcome.path, contentHash: outcome.content === null ? null : sha256Hex(outcome.content) },
      });
      if (outcome.conflict !== undefined) {
        const copyPath = await this.writeConflictCopy(remote, local.path, outcome.conflict, merged);
        if (copyPath === null) return false;
        copyPaths.push(copyPath);
        // A local file at the remote path that is no document's own (this
        // device has no live state for the merged document) moves to the copy.
        if (!liveHere(state)) await this.renameFollowsCopy(local.path, copyPath);
      }
      if (outcome.content === null) {
        if (current !== null) {
          const expectedHash = sha256Hex(current);
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(local.path)), () => this.deleteFile(local.path, { expectedHash }));
        }
      } else {
        let there = outcome.path === local.path && current !== null ? current : await this.readOrNull(outcome.path);
        if (outcome.path !== local.path && current !== null) {
          if (there !== null && !respelled) return false;
          await this.echoed(this.echoes.expectRename(await this.heldSpelling(local.path), outcome.path), () => this.renameFile(local.path, outcome.path));
          there = current;
        }
        const merged = outcome.content;
        const hash = sha256Hex(merged);
        await this.matchSpelling(outcome.path, remote.documentId);
        if (there === null || sha256Hex(there) !== hash) {
          const expectedHash = there === null ? null : sha256Hex(there);
          await this.echoed(this.echoes.expectWrite(await this.heldSpelling(outcome.path), hash), () => this.vault.write(outcome.path, merged, { expectedHash }));
        }
      }
    } catch (error) {
      // "changed": the user saved a file after it was read here (#163); the
      // next merge attempt starts from what they saved.
      if (isVaultError(error, "path-conflict") || isVaultError(error, "already-exists") || isVaultError(error, "changed")) return false;
      throw error;
    }
    // The document's unacknowledged operations are superseded: their commits
    // were refused (the head had moved past their base), and their content is
    // part of the merge result on disk or of the conflict copy. So are those
    // of a local file that stood at the remote revision's path without being
    // this document's (a local create the remote one collided with), whose
    // content the result or the copy now holds. They go before the rebase, so
    // a document never has the remote revision as its base while an operation
    // based on an older head is still pending.
    const ownFile = liveHere(state);
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId === remote.documentId) await this.removeOperation(operation.revisionId);
    }
    if (!ownFile) await this.dropOperationsAt(local.path, remote.documentId);
    const before = remote.deleted && ownFile ? await this.journal.getDocument(remote.documentId) : undefined;
    // A local rename the merge kept is pushed as a rename of the document:
    // its binding is at the result's path, its base at the remote path.
    await this.putDocument(syncedState(remote), { kind: "merged", path: outcome.path, hash: outcome.content === null ? null : sha256Hex(outcome.content) });
    // A local rename of the deleted document is a rename of nothing now: the
    // file it moved, if kept, is pushed as a new document.
    if (outcome.content === null || outcome.path !== before?.binding?.spelling) this.forgetRenamesFrom(before);
    await this.journal.removeDeferred(remote.documentId);
    this.markDirty(local.path);
    this.markDirty(outcome.path);
    for (const copyPath of copyPaths) this.markDirty(copyPath);
    // A merge made by a pull is pushed like a local edit.
    this.schedulePush();
    return true;
  }

  /**
   * Moves a local rename not yet pushed that brought a file to `path` on to
   * `copyPath`, where a merge just kept that file as a conflict copy (#479).
   * The file is no live document's: a local rename of a document deleted on
   * the server, say, whose rename stays recorded. Left pointing at `path`,
   * the record would take the merged document's file written there for the
   * renamed one, so a later local rename of that file would be pushed as a
   * delete of the merged document plus a create (SPEC.md §2 principle 1).
   * Compared as the vault compares paths.
   */
  private async renameFollowsCopy(path: string, copyPath: string): Promise<void> {
    const key = this.pathSpace.fileKey(path);
    for (const move of await this.localRenames()) {
      // The copy holds the file's content now: the document it is keeps it there.
      if (this.pathSpace.fileKey(move.to) === key) await this.bindings.renamed(move.to, copyPath);
    }
  }

  /**
   * Drops the unacknowledged operations of other documents that put a file at
   * `path`, compared as the vault compares paths (one at `Notes/C.md` put the
   * file at `notes/c.md` on a case-insensitive platform, #242); deletes stay.
   */
  private async dropOperationsAt(path: string, documentId: string): Promise<void> {
    const key = this.pathSpace.fileKey(path);
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId !== documentId && this.pathSpace.fileKey(operation.path) === key && !operation.deleted) await this.removeOperation(operation.revisionId);
    }
  }

  /**
   * Drops the unacknowledged creates (operations of documents the journal
   * has no live state for) that put a file at `path`, compared as the vault
   * compares paths. A known document's operations stay: its file is never
   * another document's (see localMoveAt).
   *
   * The known-document guard has nothing left to decide: another known
   * document at the path (one the journal has live there, or one a local
   * move put there, also after the revision's own document moved away from
   * it) hands the revision, a new document's (#264) or a known one's (#267),
   * to the merge path before it gets here, so every operation left at the
   * path is a create.
   */
  private async dropCreatesAt(path: string): Promise<void> {
    const key = this.pathSpace.fileKey(path);
    for (const operation of await this.journal.listPending()) {
      if (operation.deleted || this.pathSpace.fileKey(operation.path) !== key) continue;
      const state = await this.journal.getDocument(operation.documentId);
      if (state === undefined || state.deleted) {
        await this.removeOperation(operation.revisionId);
        this.markDirty(operation.path);
      }
    }
  }

  /**
   * Keeps the local version of a conflict as a copy next to `localPath`
   * (SPEC.md §7). The conflict is logged first, so a copy interrupted by a
   * crash is finished under the same name rather than written twice. Returns
   * the copy's path, or null if no name fits the path limits: the conflict is
   * then logged without a copy and nothing is written, so the local version
   * stays where it is. `merged` is the document the merge rebases
   * (PathClaims.freeCopyName's `exempt`).
   */
  private async writeConflictCopy(remote: RemoteRevision, localPath: string, conflict: { reason: ConflictReason; content: Uint8Array }, merged?: Exempt): Promise<string | null> {
    const hash = sha256Hex(conflict.content);
    // A `path-taken` record names where the document's own file moved
    // (moveAside, moveToConflictPath), never a copy: reused, the copy would
    // be the document's own file, which the merge result then overwrites,
    // and the local version would be lost (#462).
    const logged = (await this.journal.listConflicts()).filter((record) => record.documentId === remote.documentId && record.copyHash === hash && record.reason !== "path-taken");
    let copyPath: string | null = null;
    for (const record of logged) {
      if (record.copyPath === null) continue;
      const there = await this.readOrNull(record.copyPath);
      if (there === null || sha256Hex(there) === hash) {
        copyPath = record.copyPath;
        break;
      }
    }
    if (copyPath === null) {
      copyPath = await this.freeCopyName(localPath, merged);
      const unresolved = copyPath === null && logged.some((record) => record.copyPath === null && record.remoteRevisionId === remote.revisionId);
      if (!unresolved) {
        await this.journal.putConflict(this.conflictRecord(remote.documentId, remote.path, conflict.reason, copyPath, hash, remote.revisionId));
      }
      if (copyPath === null) return null;
    }
    const there = await this.readOrNull(copyPath);
    if (there === null || sha256Hex(there) !== hash) {
      const target = copyPath;
      // Only where no file is: one saved there meanwhile is the user's, and
      // the vault refuses the write ("changed").
      await this.echoed(this.echoes.expectWrite(target, hash), () => this.vault.write(target, conflict.content, { expectedHash: null }));
    }
    return copyPath;
  }

  private conflictRecord(documentId: string, path: string, reason: ConflictReason, copyPath: string | null, copyHash: string, remoteRevisionId: string): ConflictRecord {
    return { id: this.newId(), documentId, path, reason, copyPath, copyHash, remoteRevisionId, at: this.now().getTime() };
  }

  /** The first free conflict-copy name for `path` (PathClaims.freeCopyName, PO-14). */
  private async freeCopyName(path: string, exempt?: Exempt): Promise<string | null> {
    const claims = await PathClaims.load(this.pathSpace, this.journal, this.vault);
    return claims.freeCopyName(path, this.copyNaming(), exempt);
  }

  /** How this engine names conflict copies (SPEC.md §7). */
  private copyNaming(): CopyNaming {
    return { deviceName: this.deviceName, date: this.now(), rules: this.pathRules, maxAttempts: maxConflictNameAttempts };
  }

  /** Whether `remote` has content larger than the download cap. */
  private overCap(remote: RemoteRevision): boolean {
    return !remote.deleted && remote.size > this.maxDownloadBytes;
  }

  private async defer(remote: RemoteRevision, reason: DeferReason): Promise<"deferred"> {
    await this.journal.putDeferred({ revision: remote, reason });
    return "deferred";
  }

  /** The document's local file: its synced path if it has one, else the remote revision's path. */
  private async localFile(state: DocumentState | undefined, remote: RemoteRevision): Promise<{ path: string; content: Uint8Array | null }> {
    const path = state !== undefined && !state.deleted ? state.path : remote.path;
    return { path, content: await this.readOrNull(path) };
  }

  /**
   * Where the document's file went if it was moved from its synced path: the
   * path of a pending rename, or of a rename event not yet pushed, if a file
   * is there. A file at the synced path is then another one, created after the
   * move, unless it still holds the synced content. Otherwise `local` as it is
   * (the document's file, or a local delete).
   */
  private async followRename(state: DocumentState | undefined, local: { path: string; content: Uint8Array | null }): Promise<{ path: string; content: Uint8Array | null }> {
    if (state === undefined || state.deleted || local.path !== state.path) return local;
    if (local.content !== null) {
      // On a case-insensitive platform the file at the synced path may be
      // the document's own under the spelling a local case-only rename gave
      // it: the rename is the user's, so the merge keeps it (#304).
      const actual = await this.fileAt(state.path);
      if (actual !== undefined && actual !== state.path && (await this.localSpelling(actual, state.documentId))) return { path: actual, content: local.content };
      if (sha256Hex(local.content) === state.baseHash) return local;
    }
    const merging = (await this.journal.getDeferred(state.documentId))?.merging;
    const pending = (await this.journal.listPending()).filter((operation) => operation.documentId === state.documentId && !operation.deleted && operation.path !== state.path);
    const candidates = [
      // An interrupted merge that moved the file there. Only if no file is
      // at the synced path: the merge is recorded before the file moves, so
      // a file still there means the move never happened, and a file at the
      // recorded path is another one, created since.
      ...(local.content === null && merging !== undefined && merging.contentHash !== null && merging.path !== state.path ? [merging.path] : []),
      ...pending.map((operation) => operation.path).reverse(),
      ...(await this.localRenames()).filter((move) => move.documentId === state.documentId).map((move) => move.to),
    ];
    for (const path of candidates) {
      const content = await this.readOrNull(path);
      if (content === null) continue;
      // A file the journal has as another live document's, which no local
      // move took away, is that document's: on a case-insensitive platform
      // one created at the rename's target in another case after the user
      // deleted the renamed file (#323).
      const holder = await this.documentAt(path);
      if (holder !== undefined && holder.documentId !== state.documentId && !(await this.movedAway(holder))) continue;
      return { path, content };
    }
    return local;
  }

  /**
   * Reconciles with a server whose history no longer contains the cursor.
   * Scans the whole feed for each document's head, applies heads of documents
   * this device does not know, and hands every document the journal knows at
   * another revision to the merge path, since the server may have lost
   * acknowledged revisions that only this device still has. Only then is the
   * cursor reset to the server's head, so an interrupted resync runs again.
   *
   * A retention purge leaves a purge marker that the server's anchor checks
   * accept (SPEC.md §6.1, §11), so divergence means a restore, and nothing
   * known is applied over without a merge (#488). A server without purge
   * markers also reports a purge as divergence; merging then keeps an
   * unchanged note another device deleted (#480) rather than risk deleting
   * content the server lost.
   */
  private async resync(summary: PullSummary): Promise<void> {
    summary.resynced = true;
    const heads = new Map<string, IncomingRevision>();
    let seq = 0n;
    let anchor: Uint8Array | undefined;
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: seq, pageSize: this.pageSize });
      for (const revision of response.revisions) {
        if (revision.seq <= seq) throw new RemoteContentError(`change feed went from seq ${String(seq)} back to ${String(revision.seq)}`);
        heads.set(revision.documentId, toIncoming(revision));
        seq = revision.seq;
        anchor = cursorAnchor(revision);
      }
      if (!response.hasMore) break;
      if (response.revisions.length === 0) throw new RemoteContentError("change feed page claims more revisions but has none");
    }
    // A document the restored server lacks keeps the old server's seq, under
    // which the restored server's own revisions of it would look applied:
    // seq 0 is no revision of this server (see applyRevision). Marked before
    // the heads are applied: the server has no claim of its own for such a
    // document, so a head at its path takes the path (claimPath).
    for (const state of await this.journal.listDocuments()) {
      if (!heads.has(state.documentId) && state.seq !== 0n) await this.putDocument({ ...state, seq: 0n }, { kind: "kept" });
    }
    const ordered = [...heads.values()].sort((left, right) => (left.remote.seq < right.remote.seq ? -1 : 1));
    for (const incoming of ordered) {
      const { remote } = incoming;
      const state = await this.journal.getDocument(remote.documentId);
      if (state === undefined || !hasBase(state)) {
        this.count(summary, await this.applyRevision(incoming));
      } else if (state.revisionId === remote.revisionId) {
        // Same revision; renumber it, as the restored server's seq values may differ.
        if (state.seq !== remote.seq) await this.putDocument({ ...state, seq: remote.seq }, { kind: "kept" });
      } else if (this.outOfScope(remote, state)) {
        this.count(summary, await this.defer(remote, "out-of-scope"));
      } else if (this.overCap(remote)) {
        this.count(summary, await this.defer(remote, "too-large"));
      } else {
        const local = await this.localFile(state, remote);
        this.count(summary, await this.handToMerge(remote, state, local));
      }
    }
    await this.journal.resetCursor(seq, anchor);
    summary.cursor = seq;
  }

  private async pushOnce(): Promise<PushSummary> {
    // Classify every vault event so far, so the push sees the latest changes.
    await this.events;
    const summary: PushSummary = { committed: 0, conflicts: 0, pending: 0, rejected: [] };
    await this.intents.recover();
    await this.finishConflictMoves();
    await this.pullOnce();
    await this.retryMerges();
    await this.retryRefusedPaths();
    let changed = true;
    for (let round = 0; round < maxPushRounds && changed; round++) {
      const all = this.dirty.all;
      const seen = new Map(this.dirty.paths);
      const waiting = await this.pushRound({ all, paths: new Set(seen.keys()) }, summary, round === 0);
      if (all) this.dirty.all = false;
      for (const [path, clock] of seen) {
        if (!waiting.has(path) && this.dirty.paths.get(path) === clock) this.dirty.paths.delete(path);
      }
      // Changes made or found during the round (a merge, an acknowledged commit, an upload superseded) are the next round's.
      changed = [...this.dirty.paths].some(([path, clock]) => seen.get(path) !== clock);
    }
    summary.pending = (await this.journal.listPending()).length;
    if (changed) this.schedulePush();
    return summary;
  }

  /**
   * Finishes a move to a `path-taken` conflict copy (moveToConflictPath) that
   * a crash interrupted after the file moved, before anything is committed:
   * resumed as it was, the refused operation would take the original path
   * once that is free, with the file at the copy's path (#371). If the
   * document already has an operation pending at the copy's path, the crash
   * came before the refused one was removed, which is all that is left to do.
   * Otherwise, if the file left the original path, the copy's operation
   * replaces the refused one, or, if the user has deleted or moved the copy
   * since, the refused one is dropped and its paths are looked at again (a
   * moved copy is a new file where it is now, #372).
   */
  private async finishConflictMoves(): Promise<void> {
    const pending = await this.journal.listPending();
    if (pending.length === 0) return;
    const conflicts = await this.journal.listConflicts();
    const busy = await this.busy();
    for (const operation of pending) {
      if (operation.deleted || busy.documents.has(operation.documentId)) continue;
      const record = conflicts.find(
        (candidate) =>
          candidate.reason === "path-taken" &&
          candidate.documentId === operation.documentId &&
          candidate.path === operation.path &&
          candidate.copyHash === operation.contentHash &&
          candidate.copyPath !== null &&
          candidate.copyPath !== operation.path,
      );
      if (record?.copyPath == null) continue;
      const copyPath = record.copyPath;
      const replaced = pending.some((candidate) => candidate.revisionId !== operation.revisionId && candidate.documentId === operation.documentId && candidate.path === copyPath && !candidate.deleted);
      if (!replaced) {
        // Not moved yet if the file is still at the path (another document's file there is not this one's).
        const holder = await this.documentAt(operation.path);
        if ((holder === undefined || holder.documentId === operation.documentId) && (await this.readOrNull(operation.path)) !== null) continue;
        const content = await this.readOrNull(copyPath);
        if (content !== null) {
          await this.journal.addPending({ ...operation, revisionId: this.newId(), path: copyPath, contentHash: sha256Hex(content), size: BigInt(content.length) });
        } else {
          const state = await this.journal.getDocument(operation.documentId);
          if (state !== undefined && !state.deleted) this.markDirty(state.path);
          this.markDirty(copyPath);
        }
      }
      await this.removeOperation(operation.revisionId);
      this.markDirty(operation.path);
    }
  }

  /** Asks the merge hook again about every document it deferred: a merge may now succeed. */
  private async retryMerges(): Promise<void> {
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason !== "local-changes") continue;
      const state = await this.journal.getDocument(deferred.revision.documentId);
      // Out of scope since it was deferred: its next revision, or a start that finds it in scope again, takes it on.
      if (this.outOfScope(deferred.revision, state)) continue;
      await this.handToMerge(deferred.revision, state, await this.localFile(state, deferred.revision));
    }
  }

  /**
   * Resumes pending operations (first round only), then records and commits
   * the operations the push plan derives (push-plan.ts). Returns the dirty
   * paths left for a later push.
   */
  private async pushRound(dirty: DirtyPaths, summary: PushSummary, resume: boolean): Promise<Set<string>> {
    let busy = await this.busy();
    if (resume) {
      for (const operation of await this.journal.listPending()) {
        if (busy.documents.has(operation.documentId) || busy.paths.has(operation.path)) continue;
        // Recorded while its path was in scope: it waits until it is again.
        if (!this.inScope(operation.path)) continue;
        await this.commitOperation(operation, summary);
        busy = await this.busy();
      }
    }
    await this.bindings.idle();
    const plan = await planPush(
      {
        space: this.pathSpace,
        documents: await this.journal.listDocuments(),
        pending: await this.journal.listPending(),
        deferred: await this.journal.listDeferred(),
        listed: await this.vault.list(),
        read: (path) => this.readOrNull(path),
        inScope: (path) => this.inScope(path),
        classify: this.classify,
        newId: this.newId,
      },
      dirty,
    );
    // The user deleted the document's file, and its synced content is back at its path: that file is its own again.
    for (const { state, path } of plan.adopted) await this.putDocument(state, { kind: "adopted", path });
    for (const operation of plan.operations) {
      // An earlier commit's pull may have handed this document or path to the merge path.
      busy = await this.busy();
      if (busy.documents.has(operation.documentId) || busy.paths.has(operation.path)) {
        plan.waiting.add(operation.path);
        continue;
      }
      // The file is no longer what this round found there: a merge moved it
      // aside, or the user changed it. The next round looks again, with the
      // rename that brought it there if it is still the binding's (#280).
      // Or an earlier commit's pull merged a remote revision of the document
      // (a delete the local edit wins over, say) and moved its base on: the
      // operation's base is no longer the head, so its commit would be
      // refused for good, as the pull after the refusal finds nothing left
      // to merge (#482). The next round looks again, from the new base.
      if (
        (!operation.deleted && !sameHash(await this.readOrNull(operation.path), operation.contentHash)) ||
        ((await this.journal.getDocument(operation.documentId))?.revisionId ?? "") !== operation.baseRevisionId
      ) {
        this.markDirty(operation.path);
        continue;
      }
      // A create's document gets its row with the operation (Bindings.created).
      if (operation.baseRevisionId === "" && !(await this.known(operation.documentId))) await this.bindings.created(operation);
      else if (plan.revivals.has(operation.revisionId)) await this.bindings.revived(operation);
      else await this.journal.addPending(operation);
      await this.commitOperation(operation, summary);
    }
    return plan.waiting;
  }

  /** The documents whose deferred remote revision keeps their local changes from being pushed, and their server claims (busyClaims). */
  private async busy(): Promise<Busy> {
    return busyClaims(await this.journal.listDocuments(), await this.journal.listDeferred());
  }

  /** The file the vault holds at `path`, under the spelling it has (on a case-insensitive platform, possibly another one), if any. */
  private async fileAt(path: string): Promise<string | undefined> {
    if ((await this.readOrNull(path)) === null) return undefined;
    if (this.pathRules.platform === "posix") return path;
    const key = this.pathSpace.fileKey(path);
    return (await this.vault.list()).find((candidate) => this.pathSpace.fileKey(candidate) === key) ?? path;
  }

  /**
   * Uploads an operation's content and commits it with its own revision id
   * and identical fields, however often it is retried, so a commit whose
   * response was lost returns the revision already committed (SPEC.md §6.2).
   * The journal records the new base and only then drops the operation.
   */
  private async commitOperation(operation: PendingOperation, summary: PushSummary): Promise<void> {
    const state = await this.journal.getDocument(operation.documentId);
    if (state?.revisionId === operation.revisionId) {
      // Acknowledged before an interruption; only the clean-up is left.
      await this.removeOperation(operation.revisionId);
      return;
    }
    const problem = pathProblem(operation.path, state !== undefined && !state.deleted && state.path === operation.path);
    if (problem !== undefined) {
      // The server would refuse the path (SPEC.md §6.2, #100), so nothing is
      // sent, on this push or any later one. A path with a "\" or a
      // drive-like prefix may still be kept by the live document already at
      // it, never given to a new, moved or deleted one (decisions #191,
      // #148). The operation stays pending and its file where it is, and
      // every push reports it, unless the file is gone (renamed or removed),
      // which a later push then sees as any other change.
      if (!operation.deleted && (await this.readOrNull(operation.path)) === null) {
        await this.removeOperation(operation.revisionId);
        this.markDirty(operation.path);
        if (state !== undefined && !state.deleted) this.markDirty(state.path);
        return;
      }
      summary.rejected.push({ operation, reason: problem, error: new ConnectError(`the server refuses this path (${problem})`, Code.InvalidArgument) });
      return;
    }
    // A rename or delete keeps the base's content, which the server already holds.
    const keepsContent = state !== undefined && state.revisionId === operation.baseRevisionId && state.baseHash === operation.contentHash;
    const upload = () => uploadContent(this.api, this.vaultId, operation.contentHash, operation.size, () => (operation.deleted ? Promise.resolve(null) : this.readOrNull(operation.path)));
    const superseded = async () => {
      // The file changed before its content was uploaded, so this revision
      // was never committed (the server commits only complete blobs). The
      // next round derives the document's operation again from its binding,
      // which holds any rename the operation carried (#286).
      await this.removeOperation(operation.revisionId);
      this.markDirty(operation.path);
    };
    if (!keepsContent && (await upload()) === "missing") {
      await superseded();
      return;
    }
    const request = {
      vaultId: this.vaultId,
      documentId: operation.documentId,
      revisionId: operation.revisionId,
      baseRevId: operation.baseRevisionId,
      kind: kindValue(operation.kind),
      contentRef: { blobId: hexToBytes(operation.contentHash), size: operation.size },
      path: new TextEncoder().encode(operation.path),
      deleted: operation.deleted,
      deviceId: this.deviceId,
    };
    let committed;
    for (let attempt = 1; committed === undefined; attempt++) {
      try {
        committed = await this.api.sync.commitRevision(request);
      } catch (error) {
        // The response may have been lost after the server committed: the
        // identical request returns that revision instead of a conflict.
        if (isTransient(error) && attempt < maxCommitAttempts) continue;
        // Blob garbage collection removed the content since it was uploaded
        // or found complete (SPEC.md §11): upload it again. A tombstone's
        // content is the base's, which its head still references.
        if (blobMissing(error) && !operation.deleted && attempt < maxCommitAttempts) {
          if ((await upload()) === "missing") {
            await superseded();
            return;
          }
          continue;
        }
        await this.commitFailed(operation, error, summary);
        return;
      }
    }
    const revision = committed.revision;
    if (revision?.id !== operation.revisionId || revision.documentId !== operation.documentId) {
      throw new RemoteContentError(`CommitRevision for ${operation.revisionId} returned another revision`);
    }
    const remote = toIncoming(revision).remote;
    await this.putDocument({
      documentId: operation.documentId,
      path: operation.path,
      revisionId: revision.id,
      seq: revision.seq,
      baseHash: operation.contentHash,
      size: operation.size,
      kind: operation.kind,
      deleted: operation.deleted,
      anchor: cursorAnchor(revision),
    }, { kind: "acknowledged", hash: operation.contentHash });
    // A delete of the file the user made before the commit landed stays
    // theirs, and a local rename made meanwhile is from the commit's path
    // now (#280): both are the binding, which the acknowledgement keeps.
    await this.removeOperation(operation.revisionId);
    await this.advancePastOwnCommit(revision);
    summary.committed++;
    // Changes made while the operation was pending were left for after it.
    this.markDirty(operation.path);
    this.onAcknowledged(remote);
  }

  /**
   * Moves the cursor onto this device's just-acknowledged revision if it is
   * the next seq after the cursor, so its own vault_changed starts no pull
   * (SPEC.md §6.1, §6.4). Seqs are gapless, so nothing is skipped; if another
   * device committed in between, the cursor stays for the next pull.
   * Interrupted before the cursor moves, the next pull lists the revision and
   * skips it. The revision does not go through the pull's apply step: the
   * journal already records it as applied, so that step would only remove a
   * deferral (path conflict, invalid path) of an older revision of the
   * document, and a document with one cannot have a commit acknowledged here
   * (its base is behind the server's head, so the commit is refused as head
   * moved). A stale path-conflict deferral would be removed by its retry
   * anyway, which finds it superseded.
   */
  private async advancePastOwnCommit(revision: Revision): Promise<void> {
    if ((await this.journal.getCursor()) !== revision.seq - 1n) return;
    await this.journal.setCursor(revision.seq, cursorAnchor(revision));
  }

  /**
   * Handles a refused commit; the operation stays pending unless resolved here.
   * Head moved: pull, which hands the document to the merge hook (it has a
   * pending operation). Path taken by another document (ALREADY_EXISTS): pull,
   * so that document arrives. If its revision lands at the same path, the pull
   * hands it to the merge hook, which keeps the local file as a conflict copy;
   * otherwise (the paths differ only by case or Unicode form, or the hook
   * deferred) see moveToConflictPath. INVALID_ARGUMENT: recorded as rejected.
   * Anything else rejects the push.
   */
  private async commitFailed(operation: PendingOperation, error: unknown, summary: PushSummary): Promise<void> {
    if (!(error instanceof ConnectError)) throw error;
    if (headMoved(error)) {
      summary.conflicts++;
      await this.pullOnce();
      return;
    }
    if (error.code === Code.AlreadyExists) {
      summary.conflicts++;
      await this.pullOnce();
      await this.moveToConflictPath(operation, error, summary);
      return;
    }
    if (error.code === Code.InvalidArgument) {
      summary.rejected.push({ operation, reason: "refused", error });
      return;
    }
    throw error;
  }

  /**
   * Resolves a commit refused because another document holds its path
   * (SPEC.md §6.3): if the operation is still pending after the pull and the
   * merge path does not own it, the local document moves to
   * `<name> (conflict <device> <date>).<ext>` and is committed there, under
   * its own document id. Logged in the conflict log before the file moves, so
   * an interrupted move resumes under the same name; the replacement
   * operation is added before the refused one is removed. If no name fits the
   * path limits, nothing moves and the operation is reported as rejected.
   */
  private async moveToConflictPath(operation: PendingOperation, error: ConnectError, summary: PushSummary): Promise<void> {
    const pending = await this.journal.listPending();
    if (operation.deleted) return;
    const busy = await this.busy();
    if (!pending.some((candidate) => candidate.revisionId === operation.revisionId)) {
      // The pull resolved it. If it moved the document aside for the other
      // document (a local rename onto that one's path), the document's
      // operation now stands at the conflict-copy path: committed there.
      const moved = pending.find((candidate) => candidate.documentId === operation.documentId && !candidate.deleted);
      if (moved !== undefined && !busy.documents.has(moved.documentId) && !busy.paths.has(moved.path)) await this.commitOperation(moved, summary);
      return;
    }
    if (busy.documents.has(operation.documentId) || busy.paths.has(operation.path)) return;
    const conflicts = await this.journal.listConflicts();
    const movedHere = (path: string) => conflicts.find((record) => record.reason === "path-taken" && record.documentId === operation.documentId && record.copyPath === path);
    // What the server refuses a path for (SPEC.md §5, §6.3): a document other
    // than this one that this device knows of (a live one the journal has,
    // or a deferred remote revision) holds it by path key, as a file or as a
    // folder, or holds one of its folders as a file.
    const takenByOther = async () =>
      (await PathClaims.load(this.pathSpace, this.journal, this.vault))
        .collisions(operation.path, "server")
        .some((claim) => (claim.kind === "server-known" || claim.kind === "server-newer") && claim.documentId !== operation.documentId);
    if (movedHere(operation.path) !== undefined && !(await takenByOther())) {
      // Already moved to a conflict-copy path, and refused there too, though
      // no document this device knows of (after the pull) holds that path:
      // the server keeps refusing something a new name does not fix. Moving
      // on from name to name would not end, so it stays pending and is
      // reported. A known document that took the copy's path after the move
      // (by path key, #243) is fixed by a new name, below.
      summary.rejected.push({ operation, reason: "path-taken", error });
      return;
    }
    const logged = conflicts.filter(
      (record) => record.reason === "path-taken" && record.documentId === operation.documentId && record.path === operation.path && record.copyHash === operation.contentHash,
    );
    let record = logged.find((candidate) => candidate.copyPath !== null);
    // The file at the path, unless the journal has another document there:
    // on a case-insensitive platform a path of another spelling names that
    // document's file, which is never this operation's to move (#242). Its
    // bytes are that document's, whatever they are now: change detection
    // pushes them as its edit, and moving them would leave it no file, which
    // the next push would take for a delete (decision #52, amended).
    // The document bound to the file decides; a file no binding names is
    // that of the document synced there.
    const holder = (await this.journal.documentByFileKey(this.pathSpace.filesystemKey(operation.path))) ?? (await this.documentAt(operation.path));
    const found = await this.readOrNull(operation.path);
    const othersFile = found !== null && holder !== undefined && holder.documentId !== operation.documentId;
    const atPath = othersFile ? null : found;
    if (record === undefined) {
      if (atPath === null) {
        // Nothing to move: the file is gone (the user deleted or moved it),
        // so the operation can never commit and nothing of it is left to
        // keep. It is dropped, and the next push looks at its paths again.
        await this.removeOperation(operation.revisionId);
        this.markDirty(operation.path);
        const state = await this.journal.getDocument(operation.documentId);
        if (state !== undefined && !state.deleted) this.markDirty(state.path);
        return;
      }
      // A copy refused again is named after the path it was first moved
      // from, not after its own copy name.
      let origin = operation.path;
      const seen = new Set([origin]);
      for (let previous = movedHere(origin); previous !== undefined && !seen.has(previous.path); previous = movedHere(origin)) {
        origin = previous.path;
        seen.add(origin);
      }
      // Another document holding one of its folders as a file is in the way
      // of the folder, so that is what moves (freeCopyName's folder rule).
      const copyPath = await this.freeCopyName(origin);
      if (copyPath === null) {
        if (logged.length === 0) await this.journal.putConflict(this.conflictRecord(operation.documentId, operation.path, "path-taken", null, operation.contentHash, ""));
        summary.rejected.push({ operation, reason: "path-taken", error });
        return;
      }
      record = this.conflictRecord(operation.documentId, operation.path, "path-taken", copyPath, operation.contentHash, "");
      await this.journal.putConflict(record);
    }
    const copyPath = record.copyPath;
    if (copyPath === null) return;
    // Already moved before an interruption, if the copy's path holds a file;
    // a file at the old path is then a new one, which the next round pushes.
    if (atPath !== null && (await this.vault.stat(copyPath)) === null) {
      await this.echoed(this.echoes.expectRename(await this.heldSpelling(operation.path), copyPath), () => this.renameFile(operation.path, copyPath));
    }
    const content = await this.readOrNull(copyPath);
    if (content === null) return;
    const replacement = pending.find((candidate) => candidate.documentId === operation.documentId && candidate.path === copyPath) ?? {
      ...operation,
      revisionId: this.newId(),
      path: copyPath,
      contentHash: sha256Hex(content),
      size: BigInt(content.length),
    };
    if (!pending.includes(replacement)) await this.journal.addPending(replacement);
    await this.removeOperation(operation.revisionId);
    this.markDirty(operation.path);
    // A remote document the file was in the way of (a file where it needs a
    // folder, or the reverse) may now fit, and so may the merge of a remote
    // rename there, deferred with the user's edit (#307).
    await this.retryRefusedPaths(true);
    await this.retryMerges();
    await this.commitOperation(replacement, summary);
  }

  /**
   * Applies again the remote revisions deferred because the vault refused
   * their path, once no file or folder is in the way any more. Each is tried
   * at most once per engine unless `again`, so a path the vault refuses for
   * another reason does not cost a download on every push. So are, once per
   * engine, unmaterializable revisions whose path the platform rules now
   * allow (the vault refused it although they did, or the vault moved to a
   * shorter folder). So are, once per engine, out-of-scope revisions now in
   * scope and too-large revisions the download cap now fits.
   */
  private async retryRefusedPaths(again = false): Promise<void> {
    const deferrals = (await this.journal.listDeferred()).filter(
      (deferred) =>
        (deferred.reason === "path-conflict" && (again || !this.retried.has(deferred.revision.revisionId))) ||
        (deferred.reason === "unmaterializable" && !this.retried.has(deferred.revision.revisionId) && unmaterializableReason(deferred.revision.path, this.pathRules) === undefined) ||
        (deferred.reason === "out-of-scope" && !this.retried.has(deferred.revision.revisionId) && this.inScope(deferred.revision.path)) ||
        (deferred.reason === "too-large" && !this.retried.has(deferred.revision.revisionId) && !this.overCap(deferred.revision)),
    );
    if (deferrals.length === 0) return;
    // Only an untracked file in the way keeps a revision waiting here: a
    // document's file is rule W's to move when the revision is applied.
    const bound = new Set((await this.journal.listDocuments()).flatMap((state) => (state.binding && hasBase(state) ? [state.binding.fileKey] : [])));
    const files = new Set((await this.vault.list()).filter((file) => !bound.has(this.pathSpace.filesystemKey(file))));
    const folders = new Set([...files].flatMap((file) => this.pathSpace.ancestors(file)));
    for (const deferred of deferrals) {
      const { path } = deferred.revision;
      if (!deferred.revision.deleted && (folders.has(path) || this.pathSpace.ancestors(path).some((ancestor) => files.has(ancestor)))) continue;
      this.retried.add(deferred.revision.revisionId);
      const outcome = await this.applyRevision({ remote: deferred.revision, pathAllowed: true });
      // Already superseded: a newer revision of the document was applied.
      if (outcome === "skipped") await this.journal.removeDeferred(deferred.revision.documentId);
    }
  }

  /** Marks a path changed, for the next push to look at. */
  private markDirty(path: string): void {
    this.dirty.paths.set(path, ++this.dirtyClock);
  }

  /** Records a vault event for the next push. Renames and deletes are the bindings' (transition). */
  private recordChange(event: VaultEvent): void {
    this.markDirty(event.path);
    if (event.type === "rename") this.markDirty(event.oldPath);
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushDebounceMs === null || this.disposed) return;
    this.cancelScheduledPush();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.automaticPush();
    }, this.pushDebounceMs);
  }

  /** A push the engine starts on its own; its outcome goes to onPushComplete or onPushError. */
  private automaticPush(): void {
    this.push().then(
      (summary) => {
        this.onPushComplete(summary);
      },
      (error: unknown) => {
        this.onPushError(error);
      },
    );
  }

  private cancelScheduledPush(): void {
    if (this.pushTimer === undefined) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  private async handleEvent(event: VaultEvent, duringScan: boolean): Promise<void> {
    let echo = false;
    try {
      echo = await this.echoes.isEcho(event, async (path) => {
        const content = await this.readOrNull(path);
        return content === null ? null : sha256Hex(content);
      });
    } catch {
      // In doubt, report the change: a duplicate report is harmless, a missed edit is not.
    }
    if (echo) return;
    this.recordChange(event);
    try {
      await this.transition(event, duringScan);
    } finally {
      // Reported even if its transition failed: the change is still the user's, unpushed.
      try {
        this.onLocalChange(event);
      } catch (error) {
        // Keep classifying later events; surface the listener's error without swallowing it.
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  /** Whether the vault syncs `path` (VaultAdapter.isSynced). */
  private inScope(path: string): boolean {
    return this.vault.isSynced?.(path) ?? true;
  }

  /** Whether `remote` is not this device's to apply now: its path, or the path its document has here, is out of scope. */
  private outOfScope(remote: RemoteRevision, state: DocumentState | undefined): boolean {
    return !this.inScope(remote.path) || (state !== undefined && !state.deleted && !this.inScope(state.path));
  }

  /** Removes a pending operation; a create's row goes with its last one (Bindings.dropped). */
  private removeOperation(revisionId: string): Promise<void> {
    return this.bindings.dropped([revisionId]);
  }

  /** Every document row the engine writes goes through Bindings, which gives it the binding `change` makes. */
  private putDocument(state: DocumentState, change: BindingChange): Promise<void> {
    return this.bindings.put(state, change);
  }

  /** The engine moves a file: the document bound to it keeps it (E1, design §4.3). */
  private async renameFile(from: string, to: string): Promise<void> {
    await this.vault.rename(from, to);
    await this.bindings.renamed(from, to);
  }

  /** The engine deletes a file: its document no longer has it, unless the write that follows binds it again. */
  private async deleteFile(path: string, precondition?: DeletePrecondition): Promise<void> {
    await this.vault.delete(path, precondition);
    await this.bindings.deleted(path, "engine");
  }

  /** Records a user's rename or delete as its binding transition (E1–E3), before the event counts as handled (PO-2). */
  private async transition(event: VaultEvent, duringScan: boolean): Promise<void> {
    // A transition that fails stops event handling (later events wait
    // behind it and every push rejects with its error) until a restart,
    // whose scan reconciles bindings with the disk (PO-3).
    if (event.type === "rename") await this.bindings.renamed(event.oldPath, event.path, duringScan);
    else if (event.type === "delete") await this.bindings.deleted(event.path, "user");
  }

  /**
   * The differential check of refactor step R4 (design §9.2,
   * `binding-shadow`): every document whose binding disagrees with the
   * ownership the engine still derives (followRename, movedAway,
   * localMoveAt) about which local file is the document. Report only:
   * nothing decides by bindings yet. Runs between pulls and pushes, once
   * every event received so far is handled.
   */
  async bindingShadow(): Promise<BindingDivergence[]> {
    await this.events;
    const run = this.work.then(async () => {
      await this.bindings.idle();
      return this.shadowDivergences();
    });
    this.work = run.catch(() => undefined);
    return run;
  }

  private async shadowDivergences(): Promise<BindingDivergence[]> {
    const divergences: BindingDivergence[] = [];
    for (const state of await this.journal.listDocuments()) {
      const derived = await this.derivedFile(state);
      const binding = state.binding;
      if (binding === undefined) {
        divergences.push({ documentId: state.documentId, binding: undefined, absence: undefined, derived });
        continue;
      }
      const bound = binding === null ? null : binding.spelling;
      const agree = bound === null || derived === null ? bound === derived : this.pathSpace.oneFile(bound, derived);
      if (!agree) divergences.push({ documentId: state.documentId, binding: bound, absence: state.absence ?? null, derived });
    }
    return divergences;
  }

  /**
   * Which local file the engine's derived ownership takes to be the
   * document's, or null for none: its synced path unless a local move took
   * it away (movedAway), followed to where it went (followRename), unless
   * another document's local move holds that file (localMoveAt).
   */
  private async derivedFile(state: DocumentState): Promise<string | null> {
    if (!hasBase(state)) {
      // A create not acknowledged yet: the file it reads, or where a local rename moved it.
      const create = (await this.journal.listPending()).find((operation) => operation.documentId === state.documentId && operation.baseRevisionId === "" && !operation.deleted);
      if (create === undefined) return null;
      const path = (await this.localRenames()).find((move) => move.documentId === state.documentId)?.to ?? create.path;
      return (await this.vault.stat(path)) === null ? null : path;
    }
    if (state.deleted) return null;
    const found = await this.followRename(state, { path: state.path, content: await this.readOrNull(state.path) });
    if (found.content === null) return null;
    if (found.path === state.path && (await this.movedAway(state))) return null;
    const mover = await this.localMoveAt(found.path, state.documentId);
    return mover === undefined ? found.path : null;
  }

  private async readOrNull(path: string): Promise<Uint8Array | null> {
    try {
      return await this.vault.read(path);
    } catch (error) {
      if (isVaultError(error, "not-found")) return null;
      throw error;
    }
  }
}

/** Length of a Revision.anchor (SPEC.md §6.1). */
const anchorBytes = 16;

/**
 * The anchor to store with a cursor at `revision`, or undefined if it has
 * none the server would accept back (a server from before #155 sends none):
 * the next pull then runs without the check, as before.
 */
function cursorAnchor(revision: Revision): Uint8Array | undefined {
  return revision.anchor.length === anchorBytes ? revision.anchor : undefined;
}

/**
 * Whether a local move put the document's file elsewhere than its synced
 * path (design §4.3 E1): its binding names another spelling.
 */
function movedLocally(state: DocumentState | undefined): boolean {
  const binding = state?.binding;
  return state !== undefined && binding !== undefined && binding !== null && binding.spelling !== state.path;
}

function syncedState(remote: RemoteRevision): DocumentState {
  return {
    documentId: remote.documentId,
    path: remote.path,
    revisionId: remote.revisionId,
    seq: remote.seq,
    baseHash: remote.contentHash,
    size: remote.size,
    kind: remote.kind,
    deleted: remote.deleted,
  };
}

/** A failure after which the identical call may succeed. */
function isTransient(error: unknown): boolean {
  return error instanceof ConnectError && (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded);
}

function sameHash(content: Uint8Array | null, hash: string): boolean {
  return content !== null && sha256Hex(content) === hash;
}

function sameContent(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && sha256Hex(left) === sha256Hex(right);
}
