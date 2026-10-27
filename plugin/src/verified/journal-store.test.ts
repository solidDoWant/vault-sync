import { IDBDatabase as FakeIDBDatabase, IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { CoreJournalClosedError, CoreJournalStore, emptyJournal, type CoreDocument, type CoreJournal } from "./journal-store";

const name = "core-journal";

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

function row(index: number, rng: ReturnType<typeof random>): CoreDocument {
  const path = rng.pick(["a.md", "b.md", "Folder/c.md", "d.png"]);
  return {
    base: rng.int(4) === 0 ? null : { rev: `r${String(index)}`, position: BigInt(index), path, content: `h${String(rng.int(5))}`, kind: path.endsWith(".png") ? "binary" : "note", deleted: rng.int(5) === 0 },
    ahead:
      rng.int(3) === 0
        ? {
            revision: { id: `a${String(index)}`, doc: "d", position: BigInt(index + 1), parent: null, path, content: "x", kind: "note", deleted: false, device: "other" },
            blocker: rng.pick([{ kind: "local-changes" }, { kind: "path-held" }, { kind: "unmaterializable", alias: true }] as const),
            postponed: rng.int(2) === 0,
          }
        : null,
    binding: rng.int(3) === 0 ? null : { spelling: path, seen: `h${String(rng.int(5))}`, displaced: rng.int(2) === 0, userSpelling: rng.int(4) === 0 ? "moved.md" : null },
    absence: rng.pick(["never", "user-deleted", "released"] as const),
    outbox: rng.int(2) === 0 ? null : { rev: `o${String(index)}`, baseRev: null, path, content: "y", kind: "note", deleted: false, sealed: rng.int(2) === 0, rejected: false },
  };
}

/** A random successor of `journal`: rows added, replaced, removed and kept; the cursor, anchor, intents and conflicts changed. */
function nextJournal(journal: CoreJournal, index: number, rng: ReturnType<typeof random>): CoreJournal {
  const removed = new Set<string>();
  const added: Record<string, CoreDocument> = {};
  for (const id of ["d0", "d1", "d2", "d3", "d4", "d5"]) {
    const choice = rng.int(4);
    if (choice === 0) added[id] = row(index, rng);
    else if (choice === 1) removed.add(id);
  }
  const documents = { ...Object.fromEntries(Object.entries(journal.documents).filter(([id]) => !removed.has(id))), ...added };
  return {
    documents,
    cursor: journal.cursor + BigInt(rng.int(3)),
    anchor: rng.int(4) === 0 ? null : new Uint8Array(16).fill(index % 256),
    intents: rng.int(2) === 0 ? [] : [{ id: `i${String(index)}`, intent: { kind: "detach", doc: "d0", from: "a.md", to: "b.md" } }],
    conflicts: [...journal.conflicts, ...(rng.int(3) === 0 ? [{ doc: rng.int(2) === 0 ? null : "d1", copy: `copy ${String(index)}.md`, reason: "binary" }] : [])],
  };
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

describe("CoreJournalStore", () => {
  it("reads back no journal before the first persist", async () => {
    const store = await CoreJournalStore.open(new FakeIDBFactory(), name);
    expect(await store.load()).toBeUndefined();
    store.close();
  });

  it("reads back the persisted journal after a restart, every field included", async () => {
    const factory = new FakeIDBFactory();
    const rng = random(1);
    const journal = nextJournal(nextJournal(emptyJournal(), 1, rng), 2, rng);
    journal.anchor = new Uint8Array(16).fill(9);
    journal.intents = [
      { id: "i1", intent: { kind: "merge", doc: "d1", revision: { id: "r", doc: "d1", position: 5n, parent: "p", path: "a.md", content: "c", kind: "note", deleted: false, device: "dev" }, result: "a.md", resultContent: "m", copy: { path: "a (copy).md", content: "l" } } },
      { id: "i2", intent: { kind: "resync" } },
    ];
    const store = await CoreJournalStore.open(factory, name);
    await store.persist(journal);
    store.close();

    const reopened = await CoreJournalStore.open(factory, name);
    expect(await reopened.load()).toEqual(journal);
    reopened.close();
  });

  it("persists an empty journal as a journal, distinct from none", async () => {
    const factory = new FakeIDBFactory();
    const store = await CoreJournalStore.open(factory, name);
    await store.persist(emptyJournal());
    store.close();
    const reopened = await CoreJournalStore.open(factory, name);
    expect(await reopened.load()).toEqual(emptyJournal());
    reopened.close();
  });

  it("is not changed by later edits of a journal it was given or returned", async () => {
    const store = await CoreJournalStore.open(new FakeIDBFactory(), name);
    const journal = nextJournal(emptyJournal(), 1, random(3));
    journal.documents.mine = row(1, random(4));
    await store.persist(journal);
    const expected = structuredClone(journal);
    journal.cursor = 99n;
    delete journal.documents.mine;
    const loaded = await store.load();
    expect(loaded).toEqual(expected);
    if (loaded !== undefined) loaded.cursor = 100n;
    expect(await store.load()).toEqual(expected);
    store.close();
  });

  it("rejects calls after it is closed", async () => {
    const store = await CoreJournalStore.open(new FakeIDBFactory(), name);
    store.close();
    await expect(store.load()).rejects.toBeInstanceOf(CoreJournalClosedError);
    await expect(store.persist(emptyJournal())).rejects.toBeInstanceOf(CoreJournalClosedError);
  });

  describe("given a crash at any point of a journal write", () => {
    const seeds = Array.from({ length: 60 }, (_, index) => index + 1);

    it("reads back either the old or the new journal, and the new one once the write resolved", async () => {
      const landed = { old: 0, new: 0 };
      for (const seed of seeds) {
        const rng = random(seed);
        const factory = new FakeIDBFactory();
        let store = await CoreJournalStore.open(factory, name);
        let durable: CoreJournal | undefined = undefined;
        let journal = emptyJournal();

        for (let index = 1; index <= 16; index++) {
          const next = nextJournal(journal, index, rng);
          const context = `seed ${String(seed)}, write ${String(index)}`;
          if (rng.int(3) !== 0) {
            await store.persist(next);
            durable = next;
            journal = next;
            continue;
          }

          // A crash: the write's transaction is aborted after some turns of
          // the event loop (part-way, or after it committed), as when the app
          // is killed, and the app starts again with a new connection, or
          // (when the app survives a failed write) keeps the same one.
          const ticks = rng.int(10);
          const resolved = await capturingTransactions(async (transactions) => {
            const pending = store.persist(next).then(
              () => true,
              () => false,
            );
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
          if (rng.int(4) !== 0) {
            store.close();
            store = await CoreJournalStore.open(factory, name);
          }

          // Read through a connection of its own, so a surviving store keeps
          // what it believes is durable for its next write.
          const inspector = await CoreJournalStore.open(factory, name);
          const state = await inspector.load();
          inspector.close();
          const crashContext = `${context}: crash after ${String(ticks)} ticks`;
          if (resolved) expect(state, `${crashContext}, after the write resolved`).toEqual(next);
          else expect([durable, next], crashContext).toContainEqual(state);
          if (state !== undefined && deepEqualJournal(state, next)) {
            landed.new++;
            durable = next;
            journal = next;
          } else {
            landed.old++;
            journal = durable ?? emptyJournal();
          }
        }
        // The store kept working: one more write lands whole.
        const last = nextJournal(journal, 99, rng);
        await store.persist(last);
        const inspector = await CoreJournalStore.open(factory, name);
        expect(await inspector.load(), `seed ${String(seed)}: final write`).toEqual(last);
        inspector.close();
        store.close();
      }
      // Both outcomes of a crash were exercised, many times.
      expect(landed.old).toBeGreaterThan(30);
      expect(landed.new).toBeGreaterThan(30);
    });
  });
});

function deepEqualJournal(a: CoreJournal, b: CoreJournal): boolean {
  try {
    expect(a).toEqual(b);
    return true;
  } catch {
    return false;
  }
}
