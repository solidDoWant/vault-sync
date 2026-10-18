import { describe, expect, it } from "vitest";

import type { DocumentState, PendingOperation } from "./journal";
import { InMemoryJournal } from "./memory";

const doc = (overrides: Partial<DocumentState> = {}): DocumentState => ({
  documentId: "doc-1",
  path: "note.md",
  revisionId: "rev-1",
  baseHash: "aa",
  deleted: false,
  ...overrides,
});

const op = (overrides: Partial<PendingOperation> = {}): PendingOperation => ({
  revisionId: "rev-2",
  documentId: "doc-1",
  baseRevisionId: "rev-1",
  path: "note.md",
  contentHash: "bb",
  deleted: false,
  ...overrides,
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
});
