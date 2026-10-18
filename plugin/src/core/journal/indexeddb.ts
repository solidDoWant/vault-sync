import type { ConflictRecord, DeferredRevision, DocumentState, Journal, PendingOperation } from "./journal";

/**
 * The durable Journal (SPEC.md §8), on IndexedDB: Obsidian desktop
 * (Electron) and mobile (Android WebView, iOS WKWebView) all have it.
 *
 * Every method is exactly one IndexedDB transaction, and its promise
 * resolves only once that transaction has completed with `strict`
 * durability, i.e. is on disk. A transaction is all-or-nothing, so a crash
 * (the app killed, the device powered off) leaves each engine step either
 * fully recorded or not at all; the engine's write ordering does the rest.
 *
 * The `IDBFactory` is passed in, so this module touches no global: the
 * plugin passes the window's, tests and the Node simulation pass
 * `fake-indexeddb`.
 */
export class IndexedDbJournal implements Journal {
  private closedReason: string | undefined;

  private constructor(private readonly db: IDBDatabase) {
    // Another connection wants to upgrade the schema (a newer vault-sync in
    // another window): step aside instead of blocking it. Later calls fail
    // loudly; nothing is written with an outdated schema.
    db.onversionchange = () => {
      this.close("the journal's schema was upgraded by another connection");
    };
    // The browser closed the connection itself (storage cleared, disk error).
    db.onclose = () => {
      this.closedReason ??= "the browser closed the journal's database";
    };
  }

