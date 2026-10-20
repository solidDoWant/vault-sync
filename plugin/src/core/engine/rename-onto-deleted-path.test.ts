import { describe, expect, it } from "vitest";

import { files, syncedOnBoth, twoDevices } from "./testing";

// The user deletes a note and renames another note onto its path while
// another device pushes an edit of the renamed note (#451). The local rename
// wins over the remote edit (SPEC.md §7): the deleted note is tombstoned, the
// renamed note moves with the remote edit merged in, and nothing is left
// deferred or unpushed (SPEC.md §2 principle 1).

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("a rename onto a just-deleted note's path on %s (#451)", (platform) => {
  it("pushes the delete and the rename when another device edited the renamed note", async () => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "x.md", "x\n");
    await syncedOnBoth(devices, "c.md", "c\n");
    const before = server.liveDocuments();
    const renamed = before.get("x.md");
    const deleted = before.get("c.md");
    expect(renamed).toBeDefined();
    expect(deleted).toBeDefined();

    await b.vault.write("x.md", bytes("x\nremote\n"));
    await b.engine.push();
    await a.vault.delete("c.md");
    await a.vault.rename("x.md", "c.md");
    await a.engine.settled();
    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();

    expect(server.liveDocuments()).toEqual(new Map([["c.md", renamed]]));
    expect(server.liveFiles()).toEqual(new Map([["c.md", "x\nremote\n"]]));
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
