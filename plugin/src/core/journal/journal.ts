/**
 * The client's single durable journal (SPEC.md §2 principle 2, §8): the bridge
 * between the server's revision log and the local vault. The production
 * implementation will be IndexedDB-backed; InMemoryJournal serves tests and
 * the simulation. This interface is the Phase 1 skeleton; the sync engine
 * (Phase 2) may extend it.
 */
export interface Journal {
  /** Highest `seq` fully applied to disk; 0n before the first pull. */
  getCursor(): Promise<bigint>;
  /** Advances the cursor. Rejects with RangeError if `seq` is lower than the current cursor. */
  setCursor(seq: bigint): Promise<void>;

  getDocument(documentId: string): Promise<DocumentState | undefined>;
  findDocumentByPath(path: string): Promise<DocumentState | undefined>;
  listDocuments(): Promise<DocumentState[]>;
  /** Inserts or replaces the state of `state.documentId`. */
  putDocument(state: DocumentState): Promise<void>;

  /** Queues a local change. Rejects with Error if `revisionId` is already pending. */
  addPending(operation: PendingOperation): Promise<void>;
  /** Pending operations in the order they were added. */
  listPending(): Promise<PendingOperation[]>;
  /**
   * Removes a pending operation. Call only after CommitRevision has succeeded
   * (SPEC.md §8). Removing an unknown id is a no-op, so the call is idempotent
   * across crash/retry.
   */
  removePending(revisionId: string): Promise<void>;
}

/** What the client last synced for one document. */
export interface DocumentState {
  documentId: string;
  /** Path on disk at the last sync. */
  path: string;
  /** Last revision synced with the server: the base for 3-way merges. */
  revisionId: string;
  /** SHA-256 (hex) of the content at `revisionId`, compared against disk before applying remote content. */
  baseHash: string;
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
  deleted: boolean;
}
