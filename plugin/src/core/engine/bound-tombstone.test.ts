import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// A document whose file the user moved, deleted on the server before the
// move was pushed, stays bound to that file on its tombstone: the move wins
// over the delete (PO-9). A revision that brings the document back on the
// server, at its old path or elsewhere, meets that file as a local change
// (design §4.5 step 4): the merge path takes the bound file, which stays
// the document's (PO-1, INV-3). Before #790 the engine wrote the revision
// as a new file and left the bound file untracked, so the next push
// committed the user's edit of it as another document (seed 100101). The
// merge keeps the user's name for it (#802).

const bytes = (content: string) => new TextEncoder().encode(content);

describe("SyncEngine, given a moved note deleted on the server and brought back elsewhere before the move is pushed", () => {
  it.each([
    ["in one pull, unedited", false, false],
    ["in one pull, edited", false, true],
    ["one pull per revision, unedited", true, false],
    ["one pull per revision, edited", true, true],
  ] as const)("keeps the moved file the note's at the user's name and commits its later edit as the note's (%s)", async (_variant, stepwise, edited) => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "b", path: "Café.md", content: "b\n" });
    await h.engine.pull();
    await h.vault.rename("Café.md", "A.md");
    if (edited) await h.vault.write("A.md", bytes("b\nmine\n"));
    await h.engine.settled();
    const inode = h.vault.inodeOf("A.md");
    expect(inode).toBeDefined();

    h.server.commit({ documentId: "b", path: "Café.md", deleted: true });
    if (stepwise) await h.engine.pull();
    h.server.commit({ documentId: "b", path: "Café.md", content: "back\n" });
    if (stepwise) await h.engine.pull();
    h.server.commit({ documentId: "b", path: "notes/f.md", content: "back\n" });
    await h.engine.pull();

    // The note's file is the one the user moved, wherever the merge put it.
    const held = [...(await files(h.vault)).keys()].filter((path) => h.vault.inodeOf(path) === inode);
    expect(held).toHaveLength(1);
    const path = held[0] ?? "";
    // The user's rename wins over the re-create as over any remote revision
    // (PO-9; ruling on #52, #802): the note stays at the user's name.
    expect(path).toBe("A.md");
    // The user's edit survives as a conflict copy (principle 1). An unedited
    // file is no local change: its bytes are the deleted revision's, which
    // the server's history holds, and no copy of them becomes another
    // document.
    if (edited) expect([...(await files(h.vault)).values()]).toContain("b\nmine\n");
    expect([...(await files(h.vault)).keys()].some((other) => other.includes("(conflict"))).toBe(edited);

    await h.vault.write(path, bytes("b\nlater\n"));
    await h.engine.settled();
    await h.engine.push();
    await h.engine.pull();

    // The edit of the note's file is committed as the note, never as a new document.
    expect(h.server.liveDocuments().get(path)).toBe("b");
    expect(h.server.liveFiles().get(path)).toBe("b\nlater\n");
    const others = [...h.server.liveFiles()].filter(([other]) => other !== path).map(([, content]) => content);
    expect(others).not.toContain("b\nlater\n");
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
  });
});
