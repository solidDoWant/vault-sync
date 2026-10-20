import { describe, expect, it } from "vitest";

import { threeWayMerge } from "./merge";
import { files, harness, syncedOnBoth, twoDevices } from "./testing";

// Two devices rename the same note X onto the path of a note C that each
// moved away or deleted, and both edit X (#462). Device b's push lands
// first; device a's edit of X must survive, merged into X or kept as a
// conflict copy (SPEC.md §2 principle 1, §7).

const bytes = (content: string) => new TextEncoder().encode(content);

describe.each(["posix", "macos", "windows"] as const)("both devices renaming a note onto a vacated path on %s (#462)", (platform) => {
  it.each([false, true])("keeps the local edit when the local device deleted the vacated note (edited first: %s)", async (editedFirst) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "x.md", "x\n");
    await syncedOnBoth(devices, "c.md", "c\n");

    await b.vault.write("c.md", bytes("c\nremote\n"));
    await b.vault.rename("c.md", "d.md");
    await b.vault.rename("x.md", "c.md");
    await b.vault.write("c.md", bytes("x\nremote\n"));
    await b.engine.push();

    if (editedFirst) await a.vault.write("c.md", bytes("c\nlocal\n"));
    await a.vault.delete("c.md");
    await a.vault.rename("x.md", "c.md");
    await a.vault.write("c.md", bytes("x\nlocal\n"));
    await a.engine.settled();
    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();

    const contents = [...server.liveFiles().values()];
    expect(contents).toContain("x\nlocal\n");
    expect(contents).toContain("x\nremote\n");
    expect(contents).toContain("c\nremote\n");
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
  });
});

// The merge of a remote revision takes the file a local rename of its
// document brought to a path whose note the user deleted (#451), but only
// while the remote revision puts the document elsewhere. One that puts it at
// that very path waits while the journal still has the deleted note there
// (its own remote move over the download cap): taken, the journal would hold
// two live documents at one path (#379). The rename lands once the note's
// move is applied.
describe.each(["posix", "macos", "windows"] as const)("a remote rename onto the path of a held, locally deleted note on %s (#462)", (platform) => {
  it("waits for the held note to move away, then converges with the local edit kept", async () => {
    const h = harness({ merge: threeWayMerge, pathRules: { platform }, maxDownloadBytes: 16 });
    h.server.commit({ documentId: "X", path: "x.md", content: "x\n" });
    h.server.commit({ documentId: "C", path: "c.md", content: "c\n" });
    await h.engine.pull();

    // The user deletes c.md and moves x.md onto it with an edit, while
    // another device moves C to d.md, making it larger than this device
    // downloads, and X to c.md with an edit of its own.
    await h.vault.delete("c.md");
    await h.vault.rename("x.md", "c.md");
    await h.vault.write("c.md", bytes("x\nlocal\n"));
    await h.engine.settled();
    h.server.commit({ documentId: "C", path: "d.md", content: "c, and a lot more\n" });
    h.server.commit({ documentId: "X", path: "c.md", content: "x\nremote\n" });
    await h.engine.push();

    // The journal never holds two live documents at one path.
    const live = (await h.journal.listDocuments()).filter((state) => !state.deleted).map((state) => state.path.toLowerCase());
    expect(new Set(live).size).toBe(live.length);

    // Another device shrinks C again, so this device applies its move.
    h.server.commit({ documentId: "C", path: "d.md", content: "c\n" });
    for (let round = 0; round < 4; round++) await h.engine.push();
    await h.engine.pull();

    const contents = [...h.server.liveFiles().values()];
    expect(contents).toContain("x\nlocal\n");
    expect(contents).toContain("x\nremote\n");
    expect(contents).toContain("c\n");
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
  });
});
