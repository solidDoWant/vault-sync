import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { files, harness, type Harness } from "./testing";

// Drive-like paths (SPEC.md §6.2, decision #148): Win32 reads any single
// character followed by ":" at the start of a path as a drive ("1:x.md",
// "é:x.md"), so no document may be created, moved or brought back at such a
// path. The engine refuses the commit itself, sending nothing, through the
// same rule as backslash paths (#191). A local file there stays on disk,
// unsynced and reported as rejected; a document the server already holds at
// one stays editable and deletable (SPEC.md §2, principle 1).

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

describe("SyncEngine with drive-like paths (#148)", () => {
  it.each(["1:x.md", "é:x.md", "😀:x.md"])("never commits a local file at %s, and keeps it on disk across a restart", async (path) => {
    const h = harness({ merge: "default" });
    await h.vault.write(path, bytes("mine\n"));
    const calls = recordCalls(h);

    const first = await h.engine.push();
    h.restart();
    const second = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map());
    for (const summary of [first, second]) {
      expect(summary.committed).toBe(0);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual([path]);
      expect(summary.rejected.map(({ error }) => error.code)).toEqual([Code.InvalidArgument]);
    }
    expect(await files(h.vault)).toEqual(new Map([[path, "mine\n"]]));
  });

  it("commits a file with two characters before the colon, or a drive-like name in a later segment", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("12:x.md", bytes("two\n"));
    await h.vault.write("notes/1:x.md", bytes("nested\n"));

    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 2, rejected: [] });
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["12:x.md", "two\n"],
        ["notes/1:x.md", "nested\n"],
      ]),
    );
  });

  it("never moves a synced document to a drive-like path, and syncs it once renamed to a valid one", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "doc", path: "a.md", content: "kept\n" });
    await h.engine.pull();
    await h.vault.rename("a.md", "1:a.md");
    const calls = recordCalls(h);

    const refused = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(refused.rejected.map(({ operation }) => operation.path)).toEqual(["1:a.md"]);
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "kept\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["1:a.md", "kept\n"]]));

    await h.vault.rename("1:a.md", "1-a.md");
    const renamed = await h.engine.push();

    expect(renamed).toMatchObject({ rejected: [], pending: 0 });
    // The content syncs. (Today it syncs as a delete of a.md and a new
    // document, as it does after a refused move to a backslash path.)
    expect(h.server.liveFiles()).toEqual(new Map([["1-a.md", "kept\n"]]));
  });

  describe("given a document the server already holds at a drive-like path", () => {
    async function synced() {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "legacy", path: "1:note.md", content: "legacy\n" });
      await h.engine.pull();
      expect(await files(h.vault)).toEqual(new Map([["1:note.md", "legacy\n"]]));
      return h;
    }

    it("commits a local edit of it in place", async () => {
      const h = await synced();
      await h.vault.write("1:note.md", bytes("edited\n"));

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.liveFiles()).toEqual(new Map([["1:note.md", "edited\n"]]));
    });

    it("commits a local delete of it as a tombstone", async () => {
      const h = await synced();
      await h.vault.delete("1:note.md");

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.head("legacy")?.deleted).toBe(true);
    });

    it("commits a local rename of it to a valid path", async () => {
      const h = await synced();
      await h.vault.rename("1:note.md", "1-note.md");

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ committed: 1, rejected: [] });
      expect(h.server.liveFiles()).toEqual(new Map([["1-note.md", "legacy\n"]]));
    });

    it("never brings it back at its drive-like path once deleted, and keeps the local file", async () => {
      const h = await synced();
      await h.vault.delete("1:note.md");
      await h.engine.push();
      await h.vault.write("1:note.md", bytes("again\n"));
      const calls = recordCalls(h);

      const summary = await h.engine.push();

      expect(uploadsOrCommits(calls)).toEqual([]);
      expect(summary.rejected.map(({ operation }) => operation.path)).toEqual(["1:note.md"]);
      expect(h.server.head("legacy")?.deleted).toBe(true);
      expect(await files(h.vault)).toEqual(new Map([["1:note.md", "again\n"]]));
    });
  });
});
