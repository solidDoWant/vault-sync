import type { UnmaterializableCause } from "../vaultpath/platform";

/**
 * The client's single durable journal (SPEC.md §2 principle 2, §8): the bridge
 * between the server's revision log and the local vault. The production
 * implementation is IndexedDbJournal (./indexeddb.ts); InMemoryJournal serves
 * tests and the simulation. Both pass the shared suite in ./conformance.ts.
 *
 * Every method's effect must be durable when its promise resolves: the sync
 * engine orders its disk writes and journal updates so that a crash between
 * any two of them is recoverable (SPEC.md §8, crash safety).
 */
export interface Journal {
  /** Highest `seq` fully applied to disk; 0n before the first pull. */
  getCursor(): Promise<bigint>;
  /**
   * The anchor (`Revision.anchor`) of the revision at the cursor, stored with
   * it; undefined if none was stored with the current cursor. Sent with the
   * cursor so the server can tell whether its history still holds that
   * revision (SPEC.md §6.1).
   */
  getCursorAnchor(): Promise<Uint8Array | undefined>;
  /**
   * Advances the cursor and stores `anchor` with it, atomically; without an
   * anchor, none is stored. Rejects with RangeError if `seq` is lower than
   * the current cursor.
   */
  setCursor(seq: bigint, anchor?: Uint8Array): Promise<void>;
  /**
   * Sets the cursor to `seq`, also backwards, with `anchor` as setCursor
   * does. Only for a resync after the server's history diverged from the
   * cursor (e.g. after a database restore; SPEC.md §8).
   */
  resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void>;

  getDocument(documentId: string): Promise<DocumentState | undefined>;
  /**
   * The live (`deleted: false`) document whose path is exactly `path`, or
   * undefined if there is none. Tombstones are never returned, even when the
   * only document with that path is one: a deleted document keeps its last
   * path (SPEC.md §6.3), so a tombstone and a live document can share a path.
   * The comparison is exact; path keys are the engine's concern.
   *
   * The engine never leaves two live documents at one path, but the journal
   * does not enforce it; should it happen, the one with the lowest
   * `documentId` (in UTF-16 code unit order, IndexedDB's key order) is
   * returned, so every implementation picks the same one.
   */
  findDocumentByPath(path: string): Promise<DocumentState | undefined>;
  /** Every document's state, live and deleted, in `documentId` order (UTF-16 code units, as findDocumentByPath). */
  listDocuments(): Promise<DocumentState[]>;
  /** Inserts or replaces the state of `state.documentId`. */
  putDocument(state: DocumentState): Promise<void>;

  /**
   * Queues a local change before any of it is sent, so that a restart
   * resumes it with the same revision id (SPEC.md §6.2, §8). Rejects with
   * Error if `revisionId` is already pending.
   */
  addPending(operation: PendingOperation): Promise<void>;
  /** Pending operations in the order they were added. */
  listPending(): Promise<PendingOperation[]>;
  /**
   * Removes a pending operation. Call only after CommitRevision has succeeded
   * (SPEC.md §8). Removing an unknown id is a no-op, so the call is idempotent
   * across crash/retry.
   */
  removePending(revisionId: string): Promise<void>;

  /**
   * Records a remote revision the engine did not apply to disk, replacing any
   * earlier one recorded for the same document: the newest remote revision
   * supersedes older ones, and the base stays the document's DocumentState.
   */
  putDeferred(deferred: DeferredRevision): Promise<void>;
  getDeferred(documentId: string): Promise<DeferredRevision | undefined>;
  /** Deferred revisions, in no particular order. */
  listDeferred(): Promise<DeferredRevision[]>;
  /** Removes a document's deferred revision once it is resolved. Removing an unknown id is a no-op. */
  removeDeferred(documentId: string): Promise<void>;

  /**
   * Records a conflict in the conflict log (SPEC.md §7), or replaces the
   * record with the same id. The engine records a conflict before it writes
   * the conflict copy, so an interrupted copy is finished under the same name.
   */
  putConflict(conflict: ConflictRecord): Promise<void>;
  /** The conflict log, oldest first: what the UI's conflict view reads. */
  listConflicts(): Promise<ConflictRecord[]>;