  /**
   * Opens (creating or upgrading as needed) the journal in database `name`.
   * `migrations` is the schema history; production code uses the default.
   * A database written by a newer schema than `migrations` knows is refused
   * with JournalVersionError and left untouched.
   */
  static open(factory: IDBFactory, name: string, migrations: readonly JournalMigration[] = journalMigrations): Promise<IndexedDbJournal> {
    const version = migrations.length;
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, version);
      } catch (error) {
        reject(asError(error));
        return;
      }
      request.onupgradeneeded = (event) => {
        // The whole upgrade runs in this one versionchange transaction: if
        // any migration fails, it aborts and the database stays at its old
        // version with its old data.
        const transaction = request.transaction;
        if (transaction === null) return;
        try {
          for (let from = event.oldVersion; from < version; from++) migrations[from]?.(transaction);
        } catch (error) {
          transaction.abort();
          reject(new JournalMigrationError(`journal schema migration ${String(event.oldVersion)} to ${String(version)} failed`, { cause: error }));
        }
      };
      request.onsuccess = () => {
        resolve(new IndexedDbJournal(request.result));
      };
      request.onerror = (event) => {
        const error = request.error;
        // Rejected already if a migration threw; this is the resulting abort.
        if (error?.name === "AbortError") {
          event.preventDefault();
          reject(new JournalMigrationError(`journal schema migration to ${String(version)} was aborted`, { cause: error }));
          return;
        }
        if (error?.name === "VersionError") {
          reject(new JournalVersionError(`the journal in ${JSON.stringify(name)} was written by a newer vault-sync (schema newer than ${String(version)})`, { cause: error }));
          return;
        }
        reject(asError(error));
      };
      // Another connection (an older vault-sync in another window) holds the
      // database open. The upgrade proceeds once that one closes; keep waiting.
      request.onblocked = () => undefined;
    });
  }

  /** Closes the connection. Calls after this reject. */
  close(reason = "the journal is closed"): void {
    this.closedReason ??= reason;
    this.db.close();
  }

  getCursor(): Promise<bigint> {
    return this.transaction(["meta"], "readonly", (transaction) => {
      const request = transaction.objectStore("meta").get(cursorKey);
      return () => (request.result === undefined ? 0n : (request.result as bigint));
    });
  }

  setCursor(seq: bigint): Promise<void> {
    return this.transaction(["meta"], "readwrite", (transaction, abort) => {
      const store = transaction.objectStore("meta");
      const request = store.get(cursorKey);
      request.onsuccess = () => {
        const cursor = request.result === undefined ? 0n : (request.result as bigint);
        if (seq < cursor) {
          abort(new RangeError(`cursor cannot move backwards from ${String(cursor)} to ${String(seq)}`));
          return;
        }
        store.put(seq, cursorKey);
      };
      return () => undefined;
    });
  }

  resetCursor(seq: bigint): Promise<void> {
    return this.transaction(["meta"], "readwrite", (transaction) => {
      transaction.objectStore("meta").put(seq, cursorKey);
      return () => undefined;
    });
  }

  getDocument(documentId: string): Promise<DocumentState | undefined> {
    return this.transaction(["documents"], "readonly", (transaction) => {
      const request = transaction.objectStore("documents").get(documentId);
      return () => request.result as DocumentState | undefined;
    });
  }

  findDocumentByPath(path: string): Promise<DocumentState | undefined> {
    return this.transaction(["documents"], "readonly", (transaction) => {
      const request = transaction.objectStore("documents").index("path").getAll(path);
      return () => (request.result as DocumentState[]).find((state) => !state.deleted);
    });
  }

  listDocuments(): Promise<DocumentState[]> {
    return this.transaction(["documents"], "readonly", (transaction) => {
      const request = transaction.objectStore("documents").getAll();
      return () => request.result as DocumentState[];
    });
  }

  putDocument(state: DocumentState): Promise<void> {
    return this.transaction(["documents"], "readwrite", (transaction) => {
      transaction.objectStore("documents").put(state);
      return () => undefined;
    });
  }

  addPending(operation: PendingOperation): Promise<void> {
    return this.transaction(["pending"], "readwrite", (transaction, abort) => {
      // `add` on the unique revisionId index fails the request (and so the
      // transaction) instead of replacing an operation already pending.
      const request = transaction.objectStore("pending").add(operation);
      request.onerror = (event) => {
        event.preventDefault();
        abort(
          request.error?.name === "ConstraintError"
            ? new Error(`revision ${operation.revisionId} is already pending`)
            : asError(request.error),
        );
      };
      return () => undefined;
    });
  }

  listPending(): Promise<PendingOperation[]> {
    return this.transaction(["pending"], "readonly", (transaction) => {
      // Keys are auto-incremented, so key order is insertion order.
      const request = transaction.objectStore("pending").getAll();
      return () => request.result as PendingOperation[];
    });
  }

  removePending(revisionId: string): Promise<void> {
    return this.transaction(["pending"], "readwrite", (transaction) => {
      const store = transaction.objectStore("pending");
      const request = store.index("revisionId").getKey(revisionId);
      request.onsuccess = () => {
        if (request.result !== undefined) store.delete(request.result);
      };
      return () => undefined;
    });
  }

  putDeferred(deferred: DeferredRevision): Promise<void> {
    return this.transaction(["deferred"], "readwrite", (transaction) => {
      transaction.objectStore("deferred").put(deferred);
      return () => undefined;
    });
  }

  getDeferred(documentId: string): Promise<DeferredRevision | undefined> {
    return this.transaction(["deferred"], "readonly", (transaction) => {
      const request = transaction.objectStore("deferred").get(documentId);
      return () => request.result as DeferredRevision | undefined;
    });
  }

  listDeferred(): Promise<DeferredRevision[]> {
    return this.transaction(["deferred"], "readonly", (transaction) => {
      const request = transaction.objectStore("deferred").getAll();
      return () => request.result as DeferredRevision[];
    });
  }

  removeDeferred(documentId: string): Promise<void> {
    return this.transaction(["deferred"], "readwrite", (transaction) => {
      transaction.objectStore("deferred").delete(documentId);
      return () => undefined;
    });
  }

  putConflict(conflict: ConflictRecord): Promise<void> {
    return this.transaction(["conflicts"], "readwrite", (transaction) => {
      const store = transaction.objectStore("conflicts");
      const request = store.index("id").getKey(conflict.id);
      request.onsuccess = () => {
        // Replacing in place: the same key, so the same place in the log.
        if (request.result === undefined) store.add(conflict);
        else store.put(conflict, request.result);
      };
      return () => undefined;
    });
  }

  listConflicts(): Promise<ConflictRecord[]> {
    return this.transaction(["conflicts"], "readonly", (transaction) => {
      // Keys are auto-incremented, so key order is the order recorded.
      const request = transaction.objectStore("conflicts").getAll();
      return () => request.result as ConflictRecord[];
    });
  }

  /**
   * Runs `work` in one transaction and resolves with what its returned
   * getter reads, only once the transaction has completed (committed). Any
   * failed request, or `abort(error)`, aborts the whole transaction, which
   * rejects with that error and leaves the journal unchanged.
   */
  private transaction<T>(
    stores: StoreName[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction, abort: (error: Error) => void) => () => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closedReason !== undefined) {
        reject(new JournalClosedError(this.closedReason));
        return;
      }
      let transaction: IDBTransaction;
      try {
        transaction = this.db.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      } catch (error) {
        // InvalidStateError: the browser closed the connection and its close event has not run yet.
        reject(asError(error));
        return;
      }
      let failure: Error | undefined;
      const abort = (error: Error) => {
        failure ??= error;
        try {
          transaction.abort();
        } catch {
          // Already finished; oncomplete/onabort reports the outcome.
        }
      };
      let result: () => T = () => {
        throw new Error("journal transaction completed before its work ran");
      };
      transaction.oncomplete = () => {
        try {
          resolve(result());
        } catch (error) {
          reject(asError(error));
        }
      };
      transaction.onabort = () => {
        reject(failure ?? asError(transaction.error ?? new Error("journal transaction aborted")));
      };
      try {
        result = work(transaction, abort);
      } catch (error) {
        abort(asError(error));
      }
    });
  }
}

