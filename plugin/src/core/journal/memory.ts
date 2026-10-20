import type { ConflictRecord, DeferredRevision, DocumentState, Journal, PendingOperation } from "./journal";

/** A non-durable Journal for unit tests and the simulation harness. */
export class InMemoryJournal implements Journal {
  private cursor = 0n;
  private cursorAnchor: Uint8Array | undefined;
  private readonly documents = new Map<string, DocumentState>();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly deferred = new Map<string, DeferredRevision>();
  private readonly conflicts = new Map<string, ConflictRecord>();

  getCursor(): Promise<bigint> {
    return Promise.resolve(this.cursor);
  }

  getCursorAnchor(): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.cursorAnchor === undefined ? undefined : this.cursorAnchor.slice());
  }

  setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    if (seq < this.cursor) {
      return Promise.reject(new RangeError(`cursor cannot move backwards from ${String(this.cursor)} to ${String(seq)}`));
    }
    return this.resetCursor(seq, anchor);
  }

  resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    this.cursor = seq;
    this.cursorAnchor = anchor === undefined ? undefined : anchor.slice();
    return Promise.resolve();
  }

  getDocument(documentId: string): Promise<DocumentState | undefined> {
    const state = this.documents.get(documentId);
    return Promise.resolve(state === undefined ? undefined : { ...state });
  }

  findDocumentByPath(path: string): Promise<DocumentState | undefined> {
    const found = this.sortedDocuments().find((state) => state.path === path && !state.deleted);
    return Promise.resolve(found === undefined ? undefined : { ...found });
  }

  listDocuments(): Promise<DocumentState[]> {
    return Promise.resolve(this.sortedDocuments().map((state) => ({ ...state })));
  }

  /** The documents in id order (UTF-16 code units), IndexedDB's key order. */
  private sortedDocuments(): DocumentState[] {
    return [...this.documents.values()].sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
  }

  putDocument(state: DocumentState): Promise<void> {
    this.documents.set(state.documentId, { ...state });
    return Promise.resolve();
  }

  addPending(operation: PendingOperation): Promise<void> {
    if (this.pending.has(operation.revisionId)) {
      return Promise.reject(new Error(`revision ${operation.revisionId} is already pending`));
    }
    this.pending.set(operation.revisionId, { ...operation });
    return Promise.resolve();
  }

  listPending(): Promise<PendingOperation[]> {
    return Promise.resolve([...this.pending.values()].map((operation) => ({ ...operation })));
  }

  removePending(revisionId: string): Promise<void> {
    this.pending.delete(revisionId);
    return Promise.resolve();
  }

  putDeferred(deferred: DeferredRevision): Promise<void> {
    this.deferred.set(deferred.revision.documentId, copyDeferred(deferred));
    return Promise.resolve();
  }

  getDeferred(documentId: string): Promise<DeferredRevision | undefined> {
    const deferred = this.deferred.get(documentId);
    return Promise.resolve(deferred === undefined ? undefined : copyDeferred(deferred));
  }

  listDeferred(): Promise<DeferredRevision[]> {
    return Promise.resolve([...this.deferred.values()].map(copyDeferred));
  }

  removeDeferred(documentId: string): Promise<void> {
    this.deferred.delete(documentId);
    return Promise.resolve();
  }

  putConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.id, { ...conflict });
    return Promise.resolve();
  }

  listConflicts(): Promise<ConflictRecord[]> {
    return Promise.resolve([...this.conflicts.values()].map((conflict) => ({ ...conflict })));
  }
}

function copyDeferred(deferred: DeferredRevision): DeferredRevision {
  const copy: DeferredRevision = { reason: deferred.reason, revision: { ...deferred.revision } };
  if (deferred.merging !== undefined) copy.merging = { ...deferred.merging };
  if (deferred.unmaterializable !== undefined) copy.unmaterializable = deferred.unmaterializable;
  return copy;
}