  /**
   * The document whose binding names a file with file key `fileKey` (the
   * platform's `F` of its spelling, docs/design/engine-path-ownership.md
   * §3.1), or undefined if none does. An index probe, not a scan. Should two
   * bindings share a file key (the engine never leaves them so), the one
   * with the lowest `documentId` is returned, as findDocumentByPath does.
   */
  documentByFileKey(fileKey: string): Promise<DocumentState | undefined>;

  /**
   * Every document whose binding names a file with file key `fileKey`, in
   * `documentId` order: one at most, unless a v2 journal's migration bound
   * two documents to one file (indexeddb.ts deriveV3Records). An index
   * read, not a scan.
   */
  documentsByFileKey(fileKey: string): Promise<DocumentState[]>;

  /**
   * Records an intent (design §4.4) before the first disk step of the change
   * it describes, and resolves with its id. The intent stays until a
   * `transact` (or removeIntent) removes it.
   */
  putIntent(intent: NewIntent): Promise<number>;
  /** Open intents, oldest first. */
  listIntents(): Promise<Intent[]>;
  /** Removes an intent: `transact({ removeIntents: [id] })`. Removing an unknown id is a no-op. */
  removeIntent(id: number): Promise<void>;

  /**
   * Applies `changes` as one durable transaction: all of them or, if any
   * part fails, none (design §6.1). The parts apply in this order: cursor,
   * documents, document removals, pending removals, seals, pending additions, deferral
   * removals, deferrals, conflicts, intent removals. Rejects, changing
   * nothing:
   * - with RangeError if `cursor` moves the cursor backwards without `reset`;
   * - with Error if an added pending revision id is already pending, if a
   *   seal names no pending operation, or if an added operation's document
   *   still has another pending operation after this transaction's removals
   *   (the outbox holds at most one per document; addPending, which the
   *   engine uses until refactor step R5, does not enforce it).
   */
  transact(changes: JournalChanges): Promise<void>;
}

/** What one `Journal.transact` changes. Every part is optional. */
export interface JournalChanges {
  /** Sets the cursor, as setCursor does, or as resetCursor does with `reset`. */
  cursor?: { seq: bigint; anchor?: Uint8Array; reset?: boolean };
  /** Inserts or replaces document states, as putDocument. */
  putDocuments?: readonly DocumentState[];
  /** Ids of documents whose state to remove, after putDocuments; unknown ids are no-ops. */
  removeDocuments?: readonly string[];
  /** Revision ids of pending operations to remove; unknown ids are no-ops. */
  removePending?: readonly string[];
  /** Revision ids of pending operations to mark `sealed` (about to be sent). */
  sealPending?: readonly string[];
  /** Pending operations to add, after every one already pending. */
  addPending?: readonly PendingOperation[];
  /** Document ids whose deferred revision to remove; unknown ids are no-ops. */
  removeDeferred?: readonly string[];
  /** Deferred revisions to record, as putDeferred. */
  putDeferred?: readonly DeferredRevision[];
  /** Conflict records to add or replace, as putConflict. */
  putConflicts?: readonly ConflictRecord[];
  /** Ids of intents to remove; unknown ids are no-ops. */
  removeIntents?: readonly number[];
}

/**
 * The kinds of multi-step change an intent records (design §4.4). Each
 * kind's `steps` are defined by the refactor step that first writes it.
 */
export type IntentKind = "apply" | "merge" | "displace" | "detach" | "commit" | "resync";

/** An intent as recorded, before the journal assigned its id. */
export interface NewIntent {
  kind: IntentKind;
  documentId: string;
  /** The kind's disk steps and expected outcome: any structured-cloneable value. */
  steps: Record<string, unknown>;
}

/** An open intent: a write-ahead record of a change that touches the disk and more than one journal row. */
export interface Intent extends NewIntent {
  /** Assigned by the journal, increasing in the order intents were recorded. */
  id: number;
}

/**
 * Which local file is a document on this device (design §4.1): the file at
 * exactly `spelling`.
 */
export interface Binding {
  /** The file's path, spelled as on disk. */
  spelling: string;
  /**
   * The platform's filesystem fold (`F`, PathSpace.filesystemKey) of
   * `spelling`: what documentByFileKey looks up. It is plain `F`, not
   * PathSpace.fileKey (`K` of `F`), so look bindings up with
   * PathSpace.filesystemKey.
   */
  fileKey: string;
  /** Content hash the engine last read or wrote at `spelling`. */
  seen: string;
}

