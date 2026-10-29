/**
 * The device journal of the sync engine (docs/design/engine.md §2): what this
 * device last synced, and what it has not pushed yet. One journal per vault.
 *
 * Every change is one `commit` call, applied all-or-nothing, so a crash
 * leaves each engine step either fully recorded or not at all.
 */

/** A document's kind: `text` is Markdown, merged three-way; `blob` is everything else. */
export type SyncKind = "text" | "blob";

/** The last applied change-list position, and the anchor the server sent with it (SPEC.md §6.1). */
export interface Cursor {
  seq: bigint;
  /** The anchor of the revision at `seq`; empty when the server sent none or `seq` is 0. */
  anchor: Uint8Array;
}

/** The revision this device last synced for a document (`docs[document_id]`). */
export interface DocEntry {
  documentId: string;
  path: string;
  kind: SyncKind;
  baseRevId: string;
  /** SHA-256 (lowercase hex) of the base revision's content. */
  baseHash: string;
  /** Size in bytes of the base revision's content: a tombstone names the content it deletes. */
  baseSize: number;
  /**
   * The base revision is a tombstone: the document was deleted on the server
   * while this device kept it (rows A7 and A10), and a pending re-create
   * builds on it.
   */
  deleted?: boolean;
}

export type PendingKind = "create" | "edit" | "rename" | "delete";

/** A local operation not yet acknowledged by the server. */
export interface PendingOp {
  opId: string;
  /** Position in the queue: operations are pushed in ascending order. */
  order: number;
  documentId: string;
  kind: PendingKind;
  /** The document's path after the operation. */
  path: string;
  /** The document's kind, for a create. */
  docKind: SyncKind;
  /** Chosen once and kept until the commit is acknowledged, so a retry is idempotent. */
  revisionId: string;
  /** SHA-256 of the content the operation commits (a delete: the content it deletes). */
  contentHash: string;
  contentSize: number;
  /**
   * Whether a CommitRevision of this operation may have reached the server.
   * Set before the first attempt; a sent operation is never changed, only
   * acknowledged, so its retry is the same commit.
   */
  sent: boolean;
  /**
   * The server refused the operation's path as unportable or taken by a
   * document this device already holds (rules P2, P3), with its reason. The
   * operation is not retried until the file is renamed.
   */
  refused?: string;
}

/** A conflict copy this device created, for the conflict view. */
export interface ConflictEntry {
  path: string;
  /** The document the copy was taken from. */
  documentId: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** One atomic change to the journal. */
export interface JournalChange {
  cursor?: Cursor;
  putDocs?: DocEntry[];
  deleteDocs?: string[];
  putPending?: PendingOp[];
  deletePending?: string[];
  putConflicts?: ConflictEntry[];
  deleteConflicts?: string[];
}

/** Everything the journal holds. */
export interface JournalState {
  cursor: Cursor;
  docs: Map<string, DocEntry>;
  /** In push order. */
  pending: PendingOp[];
  conflicts: Map<string, ConflictEntry>;
}

export interface SyncJournal {
  /** Reads the whole journal. */
  load(): Promise<JournalState>;
  /** Applies `change` atomically; resolves once it is durable. */
  commit(change: JournalChange): Promise<void>;
}

/** The cursor of a journal that has applied nothing yet. */
export const initialCursor: Cursor = { seq: 0n, anchor: new Uint8Array() };

/** Applies `change` to `state` in place (shared by every journal implementation). */
export function applyChange(state: JournalState, change: JournalChange): void {
  if (change.cursor !== undefined) state.cursor = { seq: change.cursor.seq, anchor: change.cursor.anchor.slice() };
  for (const id of change.deleteDocs ?? []) state.docs.delete(id);
  for (const entry of change.putDocs ?? []) state.docs.set(entry.documentId, { ...entry });
  const removed = new Set(change.deletePending ?? []);
  const put = new Map((change.putPending ?? []).map((op) => [op.opId, { ...op }]));
  const pending = state.pending.filter((op) => !removed.has(op.opId) && !put.has(op.opId));
  pending.push(...put.values());
  pending.sort((a, b) => a.order - b.order);
  state.pending = pending;
  for (const path of change.deleteConflicts ?? []) state.conflicts.delete(path);
  for (const entry of change.putConflicts ?? []) state.conflicts.set(entry.path, { ...entry });
}

function copyState(state: JournalState): JournalState {
  return {
    cursor: { seq: state.cursor.seq, anchor: state.cursor.anchor.slice() },
    docs: new Map([...state.docs].map(([id, entry]) => [id, { ...entry }])),
    pending: state.pending.map((op) => ({ ...op })),
    conflicts: new Map([...state.conflicts].map(([path, entry]) => [path, { ...entry }])),
  };
}

/** A journal in memory, for tests. It survives an engine restart as long as the object does. */
export class MemorySyncJournal implements SyncJournal {
  private state: JournalState = { cursor: initialCursor, docs: new Map(), pending: [], conflicts: new Map() };

  load(): Promise<JournalState> {
    return Promise.resolve(copyState(this.state));
  }

  commit(change: JournalChange): Promise<void> {
    const next = copyState(this.state);
    applyChange(next, change);
    this.state = next;
    return Promise.resolve();
  }
}
