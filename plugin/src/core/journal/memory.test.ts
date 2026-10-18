import { describe, expect, it } from "vitest";

import type { ConflictRecord, DeferredRevision, DocumentState, PendingOperation } from "./journal";
import { InMemoryJournal } from "./memory";

const doc = (overrides: Partial<DocumentState> = {}): DocumentState => ({
  documentId: "doc-1",
  path: "note.md",
  revisionId: "rev-1",
  seq: 1n,
  baseHash: "aa",
  size: 2n,
  kind: "text",
  deleted: false,
  ...overrides,
});

const op = (overrides: Partial<PendingOperation> = {}): PendingOperation => ({
  revisionId: "rev-2",
  documentId: "doc-1",
  baseRevisionId: "rev-1",
  path: "note.md",
  contentHash: "bb",
  size: 2n,
  kind: "text",
  deleted: false,
  ...overrides,
});

const deferred = (documentId: string, revisionId: string): DeferredRevision => ({
  reason: "local-changes",
  revision: {
    revisionId,
    documentId,
    seq: 7n,
    parentRevisionId: "rev-1",
    kind: "text",
    path: "note.md",
    deleted: false,
    contentHash: "cc",
    size: 3n,
  },
});

describe("InMemoryJournal", () => {
  describe("cursor", () => {
    it("starts at zero", async () => {
      expect(await new InMemoryJournal().getCursor()).toBe(0n);
    });

    it("advances and never moves backwards", async () => {
      const journal = new InMemoryJournal();
      await journal.setCursor(5n);
      await journal.setCursor(5n);
      await expect(journal.setCursor(4n)).rejects.toThrow(RangeError);
      expect(await journal.getCursor()).toBe(5n);
    });

    it("moves backwards only through an explicit reset", async () => {
      const journal = new InMemoryJournal();
      await journal.setCursor(9n);
      await journal.resetCursor(3n);
      expect(await journal.getCursor()).toBe(3n);
    });
  });

  describe("documents", () => {
    it("stores, replaces and finds document state by id and path", async () => {
      const journal = new InMemoryJournal();
      await journal.putDocument(doc());
      await journal.putDocument(doc({ documentId: "doc-2", path: "other.md" }));
      await journal.putDocument(doc({ path: "renamed.md", revisionId: "rev-3" }));

      expect(await journal.getDocument("doc-1")).toEqual(doc({ path: "renamed.md", revisionId: "rev-3" }));
      expect(await journal.findDocumentByPath("renamed.md")).toEqual(doc({ path: "renamed.md", revisionId: "rev-3" }));
      expect(await journal.findDocumentByPath("note.md")).toBeUndefined();
      expect(await journal.getDocument("missing")).toBeUndefined();
      expect((await journal.listDocuments()).map((state) => state.documentId).sort()).toEqual(["doc-1", "doc-2"]);
    });

    it("does not let callers mutate stored state", async () => {
      const journal = new InMemoryJournal();
      const state = doc();
      await journal.putDocument(state);
      state.path = "mutated.md";
      const read = await journal.getDocument("doc-1");
      if (read !== undefined) read.revisionId = "mutated";
      expect(await journal.getDocument("doc-1")).toEqual(doc());
    });

    // Regression for #129: the lookup returned whichever document was stored first, tombstones included.
    it.each([
      ["tombstone first", ["old", "new"]],
      ["live document first", ["new", "old"]],
    ])("finds the live document when a tombstone shares its path (%s)", async (_order, ids) => {
      const journal = new InMemoryJournal();
      for (const id of ids) {
        await journal.putDocument(doc({ documentId: id, path: "a.md", revisionId: `r-${id}`, deleted: id === "old" }));
      }
      expect((await journal.findDocumentByPath("a.md"))?.documentId).toBe("new");
    });

    it("never returns a tombstone, even when it is the only document at the path", async () => {
      const journal = new InMemoryJournal();
      await journal.putDocument(doc({ path: "a.md", deleted: true }));
      expect(await journal.findDocumentByPath("a.md")).toBeUndefined();
    });
  });

  describe("pending operations", () => {
    it("keeps operations in insertion order until removed", async () => {
      const journal = new InMemoryJournal();
      await journal.addPending(op({ revisionId: "b" }));
      await journal.addPending(op({ revisionId: "a" }));
      await journal.addPending(op({ revisionId: "c" }));
      await journal.removePending("a");
      await journal.removePending("a");

      expect((await journal.listPending()).map((pending) => pending.revisionId)).toEqual(["b", "c"]);
    });

    it("rejects a duplicate revision id instead of silently replacing it", async () => {
      const journal = new InMemoryJournal();
      await journal.addPending(op());
      await expect(journal.addPending(op({ path: "other.md" }))).rejects.toThrow();
      expect(await journal.listPending()).toEqual([op()]);
    });
  });

  describe("deferred remote revisions", () => {
    it("keeps the newest deferred revision per document until it is removed", async () => {
      const journal = new InMemoryJournal();
      await journal.putDeferred(deferred("doc-1", "r2"));
      await journal.putDeferred(deferred("doc-2", "r3"));
      await journal.putDeferred(deferred("doc-1", "r4"));

      expect(await journal.getDeferred("doc-1")).toEqual(deferred("doc-1", "r4"));
      expect((await journal.listDeferred()).map((entry) => entry.revision.revisionId).sort()).toEqual(["r3", "r4"]);

      await journal.removeDeferred("doc-1");
      await journal.removeDeferred("doc-1");
      expect(await journal.getDeferred("doc-1")).toBeUndefined();
      expect(await journal.listDeferred()).toEqual([deferred("doc-2", "r3")]);
    });

    it("does not let callers mutate stored deferred revisions", async () => {
      const journal = new InMemoryJournal();
      const entry = deferred("doc-1", "r2");
      await journal.putDeferred(entry);
      entry.revision.path = "mutated.md";
      const read = await journal.getDeferred("doc-1");
      if (read !== undefined) read.revision.revisionId = "mutated";
      expect(await journal.getDeferred("doc-1")).toEqual(deferred("doc-1", "r2"));
    });

    it("keeps the merge-in-progress marker with the deferred revision, copied", async () => {
      const journal = new InMemoryJournal();
      const entry: DeferredRevision = { ...deferred("doc-1", "r2"), merging: { path: "note.md", contentHash: "dd" } };
      await journal.putDeferred(entry);
      if (entry.merging !== undefined) entry.merging.path = "mutated.md";
      expect((await journal.getDeferred("doc-1"))?.merging).toEqual({ path: "note.md", contentHash: "dd" });
      expect((await journal.listDeferred())[0]?.merging).toEqual({ path: "note.md", contentHash: "dd" });
    });
  });

  describe("conflict log", () => {
    const conflict = (id: string, overrides: Partial<ConflictRecord> = {}): ConflictRecord => ({
      id,
      documentId: "doc-1",
      path: "note.md",
      reason: "overlapping-edits",
      copyPath: "note (conflict laptop 2026-10-18 040506).md",
      copyHash: "ee",
      remoteRevisionId: "rev-3",
      at: 1,
      ...overrides,
    });

    it("lists conflicts oldest first and replaces a record with the same id in place", async () => {
      const journal = new InMemoryJournal();
      await journal.putConflict(conflict("c1"));
      await journal.putConflict(conflict("c2", { reason: "binary" }));
      await journal.putConflict(conflict("c1", { copyPath: null }));

      expect(await journal.listConflicts()).toEqual([conflict("c1", { copyPath: null }), conflict("c2", { reason: "binary" })]);
    });

    it("does not let callers mutate stored conflicts", async () => {
      const journal = new InMemoryJournal();
      const entry = conflict("c1");
      await journal.putConflict(entry);
      entry.path = "mutated.md";
      const [read] = await journal.listConflicts();
      if (read !== undefined) read.copyHash = "mutated";
      expect(await journal.listConflicts()).toEqual([conflict("c1")]);
    });
  });
});
