import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { files, harness, type Harness } from "./testing";

// Backslash paths (SPEC.md §6.2, decision #191): "\" is a separator on
// Windows only, so no document may be created, moved or brought back at a
// path containing one. The engine refuses such a commit itself, sending
// nothing, and the server refuses it too. A local file at such a path stays
// on disk, unsynced and reported as rejected; a document the server already
// holds at one stays editable and deletable (SPEC.md §2, principle 1).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** Records the method of every call the engine makes to the server. */
function recordCalls(h: Harness): string[] {
  const calls: string[] = [];
  h.server.interceptor = (method) => {
    calls.push(method);
  };
  return calls;
}

const uploadsOrCommits = (calls: string[]) => calls.filter((method) => method !== "ListChanges" && method !== "GetRevision" && method !== "DownloadBlob");

describe("SyncEngine with backslash paths (#191)", () => {
  it("never commits a local file at a/b's backslash twin, and never deletes or moves it", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "twin", path: "a/b", content: "slash\n" });
    await h.engine.pull();
    await h.vault.write("a\\b", bytes("backslash\n"));
    const calls = recordCalls(h);

    const first = await h.engine.push();
    h.restart();
    const second = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map([["a/b", "slash\n"]]));
    for (const summary of [first, second]) {
      expect(summary.committed).toBe(0);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["a\\b"]);
      expect(summary.rejected.map(({ error }) => error.code)).toEqual([Code.InvalidArgument]);
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
    const calls = recordCalls(h);

    const summary = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map([["notes", "a file\n"]]));
    expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["notes\\c.md"]);
    expect(await files(h.vault)).toEqual(
      new Map([
        ["notes", "a file\n"],
        ["notes\\c.md", "under the file\n"],
      ]),
    );
  });

  it("syncs a rejected backslash file once the user renames it to a valid path", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("a\\b.md", bytes("mine\n"));
    expect((await h.engine.push()).rejected).toHaveLength(1);

    await h.vault.rename("a\\b.md", "a/b.md");
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 1, rejected: [], pending: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["a/b.md", "mine\n"]]));
  });

  it("never moves a synced document to a backslash path, and never deletes it for having moved", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "doc", path: "a.md", content: "kept\n" });
    await h.engine.pull();
    await h.vault.rename("a.md", "x\\a.md");
    const calls = recordCalls(h);

    const first = await h.engine.push();
    h.restart();
    const second = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    for (const summary of [first, second]) {
      expect(summary.committed).toBe(0);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["x\\a.md"]);
    }
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "kept\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["x\\a.md", "kept\n"]]));
  });

  it("commits the delete of a synced document whose refused move to a backslash path the user then deleted", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "doc", path: "a.md", content: "kept\n" });
    await h.engine.pull();
    await h.vault.rename("a.md", "x\\a.md");
    expect((await h.engine.push()).rejected.map(({ operation }) => operation.path)).toEqual(["x\\a.md"]);

    await h.vault.delete("x\\a.md");
    await h.engine.push();

    expect(h.server.head("doc")?.deleted).toBe(true);
    expect(h.server.liveFiles()).toEqual(new Map());
    expect(await files(h.vault)).toEqual(new Map());
    expect(await h.engine.push()).toMatchObject({ committed: 0, rejected: [], pending: 0 });
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

    it("never brings it back at its backslash path once deleted, and keeps the local file", async () => {
      const h = await synced();
      await h.vault.delete("old\\note.md");
      await h.engine.push();
      await h.vault.write("old\\note.md", bytes("again\n"));
      const calls = recordCalls(h);

      const summary = await h.engine.push();

      expect(uploadsOrCommits(calls)).toEqual([]);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["old\\note.md"]);
      expect(h.server.head("legacy")?.deleted).toBe(true);
      expect(await files(h.vault)).toEqual(new Map([["old\\note.md", "again\n"]]));
    });
  });
});
