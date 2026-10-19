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
  /** Advances the cursor. Rejects with RangeError if `seq` is lower than the current cursor. */
  setCursor(seq: bigint): Promise<void>;
  /**
   * Sets the cursor to `seq`, also backwards. Only for a resync after the
   * server's history diverged from the cursor (its `head_seq` fell below it,
   * e.g. after a database restore; SPEC.md §8).
   */
  resetCursor(seq: bigint): Promise<void>;

  getDocument(documentId: string): Promise<DocumentState | undefined>;
  /**
   * The live (`deleted: false`) document whose path is exactly `path`, or
   * undefined if there is none. Tombstones are never returned, even when the
   * only document with that path is one: a deleted document keeps its last
   * path (SPEC.md §6.3), so a tombstone and a live document can share a path.
   * The comparison is exact; path keys are the engine's concern.
   */
  findDocumentByPath(path: string): Promise<DocumentState | undefined>;
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
}

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
   * The last synced revision is a tombstone, or this device holds no file of
   * the document: an unmaterializable document whose file was released
   * (SPEC.md §8), so `path` names no file of it any more.
   */
  deleted: boolean;
}

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
  /**
   * Set while the engine writes a merge result for `revision`: recorded
   * before the disk changes, so a merge interrupted after them is recognized
   * (the file at `path` hashes to `contentHash`, null for a deleted result)
   * and finished without asking the merge hook again.
   */
  merging?: { path: string; contentHash: string | null };
  /** For `unmaterializable`: why the platform cannot hold the path. */
  unmaterializable?: UnmaterializableCause;
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
