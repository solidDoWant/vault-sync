import { IDBDatabase as FakeIDBDatabase, IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { SyncEngine } from "../engine/engine";
import type { MergeHook } from "../engine/merge";
import { InMemoryServer } from "../engine/memory-server";
import { Crash, CrashingVault, CrashPoints, files } from "../engine/testing";
import { createProtocolClient } from "../protocol/client";
import { InMemoryVault } from "../vault/memory";
import { describeValue, journalConformance, runJournalConformanceCase, sampleConflict, sampleDeferred, sampleDocument, samplePending } from "./conformance";
import { IndexedDbJournal, JournalClosedError, JournalMigrationError, journalMigrations, JournalVersionError, type JournalMigration } from "./indexeddb";
import type { ConflictRecord, DeferredRevision, DocumentState, Journal, PendingOperation } from "./journal";
import { InMemoryJournal } from "./memory";

const name = "journal";

const deferAllMerges: MergeHook = () => Promise.resolve({ status: "deferred" });

/** A schema after the current one, for upgrade tests: an index on `kind`, and every document record rewritten (with a field earlier schemas lack). */
const addKindIndex: JournalMigration = (transaction) => {
  const documents = transaction.objectStore("documents");
  documents.createIndex("kind", "kind");
  const request = documents.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) return;
    cursor.update({ ...(cursor.value as DocumentState), migrated: true });
    cursor.continue();
  };
};

/** The schema before the conflict log (#18): what devices that synced before it have. */
const v1Migrations = journalMigrations.slice(0, 1);

/** Everything a journal holds, in comparable form. `conflicts: false` for a v1 journal, which has no conflict log. */
async function snapshot(journal: Journal, { conflicts = true } = {}) {
  return describeValue({
    cursor: await journal.getCursor(),
    documents: (await journal.listDocuments()).sort((a, b) => a.documentId.localeCompare(b.documentId)),
    pending: await journal.listPending(),
    deferred: (await journal.listDeferred()).sort((a, b) => a.revision.documentId.localeCompare(b.revision.documentId)),
    ...(conflicts ? { conflicts: await journal.listConflicts() } : {}),
  });
}

