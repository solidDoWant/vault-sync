import type { ConflictEntry, Cursor, DocEntry, JournalChange, JournalState, PendingOp, SkippedEntry, SyncJournal, WaitingEntry } from "./journal";

/** The schema version of the database: 2 added the `waiting` store. */
const version = 2;
const stores = ["meta", "docs", "pending", "conflicts", "skipped", "waiting"] as const;

interface StoredCursor {
  /** The meta store's record key: "cursor". */
  key: string;
  seq: string;
  anchor: Uint8Array;
}

/**
 * The durable device journal (docs/design/engine.md §2) on IndexedDB, which
 * Obsidian desktop and mobile both have. `commit` is one IndexedDB
 * transaction and resolves once it completed with `strict` durability, so a
 * crash leaves each engine step recorded fully or not at all.
 *
 * The `IDBFactory` is passed in: the plugin passes the window's, tests pass
 * `fake-indexeddb`.
 */
export class IndexedDbSyncJournal implements SyncJournal {
  private constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => {
      db.close();
    };
  }

  /** Opens (creating if needed) the journal in database `name`. */
  static open(factory: IDBFactory, name: string): Promise<IndexedDbSyncJournal> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, version);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 1) {
          db.createObjectStore("meta", { keyPath: "key" });
          db.createObjectStore("docs", { keyPath: "documentId" });
          db.createObjectStore("pending", { keyPath: "opId" });
          db.createObjectStore("conflicts", { keyPath: "path" });
          db.createObjectStore("skipped", { keyPath: "documentId" });
        }
        if (event.oldVersion < 2) db.createObjectStore("waiting", { keyPath: "documentId" });
      };
      request.onsuccess = () => {
        resolve(new IndexedDbSyncJournal(request.result));
      };
      request.onerror = () => {
        reject(request.error ?? new Error("the journal could not be opened"));
      };
    });
  }

  close(): void {
    this.db.close();
  }

  async load(): Promise<JournalState> {
    const transaction = this.db.transaction([...stores], "readonly");
    const [meta, docs, pending, conflicts, skipped, waiting] = await Promise.all([
      all<StoredCursor>(transaction.objectStore("meta")),
      all<DocEntry>(transaction.objectStore("docs")),
      all<PendingOp>(transaction.objectStore("pending")),
      all<ConflictEntry>(transaction.objectStore("conflicts")),
      all<SkippedEntry>(transaction.objectStore("skipped")),
      all<WaitingEntry>(transaction.objectStore("waiting")),
    ]);
    const stored = meta.find((record) => record.key === "cursor");
    const cursor: Cursor = stored === undefined ? { seq: 0n, anchor: new Uint8Array() } : { seq: BigInt(stored.seq), anchor: stored.anchor };
    return {
      cursor,
      docs: new Map(docs.map((entry) => [entry.documentId, entry])),
      pending: pending.sort((a, b) => a.order - b.order),
      conflicts: new Map(conflicts.map((entry) => [entry.path, entry])),
      skipped: new Map(skipped.map((entry) => [entry.documentId, entry])),
      waiting: new Map(waiting.map((entry) => [entry.documentId, entry])),
    };
  }

  commit(change: JournalChange): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([...stores], "readwrite", {
        durability: "strict",
      });
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("a journal write failed"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("a journal write was aborted"));
      };
      if (change.cursor !== undefined) {
        const record: StoredCursor = {
          key: "cursor",
          seq: change.cursor.seq.toString(),
          anchor: change.cursor.anchor.slice(),
        };
        transaction.objectStore("meta").put(record);
      }
      const docs = transaction.objectStore("docs");
      for (const id of change.deleteDocs ?? []) docs.delete(id);
      for (const entry of change.putDocs ?? []) docs.put(entry);
      const pending = transaction.objectStore("pending");
      for (const id of change.deletePending ?? []) pending.delete(id);
      for (const op of change.putPending ?? []) pending.put(op);
      const conflicts = transaction.objectStore("conflicts");
      for (const path of change.deleteConflicts ?? []) conflicts.delete(path);
      for (const entry of change.putConflicts ?? []) conflicts.put(entry);
      const skipped = transaction.objectStore("skipped");
      for (const id of change.deleteSkipped ?? []) skipped.delete(id);
      for (const entry of change.putSkipped ?? []) skipped.put(entry);
      const waiting = transaction.objectStore("waiting");
      for (const id of change.deleteWaiting ?? []) waiting.delete(id);
      for (const entry of change.putWaiting ?? []) waiting.put(entry);
    });
  }
}

function all<T>(store: IDBObjectStore): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      resolve(request.result as T[]);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("a journal read failed"));
    };
  });
}