/**
 * Why a document has no binding (design §4.1): the user deleted its file,
 * the engine released it (an unmaterializable path), or this device never
 * had one.
 */
export type Absence = "user-deleted" | "released" | "never";

/** What the client last synced for one document. */
export interface DocumentState {
  documentId: string;
  /** Path on disk at the last sync. */
  path: string;
  /** Last revision synced with the server: the base for 3-way merges. */
  revisionId: string;
  /** `seq` of `revisionId`; remote revisions of this document at or below it are already reflected. */
  seq: bigint;
  /** SHA-256 (hex) of the content at `revisionId`, compared against disk before applying remote content. */
  baseHash: string;
  /** Size in bytes of the content at `revisionId`: a rename or delete commits the same content reference. */
  size: bigint;
  /** The document's kind; every revision of a document has the same one. */
  kind: DocumentKindName;
  /**
   * The last synced revision is a tombstone. Only that: a document whose
   * file the engine released (SPEC.md §8) keeps its live base, and has
   * `absence = "released"` (design §6.2, refactor step R7b; journal v5).
   */
  deleted: boolean;
  /**
   * The anchor (`Revision.anchor`) of `revisionId`, recorded when this
   * device's own commit of it was acknowledged: while `seq` lies above the
   * cursor, a pull sends it for the server to check (SPEC.md §6.1).
   * Absent for a revision this device pulled, or one from a server that
   * sends no anchors.
   */
  anchor?: Uint8Array;
  /**
   * The local file that is this document, or null if it has none
   * (`absence` then says why). Undefined where not recorded: a state the
   * engine wrote before it maintains bindings (refactor step R4).
   */
  binding?: Binding | null;
  /** Why the document has no binding; null while it has one. Undefined where not recorded, as `binding`. */
  absence?: Absence | null;
  /**
   * Revisions of this document this device synced before `revisionId`,
   * newest first, at most `priorRevisionLimit`: the ones it knows the base
   * descends from. A restore that rolls the document back to one of them
   * rolled it back along this device's own history (design §4.6). Undefined
   * on a row written before it was recorded (refactor step R7b), which
   * proves no ancestry.
   */
  prior?: string[];
}

/** How many of a document's earlier revisions DocumentState.prior keeps. */
export const priorRevisionLimit = 32;

/** A local change not yet acknowledged by the server; mirrors CommitRevision (SPEC.md §6.2). */
export interface PendingOperation {
  /** Client-generated UUIDv7, reused on retry so a lost response is not a conflict. */
  revisionId: string;
  documentId: string;
  /** Empty for a new document. */
  baseRevisionId: string;
  path: string;
  /** Content hash / blob id of the new content. */
  contentHash: string;
  /** Size in bytes of the new content. */
  size: bigint;
  kind: DocumentKindName;
  deleted: boolean;
  /**
   * Set before the operation is first sent: a sealed operation is never
   * edited, only removed once it is acknowledged or definitively refused
   * (design §4.1). Undefined on an operation written without outbox
   * semantics (the engine until refactor step R5), which may have been sent
   * and so counts as sealed.
   */
  sealed?: boolean;
}

export type DocumentKindName = "blob" | "text" | "yjs";

/** A revision received from the server's change feed (SPEC.md §6.1), in plain, storable form. */
export interface RemoteRevision {
  revisionId: string;
  documentId: string;
  seq: bigint;
  /** Empty for a document's first revision. */
  parentRevisionId: string;
  kind: DocumentKindName;
  path: string;
  deleted: boolean;
  /** Blob id (hex): for plaintext vaults the SHA-256 of the content (SPEC.md §5). */
  contentHash: string;
  size: bigint;
}