describe("IndexedDbJournal", () => {
  describe("Journal conformance (fake-indexeddb)", () => {
    for (const testCase of journalConformance) {
      it(testCase.name, async () => {
        const factory = new FakeIDBFactory();
        let current = await IndexedDbJournal.open(factory, name);
        await runJournalConformanceCase(testCase, () => ({
          journal: current,
          // A restart: a new connection to the same database.
          reopen: async () => {
            current.close();
            current = await IndexedDbJournal.open(factory, name);
            return current;
          },
          dispose: () => {
            current.close();
          },
        }));
      });
    }
  });

  describe("given a crash during a journal write", () => {
    type Operation = { describe: string; run: (journal: Journal) => Promise<void> };

    // A seeded PRNG (mulberry32), so a failing seed replays.
    function random(seed: number) {
      let state = seed >>> 0;
      const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return { int: (bound: number) => Math.floor(next() * bound), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T };
    }

    /** Random journal writes over small id and path spaces, so they collide: replacements, duplicates, removals of unknown ids. */
    function operations(seed: number, count: number): Operation[] {
      const rng = random(seed);
      const documentIds = ["d0", "d1", "d2", "d3"];
      const paths = ["a.md", "b.md", "c.md"];
      const result: Operation[] = [];
      for (let index = 0; index < count; index++) {
        const seq = BigInt(rng.int(40));
        switch (rng.int(8)) {
          case 0:
            result.push({ describe: `setCursor(${String(seq)})`, run: (journal) => journal.setCursor(seq) });
            break;
          case 1:
            result.push({ describe: `resetCursor(${String(seq)})`, run: (journal) => journal.resetCursor(seq) });
            break;
          case 2: {
            const state: DocumentState = sampleDocument({
              documentId: rng.pick(documentIds),
              path: rng.pick(paths),
              revisionId: `r${String(index)}`,
              seq,
              deleted: rng.int(3) === 0,
            });
            result.push({ describe: `putDocument(${state.documentId})`, run: (journal) => journal.putDocument(state) });
            break;
          }
          case 3: {
            const operation: PendingOperation = samplePending({ revisionId: `p${String(rng.int(6))}`, documentId: rng.pick(documentIds), path: rng.pick(paths) });
            result.push({ describe: `addPending(${operation.revisionId})`, run: (journal) => journal.addPending(operation) });
            break;
          }
          case 4: {
            const revisionId = `p${String(rng.int(6))}`;
            result.push({ describe: `removePending(${revisionId})`, run: (journal) => journal.removePending(revisionId) });
            break;
          }
          case 5: {
            const deferred: DeferredRevision = sampleDeferred(rng.pick(documentIds), `r${String(index)}`, { reason: rng.pick(["local-changes", "invalid-path", "path-conflict"] as const) });
            if (rng.int(2) === 0) deferred.merging = { path: rng.pick(paths), contentHash: rng.int(3) === 0 ? null : `h${String(index)}` };
            result.push({ describe: `putDeferred(${deferred.revision.documentId})`, run: (journal) => journal.putDeferred(deferred) });
            break;
          }
          case 6: {
            const documentId = rng.pick(documentIds);
            result.push({ describe: `removeDeferred(${documentId})`, run: (journal) => journal.removeDeferred(documentId) });
            break;
          }
          default: {
            const conflict: ConflictRecord = sampleConflict(`c${String(rng.int(4))}`, { documentId: rng.pick(documentIds), copyPath: rng.int(3) === 0 ? null : rng.pick(paths), at: index });
            result.push({ describe: `putConflict(${conflict.id})`, run: (journal) => journal.putConflict(conflict) });
          }
        }
      }
      return result;
    }

    /** "ok", or the kind of error: the journal contract's observable outcome of a call. */
    const outcome = (promise: Promise<void>) =>
      promise.then(
        () => "ok",
        (error: unknown) => (error instanceof RangeError ? "RangeError" : "Error"),
      );

    /** The in-memory model after `operations`. */
    async function model(list: readonly Operation[]): Promise<InMemoryJournal> {
      const journal = new InMemoryJournal();
      for (const operation of list) await outcome(operation.run(journal));
      return journal;
    }

    /** Captures every transaction fake-indexeddb creates while `body` runs. */
    async function capturingTransactions<T>(body: (transactions: IDBTransaction[]) => Promise<T>): Promise<T> {
      const prototype = FakeIDBDatabase.prototype as { transaction: IDBDatabase["transaction"] };
      const original = prototype.transaction;
      const transactions: IDBTransaction[] = [];
      prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
        const transaction = original.apply(this, args);
        transactions.push(transaction);
        return transaction;
      };
      try {
        return await body(transactions);
      } finally {
        prototype.transaction = original;
      }
    }

    /** One turn of the event loop as fake-indexeddb schedules its work (setImmediate), so a crash can land between any two of its steps. */
    const tick = () =>
      new Promise<void>((resolve) => {
        (globalThis as unknown as { setImmediate: (callback: () => void) => void }).setImmediate(resolve);
      });

    const seeds = Array.from({ length: 150 }, (_, index) => index + 1);

    it("recovers to the state before or after the interrupted write, never in between, and keeps every write that resolved", async () => {
      const landed = { before: 0, after: 0 };
      for (const seed of seeds) {
        const list = operations(seed, 24);
        const rng = random(seed * 7919);
        const factory = new FakeIDBFactory();
        let journal = await IndexedDbJournal.open(factory, name);
        /** The writes that took effect, crashed ones included when they did. */
        const applied: Operation[] = [];

        for (const [index, operation] of list.entries()) {
          const context = `seed ${String(seed)}, #${String(index)} ${operation.describe}`;
          if (rng.int(3) !== 0) {
            expect(await outcome(operation.run(journal)), context).toBe(await outcome(operation.run(await model(applied))));
            applied.push(operation);
            continue;
          }

          // A crash: the write's transactions are aborted part-way (or, with
          // enough ticks, after they committed), as when the app is killed,
          // and the app starts again with a new connection.
          const ticks = rng.int(12);
          const result = await capturingTransactions(async (transactions) => {
            const pending = outcome(operation.run(journal));
            for (let turn = 0; turn < ticks; turn++) await tick();
            for (const transaction of transactions) {
              try {
                transaction.abort();
              } catch {
                // Already finished.
              }
            }
            return pending;
          });
          journal.close();
          journal = await IndexedDbJournal.open(factory, name);

          const before = await snapshot(await model(applied));
          const after = await snapshot(await model([...applied, operation]));
          const state = await snapshot(journal);
          const crashContext = `${context}: crash after ${String(ticks)} ticks`;
          if (result === "ok") {
            // Resolved means durable: an acknowledged write is never lost.
            expect(state, `${crashContext}, after the write resolved`).toBe(after);
          } else {
            expect([before, after], crashContext).toContain(state);
          }
          if (before !== after) landed[state === before ? "before" : "after"]++;
          if (state === after) applied.push(operation);
        }
        // The recovered journal kept working: it holds exactly the writes that took effect.
        expect(await snapshot(journal), `seed ${String(seed)}: final state`).toBe(await snapshot(await model(applied)));
        journal.close();
      }
      // Both outcomes of a crash were exercised, many times.
      expect(landed.before).toBeGreaterThan(100);
      expect(landed.after).toBeGreaterThan(100);
    });
  });

  describe("given the engine crashes between any two durable changes", () => {
    /** A journal over a swappable IndexedDB connection whose writes are crash points. */
    class CrashingIndexedDbJournal implements Journal {
      constructor(
        public inner: IndexedDbJournal,
        private readonly points: CrashPoints,
      ) {}
      getCursor = () => this.inner.getCursor();
      getCursorAnchor = () => this.inner.getCursorAnchor();
      setCursor = (seq: bigint, anchor?: Uint8Array) => this.points.durable(() => this.inner.setCursor(seq, anchor));
      resetCursor = (seq: bigint, anchor?: Uint8Array) => this.points.durable(() => this.inner.resetCursor(seq, anchor));
      getDocument = (documentId: string) => this.inner.getDocument(documentId);
      findDocumentByPath = (path: string) => this.inner.findDocumentByPath(path);
      listDocuments = () => this.inner.listDocuments();
      putDocument = (state: DocumentState) => this.points.durable(() => this.inner.putDocument(state));
      addPending = (operation: PendingOperation) => this.points.durable(() => this.inner.addPending(operation));
      listPending = () => this.inner.listPending();
      removePending = (revisionId: string) => this.points.durable(() => this.inner.removePending(revisionId));
      putDeferred = (deferred: DeferredRevision) => this.points.durable(() => this.inner.putDeferred(deferred));
      getDeferred = (documentId: string) => this.inner.getDeferred(documentId);
      listDeferred = () => this.inner.listDeferred();
      removeDeferred = (documentId: string) => this.points.durable(() => this.inner.removeDeferred(documentId));
      putConflict = (conflict: ConflictRecord) => this.points.durable(() => this.inner.putConflict(conflict));
      listConflicts = () => this.inner.listConflicts();
    }

    async function device() {
      const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 });
      const vault = new InMemoryVault();
      const factory = new FakeIDBFactory();
      const points = new CrashPoints();
      const journal = new CrashingIndexedDbJournal(await IndexedDbJournal.open(factory, name), points);
      let ids = 0;
      const create = () =>
        new SyncEngine({
          vaultId: server.vaultId,
          deviceId: "device-1",
          api: createProtocolClient({ transport: server.transport }),
          vault: new CrashingVault(vault, points),
          journal,
          merge: deferAllMerges,
          pageSize: 2,
          pushDebounceMs: null,
          newId: () => `id-${String(++ids)}`,
        });
      const result = {
        server,
        vault,
        journal,
        points,
        engine: create(),
        /** The app dies and starts again: a new engine over a new connection to the same database. */
        restart: async () => {
          await result.engine.settled();
          result.engine.dispose();
          journal.inner.close();
          journal.inner = await IndexedDbJournal.open(factory, name);
          result.engine = create();
        },
      };
      return result;
    }
    type Device = Awaited<ReturnType<typeof device>>;

    const state = async (d: Device) => ({
      server: d.server.liveFiles(),
      revisions: d.server.revisionCount,
      files: await files(d.vault),
      cursor: await d.journal.getCursor(),
      // Not ids: a resumed push draws new ids for the operations it re-creates.
      documents: (await d.journal.listDocuments()).map((document) => [document.path, document.baseHash, document.deleted]).sort(),
      pending: (await d.journal.listPending()).map((operation) => [operation.path, operation.contentHash]),
      deferred: await d.journal.listDeferred(),
    });

    const encoder = new TextEncoder();
    const scenarios: [string, (d: Device) => Promise<void>, (engine: SyncEngine) => Promise<unknown>][] = [
      [
        "a pull",
        (d) => {
          d.server.commit({ documentId: "a", path: "a.md", content: "a1" });
          d.server.commit({ documentId: "b", path: "b.md", content: "b1" });
          d.server.commit({ documentId: "c", path: "notes/c.md", content: "c1" });
          d.server.commit({ documentId: "a", path: "a.md", content: "a2" });
          d.server.commit({ documentId: "b", path: "renamed/b.md" });
          d.server.commit({ documentId: "c", path: "notes/c.md", deleted: true });
          d.server.commit({ documentId: "d", path: "d.md", content: "a long note that spans several download ranges" });
          d.server.commit({ documentId: "x", path: "../x.md", content: "x1" });
          return Promise.resolve();
        },
        (engine) => engine.pull(),
      ],
      [
        "a push",
        async (d) => {
          d.server.commit({ documentId: "a", path: "a.md", content: "a1" });
          d.server.commit({ documentId: "b", path: "b.md", content: "b1" });
          await d.engine.pull();
          await d.vault.write("a.md", encoder.encode("a2"));
          await d.vault.rename("b.md", "b2.md");
          await d.vault.write("c.md", encoder.encode("c1 is longer than one chunk"));
        },
        // The pull afterwards moves the cursor over the device's own revisions,
        // which a resumed push may already have done.
        async (engine) => {
          await engine.push();
          await engine.pull();
        },
      ],
    ];

    it.each(scenarios)("resumes %s from the reopened journal and reaches the same final state", async (_name, setup, run) => {
      const reference = await device();
      await setup(reference);
      await run(reference.engine);
      const expected = await state(reference);

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const d = await device();
        await setup(d);
        d.points.count = 0;
        d.points.crashAfter = crashAfter;
        const finished = await run(d.engine).then(
          () => true,
          (error: unknown) => {
            if (!(error instanceof Crash)) throw error;
            return false;
          },
        );
        if (finished) break;
        crashed++;
        d.points.crashAfter = 0;
        await d.restart();
        await run(d.engine);
        expect(await state(d), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      expect(crashed).toBeGreaterThanOrEqual(6);
    });
  });

  describe("given a schema upgrade", () => {
    /** Fills a journal at the schema of `migrations` (the conflict log only from v2 on), and returns its snapshot. */
    async function populate(factory: IDBFactory, migrations: readonly JournalMigration[] = journalMigrations) {
      const journal = await IndexedDbJournal.open(factory, name, migrations);
      await journal.setCursor(42n);
      await journal.putDocument(sampleDocument({ documentId: "old", path: "a.md", deleted: true }));
      await journal.putDocument(sampleDocument({ documentId: "new", path: "a.md" }));
      await journal.addPending(samplePending({ revisionId: "p2" }));
      await journal.addPending(samplePending({ revisionId: "p1" }));
      await journal.putDeferred(sampleDeferred("doc-1", "r9"));
      const conflicts = migrations.length >= 2;
      if (conflicts) {
        await journal.putConflict(sampleConflict("c2"));
        await journal.putConflict(sampleConflict("c1", { copyPath: null }));
      }
      const before = await snapshot(journal, { conflicts });
      journal.close();
      return before;
    }

    it("reports an upgrade blocked by a connection that does not step aside, and finishes once it closes", async () => {
      const factory = new FakeIDBFactory();
      await populate(factory, v1Migrations);
      // A connection that ignores versionchange, as a stale one from other code would.
      const stale = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(name);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("open failed"));
        };
      });
      let blocked = 0;
      let opened = false;
      const opening = IndexedDbJournal.open(factory, name, journalMigrations, { onBlocked: () => blocked++ }).then((journal) => {
        opened = true;
        return journal;
      });

      await expect.poll(() => blocked).toBe(1);
      expect(opened).toBe(false);
      stale.close();

      const upgraded = await opening;
      expect(await upgraded.getCursor()).toBe(42n);
      expect(blocked).toBe(1);
      upgraded.close();
    });

    it("upgrades a v1 journal to the current schema with the conflict log, keeping its data", async () => {
      const factory = new FakeIDBFactory();
      const before = await populate(factory, v1Migrations);

      const upgraded = await IndexedDbJournal.open(factory, name);
      expect(await snapshot(upgraded, { conflicts: false })).toBe(before);
      expect(await upgraded.getCursor()).toBe(42n);
      expect(await upgraded.listConflicts()).toEqual([]);
      await upgraded.putConflict(sampleConflict("c1"));
      await upgraded.putConflict(sampleConflict("c2"));
      await upgraded.putConflict(sampleConflict("c1", { reason: "binary" }));
      upgraded.close();

      const reopened = await IndexedDbJournal.open(factory, name);
      expect(await reopened.listConflicts()).toEqual([sampleConflict("c1", { reason: "binary" }), sampleConflict("c2")]);
      reopened.close();
    });

    it("migrates existing data, cursor and conflict log included, through a later migration that rewrites records", async () => {
      const factory = new FakeIDBFactory();
      await populate(factory);

      const upgraded = await IndexedDbJournal.open(factory, name, [...journalMigrations, addKindIndex]);
      // Every record survived; the rewritten documents carry the new field.
      expect(await upgraded.getCursor()).toBe(42n);
      expect(await upgraded.listPending()).toEqual([samplePending({ revisionId: "p2" }), samplePending({ revisionId: "p1" })]);
      expect(await upgraded.getDeferred("doc-1")).toEqual(sampleDeferred("doc-1", "r9"));
      expect(await upgraded.findDocumentByPath("a.md")).toEqual({ ...sampleDocument({ documentId: "new", path: "a.md" }), migrated: true });
      expect((await upgraded.listDocuments()).map((state) => state.documentId).sort()).toEqual(["new", "old"]);
      expect(await upgraded.listConflicts()).toEqual([sampleConflict("c2"), sampleConflict("c1", { copyPath: null })]);
      upgraded.close();
    });

    it("resumes sync from the stored cursor of a v1 journal instead of resyncing", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const factory = new FakeIDBFactory();
      const engineOver = (journal: Journal) =>
        new SyncEngine({ vaultId: server.vaultId, deviceId: "device-1", api: createProtocolClient({ transport: server.transport }), vault, journal, merge: deferAllMerges, pushDebounceMs: null });
      server.commit({ documentId: "a", path: "a.md", content: "a1" });
      server.commit({ documentId: "b", path: "b.md", content: "b1" });
      const v1 = await IndexedDbJournal.open(factory, name, v1Migrations);
      const first = engineOver(v1);
      await first.pull();
      first.dispose();
      v1.close();

      server.commit({ documentId: "a", path: "a.md", content: "a2" });
      const since: bigint[] = [];
      server.interceptor = (method, request) => {
        if (method === "ListChanges") since.push((request as { sinceSeq: bigint }).sinceSeq);
      };
      const v2 = await IndexedDbJournal.open(factory, name);
      const second = engineOver(v2);
      const summary = await second.pull();
      second.dispose();

      expect(since[0]).toBe(2n);
      expect(summary).toMatchObject({ applied: 1, resynced: false, deferred: 0 });
      expect(await files(vault)).toEqual(server.liveFiles());
      v2.close();
    });

    it.each<[string, JournalMigration]>([
      [
        "throws",
        () => {
          throw new Error("migration bug");
        },
      ],
      [
        // Two documents share a.md (a tombstone and a live one), so this index cannot be built.
        "fails a request",
        (transaction) => {
          transaction.objectStore("documents").createIndex("uniquePath", "path", { unique: true });
        },
      ],
    ])("leaves the journal at its old version, with its data, when a migration %s", async (_name, broken) => {
      const factory = new FakeIDBFactory();
      const before = await populate(factory);

      await expect(IndexedDbJournal.open(factory, name, [...journalMigrations, broken])).rejects.toThrow(JournalMigrationError);

      const reopened = await IndexedDbJournal.open(factory, name);
      expect(await snapshot(reopened)).toBe(before);
      reopened.close();
    });

    it("refuses a journal written by a newer schema and leaves it untouched", async () => {
      const factory = new FakeIDBFactory();
      const before = await populate(factory, [...journalMigrations, addKindIndex]);

      await expect(IndexedDbJournal.open(factory, name)).rejects.toThrow(JournalVersionError);

      const newer = await IndexedDbJournal.open(factory, name, [...journalMigrations, addKindIndex]);
      expect(await snapshot(newer)).toBe(before);
      newer.close();
    });

    it("lets a newer connection upgrade the schema, and fails the outdated one's later calls", async () => {
      const factory = new FakeIDBFactory();
      const outdated = await IndexedDbJournal.open(factory, name);
      await outdated.setCursor(7n);

      const upgraded = await IndexedDbJournal.open(factory, name, [...journalMigrations, addKindIndex]);

      await expect(outdated.setCursor(8n)).rejects.toThrow(JournalClosedError);
      expect(await upgraded.getCursor()).toBe(7n);
      upgraded.close();
    });
  });

  it("isolates journals in different databases of one IndexedDB origin", async () => {
    const factory = new FakeIDBFactory();
    const first = await IndexedDbJournal.open(factory, "first");
    const second = await IndexedDbJournal.open(factory, "second");
    await first.setCursor(5n);
    await first.putDocument(sampleDocument());
    await first.addPending(samplePending());
    await first.putDeferred(sampleDeferred("doc-1", "r2"));

    expect(await snapshot(second)).toBe(await snapshot(new InMemoryJournal()));
    // The same revision id is independent in each.
    await second.addPending(samplePending());
    expect(await second.listPending()).toEqual([samplePending()]);
    first.close();
    second.close();
  });

  it("rejects calls after it is closed", async () => {
    const journal = await IndexedDbJournal.open(new FakeIDBFactory(), name);
    journal.close();
    await expect(journal.getCursor()).rejects.toThrow(JournalClosedError);
    await expect(journal.putDocument(sampleDocument())).rejects.toThrow(JournalClosedError);
  });
});
