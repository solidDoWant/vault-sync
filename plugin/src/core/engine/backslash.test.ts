import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// Backslash paths (SPEC.md §6.2, decision #191): "\" is a separator on
// Windows only, so the server refuses a commit that creates or moves a
// document into a path containing one. A local file at such a path stays
// on disk, unsynced and reported as rejected; a document the server already
// holds at one stays editable and deletable (SPEC.md §2, principle 1).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

describe("SyncEngine with backslash paths (#191)", () => {
  it("never commits a local file at a/b's backslash twin, and never deletes or moves it", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "twin", path: "a/b", content: "slash\n" });
    await h.engine.pull();
    await h.vault.write("a\\b", bytes("backslash\n"));

    const first = await h.engine.push();
    h.restart();
    const second = await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["a/b", "slash\n"]]));
    for (const summary of [first, second]) {
      expect(summary.committed).toBe(0);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["a\\b"]);
    }
    expect(await files(h.vault)).toEqual(
      new Map([
        ["a/b", "slash\n"],
        ["a\\b", "backslash\n"],
      ]),
    );
  });

  it("never commits a local file at a backslash path under a live file's name", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "file", path: "notes", content: "a file\n" });
    await h.engine.pull();
    await h.vault.write("notes\\c.md", bytes("under the file\n"));

    const summary = await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["notes", "a file\n"]]));
    expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["notes\\c.md"]);
    expect(await files(h.vault)).toEqual(
      new Map([
        ["notes", "a file\n"],
        ["notes\\c.md", "under the file\n"],
      ]),
    );
  });

  describe("given a document the server already holds at a backslash path", () => {
    async function synced() {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "legacy", path: "old\\note.md", content: "legacy\n" });
      await h.engine.pull();
      expect(await files(h.vault)).toEqual(new Map([["old\\note.md", "legacy\n"]]));
      return h;
    }

    it("commits a local edit of it in place", async () => {
      const h = await synced();
      await h.vault.write("old\\note.md", bytes("edited\n"));

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.liveFiles()).toEqual(new Map([["old\\note.md", "edited\n"]]));
    });

    it("commits a local delete of it as a tombstone", async () => {
      const h = await synced();
      await h.vault.delete("old\\note.md");

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.head("legacy")?.deleted).toBe(true);
      expect(h.server.liveFiles()).toEqual(new Map());
    });

    it("commits a local rename of it to a valid path", async () => {
      const h = await synced();
      await h.vault.rename("old\\note.md", "old/note.md");

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.liveFiles()).toEqual(new Map([["old/note.md", "legacy\n"]]));
      expect(h.server.head("legacy")?.deleted).toBe(false);
    });
  });
});
