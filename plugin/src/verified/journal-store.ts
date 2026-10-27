// The verified core's journal as the shell stores it (#1042, the second part
// of #952; docs/design/verified-core.md §2.2, §4). `CoreJournal` is the whole
// `Journal` of plugin/verified/spec/Engine.dfy as a plain TypeScript value:
// one row per document (base, ahead, binding or absence, outbox), the cursor,
// the open intents and the conflict log, plus the feed anchor.
//
// `CoreJournalStore` keeps it in IndexedDB. Each `persist` is exactly one
// `strict`-durability transaction, so a crash at any point of a journal
// write leaves either the journal before it or the one it wrote, never a mix
// (the atomic journal writes `ShellStep` assumes).

export type Kind = "note" | "binary";
export type Absence = "user-deleted" | "released" | "never";

/** A revision as the server stores it (`Revision`). `device` is empty where no device is known to have committed it. */
export interface CoreRevision {
  id: string;
  doc: string;
  position: bigint;
  parent: string | null;
  path: string;
  content: string;
  kind: Kind;
  deleted: boolean;
  device: string;
}

/** `Base`: the last server revision applied or acknowledged. */
export interface CoreBase {
  rev: string;
  position: bigint;
  path: string;
  content: string;
  kind: Kind;
  deleted: boolean;
}

/** `Blocker`: why the `ahead` revision waits. */
export type Blocker =
  | { kind: "local-changes" }
  | { kind: "path-held" }
  | { kind: "invalid-path" }
  | { kind: "unmaterializable"; alias: boolean }
  | { kind: "out-of-scope" }
  | { kind: "too-large" };

/** `Ahead`: the newest server revision not applied, and why. */
export interface CoreAhead {
  revision: CoreRevision;
  blocker: Blocker;
  postponed: boolean;
}

export interface CoreBinding {
  spelling: string;
  seen: string;
  displaced: boolean;
  userSpelling: string | null;
}

export interface CoreOutbox {
  rev: string;
  baseRev: string | null;
  path: string;
  content: string;
  kind: Kind;
  deleted: boolean;
  sealed: boolean;
  rejected: boolean;
}

export interface CoreDocument {
  base: CoreBase | null;
  ahead: CoreAhead | null;
  binding: CoreBinding | null;
  absence: Absence;
  outbox: CoreOutbox | null;
}

/** `IntentKind` (design §4.4). */
export type CoreIntentKind =
  | { kind: "apply"; doc: string; revision: CoreRevision }
  | {
      kind: "merge";
      doc: string;
      revision: CoreRevision;
      result: string;
      resultContent: string;
      copy: { path: string; content: string } | null;
    }
  | { kind: "displace"; doc: string; from: string; to: string; content: string }
  | { kind: "detach"; doc: string; from: string; to: string }
  | { kind: "commit"; doc: string }
  | { kind: "resync" };

export interface CoreIntent {
  id: string;
  intent: CoreIntentKind;
}

/** The conflict log, a UI log only (§4.1). */
export interface CoreConflict {
  doc: string | null;
  copy: string;
  reason: string;
}

export interface CoreJournal {
  documents: Record<string, CoreDocument>;
  cursor: bigint;
  /**
   * The feed anchor (SPEC.md §6.1, §8 "Divergence"): the server's anchor of
   * the last feed entry the device read, sent with the cursor so the server
   * can tell a restored feed from the one the device read. The shell's form
   * of the ghost `Journal.anchor`; null before the device read any entry,
   * or for a cursor stored without one.
   */
  anchor: Uint8Array | null;
  intents: CoreIntent[];
  conflicts: CoreConflict[];
}

/** An empty journal: nothing read, nothing known. */
export function emptyJournal(): CoreJournal {
  return { documents: {}, cursor: 0n, anchor: null, intents: [], conflicts: [] };
}

const documentsStore = "documents";
const metaStore = "meta";
const schemaVersion = 1;
/** Written in every persist: its presence means a journal was persisted. */
const cursorKey = "cursor";
const anchorKey = "anchor";
const intentsKey = "intents";
const conflictsKey = "conflicts";

/** The store's database was closed, by `close` or by the browser. */
export class CoreJournalClosedError extends Error {
  override name = "CoreJournalClosedError";
}

/**
 * The verified core's journal on IndexedDB, in a database of its own: the
 * engine's journal (`IndexedDbJournal`) is left as it is, which keeps the
 * migration from it repeatable until its result is persisted.
 */
