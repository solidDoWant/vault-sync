import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { sha256Hex } from "../hash";
import type { ConflictReason, ConflictRecord, DeferReason, DeferredRevision, DocumentKindName, DocumentState, Intent, Journal, JournalChanges, PendingOperation, RemoteRevision } from "../journal/journal";
import { uuidv7 } from "../uuid";
import { isVaultError, type DeletePrecondition, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { posixPathRules, unmaterializableReason, type PathRules, type UnmaterializableCause } from "../vaultpath/platform";
import { isVaultRelativePath, pathProblem, type PathProblem } from "../vaultpath/vaultpath";
import { EchoSuppressor } from "./echo";
import { blobMissing, errorCode, headMoved } from "./errors";
import { commitRestore, documentHistory, readRevision, restorePathProblem, type HistoryEntry, type HistoryPage } from "./history";
import { threeWayMerge, type MergeHook, type MergeOutcome } from "./merge";
import { Bindings, hasBase, liveHere, type BindingChange } from "./bindings";
import { oneFileOnDisk, PathClaims, type CopyNaming, type Exempt } from "./claims";
import { PathSpace } from "./pathspace";
import { movedBeforeDelete, ruleW } from "./decide";
import { Intents } from "./intents";
import { busyClaims, ghost, planPush, type Busy, type DirtyPaths } from "./push-plan";
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

/** A conflict copy a `merge` intent writes: `content` (hash `hash`) at `path`, moved from the file at `from` if set (a file in the way of the result). */
interface MergeCopy {
  path: string;
  hash: string;
  content: Uint8Array;
  record: ConflictRecord;
  from?: string;
}

/**
 * The steps of a `merge` intent (design §4.4): the document's file as the
 * merge hook was given it (`local`, hash null for none), the copies, and
 * the result at `result.path` (hash null for a delete). `respelled`: the
 * result's path is the local file under another spelling of one file.
 * `adopts`: the local file is an untracked one the merge takes. A merge
 * recorded by a journal before R8 has no `content`, `local` hash or copies.
 */
interface MergeSteps {
  revision: RemoteRevision;
  local: { path: string; hash: string | null };
  result: { path: string; hash: string | null; content?: Uint8Array | null };
  respelled: boolean;
  adopts: boolean;
  copies: MergeCopy[];
  /** Migrated from a `merging` marker (journal v6): finished only if the disk shows the result. */
  legacy?: boolean;
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
  /** The feed revision the pull is applying, whose step's final transaction moves the cursor (feedCursor). */
  private feed: { revisionId: string; seq: bigint; anchor: Uint8Array | undefined } | undefined;
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
      recoverApply: (intent) => this.recoverApply(intent),
      recoverMerge: (intent) => this.recoverMerge(intent),
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

  /**
   * The file a document keeps on this device while its remote revision
   * waits: its bound file, if the vault has it. A tombstone's bound file is
   * the user's change that brings it back (localVersion).
   */
  private async keptFile(state: DocumentState | undefined): Promise<string | undefined> {
    const spelling = state?.binding?.spelling;
    if (state === undefined || spelling === undefined || !this.inScope(spelling)) return undefined;
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
        anchor = cursorAnchor(revision);
        // The step that applies, merges or defers the revision moves the
        // cursor in its own final transaction (feedCursor); one that changes
        // nothing leaves it to here.
        const feed = { revisionId: revision.id, seq: revision.seq, anchor };
        this.feed = feed;
        try {
          this.count(summary, await this.applyRevision(toIncoming(revision)));
          if (this.feed === feed) await this.journal.setCursor(revision.seq, anchor);
        } finally {
          this.feed = undefined;
        }
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
      // The `commit` step's final transaction (design §4.4): the outbox goes
      // with the base's move and the cursor's.
      const done: JournalChanges = { removePending: [remote.revisionId], ...this.feedCursor(remote.revisionId) };
      if (state?.revisionId !== remote.revisionId) await this.putDocument(syncedState(remote), { kind: "acknowledged", hash: remote.contentHash }, done);
      else await this.bindings.transact(() => Promise.resolve(done));
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
    // Applied or merged already: each step removes the revision's deferral
    // in its own final transaction (design §4.4), so none is left over.
    if (state?.revisionId === remote.revisionId) return "skipped";
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
      return this.defer(remote, "too-large");
    }
    if (deferred?.reason === "local-changes" || pending.length > 0) {
      return this.handToMerge(remote, state);
    }
    if (state !== undefined && remote.seq <= state.seq) return "skipped";
    // A resync found the server had lost this document (seq 0): the content
    // here may exist nowhere else, so a new revision is merged, not applied.
    if (state !== undefined && state.seq === 0n && liveHere(state)) return this.handToMerge(remote, state);
    if (!remote.deleted && !incoming.pathAllowed) return this.defer(remote, "invalid-path");
    const unmaterializable = remote.deleted ? undefined : unmaterializableReason(remote.path, this.pathRules);
    if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);

    // The path claim (design §4.5 step 3): another document's file in the
    // way of the revision's path moves by rule W, or the revision waits for
    // it, listed. Not for a document whose file a local move put elsewhere:
    // its local rename wins, so the merge path decides where its result
    // lands, and claims that path (applyMerge, #473).
    if (!remote.deleted && !movedLocally(state)) {
      const claim = await this.claimPath(remote.path, remote.documentId);
      if (claim === "alias") return this.deferUnmaterializable(remote, "alias");
      if (claim === "held") return this.defer(remote, "path-conflict");
    }

    // Download before looking at the disk, so the check-then-write window is short.
    const needsContent = !remote.deleted && (!liveHere(state) || state.baseHash !== remote.contentHash);
    const content = needsContent ? await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size) : undefined;

    const inspection = await this.inspect(state, remote);
    if (inspection.kind === "dirty") return this.handToMerge(remote, state);
    // The `apply` intent (design §4.4, PO-8), recorded before the disk
    // changes: a file the apply wrote before a crash is the document's, never
    // an untracked one (#392), and its recovery finishes it (recoverApply).
    let intent: number | undefined;
    try {
      if (inspection.kind === "clean") {
        intent = await this.journal.putIntent({ kind: "apply", documentId: remote.documentId, steps: { revision: remote } });
        await this.writeToDisk(remote, inspection, content);
      } else if (!remote.deleted) await this.takeServerSpelling(remote.path, remote.documentId);
    } catch (error) {
      const open = intent;
      if (open !== undefined) await this.bindings.transact(() => Promise.resolve({ removeIntents: [open] }));
      if (isVaultError(error, "path-conflict") || isVaultError(error, "already-exists")) return this.defer(remote, "path-conflict");
      if (isVaultError(error, "unmaterializable")) return this.deferUnmaterializable(remote, "refused-by-vault");
      if (isVaultError(error, "changed") && inspection.kind === "clean") {
        // Saved locally after inspect() checked it (Obsidian's autosave,
        // say; #163): a local change, so the merge path gets what is there now.
        return this.handToMerge(remote, state);
      }
      throw error;
    }
    if (inspection.kind === "applied" && !remote.deleted) {
      // The file is taken for the document as it is (design §4.5 step 3,
      // adoption): a local create bound to it, with identical content, is
      // superseded. Left pending, it would later claim this document's file
      // and move it away under its own id (#242). Dropped before the journal
      // update: interrupted in between, the pull applies the revision again
      // and finds the file applied.
      await this.supersedeCreates(remote.path, remote.documentId);
    }
    await this.finishApply(remote, intent);
    return "applied";
  }

  /**
   * The `apply` step's final transaction (design §4.4): the base and the
   * binding move to `remote`, a deferral of the document goes (a newer
   * revision supersedes one deferred for its path, or this is the deferred
   * one, applied by a retry after the cursor passed it), the cursor moves
   * when the pull is applying it from the feed, and the intent goes.
   */
  private async finishApply(remote: RemoteRevision, intent: number | undefined): Promise<void> {
    await this.putDocument(syncedState(remote), { kind: "applied" }, { removeDeferred: [remote.documentId], removeIntents: intent === undefined ? [] : [intent], ...this.feedCursor(remote.revisionId) });
  }

  /**
   * Recovers an `apply` intent a crash left open (design §4.4): if the disk
   * shows the revision (its content at its path, or for a tombstone no file
   * of the document's left), the apply is finished; otherwise it is dropped,
   * and the pull applies the revision again, as the cursor did not pass it
   * (or its deferral is still there).
   */
  private async recoverApply(intent: Intent): Promise<void> {
    const remote = (intent.steps as { revision: RemoteRevision }).revision;
    const state = await this.journal.getDocument(remote.documentId);
    let done: boolean;
    if (remote.deleted) {
      const binding = state?.binding;
      done = binding == null || (await this.vault.stat(binding.spelling)) === null;
    } else {
      done = sameHash(await this.readOrNull(remote.path), remote.contentHash);
    }
    if (done && state?.revisionId !== remote.revisionId) await this.finishApply(remote, intent.id);
    else await this.bindings.transact(() => Promise.resolve({ removeIntents: [intent.id] }));
  }

  /**
   * The path claim of design §4.5 step 3, for `path`, which the server gives
   * `documentId`: rule W (decide.ts, ruleW; PO-4) for every other known
   * document whose file is in the way (PathClaims.fileHolders: one file
   * key, folders included), and for every document the server lost whose
   * synced path collides with it under the server's key. A document moved
   * aside keeps its bytes, under its own id (displace) or as an untracked
   * copy (detach); no file is ever deleted to free a path. Returns true if
   * "held" if the path stays another document's (W(c)), or no copy name
   * fits: the revision then waits, listed as `path-conflict`. Returns
   * "alias" if another live document's file holds the path's one file name
   * under another server key: the revision is unmaterializable here then
   * (ruleW, `alias`). Returns "free" once the path is clear.
   *
   * A create not acknowledged yet holds its file as an untracked file does:
   * the merge path keeps it as a conflict copy, or takes it if its content
   * is the revision's (supersedeCreates).
   */
  private async claimPath(path: string, documentId: string): Promise<"free" | "held" | "alias"> {
    const resolved = new Set<string>();
    // Each turn moves one holder away, or resolves one once.
    for (let turn = 0; turn < 16; turn++) {
      const holder = await this.nextHolder(path, documentId);
      if (holder === undefined) {
        await this.dropStaleOutboxes(path, documentId);
        return "free";
      }
      const { state, spelling } = holder;
      const ahead = await this.journal.getDeferred(state.documentId);
      const outbox = (await this.journal.listPending()).filter((operation) => operation.documentId === state.documentId);
      const move = ruleW(state, ahead, outbox, path, this.pathSpace);
      if (move === "keep" || move === "alias") return move === "keep" ? "held" : "alias";
      if (move === "resolve") {
        // W(b): the holder's own remote revision first, which may move its
        // file away. If the merge path cannot finish it now (the hook
        // deferred, or it is being merged further up), the holder keeps the
        // path and this revision waits, listed: the merge is retried on
        // every push, and detaching would cut the holder's local edit off
        // its history (design §4.5, as amended in R7b).
        if (ahead === undefined || resolved.has(state.documentId) || this.resolving.has(state.documentId)) return "held";
        resolved.add(state.documentId);
        await this.handToMerge(ahead.revision, state);
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
      // The copy name stays clear of the path too, which the journal does not hold yet.
      const claims = (await PathClaims.load(this.pathSpace, this.journal, this.vault)).with([{ kind: "server-newer", path, documentId }]);
      // A document the server lost keeps its file where it is if that is not
      // in the way: neither of `path` nor of another document the server has
      // under the server's key, which would refuse its create there (C3).
      const serverHolder = claims.serverHolder(spelling);
      const inTheWay = move !== "recreate" || this.pathSpace.collides(spelling, path, "server") || this.pathSpace.collides(spelling, path, "file") || (serverHolder !== undefined && serverHolder !== state.documentId);
      const keeps = move === "displace" || move === "recreate";
      let copy: string | null = spelling;
      if (inTheWay) {
        copy = await claims.freeCopyName(spelling, this.copyNaming(), { documentId: keeps ? state.documentId : "", file: spelling, result: null });
      }
      if (copy === null) return "held";
      const record = this.conflictRecord(state.documentId, spelling, "path-taken", copy, "", "");
      const moved = keeps ? await this.intents.displace(state.documentId, spelling, copy, record, move === "recreate") : await this.intents.detach(state.documentId, spelling, copy, record);
      if (!moved) return "held";
      this.schedulePush();
    }
    return "held";
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
    // content is the revision's, supersedeCreates), unless a local rename moved
    // it: that is a local move of a document, as a known one's is (#286).
    // So is the create of a document the server lost, which this device
    // synced revisions of (DocumentState.prior; design §4.6): its content is
    // that document's, never a new one's.
    const created = new Map<string, string>();
    for (const operation of await this.journal.listPending()) if (operation.baseRevisionId === "" && !operation.deleted) created.set(operation.documentId, operation.path);
    for (const state of documents) {
      const binding = state.binding;
      if (state.documentId === documentId || binding === undefined || binding === null || !this.pathSpace.collides(binding.spelling, path, "file")) continue;
      if (!hasBase(state) && (state.prior ?? []).length === 0 && created.get(state.documentId) === binding.spelling) continue;
      if ((await this.vault.stat(binding.spelling)) === null) continue;
      return { state, spelling: binding.spelling };
    }
    // The create of a document the server lost, which a displace re-created
    // (DocumentState.prior), at a spelling the server would refuse once
    // `path` is `documentId`'s: it yields, as the document would (design §4.6).
    for (const state of documents) {
      const binding = state.binding;
      if (state.documentId === documentId || hasBase(state) || (state.prior ?? []).length === 0 || binding == null || created.get(state.documentId) !== binding.spelling) continue;
      if (!this.pathSpace.collides(binding.spelling, path, "server") || (await this.vault.stat(binding.spelling)) === null) continue;
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
    // platform, but only if the vault holds the two spellings as one file
    // (oneFileOnDisk): on NTFS or APFS `straße/` and `STRASSE/` are two
    // folders, so that is a rename, and an edit at the synced path is the
    // note's (#447).
    if (await oneFileOnDisk(this.pathSpace, this.vault, basePath, target)) {
      // The server respelled the file, and the user did not (its binding is
      // at the synced spelling): the apply renames it (design §4.4 `apply`).
      // A spelling the user gave it stays, as the local rename wins (#304).
      const respell = target !== basePath && (state?.binding?.spelling ?? basePath) === basePath;
      if (targetHash === remote.contentHash && !(respell && baseOnDisk)) return { kind: "applied" };
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
    await this.takeServerSpelling(remote.path, remote.documentId);
    await this.echoed(this.echoes.expectWrite(await this.heldSpelling(remote.path), remote.contentHash), () => this.vault.write(remote.path, content, { expectedHash }));
  }

  /**
   * Gives the file the vault holds at `path` under another spelling of one
   * file (`Notes.md` for `notes.md` on a case-insensitive platform) the
   * spelling `path`, before the engine writes `documentId`'s revision or
   * merge result there (design §4.4 `apply`): a write keeps the file's name,
   * and the file would not show the server's path. The spelling the
   * document's binding names is the user's (a case-only rename, E1), which
   * a local rename keeps (#304, PO-9).
   */
  private async takeServerSpelling(path: string, documentId: string): Promise<void> {
    if (this.pathRules.platform === "posix" || (await this.vault.stat(path)) === null) return;
    const held = await this.heldSpelling(path);
    if (held === path || (await this.journal.getDocument(documentId))?.binding?.spelling === held) return;
    await this.echoed(this.echoes.expectRename(held, path), () => this.renameFile(held, path));
  }

  /**
   * The spelling the vault holds the file at `path` under, for an echo
   * expectation of a change the engine is about to make there (SPEC.md §8):
   * `path` itself if the vault lists it, otherwise the listed spelling the
   * filesystem takes for the same file (`F`, PO-10), otherwise `path`. The
   * expectation then matches events exactly, so a user's change of another
   * file whose spelling merely has the same path key is never taken for the
   * engine's (#380), and the engine's change of `Straße.md` beside
   * `STRASSE.md`, or of NFC `Café.md` beside NFD `Café.md` on Windows, two
   * files with one file key, is expected at its own spelling (#738). A vault
   * that folds more than `F` (the folded `InMemoryVault`, X-18) is asked
   * whether it holds `path` at all: if so, under the one listed spelling with
   * its file key.
   */
  private async heldSpelling(path: string): Promise<string> {
    if (this.pathRules.platform === "posix") return path;
    const listed = await this.vault.list();
    if (listed.includes(path)) return path;
    const oneFile = listed.filter((candidate) => this.pathSpace.oneFile(candidate, path));
    if (oneFile.length > 0) return oneFile.length === 1 ? (oneFile[0] ?? path) : path;
    if ((await this.vault.stat(path)) === null) return path;
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

  private async handToMerge(remote: RemoteRevision, state: DocumentState | undefined): Promise<"deferred" | "merged"> {
    this.resolving.add(remote.documentId);
    try {
      return await this.mergeRevision(remote, state);
    } finally {
      this.resolving.delete(remote.documentId);
    }
  }

  private async mergeRevision(remote: RemoteRevision, state: DocumentState | undefined): Promise<"deferred" | "merged"> {
    // A merge a crash interrupted was finished or dropped before this pull
    // or push (Intents.recover, recoverMerge), so the document's state is
    // its own again.
    const local = await this.localVersion(state, remote);
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
          return this.mergeRevision(remote, detached);
        }
      }
      if (unmaterializable !== undefined) return this.deferUnmaterializable(remote, unmaterializable);
    }
    try {
      const applied = outcome.status === "merged" ? await this.applyMerge(remote, state, local, outcome) : false;
      // Rule W left the result's path another document's (W(c)): the revision waits, listed.
      if (applied === "held") return await this.defer(remote, "path-conflict");
      // Another live document's file holds the result's one file name: unmaterializable here (ruleW).
      if (applied === "alias") return await this.deferUnmaterializable(remote, "alias");
      if (applied) return "merged";
    } catch (error) {
      if (isVaultError(error, "unmaterializable")) return this.deferUnmaterializable(remote, "refused-by-vault");
      throw error;
    }
    return this.defer(remote, "local-changes");
  }

  /**
   * The document's local version for the merge path (design §4.5 step 4),
   * from its binding alone: its own file, the one its binding names (a
   * local rename moved it there, the user's spelling included), or none if
   * the user deleted it (`absence = user-deleted`). A document with no file
   * of its own here (a new one, a tombstone, one whose file the engine
   * released) has the file at the remote path, if any: an untracked file,
   * since rule W moved every other document's away.
   */
  private async localVersion(state: DocumentState | undefined, remote: RemoteRevision): Promise<LocalVersion> {
    // The binding as it is now: the engine's own rename of the file (a
    // clean apply interrupted by a save) moved it since `state` was read.
    const current = state === undefined ? undefined : ((await this.journal.getDocument(state.documentId)) ?? state);
    const binding = current?.binding;
    if (binding) {
      const content = await this.readOrNull(binding.spelling);
      // A tombstone bound to a file: the user's change that brings it back,
      // which rule W may have moved aside to a copy name.
      if (content !== null || liveHere(current)) return { path: binding.spelling, content };
    }
    if (liveHere(current)) {
      if (binding === null) return this.unboundVersion(current);
      // A row the start-up scan has not bound yet: its synced path.
      return { path: current.path, content: await this.readOrNull(current.path) };
    }
    return { path: remote.path, content: await this.readOrNull(remote.path) };
  }

  /** Whether the journal has a server revision of the document (not only the row of a create not acknowledged yet). */
  private async known(documentId: string): Promise<boolean> {
    const state = await this.journal.getDocument(documentId);
    return state !== undefined && hasBase(state);
  }

  /** Whether the user deleted the document's file (E3) and nothing bound it again since: a file at its path now is another one (#254). */
  private userDeleted(state: DocumentState): boolean {
    return !state.deleted && state.binding === null && state.absence === "user-deleted";
  }

  /**
   * The local version of a live document with no binding: the user deleted
   * its file (E3), or a crash hid the engine's own move of it from the
   * binding. Its version is the untracked file (no document is bound to it)
   * at its synced path, or none (`absent`): the user deleted the file and
   * saved one there again (an editor's save through a delete and a create,
   * #380), which the merge takes as the document's edit. An interrupted
   * merge leaves nothing to find: its intent was finished or dropped first
   * (recoverMerge), and its move of the file is the binding's (E1).
   */
  private async unboundVersion(state: DocumentState): Promise<LocalVersion> {
    const synced = await this.readOrNull(state.path);
    if (synced !== null) {
      const owner = await this.boundAt(state.path);
      if (owner === undefined || owner.documentId === state.documentId) return { path: state.path, content: synced };
    }
    return { path: state.path, content: null, absent: true };
  }

  /**
   * The document bound to the file the vault holds at `path` (design §4.2,
   * fileHolder), found under the spelling the vault holds it at: a vault
   * that folds names more than the file key `F` does (X-18) reads another
   * spelling's file there.
   */
  private async boundAt(path: string): Promise<DocumentState | undefined> {
    return (await this.journal.documentByFileKey(this.pathSpace.filesystemKey(path))) ?? (await this.journal.documentByFileKey(this.pathSpace.filesystemKey(await this.heldSpelling(path))));
  }

  /**
   * Makes the disk show a merge result and rebases the document onto the
   * remote revision, so that the next push commits the result with the remote
   * revision as its base (SPEC.md §6.2 step 3). Returns false, writing
   * nothing, if the local file no longer holds what the merge hook was given
   * (the user changed it meanwhile), or if a conflict copy has no name that
   * fits the path limits; "held" if rule W leaves the result's path another
   * document's; and false, keeping whatever it already wrote, if the vault
   * refuses a path. A file at the result's new path that is no document's
   * is first kept as a conflict copy and removed.
   *
   * The `merge` intent (design §4.4, PO-8): the copies' names and bytes and
   * the result are recorded before the first disk step, each disk step
   * carries a precondition (mergeOnDisk), and one transaction finishes it
   * (finishMerge): the superseded outbox goes, the base moves to the remote
   * revision, the deferral goes, the conflicts are logged, the cursor moves
   * when the revision comes from the feed, and the intent goes. Until then
   * the remote revision counts as unapplied. Interrupted, recoverMerge
   * redoes the steps from the record, or drops the intent if the user
   * changed the file meanwhile, so the merge runs again.
   */
  private async applyMerge(remote: RemoteRevision, state: DocumentState | undefined, local: LocalVersion, outcome: Extract<MergeOutcome, { status: "merged" }>): Promise<boolean | "held" | "alias"> {
    if (outcome.content !== null && !isVaultRelativePath(outcome.path)) throw new Error(`the merge hook returned a path that is not vault-relative: ${outcome.path}`);
    // The document's own file, as the merge hook was given it. A document
    // whose file the user deleted has none: a file at `local.path` now is
    // another one, never this merge's to replace or move.
    const current = local.absent === true ? null : await this.readOrNull(local.path);
    if (!sameContent(current, local.content)) return false;
    // A result path that is the document's own file under another spelling
    // (a remote case-only rename on a case-insensitive platform) is no file
    // in the way: the vault holds one file there, the document's, which the
    // rename respells (#343). Only if the vault holds the two as one: on
    // NTFS or APFS a file at `STRASSE/b.md` is another one than
    // `straße/b.md`, so it is in the way (#447).
    const respelled = outcome.content !== null && current !== null && outcome.path !== local.path && (await oneFileOnDisk(this.pathSpace, this.vault, outcome.path, local.path));
    // The document's own file, which the result moves away from (or
    // deletes), and its synced path, where the result does not go: neither
    // takes a name from a conflict copy (#319, #299).
    const merged: Exempt = {
      documentId: remote.documentId,
      file: current !== null && (outcome.content === null || outcome.path !== local.path) ? local.path : undefined,
      result: outcome.content === null ? null : outcome.path,
    };
    // The path claim where the result lands (design §4.5 step 3, PO-4):
    // another document's file in the way moves by rule W, or the result
    // waits. Never at a path the result leaves (#473).
    if (outcome.content !== null && !respelled) {
      const claim = await this.claimPath(outcome.path, remote.documentId);
      if (claim !== "free") return claim;
    }
    const steps: MergeSteps = {
      revision: remote,
      local: { path: local.path, hash: current === null ? null : sha256Hex(current) },
      result: { path: outcome.path, hash: outcome.content === null ? null : sha256Hex(outcome.content), content: outcome.content },
      respelled,
      adopts: !liveHere(state) && current !== null,
      copies: [],
    };
    // A file in the way at the result's new path is no document's now: it
    // was created here concurrently with the remote document's move there,
    // so the remote document takes the path and the file is kept as a
    // conflict copy.
    if (outcome.content !== null && (current === null || outcome.path !== local.path) && !respelled) {
      const occupant = await this.readOrNull(outcome.path);
      if (occupant !== null && !sameContent(occupant, outcome.content)) {
        const copy = await this.copyFor(remote, outcome.path, { reason: "concurrent-create", content: occupant }, merged, steps.copies);
        if (copy === null) return false;
        steps.copies.push({ ...copy, from: outcome.path });
      }
    }
    if (outcome.conflict !== undefined) {
      const copy = await this.copyFor(remote, local.path, outcome.conflict, merged, steps.copies);
      if (copy === null) return false;
      steps.copies.push(copy);
    }
    const id = await this.journal.putIntent({ kind: "merge", documentId: remote.documentId, steps: steps as unknown as Record<string, unknown> });
    let done = false;
    try {
      done = await this.mergeOnDisk(steps);
    } catch (error) {
      // "changed": the user saved a file after it was read here (#163); the
      // next merge attempt starts from what they saved.
      if (!(isVaultError(error, "path-conflict") || isVaultError(error, "already-exists") || isVaultError(error, "changed"))) {
        if (!isVaultError(error)) throw error;
        await this.abandonMerge(id, steps);
        throw error;
      }
    }
    if (!done) {
      await this.abandonMerge(id, steps);
      return false;
    }
    await this.finishMerge(id, steps);
    return true;
  }

  /**
   * The disk steps of a `merge` intent, each idempotent and checked against
   * what the disk holds (SPEC.md §8 "Conditional writes"): a copy present
   * with its content counts as written, the document's file moved to the
   * result's path counts as moved, and a result present with its content
   * counts as written. Returns false if the disk shows something the steps
   * do not explain: the user's change, which is left alone.
   */
  private async mergeOnDisk(steps: MergeSteps): Promise<boolean> {
    const { local, result } = steps;
    const documentId = steps.revision.documentId;
    for (const copy of steps.copies) {
      const there = await this.readOrNull(copy.path);
      if (there === null) {
        // Only where no file is: one saved there meanwhile is the user's, and
        // the vault refuses the write ("changed").
        await this.echoed(this.echoes.expectWrite(copy.path, copy.hash), () => this.vault.write(copy.path, copy.content, { expectedHash: null }));
      } else if (sha256Hex(there) !== copy.hash) return false;
      // Pushed as a new document at once, even if a later step fails (#345).
      this.markDirty(copy.path);
      this.schedulePush();
      const from = copy.from;
      if (from === undefined) continue;
      // The copy now holds the file's content, so a create not yet committed
      // that is bound to the file is superseded. It goes before the file
      // does, so none is ever left bound to the merged document's file.
      await this.supersedeCreates(from, documentId);
      const occupant = await this.readOrNull(from);
      if (occupant !== null && sha256Hex(occupant) === copy.hash) {
        const expectedHash = copy.hash;
        await this.echoed(this.echoes.expectDelete(await this.heldSpelling(from)), () => this.deleteFile(from, { expectedHash }));
      }
    }
    // An untracked file the merge took (design §4.5 step 3): a create bound
    // to it is superseded, before the result is written into it.
    if (steps.adopts) await this.supersedeCreates(local.path, documentId);
    if (result.hash === null) {
      const there = local.hash === null && steps.legacy !== true ? null : await this.readOrNull(local.path);
      if (there === null) return true;
      if (sha256Hex(there) !== local.hash) return false;
      const expectedHash = local.hash;
      await this.echoed(this.echoes.expectDelete(await this.heldSpelling(local.path)), () => this.deleteFile(local.path, { expectedHash }));
      return true;
    }
    let there = await this.readOrNull(result.path);
    if (result.path !== local.path && local.hash !== null) {
      const atLocal = steps.respelled ? there : await this.readOrNull(local.path);
      const moved = steps.respelled ? (await this.heldSpelling(result.path)) === result.path : atLocal === null;
      if (!moved) {
        if (atLocal === null || sha256Hex(atLocal) !== local.hash) return false;
        if (there !== null && !steps.respelled) return false;
        await this.echoed(this.echoes.expectRename(await this.heldSpelling(local.path), result.path), () => this.renameFile(local.path, result.path));
        there = atLocal;
      }
    }
    const thereHash = there === null ? null : sha256Hex(there);
    if (thereHash === result.hash) {
      await this.takeServerSpelling(result.path, documentId);
      return true;
    }
    if (thereHash !== null && thereHash !== local.hash) return false;
    const content = result.content;
    // A merge recorded by a journal before R8 (journal v6) has no bytes to write.
    if (content === undefined || content === null) return false;
    await this.takeServerSpelling(result.path, documentId);
    await this.echoed(this.echoes.expectWrite(await this.heldSpelling(result.path), result.hash), () => this.vault.write(result.path, content, { expectedHash: thereHash }));
    return true;
  }

  /**
   * The `merge` intent's final transaction (design §4.4). The document's
   * unacknowledged operations are superseded: their commits were refused
   * (the head had moved past their base), and their content is part of the
   * merge result on disk or of a conflict copy. A local rename the merge
   * kept is pushed as a rename of the document: its binding is at the
   * result's path, its base at the remote path.
   */
  private async finishMerge(id: number, steps: MergeSteps): Promise<void> {
    const remote = steps.revision;
    const superseded = (await this.journal.listPending()).filter((operation) => operation.documentId === remote.documentId).map((operation) => operation.revisionId);
    await this.putDocument(
      syncedState(remote),
      { kind: "merged", path: steps.result.path, hash: steps.result.hash },
      { removePending: superseded, removeDeferred: [remote.documentId], putConflicts: steps.copies.map((copy) => copy.record), removeIntents: [id], ...this.feedCursor(remote.revisionId) },
    );
    this.markDirty(steps.local.path);
    this.markDirty(steps.result.path);
    for (const copy of steps.copies) this.markDirty(copy.path);
    // A merge made by a pull is pushed like a local edit.
    this.schedulePush();
  }

  /**
   * Drops a `merge` intent whose steps cannot finish. A copy it already
   * wrote stays, as a file of its own the push commits as a new document,
   * and its conflict is logged, so the user sees it (#345). The deferral
   * stays: the merge runs again on the next push.
   */
  private async abandonMerge(id: number, steps: MergeSteps): Promise<void> {
    const written: ConflictRecord[] = [];
    for (const copy of steps.copies) if (sameHash(await this.readOrNull(copy.path), copy.hash)) written.push(copy.record);
    await this.bindings.transact(() => Promise.resolve({ putConflicts: written, removeIntents: [id] }));
  }

  /**
   * Recovers a `merge` intent a crash left open (design §4.4): its steps
   * are redone from the record, idempotently, and finished; if the disk
   * shows the user's change instead, the intent is dropped and the merge
   * runs again, from what the user saved.
   */
  private async recoverMerge(intent: Intent): Promise<void> {
    const steps = intent.steps as unknown as MergeSteps;
    let done = false;
    try {
      done = await this.mergeOnDisk(steps);
    } catch (error) {
      if (!isVaultError(error)) throw error;
    }
    if (done) await this.finishMerge(intent.id, steps);
    else await this.abandonMerge(intent.id, steps);
  }

  /**
   * Untracked-file adoption (design §4.5 step 3): the file at `path` is
   * `documentId`'s now, or its content went into a conflict copy, so a
   * create the server has not acknowledged that is bound to the file is
   * superseded. Its outbox goes, and with it the create's row
   * (Bindings.dropped). The binding alone says which create the file was
   * (PO-1): a create whose file the user moved elsewhere keeps it.
   */
  private async supersedeCreates(path: string, documentId: string): Promise<void> {
    // Under the spelling the vault holds the file at too: a vault that folds
    // names more than the file key `F` does (X-18) reads another spelling's file at `path`.
    const keys = new Set([this.pathSpace.filesystemKey(path), this.pathSpace.filesystemKey(await this.heldSpelling(path))]);
    const holders = (await Promise.all([...keys].map((key) => this.journal.documentsByFileKey(key)))).flat();
    for (const holder of holders) {
      if (holder.documentId === documentId || hasBase(holder)) continue;
      const operations = (await this.journal.listPending()).filter((operation) => operation.documentId === holder.documentId).map((operation) => operation.revisionId);
      if (operations.length > 0) await this.bindings.dropped(operations);
      this.markDirty(path);
    }
  }

  /**
   * The conflict copy that keeps `conflict`'s version next to `localPath`
   * (SPEC.md §7), for a `merge` intent's steps: its name, content and
   * conflict record, which the intent's final transaction logs. A copy this
   * device already keeps of the same content for the document (a merge that
   * failed after writing it) is reused, so a retry writes none twice; a
   * `path-taken` record names where the document's own file moved, never a
   * copy (#462). Returns null if no name fits the path limits: the conflict
   * is then logged without a copy and nothing is written, so the local
   * version stays where it is. `merged` is the document the merge rebases
   * (PathClaims.freeCopyName's `exempt`), and `named` the copies the same
   * merge names before this one.
   */
  private async copyFor(remote: RemoteRevision, localPath: string, conflict: { reason: ConflictReason; content: Uint8Array }, merged: Exempt, named: readonly MergeCopy[]): Promise<MergeCopy | null> {
    const hash = sha256Hex(conflict.content);
    const logged = (await this.journal.listConflicts()).filter((record) => record.documentId === remote.documentId && record.copyHash === hash && record.reason !== "path-taken");
    for (const record of logged) {
      if (record.copyPath === null || named.some((copy) => copy.path === record.copyPath)) continue;
      if (sameHash(await this.readOrNull(record.copyPath), hash)) return { path: record.copyPath, hash, content: conflict.content, record };
    }
    // The revision's path is the document's newest server claim, which the journal does not hold yet.
    const claims = (await PathClaims.load(this.pathSpace, this.journal, this.vault)).with([
      { kind: "server-newer", path: remote.path, documentId: remote.documentId },
      ...named.map((copy) => ({ kind: "reserved" as const, path: copy.path, documentId: remote.documentId })),
    ]);
    const copyPath = await claims.freeCopyName(localPath, this.copyNaming(), merged);
    const record = this.conflictRecord(remote.documentId, remote.path, conflict.reason, copyPath, hash, remote.revisionId);
    if (copyPath === null) {
      if (!logged.some((entry) => entry.copyPath === null && entry.remoteRevisionId === remote.revisionId)) await this.journal.putConflict(record);
      return null;
    }
    return { path: copyPath, hash, content: conflict.content, record };
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
    await this.bindings.transact(() => Promise.resolve({ putDeferred: [{ revision: remote, reason }], ...this.feedCursor(remote.revisionId) }));
    return "deferred";
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
      } else if (await this.rolledBack(state, remote)) {
        await this.fastForward(state, remote);
      } else {
        this.count(summary, await this.handToMerge(remote, state));
      }
    }
    await this.journal.resetCursor(seq, anchor);
    summary.cursor = seq;
  }

  /**
   * Whether the restore rolled the document back along this device's own
   * history: its restored head is a live revision this device synced before
   * its live base (DocumentState.prior), so nothing on the server is
   * concurrent with what this device holds (design §4.6). A head this device
   * never saw, one the journal cannot prove an ancestor, a tombstone on
   * either side, or a document with an operation pending or a revision
   * deferred, goes to the merge as before.
   */
  private async rolledBack(state: DocumentState, remote: RemoteRevision): Promise<boolean> {
    if (!liveHere(state) || remote.deleted || state.binding == null || !(state.prior ?? []).includes(remote.revisionId)) return false;
    if ((await this.journal.getDeferred(state.documentId)) !== undefined) return false;
    return !(await this.journal.listPending()).some((operation) => operation.documentId === state.documentId);
  }

  /**
   * Re-creates what the restore lost of a document it rolled back along this
   * device's own history (rolledBack; design §4.6, principle 1): the
   * restored head becomes the base, and the file, untouched, stays the
   * document's, so the push commits this device's version (the lost base,
   * or the local file, which a dirty file already builds on) as the
   * document's next revision under its own id: no merge, no conflict copy.
   */
  private async fastForward(state: DocumentState, remote: RemoteRevision): Promise<void> {
    // The anchor was the lost revision's: no commit of this device's above the cursor remains.
    await this.putDocument({ ...state, anchor: undefined, path: remote.path, revisionId: remote.revisionId, seq: remote.seq, baseHash: remote.contentHash, size: remote.size }, { kind: "kept" });
    this.markDirty(remote.path);
    if (state.binding != null) this.markDirty(state.binding.spelling);
    this.schedulePush();
  }

  private async pushOnce(): Promise<PushSummary> {
    // Classify every vault event so far, so the push sees the latest changes.
    await this.events;
    const summary: PushSummary = { committed: 0, conflicts: 0, pending: 0, rejected: [] };
    await this.intents.recover();
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

  /** Asks the merge hook again about every document it deferred: a merge may now succeed. */
  private async retryMerges(): Promise<void> {
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason !== "local-changes") continue;
      const state = await this.journal.getDocument(deferred.revision.documentId);
      // Out of scope since it was deferred: its next revision, or a start that finds it in scope again, takes it on.
      if (this.outOfScope(deferred.revision, state)) continue;
      await this.handToMerge(deferred.revision, state);
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
        await this.commitOperation(await this.createFollowsBinding(operation), summary);
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
    if (plan.forgotten.length > 0) await this.bindings.transact(() => Promise.resolve({ removeDocuments: plan.forgotten }));
    // A document the restored server lacks yields its path to another claim: re-created at a copy name (design §4.6).
    for (const { state, spelling } of plan.yielding) {
      const copy = await this.freeCopyName(spelling, { documentId: state.documentId, file: spelling, result: null });
      if (copy === null) continue;
      await this.intents.displace(state.documentId, spelling, copy, this.conflictRecord(state.documentId, spelling, "path-taken", copy, "", ""), true);
      plan.waiting.add(copy);
    }
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
        !(await this.onBase(operation))
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

  /**
   * A create in the outbox whose file the user moved (E1) or edited since
   * it was recorded: the create follows the document's binding and its
   * content, under a new revision id, as a displace intent's does
   * (intents.ts). Otherwise the create no longer matches its file, is
   * dropped as superseded, and the file is pushed as another document (P1;
   * a document re-created after a restore, R7b). If the first create did
   * land, the pull finds it and rebases this one on it (applyRevision).
   */
  private async createFollowsBinding(operation: PendingOperation): Promise<PendingOperation> {
    if (operation.baseRevisionId !== "" || operation.deleted) return operation;
    const spelling = (await this.journal.getDocument(operation.documentId))?.binding?.spelling;
    if (spelling === undefined) return operation;
    const content = await this.readOrNull(spelling);
    if (content === null || (spelling === operation.path && sha256Hex(content) === operation.contentHash)) return operation;
    const moved: PendingOperation = { ...operation, revisionId: this.newId(), path: spelling, contentHash: sha256Hex(content), size: BigInt(content.length) };
    await this.journal.transact({ removePending: [operation.revisionId], addPending: [moved] });
    return moved;
  }

  /**
   * Whether `operation` is on its document's base: the base is still the
   * one it was derived from, or the document is one the restored server
   * lacks (ghost), which the operation creates again.
   */
  private async onBase(operation: PendingOperation): Promise<boolean> {
    const state = await this.journal.getDocument(operation.documentId);
    if (state !== undefined && operation.baseRevisionId === "" && ghost(state)) return true;
    return (state?.revisionId ?? "") === operation.baseRevisionId;
  }

  /** The documents whose deferred remote revision keeps their local changes from being pushed, and their server claims (busyClaims). */
  private async busy(): Promise<Busy> {
    return busyClaims(await this.journal.listDocuments(), await this.journal.listDeferred());
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
      prior: remote.parentRevisionId === "" ? [] : [remote.parentRevisionId],
    }, { kind: "acknowledged", hash: operation.contentHash }, { removePending: [operation.revisionId], ...(await this.pastOwnCommit(revision)) });
    // A delete of the file the user made before the commit landed stays
    // theirs, and a local rename made meanwhile is from the commit's path
    // now (#280): both are the binding, which the acknowledgement keeps.
    // One transaction (design §4.4 `commit`): the outbox goes with the
    // base's move and the cursor's.
    summary.committed++;
    // Changes made while the operation was pending were left for after it.
    this.markDirty(operation.path);
    this.onAcknowledged(remote);
  }

  /**
   * The cursor change onto this device's just-acknowledged revision if it is
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
  private async pastOwnCommit(revision: Revision): Promise<JournalChanges> {
    if ((await this.journal.getCursor()) !== revision.seq - 1n) return {};
    return { cursor: { seq: revision.seq, anchor: cursorAnchor(revision) } };
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
   * its own document id, by a `displace` intent (design §4.4, §4.5 W(a)),
   * whose recovery finishes an interrupted move. If no name fits the path
   * limits, nothing moves and the operation is reported as rejected.
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
    // A record whose copy is its own path names no move: a document the
    // restored server lacks, re-created where its file is (design §4.6). Its
    // refused create still moves to a copy name under its own id (#722).
    const conflicts = (await this.journal.listConflicts()).filter((record) => record.copyPath !== record.path);
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
    // The file at the path, unless another document is bound to it (design
    // §4.2, fileHolder): on a case-insensitive platform a path of another
    // spelling names that document's file, which is never this operation's
    // to move (#242). Its bytes are that document's, whatever they are now:
    // the push commits them as its edit, and moving them would leave it no
    // file (decision #52, amended).
    const holder = await this.boundAt(operation.path);
    const found = await this.readOrNull(operation.path);
    const othersFile = found !== null && holder !== undefined && holder.documentId !== operation.documentId;
    if (found === null || othersFile) {
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
      const logged = conflicts.some((record) => record.reason === "path-taken" && record.documentId === operation.documentId && record.path === operation.path && record.copyPath === null);
      if (!logged) await this.journal.putConflict(this.conflictRecord(operation.documentId, operation.path, "path-taken", null, operation.contentHash, ""));
      summary.rejected.push({ operation, reason: "path-taken", error });
      return;
    }
    // W(a) from the document's own side (design §4.5): the `displace`
    // intent moves its file to the copy name under its own id, and its
    // final transaction rewrites the outbox and logs the move. Interrupted,
    // Intents.recover finishes it from the disk (#371, #372).
    const record = this.conflictRecord(operation.documentId, operation.path, "path-taken", copyPath, operation.contentHash, "");
    if (!(await this.intents.displace(operation.documentId, operation.path, copyPath, record))) return;
    // A remote document the file was in the way of (a file where it needs a
    // folder, or the reverse) may now fit, and so may the merge of a remote
    // rename there, deferred with the user's edit (#307).
    await this.retryRefusedPaths(true);
    await this.retryMerges();
    // A create's replacement is recorded at the copy name; a known
    // document's rename there is derived by the next round from its binding.
    const replacement = (await this.journal.listPending()).find((candidate) => candidate.documentId === operation.documentId && candidate.path === copyPath && !candidate.deleted);
    if (replacement !== undefined) await this.commitOperation(replacement, summary);
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
    const listed = await this.journal.listDeferred();
    const aliased = await this.aliasedPaths(listed);
    const deferrals = listed.filter(
      (deferred) =>
        (deferred.reason === "path-conflict" && (again || !this.retried.has(deferred.revision.revisionId))) ||
        (deferred.reason === "unmaterializable" && deferred.unmaterializable === "alias" && !aliased(deferred.revision)) ||
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

  /**
   * Whether another live document's newest server claim (its deferred
   * revision, else its synced path) is a path one file with a revision's on
   * this device under another server key: the `alias` that keeps the
   * revision unmaterializable here (ruleW). Once the server moves or deletes
   * that document, the revision is retried (decision #52).
   */
  private async aliasedPaths(deferrals: readonly DeferredRevision[]): Promise<(revision: RemoteRevision) => boolean> {
    const newer = new Map(deferrals.map((deferred) => [deferred.revision.documentId, deferred.revision]));
    const claims: { documentId: string; path: string }[] = [];
    for (const state of await this.journal.listDocuments()) {
      const ahead = newer.get(state.documentId);
      if (ahead !== undefined ? !ahead.deleted : liveHere(state)) claims.push({ documentId: state.documentId, path: ahead?.path ?? state.path });
    }
    return (revision) =>
      claims.some((claim) => claim.documentId !== revision.documentId && this.pathSpace.collides(claim.path, revision.path, "file") && !this.pathSpace.collides(claim.path, revision.path, "server"));
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
  private putDocument(state: DocumentState, change: BindingChange, alongside?: JournalChanges): Promise<void> {
    return this.bindings.put(state, change, alongside);
  }

  /**
   * The cursor change of the feed revision `revisionId`, if the pull is
   * applying it now, for the final transaction of its step (design §4.4:
   * the cursor moves in the same transaction). Taken once: the pull then
   * leaves the cursor alone.
   */
  private feedCursor(revisionId: string): JournalChanges {
    const feed = this.feed;
    if (feed?.revisionId !== revisionId) return {};
    this.feed = undefined;
    return { cursor: { seq: feed.seq, anchor: feed.anchor } };
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
    prior: remote.parentRevisionId === "" ? [] : [remote.parentRevisionId],
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
