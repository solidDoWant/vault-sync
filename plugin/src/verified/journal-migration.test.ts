import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { sampleConflict, sampleDeferred, sampleDocument, samplePending } from "../core/journal/conformance";
import { IndexedDbJournal } from "../core/journal/indexeddb";
import { InMemoryJournal } from "../core/journal/memory";
import { JournalMigrationRefused, loadOrMigrate, migrateEngineJournal } from "./journal-migration";
import { CoreJournalStore, type CoreJournal, type CoreRevision } from "./journal-store";

const anchor = new Uint8Array(16).fill(7);

/**
 * A journal of the current engine's format (IndexedDbJournal at its current
 * schema) with a row of every shape the engine writes: bound, tombstone,
 * released, edited with a sealed operation, displaced by the engine, a
 * create not acknowledged yet, a local delete, a binary file, and deferrals
 * of every reason, one for a document with no row.
 */
async function writeFixture(factory: IDBFactory): Promise<void> {
  const journal = await IndexedDbJournal.open(factory, "engine");
  await journal.setCursor(42n, anchor);
  const rows = [
    sampleDocument({ documentId: "live", path: "Notes/Ä.md", revisionId: "r-live", seq: 3n, baseHash: "h-live", binding: { spelling: "Notes/Ä.md", fileKey: "notes/ä.md", seen: "h-live-disk" }, absence: null, anchor: new Uint8Array(16).fill(1), prior: ["r-older"] }),
    sampleDocument({ documentId: "tombstone", path: "gone.md", revisionId: "r-gone", seq: 5n, baseHash: "h-gone", deleted: true, binding: null, absence: "never" }),
    sampleDocument({ documentId: "released", path: "con.md", revisionId: "r-con", seq: 6n, baseHash: "h-con", binding: null, absence: "released" }),
    sampleDocument({ documentId: "edited", path: "edited.md", revisionId: "r-edited", seq: 8n, baseHash: "h-e0", binding: { spelling: "edited.md", fileKey: "edited.md", seen: "h-e1" }, absence: null }),
    sampleDocument({ documentId: "displaced", path: "x.md", revisionId: "r-x", seq: 9n, baseHash: "h-x", binding: { spelling: "x (moved).md", fileKey: "x (moved).md", seen: "h-x", displaced: true, userSpelling: "x.md" }, absence: null }),
    sampleDocument({ documentId: "created", path: "new.md", revisionId: "", seq: 0n, baseHash: "", binding: { spelling: "new.md", fileKey: "new.md", seen: "h-new" }, absence: null }),
    sampleDocument({ documentId: "deleted-locally", path: "doomed.md", revisionId: "r-doomed", seq: 10n, baseHash: "h-doomed", binding: null, absence: "user-deleted" }),
    sampleDocument({ documentId: "picture", path: "img.png", revisionId: "r-img", seq: 11n, baseHash: "h-img", kind: "blob", binding: { spelling: "img.png", fileKey: "img.png", seen: "h-img" }, absence: null }),
  ];
  for (const state of rows) await journal.putDocument(state);
  await journal.addPending(samplePending({ revisionId: "p-edit", documentId: "edited", baseRevisionId: "r-edited", path: "edited.md", contentHash: "h-e1", sealed: true }));
  await journal.addPending(samplePending({ revisionId: "p-create", documentId: "created", baseRevisionId: "", path: "new.md", contentHash: "h-new", sealed: false }));
  // An operation written before outbox semantics (no `sealed`): it may have been sent.
  await journal.addPending(samplePending({ revisionId: "p-delete", documentId: "deleted-locally", baseRevisionId: "r-doomed", path: "doomed.md", contentHash: "h-doomed", deleted: true }));
  await journal.putDeferred(sampleDeferred("released", "r-con2", { reason: "unmaterializable", unmaterializable: "reserved-name" }));
  await journal.putDeferred(sampleDeferred("edited", "r-edited2", { reason: "local-changes", descendsFromBase: true }));
  await journal.putDeferred(
    sampleDeferred("picture", "r-img2", {
      reason: "path-conflict",
      postponed: true,
      revision: { revisionId: "r-img2", documentId: "picture", seq: 40n, parentRevisionId: "r-img", kind: "blob", path: "IMG.png", deleted: false, contentHash: "h-img2", size: 9n, deviceId: "phone" },
    }),
  );
  await journal.putDeferred(sampleDeferred("live", "r-live2", { reason: "too-large" }));
  await journal.putDeferred(sampleDeferred("remote-only", "r-remote", { reason: "out-of-scope", revision: { revisionId: "r-remote", documentId: "remote-only", seq: 41n, parentRevisionId: "", kind: "text", path: ".obsidian/app.json", deleted: false, contentHash: "h-app", size: 2n } }));
  await journal.putDeferred(sampleDeferred("tombstone", "r-alias", { reason: "unmaterializable", unmaterializable: "alias" }));
  await journal.putDeferred(sampleDeferred("deleted-locally", "r-bad", { reason: "invalid-path" }));
  await journal.putConflict(sampleConflict("c1", { documentId: "edited", copyPath: "edited (conflict).md", reason: "overlapping-edits" }));
  await journal.putConflict(sampleConflict("c2", { documentId: "picture", copyPath: null, reason: "binary" }));
  await journal.putConflict(sampleConflict("c3", { documentId: "created", copyPath: "new (conflict).md", reason: "path-taken" }));
  journal.close();
}