/**
 * Why a remote revision was deferred instead of applied:
 * - `local-changes`: the document has unsynced local changes, so it was
 *   handed to the merge hook (SPEC.md §8), which now owns it.
 * - `invalid-path`: the path is not vault-relative (SPEC.md §6.2), so it must
 *   not touch the disk.
 * - `path-conflict`: the vault refused the path (a folder or file is in the way).
 * - `unmaterializable`: the local platform cannot hold the path (SPEC.md §8,
 *   platform path rules), e.g. a Windows reserved name. The document is
 *   tracked, never dropped or renamed on the server, and its local changes
 *   wait until a later revision gives it a path the platform can hold. A
 *   file it already had is removed if unchanged (its DocumentState is then
 *   stored as `deleted`), and kept if edited.
 * - `out-of-scope`: the revision's path, or the path the document has on
 *   this device, is outside what the vault syncs (VaultAdapter.isSynced),
 *   e.g. a config file while config sync is off. Nothing touches the disk,
 *   the document's local changes wait, and the revision is applied at an
 *   engine start that finds it in scope again.
 * - `too-large`: the revision's content is larger than the engine's download
 *   cap (SyncEngineOptions.maxDownloadBytes, SPEC.md §8). Its content is never
 *   downloaded and nothing touches the disk; the document's local changes
 *   wait, and a later revision within the cap (or an engine start with a cap
 *   that fits it) applies it.
 */
export type DeferReason = "local-changes" | "invalid-path" | "path-conflict" | "unmaterializable" | "out-of-scope" | "too-large";

export interface DeferredRevision {
  revision: RemoteRevision;
  reason: DeferReason;
  /** For `unmaterializable`: why the platform cannot hold the path. */
  unmaterializable?: UnmaterializableCause;
  /**
   * The revision is known to descend from the document's base: it came from
   * the change feed of a server that had not diverged since the base was
   * synced (design §4.6). Absent proves nothing: a resync's head, a revision
   * deferred behind one, and a deferral an older engine wrote.
   */
  descendsFromBase?: true;
}

/**
 * Why the engine kept two versions of a document instead of merging them (SPEC.md §7):
 * - `overlapping-edits`: concurrent edits of a text document changed the same lines.
 * - `binary`: concurrent edits of a document that is not merged as text.
 * - `concurrent-create`: two documents were created at the same path, with no common base.
 * - `path-taken`: the server refused a local create (or rename) because another
 *   document holds the path (ALREADY_EXISTS, SPEC.md §6.3); the local document
 *   itself moved to the conflict copy's path.
 * - `base-purged`: concurrent edits whose common base retention purged from
 *   the server (SPEC.md §11), so they could not be merged.
 */
export type ConflictReason = "overlapping-edits" | "binary" | "concurrent-create" | "path-taken" | "base-purged";

/** One entry of the conflict log. */
export interface ConflictRecord {
  id: string;
  /** The document whose version stayed in place (for `path-taken`, the local document that moved). */
  documentId: string;
  /** Where the conflict happened: the path both versions wanted. */
  path: string;
  reason: ConflictReason;
  /**
   * Where the local version was kept, as an ordinary file the engine pushes
   * as a document of its own (for `path-taken`, the local document's new
   * path). null if no conflict-copy name fits the path limits: the local
   * version then stays where it is, untouched and unsynced, until the user
   * renames it.
   */
  copyPath: string | null;
  /** Content hash of the local version that was kept. */
  copyHash: string;
  /** The remote revision that stayed in place; empty for `path-taken`. */
  remoteRevisionId: string;
  /** When the conflict was recorded, in milliseconds since the epoch. */
  at: number;
}

/**
 * The rows of `documents` that an engine before refactor step R7b wrote with
 * `deleted` doubling as "released" (design §6.2 as amended, journal v5), in
 * the shape that ends it: `deleted` back to the base's own flag, which a
 * release always stored over a live base. Such a row has a base, no
 * binding, `absence = "released"` and a deferred revision: every release
 * gave up the file of a document whose remote revision waits (an
 * unmaterializable path, or one out of scope, over the download cap or
 * invalid). Every other row is left as it is, and none is dropped.
 */
export function releasedRows(documents: readonly DocumentState[], deferred: readonly DeferredRevision[]): DocumentState[] {
  const waiting = new Set(deferred.map((entry) => entry.revision.documentId));
  return documents.filter((state) => state.deleted && state.revisionId !== "" && state.binding === null && state.absence === "released" && waiting.has(state.documentId)).map((state) => ({ ...state, deleted: false }));
}
