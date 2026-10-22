import { describe, expect, it } from "vitest";

import { byFolderCase, files, harness } from "./testing";

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

    // The folder keeps the spelling it has on disk, so the rename respells
    // the file's own name only (#659).
    expect([...h.server.liveFiles()]).toEqual([["Notes/c.md", "new\n"]]);
    expect(h.server.revisionCount).toBe(1);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});

// A remote case-only rename of a note the user edited (#343): the file at the
// new spelling is the note's own, not a file in the way, so the engine merges
// the rename with the edit instead of putting the revision off forever, and
// the edit is pushed (SPEC.md §2, principle 1).
describe.each(["windows", "macos"] as const)("a remote case-only rename of a locally edited note on %s (#343)", (platform) => {
  it.each(["push", "pull"] as const)("merges the rename with the edit when the %s meets it", async (first) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "Notes/C.md", content: "c\n" });
    await h.engine.pull();

    await h.vault.write("Notes/C.md", new TextEncoder().encode("c\nlocal edit\n"));
    h.server.commit({ documentId: "note", path: "notes/c.md", content: "c\n" });
    await h.engine[first]();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["notes/c.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["notes/c.md", "c\nlocal edit\n"]]));
    // The folder keeps the spelling it has on disk (INV-9, #737, #659).
    expect(await files(h.vault)).toEqual(new Map([["Notes/c.md", "c\nlocal edit\n"]]));
    expect(await h.journal.getDeferred("note")).toBeUndefined();
    expect(await h.journal.listPending()).toEqual([]);

    // Quiet: nothing more to push, and the vault still matches the server.
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(byFolderCase(await files(h.vault))).toEqual(byFolderCase(h.server.liveFiles()));
  });

  it.each([
    ["only renames it", "one\ntwo\nthree\nfour\n", "one\ntwo\nthree\nfour\nlocal edit\n"],
    ["renames and edits it", "remote edit\none\ntwo\nthree\nfour\n", "remote edit\none\ntwo\nthree\nfour\nlocal edit\n"],
  ])("merges the local edit when the other device %s while the push commits the edit, so the server refuses the commit", async (_change, remoteContent, mergedContent) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "note", path: "Notes/C.md", content: "one\ntwo\nthree\nfour\n" });
    await h.engine.pull();

    await h.vault.write("Notes/C.md", new TextEncoder().encode("one\ntwo\nthree\nfour\nlocal edit\n"));
    // Another device renames the note by case just before the edit's commit
    // reaches the server, so its base is no longer the head.
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision") return;
      h.server.interceptor = undefined;
      h.server.commit({ documentId: "note", path: "notes/c.md", content: remoteContent });
    };
    await h.engine.push();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["notes/c.md", "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["notes/c.md", mergedContent]]));
    // One file, at the new spelling of its name, in its folder as the disk
    // spells it: no conflict copy.
    expect(await files(h.vault)).toEqual(new Map([["Notes/c.md", mergedContent]]));
    expect(await h.journal.getDeferred("note")).toBeUndefined();
    expect(await h.journal.listPending()).toEqual([]);

    // Quiet: nothing more to pull or push, and the vault still matches the server.
    await h.engine.pull();
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
    expect(byFolderCase(await files(h.vault))).toEqual(byFolderCase(h.server.liveFiles()));
  });
});

describe.each(["windows", "macos"] as const)("a rename onto a case variant of a path another rename vacates on %s", (platform) => {
  it.each([
    ["first", ["1", "2"]],
    ["last", ["2", "1"]],
  ] as const)("commits the vacating rename first, keeping both ids with no conflict (the vacating rename %s in the journal)", async (_, ids) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    // The journal lists documents by id: the order the push finds the two renames in.
    h.server.commit({ documentId: ids[0], path: "a.md", content: "a\n" });
    h.server.commit({ documentId: ids[1], path: "b.md", content: "b\n" });
    await h.engine.pull();

    await h.vault.rename("a.md", "z.md");
    await h.vault.rename("b.md", "A.md");
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ conflicts: 0, rejected: [] });
    expect(h.server.liveDocuments()).toEqual(
      new Map([
        ["A.md", ids[1]],
        ["z.md", ids[0]],
      ]),
    );
    expect(await h.journal.listConflicts()).toEqual([]);
  });
});