export class CoreJournalStore {
  /** The journal known to be durable, or undefined when not known (before the first read, or after a failed write). */
  private durable: CoreJournal | undefined;
  private closedReason: string | undefined;

  private constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => {
      this.close("the core journal's schema was upgraded by another connection");
    };
    db.onclose = () => {
      this.closedReason ??= "the browser closed the core journal's database";
    };
  }

  /** Opens, creating it if needed, the core journal in database `name`. */
  static open(factory: IDBFactory, name: string): Promise<CoreJournalStore> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, schemaVersion);
      } catch (error) {
        reject(asError(error));
        return;
      }
      request.onupgradeneeded = (event) => {
        if (event.oldVersion < 1) {
          request.result.createObjectStore(documentsStore);
          request.result.createObjectStore(metaStore);
        }
      };
      request.onsuccess = () => {
        resolve(new CoreJournalStore(request.result));
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`opening the core journal ${JSON.stringify(name)} failed`));
      };
    });
  }

  close(reason = "the core journal was closed"): void {
    this.closedReason ??= reason;
    this.db.close();
  }

  /** The persisted journal, or undefined if none was ever persisted. */
  async load(): Promise<CoreJournal | undefined> {
    const journal = await this.read();
    this.durable = journal;
    return journal === undefined ? undefined : copyJournal(journal);
  }

  /**
   * Replaces the persisted journal with `journal` in one durable
   * transaction: all of it or, if the write fails or is cut short, nothing.
   * Resolves once the transaction is on disk.
   */
  async persist(journal: CoreJournal): Promise<void> {
    const next = copyJournal(journal);
    const previous = this.durable;
    // Until this write is known to have landed or not, the durable journal is unknown.
    this.durable = undefined;
    await this.transaction("readwrite", (transaction) => {
      const documents = transaction.objectStore(documentsStore);
      const meta = transaction.objectStore(metaStore);
      if (previous === undefined) {
        documents.clear();
        for (const [id, document] of Object.entries(next.documents)) documents.put(document, id);
      } else {
        for (const id of Object.keys(previous.documents)) if (!Object.hasOwn(next.documents, id)) documents.delete(id);
        for (const [id, document] of Object.entries(next.documents)) {
          const before = previous.documents[id];
          if (before === undefined || !deepEqual(before, document)) documents.put(document, id);
        }
      }
      meta.put(next.cursor, cursorKey);
      if (next.anchor === null) meta.delete(anchorKey);
      else meta.put(next.anchor, anchorKey);
      meta.put(next.intents, intentsKey);
      meta.put(next.conflicts, conflictsKey);
      return undefined;
    });
    this.durable = next;
  }

  private async read(): Promise<CoreJournal | undefined> {
    return this.transaction("readonly", (transaction) => {
      const documents = transaction.objectStore(documentsStore);
      const meta = transaction.objectStore(metaStore);
      const keys = documents.getAllKeys();
      const rows = documents.getAll();
      const cursor = meta.get(cursorKey);
      const anchor = meta.get(anchorKey);
      const intents = meta.get(intentsKey);
      const conflicts = meta.get(conflictsKey);
      return () => {
        if (cursor.result === undefined) return undefined;
        const ids = keys.result as string[];
        const values = rows.result as CoreDocument[];
        return {
          documents: Object.fromEntries(ids.map((id, index) => [id, values[index] as CoreDocument])),
          cursor: cursor.result as bigint,
          anchor: (anchor.result as Uint8Array | undefined) ?? null,
          intents: intents.result as CoreIntent[],
          conflicts: conflicts.result as CoreConflict[],
        };
      };
    });
  }

  /** Runs `work` in one transaction over both stores; resolves with its result once the transaction completed durably. */
  private transaction<T>(mode: IDBTransactionMode, work: (transaction: IDBTransaction) => (() => T) | undefined): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new CoreJournalClosedError(this.closedReason));
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = this.db.transaction([documentsStore, metaStore], mode, { durability: "strict" });
      } catch (error) {
        reject(this.closedReason === undefined ? asError(error) : new CoreJournalClosedError(this.closedReason, { cause: error }));
        return;
      }
      let result: (() => T) | undefined;
      transaction.oncomplete = () => {
        resolve(result === undefined ? (undefined as T) : result());
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("a core journal transaction failed"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("a core journal transaction was aborted"));
      };
      try {
        result = work(transaction);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already finished.
        }
        reject(asError(error));
      }
    });
  }
}

function copyJournal(journal: CoreJournal): CoreJournal {
  return structuredClone(journal);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, index) => byte === b[index]);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
