import type { ConflictRecord, DeferredRevision, DocumentState, Intent, Journal, JournalChanges, NewIntent, PendingOperation } from "./journal";

/** Everything the journal holds; a transaction works on a copy and replaces it whole. */
interface State {
  cursor: bigint;
  cursorAnchor: Uint8Array | undefined;
  documents: Map<string, DocumentState>;
  /** By revision id, in insertion order. */
  pending: Map<string, PendingOperation>;
  deferred: Map<string, DeferredRevision>;
  conflicts: Map<string, ConflictRecord>;
  intents: Map<number, Intent>;
  nextIntentId: number;
}

/** A non-durable Journal for unit tests. */
export class InMemoryJournal implements Journal {
  private state: State = {
    cursor: 0n,
    cursorAnchor: undefined,
    documents: new Map(),
    pending: new Map(),
    deferred: new Map(),
    conflicts: new Map(),
    intents: new Map(),
    nextIntentId: 1,
  };

  getCursor(): Promise<bigint> {
    return Promise.resolve(this.state.cursor);
  }

  getCursorAnchor(): Promise<Uint8Array | undefined> {
    return Promise.resolve(copy(this.state.cursorAnchor));
  }

  setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.change({ cursor: anchor === undefined ? { seq } : { seq, anchor } });
  }

  resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.change({ cursor: anchor === undefined ? { seq, reset: true } : { seq, anchor, reset: true } });
  }

  getDocument(documentId: string): Promise<DocumentState | undefined> {
    return Promise.resolve(copy(this.state.documents.get(documentId)));
  }

  findDocumentByPath(path: string): Promise<DocumentState | undefined> {
    return Promise.resolve(copy(this.sortedDocuments().find((state) => state.path === path && !state.deleted)));
  }

  documentByFileKey(fileKey: string): Promise<DocumentState | undefined> {
    return Promise.resolve(copy(this.sortedDocuments().find((state) => state.binding?.fileKey === fileKey)));
  }

  documentsByFileKey(fileKey: string): Promise<DocumentState[]> {
    return Promise.resolve(this.sortedDocuments().filter((state) => state.binding?.fileKey === fileKey).map(copy));
  }

  listDocuments(): Promise<DocumentState[]> {
    return Promise.resolve(this.sortedDocuments().map(copy));
  }

  /** The documents in id order (UTF-16 code units), IndexedDB's key order. */
  private sortedDocuments(): DocumentState[] {
    return [...this.state.documents.values()].sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
  }

  putDocument(state: DocumentState): Promise<void> {
    return this.change({ putDocuments: [state] });
  }

  addPending(operation: PendingOperation): Promise<void> {
    return this.update((state) => {
      addPending(state, operation);
    });
  }

  listPending(): Promise<PendingOperation[]> {
    return Promise.resolve([...this.state.pending.values()].map(copy));
  }

  removePending(revisionId: string): Promise<void> {
    return this.change({ removePending: [revisionId] });
  }

  putDeferred(deferred: DeferredRevision): Promise<void> {
    return this.change({ putDeferred: [deferred] });
  }

  getDeferred(documentId: string): Promise<DeferredRevision | undefined> {
    return Promise.resolve(copy(this.state.deferred.get(documentId)));
  }

  listDeferred(): Promise<DeferredRevision[]> {
    return Promise.resolve([...this.state.deferred.values()].map(copy));
  }

  removeDeferred(documentId: string): Promise<void> {
    return this.change({ removeDeferred: [documentId] });
  }

  putConflict(conflict: ConflictRecord): Promise<void> {
    return this.change({ putConflicts: [conflict] });
  }

  listConflicts(): Promise<ConflictRecord[]> {
    return Promise.resolve([...this.state.conflicts.values()].map(copy));
  }

  putIntent(intent: NewIntent): Promise<number> {
    let id = 0;
    return this.update((state) => {
      id = state.nextIntentId++;
      state.intents.set(id, { ...copy(intent), id });
    }).then(() => id);
  }

  listIntents(): Promise<Intent[]> {
    return Promise.resolve([...this.state.intents.values()].map(copy));
  }

  removeIntent(id: number): Promise<void> {
    return this.change({ removeIntents: [id] });
  }

  transact(changes: JournalChanges): Promise<void> {
    return this.change(changes);
  }

  /** transact's work, which the single-change methods share; subclasses that wrap transact do not see those calls. */
  private change(changes: JournalChanges): Promise<void> {
    return this.update((state) => {
      const { cursor } = changes;
      if (cursor !== undefined) {
        if (cursor.reset !== true && cursor.seq < state.cursor) {
          throw new RangeError(`cursor cannot move backwards from ${String(state.cursor)} to ${String(cursor.seq)}`);
        }
        state.cursor = cursor.seq;
        state.cursorAnchor = copy(cursor.anchor);
      }
      for (const document of changes.putDocuments ?? []) state.documents.set(document.documentId, copy(document));
      for (const documentId of changes.removeDocuments ?? []) state.documents.delete(documentId);
      for (const revisionId of changes.removePending ?? []) state.pending.delete(revisionId);
      for (const revisionId of changes.sealPending ?? []) {
        const operation = state.pending.get(revisionId);
        if (operation === undefined) throw new Error(`cannot seal revision ${revisionId}: it is not pending`);
        state.pending.set(revisionId, { ...operation, sealed: true });
      }
      for (const operation of changes.addPending ?? []) {
        for (const other of state.pending.values()) {
          if (other.documentId === operation.documentId && other.revisionId !== operation.revisionId) {
            throw new Error(`document ${operation.documentId} already has pending revision ${other.revisionId}`);
          }
        }
        addPending(state, operation);
      }
      for (const documentId of changes.removeDeferred ?? []) state.deferred.delete(documentId);
      for (const deferred of changes.putDeferred ?? []) state.deferred.set(deferred.revision.documentId, copy(deferred));
      for (const conflict of changes.putConflicts ?? []) state.conflicts.set(conflict.id, copy(conflict));
      for (const id of changes.removeIntents ?? []) state.intents.delete(id);
    });
  }

  /**
   * Runs `change` on a copy of the state and keeps the copy only if it
   * succeeds: all or nothing, as an IndexedDB transaction. The copy is
   * shallow: `change` replaces stored values, never mutates them.
   */
  private update(change: (state: State) => void): Promise<void> {
    const current = this.state;
    const next: State = {
      ...current,
      documents: new Map(current.documents),
      pending: new Map(current.pending),
      deferred: new Map(current.deferred),
      conflicts: new Map(current.conflicts),
      intents: new Map(current.intents),
    };
    try {
      change(next);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.state = next;
    return Promise.resolve();
  }
}

function addPending(state: State, operation: PendingOperation): void {
  if (state.pending.has(operation.revisionId)) throw new Error(`revision ${operation.revisionId} is already pending`);
  state.pending.set(operation.revisionId, copy(operation));
}

/** A deep copy sharing nothing with `value`, as IndexedDB's structured clone. */
function copy<T>(value: T): T {
  return structuredClone(value);
}
