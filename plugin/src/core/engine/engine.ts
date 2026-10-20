import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { sha256Hex } from "../hash";
import type { ConflictReason, ConflictRecord, DeferReason, DocumentKindName, DocumentState, Journal, PendingOperation, RemoteRevision } from "../journal/journal";
import { conflictCopyPath, conflictFolderPath } from "../merge/conflict-name";
import { pathKey } from "../pathkey/pathkey";
import { uuidv7 } from "../uuid";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { posixPathRules, sameFilesystemName, unmaterializableReason, type PathRules, type UnmaterializableCause } from "../vaultpath/platform";
import { isVaultRelativePath, pathProblem, type PathProblem } from "../vaultpath/vaultpath";
import { EchoSuppressor } from "./echo";
import { blobMissing, errorCode, headMoved } from "./errors";
import { commitRestore, documentHistory, readRevision, type HistoryEntry, type HistoryPage } from "./history";
import { threeWayMerge, type MergeHook, type MergeOutcome } from "./merge";
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

type ApplyOutcome = "applied" | "deferred" | "merged" | "skipped";

/** What a push examines: changed paths, and renames (new path to the path the file had at the last sync). */
interface Changes {
  all: boolean;
  paths: Set<string>;
  renames: Map<string, string>;
  /** Paths a rename moved a file to and the user then deleted it from. */
  vacated: Set<string>;
  /**
   * Known documents whose file the user deleted, by the file's path key (#254):
   * a file at that path since then is another one, never the document's edit.
   */
  deleted: Map<string, DeletedFile>;
}

/** A known document whose file the user deleted, at the revision the journal had for it then. */
interface DeletedFile {
  documentId: string;
  revisionId: string;
}

/** Documents and paths the merge path owns: the engine pushes none of their changes. */
interface Parked {
  documents: Set<string>;
  paths: Set<string>;
}

const defaultPageSize = 500;
const defaultPushDebounceMs = 2000;
/** Rounds of one push: a merge or a superseded upload leaves changes the next round pushes. */
const maxPushRounds = 4;
/** Attempts of one CommitRevision within a push after transient failures (UNAVAILABLE, DEADLINE_EXCEEDED). */
const maxCommitAttempts = 3;
/** Numbered conflict-copy names tried before giving up on finding a free one. */
const maxConflictNameAttempts = 100;

/**
 * A document a merge rebases onto its remote revision (applyMerge), as
 * freeConflictPath sees it: `file` is its own file that the merge moves away
 * from or deletes, if there is one, and `result` the path the merge result
 * goes to, or null for a delete.
 */
