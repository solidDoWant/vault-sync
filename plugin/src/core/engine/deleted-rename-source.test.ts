import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { files, syncedOnBoth, twoDevices } from "./testing";

// The user renames a synced note b.md to x.md and does not push, while
// another device deletes b.md and then creates a new note at b.md (#486).
// The pull that applies the delete leaves the user's rename with no live
// document to rename: a later pull bringing the new note to b.md must not
// make the user's next push rename that note to x.md with the user's
// content. The new note stays at b.md with its own content, under its own
// id, the user's file stays live, and both devices converge (SPEC.md §2
// principle 1).

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("an unpushed rename of a note another device deletes on %s (#486)", (platform) => {
  it.each([
    ["unedited", "b\n", "b.md"],
    ["edited", "b\nmine\n", "b.md"],
    ["unedited, respelled", "b\n", "B.md"],
    ["edited, respelled", "b\nmine\n", "B.md"],
  ] as const)("never renames a new note at the old path (%s)", async (_variant, mine, created) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");

    await a.vault.rename("b.md", "x.md");
    if (mine !== "b\n") await a.vault.write("x.md", bytes(mine));
    await a.engine.settled();
    await b.vault.delete("b.md");
    await b.engine.push();
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

// The same, when the user edited the note before renaming it and the edit's
// push was lost on the way to the server: the edit is still pending when
// the pull applies the delete, so the delete is merged with it rather than
// applied over a clean file. The rename must be dropped there too.
describe.each(["posix", "macos", "windows"] as const)("an unpushed rename of a pending edit of a note another device deletes on %s (#486)", (platform) => {
  it("never renames a new note brought to the old path by a rename", async () => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");

    await a.vault.write("b.md", bytes("b\nmine\n"));
    await a.engine.settled();
    server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("lost", Code.Unavailable);
    };
    await a.engine.push().catch(() => undefined);
    server.interceptor = undefined;
    expect(server.liveFiles().get("b.md")).toBe("b\n");

    await a.vault.rename("b.md", "x.md");
    await a.engine.settled();
    await b.vault.delete("b.md");
    await b.engine.push();
    await a.engine.pull();

    await b.vault.write("c.md", bytes("theirs\n"));
    await b.engine.push();
    await b.vault.rename("c.md", "b.md");
    await b.engine.push();
    const theirs = server.liveDocuments().get("b.md");
    expect(theirs).toBeDefined();
    await a.engine.pull();

    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
      await a.engine.pull();
      await b.engine.pull();
    }

    expect(server.liveDocuments().get("b.md")).toBe(theirs);
    expect(server.liveFiles().get("b.md")).toBe("theirs\n");
    expect(server.liveFiles().get("x.md")).toBe("b\nmine\n");
    expect(server.liveDocuments().get("x.md")).not.toBe(theirs);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