/** One step of the journal's schema history: upgrades the database from version `index` to `index + 1`, inside the versionchange transaction. */
export type JournalMigration = (transaction: IDBTransaction) => void;

type StoreName = "meta" | "documents" | "pending" | "deferred" | "conflicts";

const cursorKey = "cursor";

/**
 * The journal's schema history. Append a migration to change the schema;
 * never edit or remove one, since journals on users' devices were written
 * by it. A migration must carry existing data forward (the cursor in
 * particular), so an upgrade never forces a full resync.
 */
export const journalMigrations: readonly JournalMigration[] = [
  // Version 1.
  (transaction) => {
    const db = transaction.db;
    // The cursor, under `cursorKey`.
    db.createObjectStore("meta");
    const documents = db.createObjectStore("documents", { keyPath: "documentId" });
    documents.createIndex("path", "path");
    // Auto-incremented keys keep insertion order.
    const pending = db.createObjectStore("pending", { autoIncrement: true });
    pending.createIndex("revisionId", "revisionId", { unique: true });
    db.createObjectStore("deferred", { keyPath: "revision.documentId" });
  },
  // Version 2: the conflict log (#18). Auto-incremented keys keep it oldest
  // first; a record replaced by id keeps its key, and so its place. Existing
  // stores are untouched (a deferral's optional `merging` marker needs no
  // schema: deferrals are stored whole).
  (transaction) => {
    const conflicts = transaction.db.createObjectStore("conflicts", { autoIncrement: true });
    conflicts.createIndex("id", "id", { unique: true });
  },
];

/** The journal was written by a newer vault-sync than this one. */
export class JournalVersionError extends Error {
  override readonly name = "JournalVersionError";
}

/** A schema upgrade failed; the journal is unchanged at its old version. */
export class JournalMigrationError extends Error {
  override readonly name = "JournalMigrationError";
}

/** The journal's connection is closed. */
export class JournalClosedError extends Error {
  override readonly name = "JournalClosedError";
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error !== null && typeof error === "object" && "name" in error && "message" in error) {
    return new Error(`${String(error.name)}: ${String(error.message)}`, { cause: error });
  }
  return new Error(String(error));
}