interface MergedDocument {
  documentId: string;
  file: string | undefined;
  result: string | null;
}

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
  /** Maps a path to what the vault takes as the same file: its path key on a case-insensitive platform. */
  private readonly fileKey: (path: string) => string;
  private readonly echoes = new EchoSuppressor();
  /** Revisions deferred for a refused path that retryRefusedPaths already tried again. */
  private readonly retried = new Set<string>();
  /** Documents being merged right now, so resolving one first never loops back to another. */
  private readonly resolving = new Set<string>();
  private readonly unsubscribe: () => void;
  private events: Promise<void> = Promise.resolve();
  /** Pulls and pushes, one at a time. */
  private work: Promise<unknown> = Promise.resolve();
  /** Local changes not yet pushed. Events are lost when the app dies, so the first push scans everything. */
  private changes: Changes = { all: true, paths: new Set(), renames: new Map(), vacated: new Set(), deleted: new Map() };
  /** The renames the running push round took from `changes` and has not committed yet: still local moves to the merge path (#280). */
  private roundRenames = new Map<string, string>();
  /** The deleted files the running push round looks at: like roundRenames, for #254. */
  private roundDeleted = new Map<string, DeletedFile>();
  /**
   * Changed paths a push left alone because the merge path or a pending
   * operation had them (#167): every later push looks at them again, so a
   * change there never waits for a restart's full scan, whatever frees them.
   * Kept apart from `changes`, so they schedule no push of their own.
   */
  private held = new Set<string>();
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
    this.fileKey = this.pathRules.platform === "posix" ? (path) => path : pathKey;
    this.rateLimitBackoff = options.rateLimitBackoff ?? defaultRateLimitBackoff;
    this.timers = options.timers ?? globalTimers;
    this.random = options.random ?? Math.random;
    this.unsubscribe = this.vault.watch((event) => {
      this.events = this.events.then(() => this.handleEvent(event));
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
    await this.events;
    await this.work;
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
      const state = await this.journal.getDocument(revision.documentId);
      const localPath = state !== undefined && !state.deleted && (await this.vault.stat(state.path)) !== null ? state.path : undefined;
      documents.push({ documentId: revision.documentId, path: revision.path, size: revision.size, revision, localPath });
    }
    return documents;
  }

  /** One page of a document's retained history, newest first, with each revision's time and device (SPEC.md §11). */
  history(documentId: string, pageToken = ""): Promise<HistoryPage> {
    return documentHistory(this.api, this.vaultId, this.deviceId, documentId, pageToken);
  }

  /** A history entry's content, for a preview. */
  readRevision(entry: HistoryEntry): Promise<Uint8Array> {
    return readRevision(this.api, this.vaultId, entry);
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
   * committed then).
   */
  restore(entry: HistoryEntry, content?: Uint8Array): Promise<RemoteRevision> {
    this.cancelScheduledPush();
    return this.serialize(async () => {
      await this.pushOnce();
      const restored = await commitRestore(this.api, this.vaultId, this.deviceId, entry, this.newId(), content);
      await this.pullOnce();
      return restored;
    });
  }

  /**
   * The documents deleted on the server that this device knows of, most
   * recently deleted first: what the user can find and restore (SPEC.md
   * §11). A document this device only released because the platform cannot
   * hold its path (§8) is not deleted, and one being brought back by a local
   * change still to be pushed is not listed either.
   */
  async deletedDocuments(): Promise<DocumentState[]> {
    const released = new Set((await this.journal.listDeferred()).filter((deferred) => deferred.reason === "unmaterializable").map((deferred) => deferred.revision.documentId));
    const pending = new Set((await this.journal.listPending()).map((operation) => operation.documentId));
    return (await this.journal.listDocuments())
      .filter((state) => state.deleted && !released.has(state.documentId) && !pending.has(state.documentId))
      .sort((left, right) => (left.seq > right.seq ? -1 : left.seq < right.seq ? 1 : 0));
  }

  private async unmaterializableDocument(revision: RemoteRevision, reason: UnmaterializableCause): Promise<UnmaterializableDocument> {
    const state = await this.journal.getDocument(revision.documentId);
    const localPath = state !== undefined && !state.deleted && (await this.vault.stat(state.path)) !== null ? state.path : undefined;
    return { documentId: revision.documentId, path: revision.path, reason, revision, localPath };
  }

  /**
   * Tracks `remote` as unmaterializable: deferred, with nothing written, and
   * reported. Recorded before the document's file is released (see
   * releaseFile), so the deferral, which parks the document, is there first.
   */
  private async deferUnmaterializable(remote: RemoteRevision, reason: UnmaterializableCause): Promise<"deferred"> {
    await this.journal.putDeferred({ revision: remote, reason: "unmaterializable", unmaterializable: reason });
    await this.releaseFile(remote.documentId);
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
   * Releases the file of an unmaterializable document: the server no longer
   * has the document at that path, so the path is freed for whatever the
   * server or the user puts there. The file is removed if it still holds the
   * synced content (which the server has) and no local operation of the
   * document is pending; a file with local changes stays, with them, until
   * the document materializes and the merge path takes it. So does a file
   * saved after the check: the delete expects the synced content, and the
   * vault refuses it with "changed" otherwise (#163).
   *
   * The release is recorded in the journal by storing the document's state
   * as `deleted` (no file of its own on this device; SPEC.md §8), so nothing
   * at the old path is afterwards taken for the document's file: another
   * document's, or a new local file, of any content. The record comes after
   * the delete, and a release interrupted in between is finished by the next
   * call (the interrupted pull's replay of the revision, or each start's
   * push): the file is then gone, or another document holds the path (one
   * the server put there meanwhile), and either way the document has no
   * file there any more. Another document's file is never removed.
   */
  private async releaseFile(documentId: string): Promise<void> {
    const state = await this.journal.getDocument(documentId);
    if (state === undefined || state.deleted) return;
    if ((await this.journal.listPending()).some((operation) => operation.documentId === documentId)) return;
    const key = this.fileKey(state.path);
    const taken = (await this.journal.listDocuments()).some((other) => other.documentId !== documentId && !other.deleted && this.fileKey(other.path) === key);
    if (!taken) {
      const content = await this.readOrNull(state.path);
      if (content !== null) {
        if (sha256Hex(content) !== state.baseHash) return;
        try {
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(state.path)), () => this.vault.delete(state.path, { expectedHash: state.baseHash }));
        } catch (error) {
          // Saved locally since the check (#163): a local edit, so the file stays, as above.
          if (isVaultError(error, "changed")) return;
          throw error;
        }
      }
    }
    await this.journal.putDocument({ ...state, deleted: true });
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
    const summary: PullSummary = { cursor: await this.journal.getCursor(), applied: 0, deferred: 0, merged: 0, resynced: false };
    let anchor = summary.cursor > 0n ? await this.journal.getCursorAnchor() : undefined;
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: summary.cursor, sinceAnchor: anchor ?? new Uint8Array(), pageSize: this.pageSize });
      if (response.diverged || response.headSeq < summary.cursor) {
        // The server lost history this device already applied (e.g. a
        // database restore): it no longer holds the revision this device
        // applied at the cursor (its anchor differs, SPEC.md §6.1), or its
        // head fell below the cursor. That is divergence, not "nothing new".
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
      if (state?.revisionId !== remote.revisionId) await this.journal.putDocument(syncedState(remote));
      if (state !== undefined && !remote.deleted) this.carryDelete(remote.documentId, state.revisionId, remote.revisionId);
      await this.journal.removePending(remote.revisionId);
      // Changes left for after the operation (a newer edit, a rename that
      // waited for it) are pushed now, as after an acknowledged commit.
      this.changes.paths.add(remote.path);
      this.schedulePush();
      return "applied";
    }
    const rebased = (operation: PendingOperation) => operation.baseRevisionId === "" || operation.baseRevisionId === remote.revisionId;
    if (state === undefined && !remote.deleted && remote.parentRevisionId === "" && pending.length > 0 && pending.every(rebased)) {
      // This device's own create, which it moved on (to a path-taken copy,
      // #286) before learning that the commit had landed: document ids are
      // this device's own. The moved create becomes the document's next
      // revision, a rename, on top of it; then the document is taken as
      // created. Interrupted in between, the pull finds it here again.
      for (const operation of pending) {
        if (operation.baseRevisionId !== "") continue;
        await this.journal.addPending({ ...operation, revisionId: this.newId(), baseRevisionId: remote.revisionId });
        await this.journal.removePending(operation.revisionId);
      }
      await this.journal.putDocument(syncedState(remote));
      for (const operation of pending) this.changes.paths.add(operation.path);
      this.schedulePush();
      return "applied";
    }
    const deferred = await this.journal.getDeferred(remote.documentId);
    if (state?.revisionId === remote.revisionId) {
      // Applied before an interruption that came before its deferral was removed.
      if (deferred !== undefined && deferred.reason !== "local-changes" && deferred.revision.seq <= remote.seq) await this.journal.removeDeferred(remote.documentId);
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
    if (state !== undefined && state.seq === 0n && !state.deleted) return this.handToMerge(remote, state, await this.localFile(state, remote));
    if (!remote.deleted && !incoming.pathAllowed) return this.defer(remote, "invalid-path");
    const unmaterializable = remote.deleted ? undefined : unmaterializableReason(remote.path, this.pathRules);
    if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);

    // An unmaterializable document whose file was released has no file of
    // its own here any more: its state is `deleted` (see releaseFile), so it
    // comes back as a new document would.

    // Download before looking at the disk, so the check-then-write window is short.
    const needsContent = !remote.deleted && (state === undefined || state.deleted || state.baseHash !== remote.contentHash);
    const content = needsContent ? await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size) : undefined;

    const inspection = await this.inspect(state, remote);
    if (inspection.kind === "dirty") return this.handToMerge(remote, state, inspection);
    if (inspection.kind === "applied" && !remote.deleted) {
      // The file at the path already holds the revision's content. If a
      // local move of another known document put it there, it is still that
      // document's: the merge path moves it to a conflict-copy path under its
      // own id, as for any other content (#242). That holds for a known
      // document's own revision too (one whose file was deleted locally,
      // say): taken here, the other document's next push would find its file
      // gone and tombstone it (#267). A file the journal has as another live
      // document's (one whose remote rename away from it is deferred, say) is
      // that document's too: taken here, the journal would hold two
      // documents at one path, and the other's move would later tombstone
      // this one (#264). The merge path lets the other document's merge go
      // first (#172).
      const holder = await this.documentAt(remote.path);
      if ((holder !== undefined && holder.documentId !== remote.documentId) || (await this.localMoveAt(remote.path, remote.documentId)) !== undefined) {
        return this.handToMerge(remote, state, { path: remote.path, content: await this.readOrNull(remote.path) });
      }
    }
    if (inspection.kind === "clean" && !remote.deleted) {
      // No file at the path, but the journal has it as another live
      // document's: one whose own remote move the merge path holds, after
      // the user deleted its file, say. Written here, the journal would hold
      // two documents at one path: the other's merge would take this file
      // as its local version, and this document's next move would find its
      // file another's for good (#379). The merge path lets the other
      // document's merge go first. One the platform cannot hold is handled
      // as its kept file is (releaseKeptFile, #391). One whose revision waits
      // for a reason no pull or push retries gives the path up there too
      // (resolveFirst, releaseIdleClaim), so this revision is written.
      const holder = await this.documentAt(remote.path);
      if (holder !== undefined && holder.documentId !== remote.documentId && (await this.journal.getDeferred(holder.documentId))?.reason !== "unmaterializable") {
        const path = inspection.source ?? remote.path;
        return this.handToMerge(remote, state, { path, content: await this.readOrNull(path) });
      }
    }
    if (inspection.kind === "clean" && inspection.source !== undefined && (await this.localMoveAt(inspection.source, remote.documentId)) !== undefined) {
      // The file at the document's synced path holds its synced content, but
      // a local rename of another document put it there after this one moved
      // away: it is that document's file, never this revision's to replace
      // or delete. The merge path finds this document's own file.
      return this.handToMerge(remote, state, { path: inspection.source, content: await this.readOrNull(inspection.source) });
    }
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
    await this.journal.putDocument(syncedState(remote));
    if (deferred !== undefined) await this.journal.removeDeferred(remote.documentId);
    return "applied";
  }

  /** Classifies the disk by content hash against the base (`state`) and the remote revision. */
  private async inspect(state: DocumentState | undefined, remote: RemoteRevision): Promise<Inspection> {
    const basePath = state !== undefined && !state.deleted ? state.path : undefined;
    const baseContent = basePath === undefined ? null : await this.readOrNull(basePath);
    const baseHash = state?.baseHash;
    const baseOnDisk = baseContent !== null && sha256Hex(baseContent) === baseHash;

    if (remote.deleted) {
      // Nothing there: the engine already deleted it, or the user deleted it too. Both agree.
      if (basePath === undefined || baseContent === null) return { kind: "applied" };
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
    // The same file, also when only its spelling changes on a case-insensitive platform.
    if (this.fileKey(basePath) === this.fileKey(target)) {
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
      await this.echoed(this.echoes.expectDelete(await this.heldSpelling(source)), () => this.vault.delete(source, { expectedHash }));
      return;
    }
    if (source !== undefined && source !== remote.path) {
      await this.echoed(this.echoes.expectRename(await this.heldSpelling(source), remote.path), () => this.vault.rename(source, remote.path));
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
    const key = this.fileKey(path);
    const actual = (await this.vault.list()).find((candidate) => candidate !== path && this.fileKey(candidate) === key);
    if (actual === undefined || (await this.localSpelling(actual, documentId))) return;
    await this.echoed(this.echoes.expectRename(actual, path), () => this.vault.rename(actual, path));
  }

  /** Whether a local rename of `documentId` not yet pushed, or a pending operation of it, put its file at exactly `path`. */
  private async localSpelling(path: string, documentId: string): Promise<boolean> {
    for (const [to, from] of this.localRenames()) {
      if (to === path && (await this.journal.findDocumentByPath(from))?.documentId === documentId) return true;
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
    const key = this.fileKey(path);
    const candidates = listed.filter((candidate) => this.fileKey(candidate) === key);
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
    if (!remote.deleted) {
      // Another document the journal has at the path, whose own merge is
      // pending (the server has already moved it away), goes first. One the
      // platform cannot hold gives up its kept file (#390).
      const holder = await this.documentAt(remote.path);
      if (holder !== undefined && holder.documentId !== remote.documentId && (await this.resolveFirst(holder.documentId)) && found.path === remote.path) {
        found = { path: found.path, content: await this.readOrNull(found.path) };
      }
    }
    let elsewhere: { path: string; content: Uint8Array | null } | undefined;
    if (found.content !== null) {
      // `found` is what occupies the document's synced path, or for a
      // document this device has no file of its own for, the remote path. A
      // known document a local rename put there (after this document moved
      // away from it, if it has a synced path there) is not this document's
      // local version. If this document's own file is where a local rename
      // moved it, that file is its local version: the local rename wins
      // (SPEC.md §7), so the result never lands here and the other document
      // keeps its place, whatever its content (review of #278; followRename
      // would take a file holding the synced content for this one). Otherwise the
      // result needs the path, and the other document moves on to a
      // conflict-copy path under its own id, as a refused create would
      // (#267). A known document's remote delete never needs the path, so
      // the other document keeps its place.
      const mover = await this.localMoveAt(found.path, remote.documentId);
      if (mover !== undefined) {
        const own = state !== undefined && !state.deleted && found.path === state.path ? await this.followRename(state, { path: found.path, content: null }) : undefined;
        if (own !== undefined && own.content !== null) elsewhere = own;
        else if ((state === undefined || state.deleted || !remote.deleted) && (await this.moveAside(mover.documentId, mover.path))) found = { path: found.path, content: await this.readOrNull(found.path) };
      }
    }
    const local = elsewhere ?? (await this.followRename(state, found));
    // A merge of this revision that was interrupted after its result reached
    // the disk is finished as it was, without asking the hook again.
    if (deferred?.revision.revisionId === remote.revisionId && deferred.merging !== undefined && (await this.resumeMerge(remote, state, deferred.merging))) return "merged";
    const outcome = await this.merge({
      remote,
      base: state,
      local: { path: local.path, content: local.content },
      readRemoteContent: () => (remote.deleted ? Promise.resolve(null) : downloadContent(this.api, this.vaultId, remote.contentHash, remote.size)),
      // A tombstone has no content of its own to merge against, and a base
      // retention purged has none any more (SPEC.md §11): never a reason to
      // stop the pull.
      readBaseContent: () => (state === undefined || state.deleted ? Promise.resolve(null) : baseContent(this.api, this.vaultId, state.revisionId)),
    });
    if (outcome.status === "merged" && outcome.content !== null) {
      // The result cannot be written here: the remote path never touches the
      // disk, and the local changes stay as they are until a later revision
      // gives the document a path the platform can hold.
      if (outcome.path === remote.path && !isVaultRelativePath(outcome.path)) return this.defer(remote, "invalid-path");
      const unmaterializable = unmaterializableReason(outcome.path, this.pathRules);
      if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);
    }
    try {
      if (outcome.status === "merged" && (await this.applyMerge(remote, state, local, outcome))) return "merged";
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
    return this.applyMerge(remote, state, resumed, { status: "merged", ...resumed });
  }

  /**
   * Hands a document whose remote revision the merge path holds to it again,
   * unless it is already being merged further up. Returns whether that
   * resolved it.
   */
  private async resolveFirst(documentId: string): Promise<boolean> {
    if (this.resolving.has(documentId)) return false;
    const deferred = await this.journal.getDeferred(documentId);
    if (deferred?.reason === "unmaterializable") return this.releaseKeptFile(documentId);
    if (deferred?.reason !== "local-changes") return this.releaseIdleClaim(documentId);
    const state = await this.journal.getDocument(documentId);
    return (await this.handToMerge(deferred.revision, state, await this.localFile(state, deferred.revision))) === "merged";
  }

  /**
   * Gives up an unmaterializable document's claim on the file with local
   * changes it kept at its old path, once the server puts another document
   * there (#390): the file is then no document's, so the merge path keeps it
   * as a `concurrent-create` conflict copy, which the next push sends as a
   * new document, and the other document takes the path. Kept, the file
   * would hold the other document off for good. An edit of the document
   * still pending at that path is dropped first (#391): its content is the
   * file's, which the copy keeps. The claim is then recorded as releaseFile
   * records it (the state `deleted`), so the document materializes as a new
   * one would. Interrupted before the copy is written, the file is untracked
   * at the path, and the push's refused create keeps it as a copy (#267). A
   * document with another operation pending (a delete, or one at another
   * path) keeps its file. Returns whether the claim was given up.
   */
  private async releaseKeptFile(documentId: string): Promise<boolean> {
    const state = await this.journal.getDocument(documentId);
    if (state === undefined || state.deleted) return false;
    const key = this.fileKey(state.path);
    const pending = (await this.journal.listPending()).filter((operation) => operation.documentId === documentId);
    if (pending.some((operation) => operation.deleted || this.fileKey(operation.path) !== key)) return false;
    for (const operation of pending) await this.journal.removePending(operation.revisionId);
    await this.journal.putDocument({ ...state, deleted: true });
    return true;
  }

  /**
   * Gives up the claim on its synced path of a document whose file is not
   * there any more and whose remote revision waits for a reason no pull or
   * push retries (`out-of-scope`, `too-large`, `invalid-path`), once the
   * server puts another document at that path (#379 review): kept, the claim
   * would hold the other document off for good. A document with an operation
   * pending or a merge result recorded keeps its claim: those are retried.
   *
   * If a local rename not yet pushed moved the document's file (the rename
   * waits with the document, SPEC.md §8), the document follows its file, as
   * on-device identity follows the filesystem (#52): its journal state moves
   * to the rename's new path and the rename is dropped, so the path it left
   * is free and no record of the rename points there once the other document
   * is written. Its revision, still deferred for its own reason, then applies
   * to the file where it is. If the file is not there, the new path is out of
   * scope or another live document holds it, the document gives its claim up
   * instead, as when the user deleted its file: like releaseKeptFile, the
   * state is recorded `deleted`, so the revision applies as a new document's
   * would once its own retry rules let it (never taking the other document's
   * file as its local version), and a file at the new path is pushed as a new
   * document. Returns whether the claim was given up.
   */
  private async releaseIdleClaim(documentId: string): Promise<boolean> {
    const deferred = await this.journal.getDeferred(documentId);
    if (deferred === undefined || deferred.merging !== undefined || (deferred.reason !== "out-of-scope" && deferred.reason !== "too-large" && deferred.reason !== "invalid-path")) return false;
    const state = await this.journal.getDocument(documentId);
    if (state === undefined || state.deleted || (await this.vault.stat(state.path)) !== null) return false;
    if ((await this.journal.listPending()).some((operation) => operation.documentId === documentId)) return false;
    const key = this.fileKey(state.path);
    let follow: string | undefined;
    for (const renames of [this.changes.renames, this.roundRenames]) {
      for (const [to, from] of [...renames]) {
        if (this.fileKey(from) !== key) continue;
        renames.delete(to);
        follow ??= to;
      }
    }
    if (follow !== undefined && this.inScope(follow) && (await this.vault.stat(follow)) !== null) {
      const holder = await this.documentAt(follow);
      if (holder === undefined || holder.documentId === documentId) {
        await this.journal.putDocument({ ...state, path: follow });
        return true;
      }
    }
    if (follow !== undefined) this.changes.paths.add(follow);
    await this.journal.putDocument({ ...state, deleted: true });
    return true;
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
    const key = this.fileKey(path);
    const synced = await this.documentAt(path);
    if (synced !== undefined && !(await this.movedAway(synced))) return undefined;
    for (const operation of await this.journal.listPending()) {
      if (this.fileKey(operation.path) === key && !operation.deleted && operation.documentId !== documentId && (await this.journal.getDocument(operation.documentId)) !== undefined) {
        return { documentId: operation.documentId, path: operation.path };
      }
    }
    for (const [to, from] of this.localRenames()) {
      if (this.fileKey(to) !== key) continue;
      const moved = (await this.journal.findDocumentByPath(from)) ?? (await this.pendingCreateAt(from));
      if (moved !== undefined && moved.documentId !== documentId) return { documentId: moved.documentId, path: to };
    }
    return undefined;
  }

  /**
   * The pending create at `path` of a document the journal does not have yet:
   * its content uploaded and its commit not acknowledged (#286). A local
   * rename from `path` moved that document's file, as it would a known one's.
   */
  private async pendingCreateAt(path: string): Promise<PendingOperation | undefined> {
    for (const operation of await this.journal.listPending()) {
      if (operation.path !== path || operation.deleted || operation.baseRevisionId !== "") continue;
      if ((await this.journal.getDocument(operation.documentId)) === undefined) return operation;
    }
    return undefined;
  }

  /**
   * Whether a local move took the document away from its synced path: it
   * has a pending operation at another path, or a local rename from that
   * path not yet pushed, or the user deleted its file since the last push.
   * Paths are compared as the vault compares them.
   */
  private async movedAway(state: DocumentState): Promise<boolean> {
    // The user deleted its file: a file at its path since then is another one (#254).
    if (this.fileDeleted(state)) return true;
    const key = this.fileKey(state.path);
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId === state.documentId && !operation.deleted && this.fileKey(operation.path) !== key) return true;
    }
    for (const [to, from] of this.localRenames()) if (from === state.path && this.fileKey(to) !== key) return true;
    return false;
  }

  /** The local renames not pushed yet: those recorded since the push round began, and those the round has not committed. */
  private localRenames(): [string, string][] {
    return [...this.changes.renames, ...this.roundRenames];
  }

  /** The live document the journal has at `path`, compared as the vault compares paths (its own spelling first). */
  private async documentAt(path: string): Promise<DocumentState | undefined> {
    const exact = await this.journal.findDocumentByPath(path);
    if (exact !== undefined || this.pathRules.platform === "posix") return exact;
    const key = this.fileKey(path);
    return (await this.journal.listDocuments()).find((state) => !state.deleted && this.fileKey(state.path) === key);
  }

  /**
   * Moves the file a local move of `documentId` put at `path` on to a
   * conflict-copy path, as the document's own (SPEC.md §6.3): its pending
   * operations and unpushed rename follow it, so it is committed there under
   * its id. Logged as `path-taken` first, so an interrupted move resumes under
   * the same name. Returns false, moving nothing, if no name fits.
   */
  private async moveAside(documentId: string, path: string): Promise<boolean> {
    const content = await this.readOrNull(path);
    if (content === null) return true;
    const hash = sha256Hex(content);
    // A logged name is reused only while it is free or already holds the
    // file: a file created there since (after a crash) is not this one.
    let copyPath: string | null = null;
    for (const record of await this.journal.listConflicts()) {
      if (record.reason !== "path-taken" || record.documentId !== documentId || record.path !== path || record.copyHash !== hash || record.copyPath === null) continue;
      const there = await this.readOrNull(record.copyPath);
      if (there === null || sha256Hex(there) === hash) {
        copyPath = record.copyPath;
        break;
      }
    }
    if (copyPath === null) {
      copyPath = await this.freeConflictPath(path);
      if (copyPath === null) return false;
      await this.journal.putConflict(this.conflictRecord(documentId, path, "path-taken", copyPath, hash, ""));
    }
    const target = copyPath;
    if ((await this.vault.stat(target)) === null) await this.echoed(this.echoes.expectRename(await this.heldSpelling(path), target), () => this.vault.rename(path, target));
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId !== documentId || operation.path !== path || operation.deleted) continue;
      await this.journal.addPending({ ...operation, revisionId: this.newId(), path: target });
      await this.journal.removePending(operation.revisionId);
    }
    const from = this.changes.renames.get(path) ?? this.roundRenames.get(path);
    if (from !== undefined) {
      this.changes.renames.delete(path);
      this.roundRenames.delete(path);
      // A pending create the rename moved is committed at the copy's path,
      // never at the path its file left (#286). Should the create have
      // landed after all (its response lost), the pull rebases this one
      // onto it (applyRevision).
      const create = await this.pendingCreateAt(from);
      if (create?.documentId === documentId) {
        const copied = await this.readOrNull(target);
        await this.journal.addPending({
          ...create,
          revisionId: this.newId(),
          path: target,
          ...(copied === null ? {} : { contentHash: sha256Hex(copied), size: BigInt(copied.length) }),
        });
        await this.journal.removePending(create.revisionId);
      } else this.changes.renames.set(target, from);
    }
    this.changes.paths.add(target);
    this.schedulePush();
    return true;
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
  private async applyMerge(
    remote: RemoteRevision,
    state: DocumentState | undefined,
    local: { path: string; content: Uint8Array | null },
    outcome: Extract<MergeOutcome, { status: "merged" }>,
  ): Promise<boolean> {
    if (outcome.content !== null && !isVaultRelativePath(outcome.path)) throw new Error(`the merge hook returned a path that is not vault-relative: ${outcome.path}`);
    const current = await this.readOrNull(local.path);
    if (!sameContent(current, local.content)) return false;
    // Another document's file is not this merge's to replace, unless a
    // local rename brought this document's own file there after that
    // document moved away or the user deleted its file (#451): the local
    // rename wins (SPEC.md §7), and the journal keeps this document at the
    // remote path, so it never holds two documents at one path.
    const holder = await this.documentAt(local.path);
    if (holder !== undefined && holder.documentId !== remote.documentId && !(await this.renamedOntoVacated(state, remote, local.path, holder))) return false;
    const copyPaths: string[] = [];
    // A result path that is the document's own file under another spelling
    // (a remote case-only rename on a case-insensitive platform) is no file
    // in the way: the vault holds one file there, the document's, which the
    // rename below respells (#343).
    const respelled = outcome.content !== null && outcome.path !== local.path && this.fileKey(outcome.path) === this.fileKey(local.path);
    // The document's own file, which the result moves away from (or
    // deletes), and its synced path, where the result does not go: neither
    // takes a name from a conflict copy (#319, #299).
    const merged: MergedDocument = {
      documentId: remote.documentId,
      file: current !== null && (outcome.content === null || outcome.path !== local.path) ? local.path : undefined,
      result: outcome.content === null ? null : outcome.path,
    };
    try {
      // A file in the way at the result's new path. If it is no document's, it
      // was created here concurrently with the remote document's move there:
      // the remote document takes the path and the file is kept as a conflict
      // copy. Cleared before the merge is recorded, so a file at the recorded
      // path is always this document's (see followRename).
      if (outcome.content !== null && outcome.path !== local.path && !respelled) {
        const occupant = await this.readOrNull(outcome.path);
        // A known document a local move put there moves on to a
        // conflict-copy path under its own id, as a refused create would.
        const mover = occupant === null || sameContent(occupant, outcome.content) ? undefined : await this.localMoveAt(outcome.path, remote.documentId);
        if (mover !== undefined && !(await this.moveAside(mover.documentId, mover.path))) return false;
        const remaining = mover === undefined ? occupant : await this.readOrNull(outcome.path);
        // A file the journal has as another live document's is that
        // document's, also if its content is the result's (#264, #267).
        const owner = remaining === null ? undefined : await this.documentAt(outcome.path);
        if (owner !== undefined && owner.documentId !== remote.documentId) return false;
        if (remaining !== null && !sameContent(remaining, outcome.content)) {
          if (await this.belongsToDocument(outcome.path)) return false;
          const copyPath = await this.writeConflictCopy(remote, outcome.path, { reason: "concurrent-create", content: remaining }, merged);
          if (copyPath === null) return false;
          copyPaths.push(copyPath);
          this.changes.paths.add(copyPath);
          // The copy now holds the file's content, so its unacknowledged
          // operations (a create not yet committed) are superseded. They go
          // before the file does, so none is ever left pointing at the merged
          // document's file.
          await this.dropOperationsAt(outcome.path, remote.documentId);
          if (!sameContent(await this.readOrNull(outcome.path), remaining)) return false;
          const expectedHash = sha256Hex(remaining);
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(outcome.path)), () => this.vault.delete(outcome.path, { expectedHash }));
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
      }
      if (outcome.content === null) {
        if (current !== null) {
          const expectedHash = sha256Hex(current);
          await this.echoed(this.echoes.expectDelete(await this.heldSpelling(local.path)), () => this.vault.delete(local.path, { expectedHash }));
        }
      } else {
        let there = outcome.path === local.path ? current : await this.readOrNull(outcome.path);
        if (outcome.path !== local.path && current !== null) {
          if (there !== null && !respelled) return false;
          await this.echoed(this.echoes.expectRename(await this.heldSpelling(local.path), outcome.path), () => this.vault.rename(local.path, outcome.path));
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
    const ownFile = state !== undefined && !state.deleted;
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId === remote.documentId) await this.journal.removePending(operation.revisionId);
    }
    if (!ownFile) await this.dropOperationsAt(local.path, remote.documentId);
    await this.journal.putDocument(syncedState(remote));
    await this.journal.removeDeferred(remote.documentId);
    this.changes.paths.add(local.path);
    this.changes.paths.add(outcome.path);
    for (const copyPath of copyPaths) this.changes.paths.add(copyPath);
    // A local rename the merge kept is pushed as a rename of the document.
    if (outcome.content !== null && !remote.deleted && outcome.path !== remote.path) this.changes.renames.set(outcome.path, remote.path);
    // A merge made by a pull is pushed like a local edit.
    this.schedulePush();
    return true;
  }

  /**
   * Whether `path`, which the journal has as `holder`'s, holds the merged
   * document's own file because a local rename of it followed there
   * (followRename) after `holder` moved away or its file was deleted, and
   * the remote revision does not put the document there.
   */
  private async renamedOntoVacated(state: DocumentState | undefined, remote: RemoteRevision, path: string, holder: DocumentState): Promise<boolean> {
    if (state === undefined || state.deleted) return false;
    const key = this.fileKey(path);
    if (this.fileKey(state.path) === key || this.fileKey(remote.path) === key) return false;
    return this.movedAway(holder);
  }

  /**
   * Drops the unacknowledged operations of other documents that put a file at
   * `path`, compared as the vault compares paths (one at `Notes/C.md` put the
   * file at `notes/c.md` on a case-insensitive platform, #242); deletes stay.
   */
  private async dropOperationsAt(path: string, documentId: string): Promise<void> {
    const key = this.fileKey(path);
    for (const operation of await this.journal.listPending()) {
      if (operation.documentId !== documentId && this.fileKey(operation.path) === key && !operation.deleted) await this.journal.removePending(operation.revisionId);
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
    const key = this.fileKey(path);
    for (const operation of await this.journal.listPending()) {
      if (operation.deleted || this.fileKey(operation.path) !== key) continue;
      const state = await this.journal.getDocument(operation.documentId);
      if (state === undefined || state.deleted) {
        await this.journal.removePending(operation.revisionId);
        this.changes.paths.add(operation.path);
      }
    }
  }

  /**
   * Whether the file at `path` is a document's: the journal has a document
   * there, a pending operation of a document the journal knows put it there,
   * or a local rename of a document not yet pushed did. Paths are compared as
   * the vault compares them.
   */
  private async belongsToDocument(path: string): Promise<boolean> {
    if ((await this.documentAt(path)) !== undefined) return true;
    return (await this.localMoveAt(path, "")) !== undefined;
  }

  /**
   * Keeps the local version of a conflict as a copy next to `localPath`
   * (SPEC.md §7). The conflict is logged first, so a copy interrupted by a
   * crash is finished under the same name rather than written twice. Returns
   * the copy's path, or null if no name fits the path limits: the conflict is
   * then logged without a copy and nothing is written, so the local version
   * stays where it is. `merged` is the document the merge rebases (see
   * freeConflictPath).
   */
  private async writeConflictCopy(remote: RemoteRevision, localPath: string, conflict: { reason: ConflictReason; content: Uint8Array }, merged?: MergedDocument): Promise<string | null> {
    const hash = sha256Hex(conflict.content);
    const logged = (await this.journal.listConflicts()).filter((record) => record.documentId === remote.documentId && record.copyHash === hash);
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
      copyPath = await this.freeConflictPath(localPath, undefined, merged);
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

  /**
   * A conflict-copy path for `path` that no file, folder, document, pending
   * operation or logged conflict uses yet, or null if no name fits the path
   * limits. With `folder` (one of `path`'s folders), that folder is what gets
   * the conflict name, and the path keeps its place inside it. Without it, so
   * does the outermost of `path`'s folders that a file takes by path key,
   * since no name inside that folder is free (#359).
   *
   * Paths are compared by path key (SPEC.md §5), as the server compares them,
   * whatever the local platform: a name free only in a case-sensitive vault
   * would be refused again (#243). That also keeps a copy off a file of
   * another spelling on a case-insensitive platform.
   *
   * `merged` is the document a merge rebases onto its remote revision: the
   * server already has it where the remote revision puts it, so neither its
   * own file that the merge moves away from or deletes nor its synced path,
   * where the result does not go, takes a name. Counted, a file `NOTES` would
   * leave no free name in `notes/` for the copy of a file in the way of the
   * document's move to `notes/c.md`, and the move would wait forever (#319).
   * So would its synced path `NOTES` once its file is gone, or once a local
   * rename moved the file into `notes/` (#299).
   */
  private async freeConflictPath(path: string, folder?: string, merged?: MergedDocument): Promise<string | null> {
    const date = this.now();
    const taken = new Set<string>();
    for (const operation of await this.journal.listPending()) taken.add(pathKey(operation.path));
    for (const record of await this.journal.listConflicts()) if (record.copyPath !== null) taken.add(pathKey(record.copyPath));
    const files = await this.knownFileKeys(merged);
    // A folder is any file's ancestor.
    const folders = new Set<string>();
    for (const file of files) for (const ancestor of ancestors(file)) folders.add(ancestor);
    // The merge result's folders are folders whatever else is named like
    // them: a file there by path key (a new file NOTES, next to a result in
    // notes/ under POSIX rules) cannot keep a copy out of them (#352).
    const resultFolders = new Set(merged === undefined || merged.result === null ? [] : ancestors(pathKey(merged.result)));
    const blocks = (ancestor: string) => files.has(ancestor) && !resultFolders.has(ancestor);
    // A file named like one of the path's own folders leaves no free name in
    // that folder (every name there is under the file by path key), so that
    // folder gets the conflict name, as for a refused create: the merge of a
    // remote rename of Notes/C.md to NOTES keeps the local edit at
    // `Notes (conflict …)/C.md` (#359). The outermost such folder, so the
    // copy is under none of them.
    const named = folder ?? ancestors(path).find((ancestor) => blocks(pathKey(ancestor)));
    for (let attempt = 1; attempt <= maxConflictNameAttempts; attempt++) {
      const candidate =
        named === undefined
          ? conflictCopyPath(path, this.deviceName, date, attempt, this.pathRules)
          : conflictFolderPath(named, path.slice(named.length + 1), this.deviceName, date, attempt, this.pathRules);
      if (candidate === null) return null;
      const candidateKey = pathKey(candidate);
      if (taken.has(candidateKey) || files.has(candidateKey) || folders.has(candidateKey) || ancestors(candidateKey).some(blocks)) continue;
      // A file outside the sync scope is not listed, but it is there.
      if (!this.inScope(candidate) && (await this.vault.stat(candidate)) !== null) continue;
      return candidate;
    }
    return null;
  }

  /**
   * The path keys of every file this device knows of: the vault's files, the
   * live documents the journal has, and the paths of remote revisions it
   * holds deferred (documents the server has there, though this vault does
   * not show them). Without `merged`'s file that its merge moves away, nor
   * its synced path unless the merge result goes there.
   */
  private async knownFileKeys(merged?: MergedDocument): Promise<Set<string>> {
    const keys = new Set((await this.vault.list()).filter((path) => path !== merged?.file).map(pathKey));
    for (const state of await this.journal.listDocuments()) {
      if (state.deleted) continue;
      if (state.documentId === merged?.documentId && (merged.result === null || pathKey(state.path) !== pathKey(merged.result))) continue;
      keys.add(pathKey(state.path));
    }
    for (const deferred of await this.journal.listDeferred()) if (!deferred.revision.deleted) keys.add(pathKey(deferred.revision.path));
    return keys;
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
      ...[...this.changes.renames].filter(([, from]) => from === state.path).map(([to]) => to),
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
    const ordered = [...heads.values()].sort((left, right) => (left.remote.seq < right.remote.seq ? -1 : 1));
    for (const incoming of ordered) {
      const { remote } = incoming;
      const state = await this.journal.getDocument(remote.documentId);
      if (state === undefined) {
        this.count(summary, await this.applyRevision(incoming));
      } else if (state.revisionId === remote.revisionId) {
        // Same revision; renumber it, as the restored server's seq values may differ.
        if (state.seq !== remote.seq) await this.journal.putDocument({ ...state, seq: remote.seq });
      } else if (this.outOfScope(remote, state)) {
        this.count(summary, await this.defer(remote, "out-of-scope"));
      } else if (this.overCap(remote)) {
        this.count(summary, await this.defer(remote, "too-large"));
      } else {
        const local = await this.localFile(state, remote);
        this.count(summary, await this.handToMerge(remote, state, local));
      }
    }
    // A document the restored server lacks keeps the old server's seq, under
    // which the restored server's own revisions of it would look applied:
    // seq 0 is no revision of this server (see applyRevision).
    for (const state of await this.journal.listDocuments()) {
      if (!heads.has(state.documentId) && state.seq !== 0n) await this.journal.putDocument({ ...state, seq: 0n });
    }
    await this.journal.resetCursor(seq, anchor);
    summary.cursor = seq;
  }

  private async pushOnce(): Promise<PushSummary> {
    // Classify every vault event so far, so the push sees the latest changes.
    await this.events;
    const summary: PushSummary = { committed: 0, conflicts: 0, pending: 0, rejected: [] };
    for (const path of this.held) this.changes.paths.add(path);
    this.held = new Set();
    await this.finishConflictMoves();
    await this.pullOnce();
    await this.retryMerges();
    await this.retryRefusedPaths();
    for (let round = 0; round < maxPushRounds; round++) {
      const changes = this.changes;
      this.changes = { all: false, paths: new Set(), renames: new Map(), vacated: new Set(), deleted: new Map() };
      this.roundRenames = changes.renames;
      this.roundDeleted = changes.deleted;
      try {
        await this.pushRound(changes, summary, round === 0);
      } catch (error) {
        this.restoreChanges(changes);
        throw error;
      } finally {
        this.roundRenames = new Map();
        this.roundDeleted = new Map();
      }
      if (!this.changes.all && this.changes.paths.size === 0) break;
    }
    summary.pending = (await this.journal.listPending()).length;
    if (this.changes.all || this.changes.paths.size > 0) this.schedulePush();
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
    const parked = await this.parked();
    for (const operation of pending) {
      if (operation.deleted || parked.documents.has(operation.documentId)) continue;
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
          if (state !== undefined && !state.deleted) this.changes.paths.add(state.path);
          this.changes.paths.add(copyPath);
        }
      }
      await this.journal.removePending(operation.revisionId);
      this.changes.paths.add(operation.path);
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

  /** Resumes pending operations (first round only), then records and commits an operation per changed file. */
  private async pushRound(changes: Changes, summary: PushSummary, resume: boolean): Promise<void> {
    let parked = await this.parked();
    if (resume) {
      for (const operation of await this.journal.listPending()) {
        if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) continue;
        // Recorded while its path was in scope: it waits until it is again.
        if (!this.inScope(operation.path)) continue;
        await this.commitOperation(operation, summary);
        parked = await this.parked();
      }
    }
    for (const operation of await this.detectChanges(changes, parked)) {
      // An earlier commit's pull may have handed this document or path to the merge path.
      parked = await this.parked();
      if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) continue;
      // The file is no longer what this round found there: a merge moved it
      // aside, or the user changed it. The next round looks again, with the
      // rename that brought it there if it is still the round's (#280).
      if (!operation.deleted && !sameHash(await this.readOrNull(operation.path), operation.contentHash)) {
        this.changes.paths.add(operation.path);
        const from = changes.renames.get(operation.path);
        if (from !== undefined && !this.changes.renames.has(operation.path)) this.changes.renames.set(operation.path, from);
        continue;
      }
      await this.journal.addPending(operation);
      await this.commitOperation(operation, summary);
    }
  }

  /** Documents and paths the merge path owns, and documents and paths with an operation still pending. */
  private async parked(): Promise<Parked> {
    const parked: Parked = { documents: new Set(), paths: new Set() };
    for (const deferred of await this.journal.listDeferred()) {
      // An unmaterializable document waits too: its local changes are not pushed, and the server never hears of its file.
      // So does one whose remote revision is out of scope, or too large to download.
      if (deferred.reason !== "local-changes" && deferred.reason !== "unmaterializable" && deferred.reason !== "out-of-scope" && deferred.reason !== "too-large") continue;
      const { revision } = deferred;
      parked.documents.add(revision.documentId);
      parked.paths.add(revision.path);
      const state = await this.journal.getDocument(revision.documentId);
      if (state !== undefined && !state.deleted) parked.paths.add(state.path);
    }
    return parked;
  }

  /**
   * The operations that make the server show the changed files, by content
   * hash against the journal's base: deletes and renames first, then edits,
   * then creates, so a path a change frees is free before a create takes it.
   * Paths the merge path owns, and documents and paths with an operation still
   * pending, are left alone: the pending operation goes first, and the disk
   * keeps the newest content for the push after it.
   */
  private async detectChanges(changes: Changes, parked: Parked): Promise<PendingOperation[]> {
    const pending = await this.journal.listPending();
    const busyDocuments = new Set([...parked.documents, ...pending.map((operation) => operation.documentId)]);
    const busyPaths = new Set([...parked.paths, ...pending.map((operation) => operation.path)]);
    const removals: PendingOperation[] = [];
    const edits: PendingOperation[] = [];
    const creates: PendingOperation[] = [];
    const handled = new Set<string>();

    // In a chain (b.md moved to c.md, then a.md to b.md), a rename's old path
    // may hold the file another rename moved there, and its new path may be
    // where a document that moved on is still synced.
    // Compared as the vault compares paths.
    const movedAway = new Set([...changes.renames.values()].map((path) => this.fileKey(path)));
    const movedHere = new Set([...changes.renames.keys()].map((path) => this.fileKey(path)));
    // Documents at a rename's new path whose file the user deleted (#254).
    const displaced: DocumentState[] = [];
    // Paths a rename recorded since this round began moved a file from or
    // to: the next round looks at them, with that rename (#280).
    const later = new Set([...this.changes.renames].flat().map((path) => this.fileKey(path)));
    const renames: PendingOperation[] = [];
    for (const [to, from] of changes.renames) {
      // A move into or out of the sync scope is a create or a delete of the side in it, which the path loop below sees.
      if (!this.inScope(from) || !this.inScope(to)) continue;
      if (later.has(this.fileKey(from)) || later.has(this.fileKey(to))) {
        // Unless a later rename continues it, it goes to the next round as it is.
        if (!this.changes.renames.has(to) && ![...this.changes.renames.values()].includes(from)) this.changes.renames.set(to, from);
        handled.add(from);
        handled.add(to);
        continue;
      }
      const state = await this.journal.findDocumentByPath(from);
      // Not a known document's rename (an untracked file, or a create still
      // pending): the path loop below sees its new path, and a push that
      // fails does not bring it back to start a later chain (#280).
      if (state === undefined) changes.renames.delete(to);
      if (busyPaths.has(from) || busyPaths.has(to) || (state !== undefined && busyDocuments.has(state.documentId))) {
        // Not a known document's rename (an untracked file, or a create still
        // pending): the path loop below sees its new path as usual.
        if (state === undefined) continue;
        // The merge path or a pending operation has the document: the rename
        // waits for a later push, rather than its new path becoming a new
        // document and its old one a delete. The push after whatever frees the
        // document (a merge or a commit, which both queue one) sees it again.
        if (!this.changes.renames.has(to)) this.changes.renames.set(to, from);
        handled.add(from);
        handled.add(to);
        continue;
      }
      if (state === undefined) continue;
      // The file left the old path: a file there now is another one, which
      // the user put there since (#254), and is pushed below.
      const holder = await this.documentAt(to);
      let freed: DocumentState | undefined;
      if (holder !== undefined && holder.documentId !== state.documentId) {
        // The document at the new path moved away too, or the user deleted
        // its file (#254, then it is deleted below). Another spelling of the
        // path that neither explains goes to the server, which refuses it if
        // that document still holds it (SPEC.md §6.3).
        if (movedAway.has(this.fileKey(to)) || this.fileDeleted(holder, [changes.deleted])) freed = holder;
        else if (holder.path === to) continue;
      }
      const content = await this.readOrNull(to);
      if (content === null) continue;
      renames.push(this.operation(state, to, content));
      handled.add(from);
      handled.add(to);
      if (freed === undefined) continue;
      handled.add(freed.path);
      if (!movedAway.has(this.fileKey(to))) displaced.push(freed);
    }
    edits.push(...dependencyOrder(renames, (operation) => changes.renames.get(operation.path)));

    // A file at a path the user vacated since the last push, by a rename
    // away or by deleting the document's file, is a new one (#254): the old
    // document is renamed or deleted under its own id, never given the new
    // file's content. A file there that a rename brought is that rename's.
    const renamed = new Set(renames.map((operation) => operation.documentId));
    const arrived = (path: string) => movedHere.has(this.fileKey(path));
    const replacements = new Map<string, string>();
    for (const operation of renames) {
      const from = changes.renames.get(operation.path);
      if (from === undefined || this.fileKey(from) === this.fileKey(operation.path) || arrived(from)) continue;
      const actual = await this.fileAt(from);
      if (actual !== undefined) replacements.set(this.fileKey(from), actual);
    }
    for (const holder of displaced) {
      if (!renamed.has(holder.documentId)) removals.push(this.operation(holder, holder.path, null));
    }
    const displacedIds = new Set(displaced.map((holder) => holder.documentId));
    for (const state of await this.journal.listDocuments()) {
      const key = this.fileKey(state.path);
      if (state.deleted || renamed.has(state.documentId) || displacedIds.has(state.documentId) || !this.fileDeleted(state, [changes.deleted])) continue;
      if (handled.has(state.path) || busyPaths.has(state.path) || busyDocuments.has(state.documentId) || later.has(key)) {
        // Its delete waits with the document: the push that frees it looks again.
        const file = changes.deleted.get(key);
        if (file !== undefined && !this.changes.deleted.has(key)) this.changes.deleted.set(key, file);
        continue;
      }
      if (!this.inScope(state.path)) continue;
      const actual = await this.fileAt(state.path);
      // No file there: the path loop below pushes the delete.
      if (actual === undefined || arrived(actual)) continue;
      handled.add(state.path);
      handled.add(actual);
      // The same content back: nothing changed.
      if (sameHash(await this.readOrNull(actual), state.baseHash)) continue;
      removals.push(this.operation(state, state.path, null));
      replacements.set(key, actual);
    }
    for (const actual of replacements.values()) {
      if (!this.inScope(actual)) continue;
      const content = await this.readOrNull(actual);
      if (content === null) continue;
      handled.add(actual);
      creates.push({ revisionId: this.newId(), documentId: this.newId(), baseRevisionId: "", path: actual, contentHash: sha256Hex(content), size: BigInt(content.length), kind: this.classify(actual), deleted: false });
    }

    // A rename's paths are looked at even when the rename waited for this
    // push: if it no longer qualifies, its new path is a file like any other.
    const paths = new Set([...changes.paths, ...[...changes.renames].flat()]);
    const tombstones = new Map<string, DocumentState>();
    const documents = await this.journal.listDocuments();
    for (const state of documents) {
      if (state.deleted) {
        const known = tombstones.get(state.path);
        if (known === undefined || known.seq < state.seq) tombstones.set(state.path, state);
      } else if (changes.all) {
        paths.add(state.path);
      }
    }
    if (changes.all) for (const path of await this.vault.list()) paths.add(path);
    if (this.pathRules.platform !== "posix") {
      // On a case-insensitive platform a path of another spelling than a
      // document's names that document's file, never a new one.
      const live = new Map(documents.filter((state) => !state.deleted).map((state) => [this.fileKey(state.path), state.path]));
      // A path no document has names the file the vault holds under its
      // own spelling: a file renamed by case before its first push is one
      // create, at its new spelling (#304).
      const onDisk = new Map((await this.vault.list()).map((path) => [this.fileKey(path), path]));
      for (const path of [...paths]) {
        const own = live.get(this.fileKey(path)) ?? onDisk.get(this.fileKey(path));
        if (own === undefined || own === path) continue;
        paths.delete(path);
        paths.add(own);
      }
    }

    for (const path of [...paths].sort()) {
      if (handled.has(path) || later.has(this.fileKey(path))) continue;
      // Outside the scope, a missing file is no delete and a changed one no edit (SPEC.md §8, config sync).
      if (!this.inScope(path)) continue;
      const state = await this.journal.findDocumentByPath(path);
      if (busyPaths.has(path) || (state !== undefined && busyDocuments.has(state.documentId))) {
        // Looked at again by every later push, until whatever has it is done (#167).
        this.held.add(path);
        continue;
      }
      const content = await this.readOrNull(path);
      if (state !== undefined) {
        if (content === null) removals.push(this.operation(state, state.path, null));
        else if (sha256Hex(content) !== state.baseHash) edits.push(this.operation(state, path, content));
        continue;
      }
      if (content === null) continue;
      // A file where a deleted document was brings that document back (SPEC.md §8, decision #17).
      const tombstone = tombstones.get(path);
      if (tombstone !== undefined && !busyDocuments.has(tombstone.documentId)) {
        edits.push(this.operation(tombstone, path, content));
        continue;
      }
      creates.push({ revisionId: this.newId(), documentId: this.newId(), baseRevisionId: "", path, contentHash: sha256Hex(content), size: BigInt(content.length), kind: this.classify(path), deleted: false });
    }
    return [...removals, ...edits, ...creates];
  }

  /** The file the vault holds at `path`, under the spelling it has (on a case-insensitive platform, possibly another one), if any. */
  private async fileAt(path: string): Promise<string | undefined> {
    if ((await this.readOrNull(path)) === null) return undefined;
    if (this.pathRules.platform === "posix") return path;
    const key = this.fileKey(path);
    return (await this.vault.list()).find((candidate) => this.fileKey(candidate) === key) ?? path;
  }

  /** A new revision of a known document: `content` at `path`, or a tombstone (null). */
  private operation(state: DocumentState, path: string, content: Uint8Array | null): PendingOperation {
    return {
      revisionId: this.newId(),
      documentId: state.documentId,
      baseRevisionId: state.revisionId,
      path,
      contentHash: content === null ? state.baseHash : sha256Hex(content),
      size: content === null ? state.size : BigInt(content.length),
      kind: state.kind,
      deleted: content === null,
    };
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
      await this.journal.removePending(operation.revisionId);
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
        await this.journal.removePending(operation.revisionId);
        this.changes.paths.add(operation.path);
        if (state !== undefined && !state.deleted) this.changes.paths.add(state.path);
        return;
      }
      summary.rejected.push({ operation, reason: problem, error: new ConnectError(`the server refuses this path (${problem})`, Code.InvalidArgument) });
      return;
    }
    // A rename or delete keeps the base's content, which the server already holds.
    const keepsContent = state !== undefined && state.revisionId === operation.baseRevisionId && state.baseHash === operation.contentHash;
    const upload = () => uploadContent(this.api, this.vaultId, operation.contentHash, operation.size, () => (operation.deleted ? Promise.resolve(null) : this.readOrNull(operation.path)));
    const contentMissing = async () => {
      // The file changed before its content was uploaded, so this revision
      // was never committed (the server commits only complete blobs). The
      // file's current content replaces it.
      await this.journal.removePending(operation.revisionId);
      this.changes.paths.add(operation.path);
      // A rename the operation carried goes on to the next round with the
      // file, unless the user moved the file on since (that later rename
      // carries it). Dropped, the file at the new path would be a new
      // document, and the old one would stay where its file was (#286).
      if (state === undefined || state.deleted || operation.deleted || this.fileKey(state.path) === this.fileKey(operation.path)) return;
      this.changes.paths.add(state.path);
      const from = this.roundRenames.get(operation.path) ?? state.path;
      if (!this.changes.renames.has(operation.path) && ![...this.changes.renames.values()].includes(from) && (await this.readOrNull(operation.path)) !== null) {
        this.changes.renames.set(operation.path, from);
      }
    };
    if (!keepsContent && (await upload()) === "missing") {
      await contentMissing();
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
            await contentMissing();
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
    await this.journal.putDocument({
      documentId: operation.documentId,
      path: operation.path,
      revisionId: revision.id,
      seq: revision.seq,
      baseHash: operation.contentHash,
      size: operation.size,
      kind: operation.kind,
      deleted: operation.deleted,
    });
    await this.journal.removePending(operation.revisionId);
    if (state !== undefined && !operation.deleted) this.carryDelete(operation.documentId, state.revisionId, revision.id);
    // The document moved: a local rename not pushed yet is from its new path now (#280).
    if (state !== undefined && !state.deleted && !operation.deleted && state.path !== operation.path) {
      if (this.roundRenames.get(operation.path) === state.path) this.roundRenames.delete(operation.path);
      for (const [to, from] of this.changes.renames) {
        if (from !== state.path) continue;
        if (to === operation.path) this.changes.renames.delete(to);
        else this.changes.renames.set(to, operation.path);
      }
    }
    await this.advancePastOwnCommit(revision);
    summary.committed++;
    // Changes made while the operation was pending were left for after it.
    this.changes.paths.add(operation.path);
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
    const parked = await this.parked();
    if (!pending.some((candidate) => candidate.revisionId === operation.revisionId)) {
      // The pull resolved it. If it moved the document aside for the other
      // document (a local rename onto that one's path), the document's
      // operation now stands at the conflict-copy path: committed there.
      const moved = pending.find((candidate) => candidate.documentId === operation.documentId && !candidate.deleted);
      if (moved !== undefined && !parked.documents.has(moved.documentId) && !parked.paths.has(moved.path)) await this.commitOperation(moved, summary);
      return;
    }
    if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) return;
    const conflicts = await this.journal.listConflicts();
    const movedHere = (path: string) => conflicts.find((record) => record.reason === "path-taken" && record.documentId === operation.documentId && record.copyPath === path);
    if (movedHere(operation.path) !== undefined && !(await this.takenByAnother(operation.path, operation.documentId))) {
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
    const holder = await this.documentAt(operation.path);
    const found = await this.readOrNull(operation.path);
    const othersFile = found !== null && holder !== undefined && holder.documentId !== operation.documentId;
    const atPath = othersFile ? null : found;
    if (record === undefined) {
      if (atPath === null) {
        // Nothing to move: the file is gone (the user deleted or moved it),
        // so the operation can never commit and nothing of it is left to
        // keep. It is dropped, and the next push looks at its paths again.
        await this.journal.removePending(operation.revisionId);
        this.changes.paths.add(operation.path);
        const state = await this.journal.getDocument(operation.documentId);
        if (state !== undefined && !state.deleted) this.changes.paths.add(state.path);
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
      // of the folder, so that is what moves.
      const copyPath = await this.freeConflictPath(origin, await this.takenFolder(origin));
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
      await this.echoed(this.echoes.expectRename(await this.heldSpelling(operation.path), copyPath), () => this.vault.rename(operation.path, copyPath));
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
    await this.journal.removePending(operation.revisionId);
    this.changes.paths.add(operation.path);
    // A remote document the file was in the way of (a file where it needs a
    // folder, or the reverse) may now fit, and so may the merge of a remote
    // rename there, deferred with the user's edit (#307).
    await this.retryRefusedPaths(true);
    await this.retryMerges();
    await this.commitOperation(replacement, summary);
  }

  /**
   * Whether a document other than `documentId` that this device knows of (a
   * live one the journal has, or a deferred remote revision) holds `path` by
   * path key, as a file or as a folder, or holds one of its folders as a
   * file: what the server refuses `path` for (SPEC.md §5, §6.3).
   */
  private async takenByAnother(path: string, documentId: string): Promise<boolean> {
    const key = pathKey(path);
    const folders = new Set(ancestors(key));
    const collides = (other: string) => {
      const otherKey = pathKey(other);
      return otherKey === key || folders.has(otherKey) || otherKey.startsWith(`${key}/`);
    };
    for (const state of await this.journal.listDocuments()) if (state.documentId !== documentId && !state.deleted && collides(state.path)) return true;
    for (const { revision } of await this.journal.listDeferred()) if (revision.documentId !== documentId && !revision.deleted && collides(revision.path)) return true;
    return false;
  }

  /**
   * The folder of `path` that another live document's path takes, ignoring
   * case and Unicode form (`notes` for a local `notes/c.md` when a remote
   * document is the file `notes`): a document this device synced, or a remote
   * revision it holds deferred, whatever the reason. A deferred revision is
   * where the server has its document, so it is in the way just the same:
   * one the vault refused, or a remote rename onto the folder's name whose
   * merge waits on the folder this path keeps (#307). The same files
   * freeConflictPath keeps a copy out of, so a folder copy name is found
   * whenever a file copy name cannot be.
   */
  private async takenFolder(path: string): Promise<string | undefined> {
    const folders = ancestors(path);
    if (folders.length === 0) return undefined;
    const keys = new Set<string>();
    for (const state of await this.journal.listDocuments()) if (!state.deleted) keys.add(pathKey(state.path));
    for (const deferred of await this.journal.listDeferred()) if (!deferred.revision.deleted) keys.add(pathKey(deferred.revision.path));
    return folders.find((folder) => keys.has(pathKey(folder)));
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
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason === "unmaterializable" && !this.retried.has(deferred.revision.revisionId)) await this.releaseFile(deferred.revision.documentId);
    }
    if (deferrals.length === 0) return;
    const files = new Set(await this.vault.list());
    const folders = new Set([...files].flatMap((file) => ancestors(file)));
    for (const deferred of deferrals) {
      const { path } = deferred.revision;
      if (!deferred.revision.deleted && (folders.has(path) || ancestors(path).some((ancestor) => files.has(ancestor)))) continue;
      this.retried.add(deferred.revision.revisionId);
      const outcome = await this.applyRevision({ remote: deferred.revision, pathAllowed: true });
      // Already superseded: a newer revision of the document was applied.
      if (outcome === "skipped") await this.journal.removeDeferred(deferred.revision.documentId);
    }
  }

  private restoreChanges(changes: Changes): void {
    this.changes.all ||= changes.all;
    for (const path of changes.paths) this.changes.paths.add(path);
    for (const [to, from] of changes.renames) if (!this.changes.renames.has(to)) this.changes.renames.set(to, from);
    // Only where the restored rename is still the one recorded there.
    for (const path of changes.vacated) if (this.changes.renames.get(path) === changes.renames.get(path)) this.changes.vacated.add(path);
    for (const [key, file] of changes.deleted) if (!this.changes.deleted.has(key)) this.changes.deleted.set(key, file);
  }

  /**
   * Whether the user deleted `state`'s file since the last push (#254), so a
   * file at its path now is another one. A delete recorded at another
   * revision of the document is stale: the engine has written the document
   * since (a remote revision that brought it back, say).
   */
  private fileDeleted(state: DocumentState, marks: readonly Map<string, DeletedFile>[] = [this.changes.deleted, this.roundDeleted]): boolean {
    const key = this.fileKey(state.path);
    return marks.some((deleted) => {
      const file = deleted.get(key);
      return file !== undefined && file.documentId === state.documentId && file.revisionId === state.revisionId;
    });
  }

  /**
   * Whether the file at `path` is a document's own file: the journal's live
   * document there that no local move took away and whose file the user did
   * not delete, or a pending operation's there (a create the running push
   * round commits, say). A file the user created there since is no
   * document's: moved away, it is a new file, never the document's rename
   * (#303), also when another device's document arrives at `path` before
   * the push.
   */
  private async ownFileAt(path: string): Promise<boolean> {
    try {
      const key = this.fileKey(path);
      // A local rename took that file away already: this one came after it.
      if (this.localRenames().some(([, from]) => this.fileKey(from) === key)) return false;
      if ((await this.journal.listPending()).some((operation) => !operation.deleted && this.fileKey(operation.path) === key)) return true;
      const state = await this.documentAt(path);
      return state !== undefined && !(await this.movedAway(state));
    } catch {
      // In doubt, a rename like any other.
      return true;
    }
  }

  /**
   * The known document whose own file a user's delete of `path` removed: the
   * journal's live document there, unless a local move took it away (then
   * the file was another one).
   */
  private async deletedFile(path: string): Promise<DeletedFile | undefined> {
    try {
      const state = await this.documentAt(path);
      if (state === undefined || (await this.movedAway(state))) return undefined;
      const key = this.fileKey(path);
      if (this.localRenames().some(([to]) => this.fileKey(to) === key)) return undefined;
      return { documentId: state.documentId, revisionId: state.revisionId };
    } catch {
      // In doubt, a delete like any other: a later file at the path is pushed as before.
      return undefined;
    }
  }

  /**
   * The path of the live document whose file the vault holds at `path` under
   * another spelling (a case-only rename lost to a restart, say), on a
   * case-insensitive platform; undefined if the spelling is the document's
   * own, no document has the file, or the filesystem could hold both
   * spellings as two files.
   */
  private async syncedSpelling(path: string): Promise<string | undefined> {
    if (this.pathRules.platform === "posix") return undefined;
    try {
      const state = await this.documentAt(path);
      if (state === undefined || state.path === path) return undefined;
      // Decided from the two spellings alone, never from what the vault holds
      // now: events arrive late, so the vault may already show later actions.
      // Path keys fold more than the filesystem (ß and SS; NFC/NFD on Windows):
      // two such spellings can be two files, so the one at `path` is not the
      // document's (decision #52).
      return sameFilesystemName(state.path, path, this.pathRules.platform) ? state.path : undefined;
    } catch {
      // In doubt, the rename is recorded from the vault's spelling, as before.
      return undefined;
    }
  }

  /** A delete of the document's file the user made before this device's own commit of it landed is still the user's, at the commit's revision. */
  private carryDelete(documentId: string, from: string, to: string): void {
    for (const deleted of [this.changes.deleted, this.roundDeleted]) {
      for (const file of deleted.values()) if (file.documentId === documentId && file.revisionId === from) file.revisionId = to;
    }
  }

  /**
   * Records a vault event for the next push. For a rename, `own` says whether
   * the file was a document's own file where it was moved from, and `synced`
   * is that document's path when the vault spelled it otherwise (a case-only
   * rename lost to a restart, on a case-insensitive platform): the rename is
   * that document's, from its path (#374).
   */
  private recordChange(event: VaultEvent, deleted?: DeletedFile, own = true, synced?: string): void {
    this.changes.paths.add(event.path);
    if (event.type === "rename") {
      this.changes.paths.add(event.oldPath);
      // a -> b -> c is one rename of the document synced at a, unless the file at b was deleted in between,
      // also while the running push round commits a -> b (until it lands, see commitOperation).
      const vacated = this.changes.vacated.has(event.oldPath);
      const origin = vacated ? event.oldPath : (this.changes.renames.get(event.oldPath) ?? this.roundRenames.get(event.oldPath) ?? synced ?? event.oldPath);
      if (!vacated) this.changes.renames.delete(event.oldPath);
      this.changes.vacated.delete(event.path);
      // A file that was no document's own file where it was moved from is a
      // new file at its new path, never a rename of the document the
      // journal has (or later gets) at its old path (#303).
      if (origin === event.oldPath && !own) {
        this.changes.renames.delete(event.path);
      } else if (origin !== event.path) this.changes.renames.set(event.path, origin);
      // The file is back where it was synced: it was never deleted.
      else this.changes.deleted.delete(this.fileKey(event.path));
    } else if (event.type === "delete" && this.changes.renames.has(event.path)) {
      // The file a rename put here is gone: a later file here is another one, never part of that rename (#280).
      this.changes.vacated.add(event.path);
    } else if (deleted !== undefined && !this.changes.deleted.has(this.fileKey(event.path))) {
      this.changes.deleted.set(this.fileKey(event.path), deleted);
    }
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

  private async handleEvent(event: VaultEvent): Promise<void> {
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
    if (event.type === "rename") {
      const own = await this.ownFileAt(event.oldPath);
      this.recordChange(event, undefined, own, own ? await this.syncedSpelling(event.oldPath) : undefined);
    }
    else this.recordChange(event, event.type === "delete" ? await this.deletedFile(event.path) : undefined);
    try {
      this.onLocalChange(event);
    } catch (error) {
      // Keep classifying later events; surface the listener's error without swallowing it.
      setTimeout(() => {
        throw error;
      });
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

/** The folders `path` is in, outermost first. */
function ancestors(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * Renames ordered so that a document moves onto a path only after the
 * document synced there moved away (`fromOf` gives a rename's old path). In a
 * cycle (two files swapped) the rest go in their own order: the server refuses
 * one, which then moves to a conflict-copy path (SPEC.md §6.3).
 */
function dependencyOrder(operations: readonly PendingOperation[], fromOf: (operation: PendingOperation) => string | undefined): PendingOperation[] {
  const ordered: PendingOperation[] = [];
  let remaining = [...operations];
  while (remaining.length > 0) {
    const ready = remaining.filter((operation) => !remaining.some((other) => other !== operation && fromOf(other) === operation.path));
    const next = ready.length > 0 ? ready : remaining;
    ordered.push(...next);
    remaining = remaining.filter((operation) => !next.includes(operation));
  }
  return ordered;
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
