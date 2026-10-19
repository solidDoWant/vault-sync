import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// A case-only rename on a case-insensitive platform (#304): the user's rename
// is a local change like any other, so a pull never undoes it (SPEC.md §2,
// principle 1), and the push commits the document under the user's spelling.

describe.each(["windows", "macos"] as const)("a case-only rename on %s (#304)", (platform) => {
  it("keeps the user's spelling when a remote edit of the note arrives before the rename is pushed", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "a.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.rename("a.md", "A.md");
    h.server.commit({ documentId: "note", path: "a.md", content: "a\nremote edit\n" });
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["A.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["A.md", "a\nremote edit\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["A.md", "a\nremote edit\n"]]));
    expect(h.localChanges.filter((event) => event.type === "rename" && event.path === "a.md")).toEqual([]);

    // Quiet: nothing more to push, and the vault still matches the server.
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("keeps the user's spelling when a remote edit arrives after a restart while the rename's commit is still pending", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "a.md", content: "a\n" });
    await h.engine.pull();

    await h.vault.rename("a.md", "A.md");
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new Error("connection lost");
    };
    await expect(h.engine.push()).rejects.toThrow();
    expect(await h.journal.listPending()).toHaveLength(1);
    h.server.interceptor = undefined;
    h.restart();
    h.server.commit({ documentId: "note", path: "a.md", content: "a\nremote edit\n" });
    await h.engine.pull();

    expect(await files(h.vault)).toEqual(new Map([["A.md", "a\nremote edit\n"]]));
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["A.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["A.md", "a\nremote edit\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("creates one document, at the new spelling, for a note renamed by case before its first push", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    await h.vault.write("Notes/C.md", new TextEncoder().encode("new\n"));
    await h.vault.rename("Notes/C.md", "notes/c.md");
    await h.engine.push();

    expect([...h.server.liveFiles()]).toEqual([["notes/c.md", "new\n"]]);
    expect(h.server.revisionCount).toBe(1);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
