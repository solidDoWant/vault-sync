import { describe, expect, it } from "vitest";

import { files, moveHeadBeforeCommit, syncedOnBoth, twoDevices } from "./testing";

// The user renames a synced note b.md to x.md and does not push, while
// another device deletes b.md and then creates a new note at b.md (#486).
// The pull that applies the delete leaves the user's rename with no live
// document to rename: a later pull bringing the new note to b.md must not
// make the user's next push rename that note to x.md with the user's
// content. The new note stays at b.md with its own content, under its own
// id, the user's file stays live, and both devices converge (SPEC.md §2
// principle 1). The delete is either pulled before the user's push (applied
// directly), or lands just before the rename's commit, so the pull after the
// refused commit merges it with the pending rename.

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("an unpushed rename of a note another device deletes on %s (#486)", (platform) => {
  it.each([
    ["pulled", "unedited", "b\n", "b.md"],
    ["pulled", "edited", "b\nmine\n", "b.md"],
    ["pulled", "unedited, respelled", "b\n", "B.md"],
    ["pulled", "edited, respelled", "b\nmine\n", "B.md"],
    ["merged", "unedited", "b\n", "b.md"],
    ["merged", "edited", "b\nmine\n", "b.md"],
  ] as const)("never renames a new note at the old path (delete %s, %s)", async (delivery, _variant, mine, created) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");
    const renamed = server.liveDocuments().get("b.md") ?? "";

    if (delivery === "pulled") {
      await a.vault.rename("b.md", "x.md");
      if (mine !== "b\n") await a.vault.write("x.md", bytes(mine));
      await a.engine.settled();
      await b.vault.delete("b.md");
      await b.engine.push();
    } else {
      // The user's edit is pushed and refused, the delete having landed
      // just before it; the user renames the note before the next pull.
      await a.vault.write("b.md", bytes(mine));
      moveHeadBeforeCommit(a, () => server.commit({ documentId: renamed, path: "b.md", deleted: true, deviceId: "device-b" }));
      await a.engine.push();
      await a.vault.rename("b.md", "x.md");
      await a.engine.settled();
      await b.engine.pull();
    }
    await a.engine.pull();

    // The new note may be spelled differently from the rename's source: on
    // a case-insensitive platform it is still the path the rename moved from.
    await b.vault.write(created, bytes("theirs\n"));
    await b.engine.push();
    const theirs = server.liveDocuments().get(created);
    expect(theirs).toBeDefined();
    await a.engine.pull();

    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
      await a.engine.pull();
      await b.engine.pull();
    }

    expect(server.liveDocuments().get(created)).toBe(theirs);
    expect(server.liveFiles().get(created)).toBe("theirs\n");
    expect(server.liveFiles().get("x.md")).toBe(mine);
    expect(server.liveDocuments().get("x.md")).not.toBe(theirs);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
