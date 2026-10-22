import { releasedRows, type Absence, type Binding, type ConflictRecord, type DeferredRevision, type DocumentState, type Intent, type Journal, type JournalChanges, type NewIntent, type PendingOperation } from "./journal";

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
   *
   * If another connection holds the database open and does not step aside
   * for the upgrade, the open waits for it and calls `options.onBlocked`, so
   * the caller can tell the user why sync has not started.
   *
   * `options.fileKey` is the device's file key (`F`), which the upgrade from
   * schema 2 records in every binding it derives; it defaults to the POSIX
   * one, the path itself.
   */
  static open(
    factory: IDBFactory,
    name: string,
    migrations: readonly JournalMigration[] = journalMigrations,
    options: JournalOpenOptions = {},
  ): Promise<IndexedDbJournal> {
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
          const context: JournalMigrationContext = { fileKey: options.fileKey ?? ((path) => path) };
          for (let from = event.oldVersion; from < version; from++) migrations[from]?.(transaction, context);
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
      // database open. The upgrade proceeds once that one closes; keep
      // waiting, but say so: a connection that never closes would otherwise
      // make the open hang with no sign.
      request.onblocked = () => {
        options.onBlocked?.();
      };
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

  getCursorAnchor(): Promise<Uint8Array | undefined> {
    return this.transaction(["meta"], "readonly", (transaction) => {
      const request = transaction.objectStore("meta").get(cursorAnchorKey);
      return () => (request.result instanceof Uint8Array ? request.result : undefined);
    });
  }

  setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.transaction(["meta"], "readwrite", (transaction, abort) => {
      const store = transaction.objectStore("meta");
      const request = store.get(cursorKey);
      request.onsuccess = () => {
        const cursor = request.result === undefined ? 0n : (request.result as bigint);
        if (seq < cursor) {
          abort(new RangeError(`cursor cannot move backwards from ${String(cursor)} to ${String(seq)}`));
          return;
        }
        putCursor(store, seq, anchor);
      };
      return () => undefined;
    });
  }

  resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.transaction(["meta"], "readwrite", (transaction) => {
      putCursor(transaction.objectStore("meta"), seq, anchor);
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
    return this.transaction(["conflicts"], "readwrite", (transaction, abort) => {
      putConflictIn(transaction.objectStore("conflicts"), conflict, abort);
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

  documentByFileKey(fileKey: string): Promise<DocumentState | undefined> {
    return this.transaction(["documents"], "readonly", (transaction) => {
      // Records with equal index keys come in primary key (documentId) order.
      const request = transaction.objectStore("documents").index(fileKeyIndex).get(fileKey);
      return () => request.result as DocumentState | undefined;
    });
  }

  documentsByFileKey(fileKey: string): Promise<DocumentState[]> {
    return this.transaction(["documents"], "readonly", (transaction) => {
      // Records with equal index keys come in primary key (documentId) order.
      const request = transaction.objectStore("documents").index(fileKeyIndex).getAll(fileKey);
      return () => request.result as DocumentState[];
    });
  }

  putIntent(intent: NewIntent): Promise<number> {
    return this.transaction(["intents"], "readwrite", (transaction) => {
      // The store's key generator assigns `id`, in increasing order.
      const request = transaction.objectStore("intents").add(intent);
      return () => request.result as number;
    });
  }

  listIntents(): Promise<Intent[]> {
    return this.transaction(["intents"], "readonly", (transaction) => {
      const request = transaction.objectStore("intents").getAll();
      return () => request.result as Intent[];
    });
  }

  removeIntent(id: number): Promise<void> {
    return this.transact({ removeIntents: [id] });
  }

  transact(changes: JournalChanges): Promise<void> {
    const stores = new Set<StoreName>();
    if (changes.cursor !== undefined) stores.add("meta");
    if (nonEmpty(changes.putDocuments) || nonEmpty(changes.removeDocuments)) stores.add("documents");
    if (nonEmpty(changes.removePending) || nonEmpty(changes.sealPending) || nonEmpty(changes.addPending)) stores.add("pending");
    if (nonEmpty(changes.removeDeferred) || nonEmpty(changes.putDeferred)) stores.add("deferred");
    if (nonEmpty(changes.putConflicts)) stores.add("conflicts");
    if (nonEmpty(changes.removeIntents)) stores.add("intents");
    if (stores.size === 0) return this.transaction(["meta"], "readonly", () => () => undefined);
    return this.transaction([...stores], "readwrite", (transaction, abort) => {
      // Read what the checks need first; the writes are issued only once
      // every read is in, so a refused change writes nothing.
      let cursor: bigint | undefined;
      let pending: StoredPending[] | undefined;
      let waiting = 1;
      const ready = () => {
        if (--waiting > 0) return;
        try {
          writeChanges(transaction, abort, changes, cursor, pending);
        } catch (error) {
          abort(asError(error));
        }
      };
      if (changes.cursor !== undefined && changes.cursor.reset !== true) {
        waiting++;
        const request = transaction.objectStore("meta").get(cursorKey);
        request.onsuccess = () => {
          cursor = request.result === undefined ? 0n : (request.result as bigint);
          ready();
        };
      }
      if (stores.has("pending")) {
        waiting++;
        const store = transaction.objectStore("pending");
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () => {
          // Both requests ran in order over one store in one transaction, so keys line up with values.
          pending = (values.result as PendingOperation[]).map((operation, index) => ({ key: keys.result[index] ?? -1, operation }));
          ready();
        };
      }
      ready();
      return () => undefined;
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
export type JournalMigration = (transaction: IDBTransaction, context: JournalMigrationContext) => void;

/** What a migration may know of the device: it runs before the engine, and cannot read the disk. */
export interface JournalMigrationContext {
  /** The device's file key (`F`) of a path. */
  fileKey: (path: string) => string;
}

export interface JournalOpenOptions {
  /** Called when the open has to wait for another connection that keeps the database open. The open still completes once that connection closes. */
  onBlocked?: () => void;
  /** The device's filesystem key (`F`: PathSpace.filesystemKey for its platform), for the migrations; defaults to the path itself, POSIX's. */
  fileKey?: (path: string) => string;
}

type StoreName = "meta" | "documents" | "pending" | "deferred" | "conflicts" | "intents";

/** The documents index on `binding.fileKey`: a document without a binding is not in it. */
const fileKeyIndex = "binding.fileKey";

/** A pending operation with its key in the store. */
interface StoredPending {
  key: IDBValidKey;
  operation: PendingOperation;
}

function nonEmpty(list: readonly unknown[] | undefined): boolean {
  return list !== undefined && list.length > 0;
}

/**
 * Issues transact's writes, given the stored cursor and pending operations
 * it checks against (each undefined if the change does not need it).
 * Throws, before writing anything, on a change it refuses.
 */
function writeChanges(transaction: IDBTransaction, abort: (error: Error) => void, changes: JournalChanges, cursor: bigint | undefined, pending: StoredPending[] | undefined): void {
  if (changes.cursor !== undefined && cursor !== undefined && changes.cursor.seq < cursor) {
    throw new RangeError(`cursor cannot move backwards from ${String(cursor)} to ${String(changes.cursor.seq)}`);
  }
  // The pending store as this transaction leaves it, by revision id: every check runs against it before any write.
  const kept = new Map<string, StoredPending>((pending ?? []).map((entry) => [entry.operation.revisionId, entry]));
  const removed: IDBValidKey[] = [];
  for (const revisionId of changes.removePending ?? []) {
    const entry = kept.get(revisionId);
    if (entry === undefined) continue;
    removed.push(entry.key);
    kept.delete(revisionId);
  }
  const sealed: StoredPending[] = [];
  for (const revisionId of changes.sealPending ?? []) {
    const entry = kept.get(revisionId);
    if (entry === undefined) throw new Error(`cannot seal revision ${revisionId}: it is not pending`);
    sealed.push({ key: entry.key, operation: { ...entry.operation, sealed: true } });
  }
  for (const operation of changes.addPending ?? []) {
    if (kept.has(operation.revisionId)) throw new Error(`revision ${operation.revisionId} is already pending`);
    for (const other of kept.values()) {
      if (other.operation.documentId === operation.documentId) {
        throw new Error(`document ${operation.documentId} already has pending revision ${other.operation.revisionId}`);
      }
    }
    kept.set(operation.revisionId, { key: -1, operation });
  }

  if (changes.cursor !== undefined) putCursor(transaction.objectStore("meta"), changes.cursor.seq, changes.cursor.anchor);
  for (const document of changes.putDocuments ?? []) transaction.objectStore("documents").put(document);
  for (const documentId of changes.removeDocuments ?? []) transaction.objectStore("documents").delete(documentId);
  if (pending !== undefined) {
    const store = transaction.objectStore("pending");
    for (const key of removed) store.delete(key);
    for (const { key, operation } of sealed) store.put(operation, key);
    for (const operation of changes.addPending ?? []) store.add(operation);
  }
  for (const documentId of changes.removeDeferred ?? []) transaction.objectStore("deferred").delete(documentId);
  for (const deferred of changes.putDeferred ?? []) transaction.objectStore("deferred").put(deferred);
  for (const conflict of changes.putConflicts ?? []) putConflictIn(transaction.objectStore("conflicts"), conflict, abort);
  for (const id of changes.removeIntents ?? []) transaction.objectStore("intents").delete(id);
}

/** Adds `conflict` to the log, or replaces the record with its id in place: the same key, so the same place in the log. */
function putConflictIn(store: IDBObjectStore, conflict: ConflictRecord, abort: (error: Error) => void): void {
  const request = store.index("id").getKey(conflict.id);
  request.onsuccess = () => {
    try {
      if (request.result === undefined) store.add(conflict);
      else store.put(conflict, request.result);
    } catch (error) {
      // DataCloneError, say: fail the transaction with it, not with an uncaught exception in this handler.
      abort(asError(error));
    }
  };
}

const cursorKey = "cursor";
/** The anchor of the revision at the cursor; written in the same transaction as the cursor, and absent if it has none. */
const cursorAnchorKey = "cursorAnchor";

/** Stores the cursor and its anchor, in the caller's transaction, so they never disagree. */
function putCursor(store: IDBObjectStore, seq: bigint, anchor: Uint8Array | undefined): void {
  store.put(seq, cursorKey);
  if (anchor === undefined) store.delete(cursorAnchorKey);
  else store.put(anchor.slice(), cursorAnchorKey);
}

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
    // The cursor, under `cursorKey`, and since #155 its anchor under
    // `cursorAnchorKey` (absent in journals written before: no check).
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
  // Version 3: path ownership (docs/design/engine-path-ownership.md §6.1,
  // §6.2). Documents gain `binding` and `absence`, indexed by the binding's
  // file key; pending operations gain `sealed`, indexed by document; and the
  // `intents` store is added. Existing records are only added to
  // (deriveV3Records): the engine still reads every v2 field as before.
  (transaction, context) => {
    const documents = transaction.objectStore("documents");
    documents.createIndex(fileKeyIndex, fileKeyIndex);
    const pending = transaction.objectStore("pending");
    pending.createIndex("documentId", "documentId");
    const intents = transaction.db.createObjectStore("intents", { keyPath: "id", autoIncrement: true });
    intents.createIndex("documentId", "documentId");

    // Requests run in order, so all four reads are in when the last succeeds.
    const deferred = transaction.objectStore("deferred").getAll();
    const states = documents.getAll();
    const pendingKeys = pending.getAllKeys();
    const operations = pending.getAll();
    operations.onsuccess = () => {
      const derived = deriveV3Records(states.result as DocumentState[], operations.result as PendingOperation[], deferred.result as DeferredRevision[], context.fileKey);
      for (const state of derived.documents) documents.put(state);
      derived.pending.forEach((operation, index) => {
        const key = pendingKeys.result[index];
        // A throw here aborts the upgrade, which leaves the v2 journal as it was.
        if (key === undefined) throw new Error("pending operations and their keys disagree");
        pending.put(operation, key);
      });
    };
  },
  // Version 4: bindings derived again (refactor step R4, design §6.2 as
  // amended). Until R4 the engine wrote document rows with the binding of
  // the row it replaced, or none, so a v3 row's binding may be stale; from
  // R4 on the engine maintains them (engine/bindings.ts). Only `binding`
  // and `absence` change.
  (transaction, context) => {
    const documents = transaction.objectStore("documents");
    const deferred = transaction.objectStore("deferred").getAll();
    const states = documents.getAll();
    const operations = transaction.objectStore("pending").getAll();
    operations.onsuccess = () => {
      const derived = deriveV3Records(states.result as DocumentState[], operations.result as PendingOperation[], deferred.result as DeferredRevision[], context.fileKey);
      for (const state of derived.documents) documents.put(state);
    };
  },
  // Version 5: `deleted` no longer doubles as "released" (refactor step
  // R7b, design §6.2 as amended). A released row (no binding, `absence`
  // "released", a deferred revision) gets its base's own `deleted`, false;
  // every other row is untouched (releasedRows).
  (transaction) => {
    const documents = transaction.objectStore("documents");
    const states = documents.getAll();
    const deferred = transaction.objectStore("deferred").getAll();
    deferred.onsuccess = () => {
      for (const state of releasedRows(states.result as DocumentState[], deferred.result as DeferredRevision[])) documents.put(state);
    };
  },
  // Version 6: a deferral's `merging` marker becomes a `merge` intent
  // (refactor step R8, design §6.2): one with no copy step and no bytes,
  // which recovery finishes if the disk shows the recorded result and
  // otherwise drops, so the merge runs again (mergingIntents).
  (transaction) => {
    const deferredStore = transaction.objectStore("deferred");
    const intents = transaction.objectStore("intents");
    const deferred = deferredStore.getAll();
    deferred.onsuccess = () => {
      const migrated = mergingIntents(deferred.result as LegacyDeferredRevision[]);
      for (const entry of migrated.deferred) deferredStore.put(entry);
      for (const intent of migrated.intents) intents.add(intent);
    };
  },
  // Version 7: a binding records whether rule W's `displace` put the file
  // at its spelling (Binding.displaced, design §4.1; #802). A journal
  // before it did not record who moved a file, so every binding is taken
  // for the engine's, which keeps the path merge of a document bound on
  // its tombstone as it was (displacedBindings).
  (transaction) => {
    const documents = transaction.objectStore("documents");
    // Read after the writes earlier migrations make in their own callbacks
    // (v3, v4 derive bindings there), which an upgrade from before v4 runs
    // in this transaction too: a request placed in this callback runs after
    // them.
    documents.count().onsuccess = () => {
      const states = documents.getAll();
      states.onsuccess = () => {
        for (const state of displacedBindings(states.result as DocumentState[])) documents.put(state);
      };
    };
  },
];

/** The rows of journal v7 that change from v6: every bound document, its binding marked `displaced` (design §4.1; #802). */
export function displacedBindings(documents: readonly DocumentState[]): DocumentState[] {
  return documents.flatMap((state) => (state.binding === undefined || state.binding === null || state.binding.displaced === true ? [] : [{ ...state, binding: { ...state.binding, displaced: true } }]));
}

/** A deferral as journals before v6 may hold it: with the `merging` marker of a merge being written. */
type LegacyDeferredRevision = DeferredRevision & { merging?: { path: string; contentHash: string | null } };

/**
 * The `merge` intents of a journal's `merging` markers (design §6.2), and
 * the deferrals that carried them, without the marker. The intent records
 * the revision and the result's path and hash only: the merge's local file
 * and copies were not recorded.
 */
export function mergingIntents(deferred: readonly LegacyDeferredRevision[]): { deferred: DeferredRevision[]; intents: NewIntent[] } {
  const marked = deferred.filter((entry) => entry.merging !== undefined);
  return {
    deferred: marked.map((entry) => {
      const copy = { ...entry };
      delete copy.merging;
      return copy;
    }),
    intents: marked.map((entry) => ({
      kind: "merge",
      documentId: entry.revision.documentId,
      steps: { revision: entry.revision, local: { path: entry.merging?.path ?? "", hash: null }, result: { path: entry.merging?.path ?? "", hash: entry.merging?.contentHash ?? null }, respelled: false, adopts: false, copies: [], legacy: true },
    })),
  };
}

/**
 * The v3 fields of a v2 journal's records (design §6.2), from what the
 * journal holds alone. It only adds information: every v2 field keeps its
 * value, so the engine, which still reads them all, behaves as before.
 * - A live document is bound to the file at its path, as last synced.
 * - A deleted document whose deferral is `unmaterializable` was released (a
 *   release stored `deleted: true` over a live base); any other deleted
 *   document never had a file here.
 * - A document's last pending operation overrides both: a delete means the
 *   user deleted the file, and any other operation binds the document to
 *   the file at its path, with the content the engine read there.
 * - Every pending operation is sealed, since any may have been sent.
 *
 * `pending` is in key (insertion) order, and the result's `pending` lines
 * up with it. A pending create has no document row and gets none here,
 * since the engine reads every row as a synced base until refactor step R5
 * (design §6.2 as amended).
 */
export function deriveV3Records(
  documents: readonly DocumentState[],
  pending: readonly PendingOperation[],
  deferred: readonly DeferredRevision[],
  fileKey: (path: string) => string,
): { documents: DocumentState[]; pending: PendingOperation[] } {
  const released = new Set(deferred.filter((entry) => entry.reason === "unmaterializable").map((entry) => entry.revision.documentId));
  const lastOperation = new Map<string, PendingOperation>();
  for (const operation of pending) lastOperation.set(operation.documentId, operation);
  const bound = (spelling: string, seen: string): { binding: Binding; absence: null } => ({ binding: { spelling, fileKey: fileKey(spelling), seen }, absence: null });
  const unbound = (absence: Absence): { binding: null; absence: Absence } => ({ binding: null, absence });
  return {
    documents: documents.map((state) => {
      const operation = lastOperation.get(state.documentId);
      if (operation !== undefined) return { ...state, ...(operation.deleted ? unbound("user-deleted") : bound(operation.path, operation.contentHash)) };
      if (!state.deleted) return { ...state, ...bound(state.path, state.baseHash) };
      return { ...state, ...unbound(released.has(state.documentId) ? "released" : "never") };
    }),
    pending: pending.map((operation) => ({ ...operation, sealed: true })),
  };
}

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