const remote = (id: string, doc: string): CoreRevision => ({
  id,
  doc,
  position: 7n,
  parent: "rev-1",
  path: "note.md",
  content: "cc",
  kind: "note",
  deleted: false,
  device: "",
});

/** The core's journal the fixture stands for, written out by hand from the fixture above. */
const expected: CoreJournal = {
  cursor: 42n,
  anchor,
  intents: [],
  conflicts: [
    { doc: "edited", copy: "edited (conflict).md", reason: "overlapping-edits" },
    { doc: "created", copy: "new (conflict).md", reason: "path-taken" },
  ],
  documents: {
    live: {
      base: { rev: "r-live", position: 3n, path: "Notes/Ä.md", content: "h-live", kind: "note", deleted: false },
      ahead: { revision: remote("r-live2", "live"), blocker: { kind: "too-large" }, postponed: false },
      binding: { spelling: "Notes/Ä.md", seen: "h-live-disk", displaced: false, userSpelling: null },
      absence: "never",
      outbox: null,
    },
    tombstone: {
      base: { rev: "r-gone", position: 5n, path: "gone.md", content: "h-gone", kind: "note", deleted: true },
      ahead: { revision: remote("r-alias", "tombstone"), blocker: { kind: "unmaterializable", alias: true }, postponed: false },
      binding: null,
      absence: "never",
      outbox: null,
    },
    released: {
      base: { rev: "r-con", position: 6n, path: "con.md", content: "h-con", kind: "note", deleted: false },
      ahead: { revision: remote("r-con2", "released"), blocker: { kind: "unmaterializable", alias: false }, postponed: false },
      binding: null,
      absence: "released",
      outbox: null,
    },
    edited: {
      base: { rev: "r-edited", position: 8n, path: "edited.md", content: "h-e0", kind: "note", deleted: false },
      ahead: { revision: remote("r-edited2", "edited"), blocker: { kind: "local-changes" }, postponed: false },
      binding: { spelling: "edited.md", seen: "h-e1", displaced: false, userSpelling: null },
      absence: "never",
      outbox: { rev: "p-edit", baseRev: "r-edited", path: "edited.md", content: "h-e1", kind: "note", deleted: false, sealed: true, rejected: false },
    },
    displaced: {
      base: { rev: "r-x", position: 9n, path: "x.md", content: "h-x", kind: "note", deleted: false },
      ahead: null,
      binding: { spelling: "x (moved).md", seen: "h-x", displaced: true, userSpelling: "x.md" },
      absence: "never",
      outbox: null,
    },
    created: {
      base: null,
      ahead: null,
      binding: { spelling: "new.md", seen: "h-new", displaced: false, userSpelling: null },
      absence: "never",
      outbox: { rev: "p-create", baseRev: null, path: "new.md", content: "h-new", kind: "note", deleted: false, sealed: false, rejected: false },
    },
    "deleted-locally": {
      base: { rev: "r-doomed", position: 10n, path: "doomed.md", content: "h-doomed", kind: "note", deleted: false },
      ahead: { revision: remote("r-bad", "deleted-locally"), blocker: { kind: "invalid-path" }, postponed: false },
      binding: null,
      absence: "user-deleted",
      outbox: { rev: "p-delete", baseRev: "r-doomed", path: "doomed.md", content: "h-doomed", kind: "note", deleted: true, sealed: true, rejected: false },
    },
    picture: {
      base: { rev: "r-img", position: 11n, path: "img.png", content: "h-img", kind: "binary", deleted: false },
      ahead: {
        revision: { id: "r-img2", doc: "picture", position: 40n, parent: "r-img", path: "IMG.png", content: "h-img2", kind: "binary", deleted: false, device: "phone" },
        blocker: { kind: "path-held" },
        postponed: true,
      },
      binding: { spelling: "img.png", seen: "h-img", displaced: false, userSpelling: null },
      absence: "never",
      outbox: null,
    },
    "remote-only": {
      base: null,
      ahead: {
        revision: { id: "r-remote", doc: "remote-only", position: 41n, parent: null, path: ".obsidian/app.json", content: "h-app", kind: "note", deleted: false, device: "" },
        blocker: { kind: "out-of-scope" },
        postponed: false,
      },
      binding: null,
      absence: "never",
      outbox: null,
    },
  },
};

