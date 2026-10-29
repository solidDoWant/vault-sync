import { describe, expect, it } from "vitest";

import type { ConflictRecord } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import { openConflicts } from "./conflicts";
import { copyOf, harness, moveHeadBeforeCommit, type Harness } from "./testing";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/** A synced note `path` (document `id`) edited on both sides on the same line: the merge keeps the local version as a conflict copy. */
async function overlappingEdits(h: Harness, id: string, path: string): Promise<void> {
  h.server.commit({ documentId: id, path, content: lines("x") });
  await h.engine.pull();
  await h.vault.write(path, bytes(lines("local")));
  h.server.commit({ documentId: id, path, content: lines("remote") });
  await h.engine.push();
}

/** A path so deep that no conflict-copy name for a file in it fits the path limits (SPEC.md §7). */
const deepFolder = Array.from({ length: 4 }, () => "f".repeat(250)).join("/");

describe("openConflicts (the conflict view, SPEC.md §7)", () => {
  describe("given a conflict copy the engine kept", () => {
    it("lists the conflict with the version that stayed in place and the copy", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");

      const open = await openConflicts(h.journal, h.vault);

      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ record: { documentId: "a", reason: "overlapping-edits", path: "a.md" }, original: "a.md", copy: copyOf("a", ".md") });
      expect(await h.vault.read("a.md")).toEqual(bytes(lines("remote")));
      expect(await h.vault.read(copyOf("a", ".md"))).toEqual(bytes(lines("local")));
    });

    it("clears the entry once the user deletes the copy, and keeps the log", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");

      await h.vault.delete(copyOf("a", ".md"));

      expect(await openConflicts(h.journal, h.vault)).toEqual([]);
      expect(await h.journal.listConflicts()).toHaveLength(1);
    });

    it("clears the entry once the deleted copy is synced away", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");
      await h.engine.push();
      expect(h.server.liveFiles().has(copyOf("a", ".md"))).toBe(true);

      await h.vault.delete(copyOf("a", ".md"));
      await h.engine.push();

      expect(h.server.liveFiles().has(copyOf("a", ".md"))).toBe(false);
      expect(await openConflicts(h.journal, h.vault)).toEqual([]);
    });

    it("clears the entry once the user renames the copy", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");

      await h.vault.rename(copyOf("a", ".md"), "kept.md");

      expect(await openConflicts(h.journal, h.vault)).toEqual([]);
    });

    it("follows the original document to where a later rename moved it", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");
      h.server.commit({ documentId: "a", path: "renamed.md" });
      await h.engine.pull();

      const [entry] = await openConflicts(h.journal, h.vault);

      expect(entry).toMatchObject({ original: "renamed.md", copy: copyOf("a", ".md") });
    });

    it("has no original once its file is gone, and still lists the copy", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");

      await h.vault.delete("a.md");

      const [entry] = await openConflicts(h.journal, h.vault);
      expect(entry).toMatchObject({ original: null, copy: copyOf("a", ".md") });
    });

    it("lists the newest conflict first", async () => {
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", "a.md");
      await overlappingEdits(h, "b", "b.md");

      const open = await openConflicts(h.journal, h.vault);

      expect(open.map((entry) => entry.record.documentId)).toEqual(["b", "a"]);
    });
  });

  describe("given a local document moved because another one took its path", () => {
    it("lists the other document's file as the original and the moved document as the copy", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("new.md", bytes("mine"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "NEW.md", content: "theirs" }));
      await h.engine.push();

      const open = await openConflicts(h.journal, h.vault);

      expect(open).toHaveLength(1);
      // The other document holds the path in another case: its file is the original.
      expect(open[0]).toMatchObject({ record: { reason: "path-taken", path: "new.md" }, original: "NEW.md", copy: copyOf("new", ".md") });
    });
  });

  describe("given a conflict logged without a copy", () => {
    it("lists it with the local version in place while the remote revision waits", async () => {
      const path = `${deepFolder}/a.md`;
      const h = harness({ merge: "default" });
      await overlappingEdits(h, "a", path);

      const open = await openConflicts(h.journal, h.vault);

      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ record: { reason: "overlapping-edits", copyPath: null }, original: path, copy: null });
    });

    it("lists a refused create that stays pending", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write(`${deepFolder}/new.md`, bytes("mine"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: `${deepFolder}/NEW.md`, content: "theirs" }));
      await h.engine.push();

      const open = await openConflicts(h.journal, h.vault);

      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ record: { reason: "path-taken", copyPath: null }, original: `${deepFolder}/new.md`, copy: null });
    });

    it("drops it once nothing of the document waits any more", async () => {
      const journal = new InMemoryJournal();
      const vault = new InMemoryVault();
      await vault.write("a.md", bytes("local"));
      const record: ConflictRecord = { id: "c1", documentId: "a", path: "a.md", reason: "overlapping-edits", copyPath: null, copyHash: "00", remoteRevisionId: "r1", at: 0 };
      await journal.putConflict(record);

      expect(await openConflicts(journal, vault)).toEqual([]);
    });
  });
});
