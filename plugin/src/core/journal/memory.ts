import type { DocumentState, Journal, PendingOperation } from "./journal";

/** A non-durable Journal for unit tests and the simulation harness. */
export class InMemoryJournal implements Journal {
  private cursor = 0n;
  private readonly documents = new Map<string, DocumentState>();
  private readonly pending = new Map<string, PendingOperation>();

  getCursor(): Promise<bigint> {
    return Promise.resolve(this.cursor);
  }

  setCursor(seq: bigint): Promise<void> {
    if (seq < this.cursor) {
      return Promise.reject(new RangeError(`cursor cannot move backwards from ${String(this.cursor)} to ${String(seq)}`));
    }
    this.cursor = seq;
    return Promise.resolve();
  }

  getDocument(documentId: string): Promise<DocumentState | undefined> {
    const state = this.documents.get(documentId);
    return Promise.resolve(state === undefined ? undefined : { ...state });
  }

  findDocumentByPath(path: string): Promise<DocumentState | undefined> {
    for (const state of this.documents.values()) {
      if (state.path === path) return Promise.resolve({ ...state });
    }
    return Promise.resolve(undefined);
  }

  listDocuments(): Promise<DocumentState[]> {
    return Promise.resolve([...this.documents.values()].map((state) => ({ ...state })));
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
}