describe("migrateEngineJournal", () => {
  it("yields the verified core's journal for a journal of the current engine's format, the feed anchor included", async () => {
    const factory = new FakeIDBFactory();
    await writeFixture(factory);
    const engine = await IndexedDbJournal.open(factory, "engine");
    expect(await migrateEngineJournal(engine)).toEqual(expected);
    engine.close();
  });

  it("gives a cursor stored without an anchor no feed anchor", async () => {
    const journal = new InMemoryJournal();
    await journal.setCursor(5n);
    expect(await migrateEngineJournal(journal)).toEqual({ documents: {}, cursor: 5n, anchor: null, intents: [], conflicts: [] });
  });

  it("gives a pending create with no document row a row bound to its file", async () => {
    const journal = new InMemoryJournal();
    await journal.addPending(samplePending({ revisionId: "p", documentId: "n", baseRevisionId: "", path: "n.md", contentHash: "h-n", sealed: false }));
    expect((await migrateEngineJournal(journal)).documents).toEqual({
      n: {
        base: null,
        ahead: null,
        binding: { spelling: "n.md", seen: "h-n", displaced: false, userSpelling: null },
        absence: "never",
        outbox: { rev: "p", baseRev: null, path: "n.md", content: "h-n", kind: "note", deleted: false, sealed: false, rejected: false },
      },
    });
  });

  describe("refuses, migrating nothing and leaving the engine's journal as it was,", () => {
    it("a journal with an open intent", async () => {
      const journal = new InMemoryJournal();
      await journal.putIntent({ kind: "apply", documentId: "a", steps: {} });
      await expect(migrateEngineJournal(journal)).rejects.toBeInstanceOf(JournalMigrationRefused);
      expect(await journal.listIntents()).toHaveLength(1);
    });

    it("a journal with two pending operations for one document", async () => {
      const journal = new InMemoryJournal();
      await journal.putDocument(sampleDocument({ documentId: "a", binding: null, absence: "user-deleted" }));
      await journal.addPending(samplePending({ revisionId: "p1", documentId: "a" }));
      await journal.addPending(samplePending({ revisionId: "p2", documentId: "a", deleted: true }));
      await expect(migrateEngineJournal(journal)).rejects.toBeInstanceOf(JournalMigrationRefused);
      expect(await journal.listPending()).toHaveLength(2);
    });

    it("a yjs document, a kind the core lacks", async () => {
      const journal = new InMemoryJournal();
      await journal.putDocument(sampleDocument({ documentId: "a", kind: "yjs", binding: null, absence: "never" }));
      await expect(migrateEngineJournal(journal)).rejects.toBeInstanceOf(JournalMigrationRefused);
    });

    it("a row with no recorded binding (a journal from before refactor step R4)", async () => {
      const journal = new InMemoryJournal();
      await journal.putDocument(sampleDocument({ documentId: "a" }));
      await expect(migrateEngineJournal(journal)).rejects.toBeInstanceOf(JournalMigrationRefused);
    });
  });
});

describe("loadOrMigrate", () => {
  it("migrates the engine's journal once, and then reads the core's journal it persisted", async () => {
    const factory = new FakeIDBFactory();
    await writeFixture(factory);
    const engine = await IndexedDbJournal.open(factory, "engine");
    const store = await CoreJournalStore.open(factory, "core");
    expect(await loadOrMigrate(store, engine)).toEqual(expected);
    store.close();

    // A later change of the engine's journal is not migrated again.
    await engine.setCursor(50n);
    const reopened = await CoreJournalStore.open(factory, "core");
    expect(await loadOrMigrate(reopened, engine)).toEqual(expected);
    reopened.close();
    engine.close();
  });

  it("persists nothing when the migration is refused", async () => {
    const factory = new FakeIDBFactory();
    const journal = new InMemoryJournal();
    await journal.putIntent({ kind: "resync", documentId: "", steps: {} });
    const store = await CoreJournalStore.open(factory, "core");
    await expect(loadOrMigrate(store, journal)).rejects.toBeInstanceOf(JournalMigrationRefused);
    expect(await store.load()).toBeUndefined();
    store.close();
  });
});
