import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// A note moved into the path another note just left wins over a concurrent
// remote rename of that note, whatever folder spelling the remote rename
// uses (#375, SPEC.md §7: a local rename wins over a concurrent remote
// rename). On Windows and macOS rules a remote rename into `NOTES/` lands in
// the folder the vault already holds as `notes/`, and must not leave the
// user's moved file behind as an unsynced duplicate.

const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("a local move into a just-vacated path on %s (#375)", (platform) => {
  it.each([
    ["notes/C.md", "NOTES/b.md"],
    ["Notes/C.md", "NOTES/b.md"],
    ["notes/C.md", "notes/x.md"],
    ["notes/z.md", "NOTES/b.md"],
    ["notes/z.md", "Notes/x.md"],
    ["z.md", "NOTES/b.md"],
  ])("wins over a concurrent remote rename (local %s, remote %s)", async (target, remoteTarget) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "A", path: "notes/C.md", content: "a\n" });
    h.server.commit({ documentId: "B", path: "notes/b.md", content: "b\n" });
    await h.engine.pull();

    await h.vault.rename("notes/C.md", "moved/C.md");
    await h.vault.rename("notes/b.md", "moved/b.md");
    await h.vault.rename("moved/b.md", target);
    h.server.commit({ documentId: "B", path: remoteTarget });
    for (let round = 0; round < 3; round++) await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["moved/C.md", "A"], [target, "B"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.each(["z.md", "notes/z.md", "Notes/z.md"])("keeps a plain local rename to %s over a remote rename into a respelled folder", async (target) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "B", path: "notes/b.md", content: "b\n" });
    await h.engine.pull();

    await h.vault.rename("notes/b.md", target);
    // On Windows and macOS the folder notes/ stays on disk when the note
    // leaves it, so a rename to Notes/z.md lands in it as notes/z.md, and
    // that is the user's rename (#659).
    const renamed = platform === "posix" ? target : target.replace(/^Notes\//, "notes/");
    expect([...(await files(h.vault)).keys()]).toEqual([renamed]);
    h.server.commit({ documentId: "B", path: "NOTES/b.md" });
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([[renamed, "B"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it("keeps the remote rename into a respelled folder over a local delete", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "B", path: "notes/b.md", content: "b\n" });
    await h.engine.pull();

    await h.vault.delete("notes/b.md");
    h.server.commit({ documentId: "B", path: "NOTES/b.md" });
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["NOTES/b.md", "B"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});
