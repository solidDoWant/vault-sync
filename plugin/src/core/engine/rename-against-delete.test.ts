import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { files, harness, syncedOnBoth, twoDevices } from "./testing";

// A local rename of a note another device deletes meanwhile is a local
// change, which wins over the delete as an edit does (SPEC.md §6.3, §7;
// design PO-7, PO-9; decision #52 as revised for refactor step R5, which
// reverses #513): in either order the document stays under its own id at
// its new path. Pushed after the delete, it comes back on its tombstone.

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe("SyncEngine, given a rename on one device and a delete of the note on another", () => {
  it.each([
    ["unedited", "b\n", false],
    ["edited", "b\nmine\n", false],
    ["edited before, the edit's commit lost", "b\nmine\n", true],
  ] as const)("keeps the renamed file under the document's own id, brought back on its tombstone (%s)", async (_variant, mine, lost) => {
    const devices = twoDevices();
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");
    const original = server.liveDocuments().get("b.md");
    expect(original).toBeDefined();

    if (lost) {
      // The edit is still pending when the delete arrives: the delete is merged with it.
      await a.vault.write("b.md", bytes(mine));
      await a.engine.settled();
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("lost", Code.Unavailable);
      };
      await expect(a.engine.push()).rejects.toThrow();
      server.interceptor = undefined;
    }
    await a.vault.rename("b.md", "x.md");
    if (mine !== "b\n") await a.vault.write("x.md", bytes(mine));
    await a.engine.settled();
    await b.vault.delete("b.md");
    await b.engine.push();

    for (let round = 0; round < 3; round++) {
      await a.engine.push();
      await b.engine.push();
      await a.engine.pull();
      await b.engine.pull();
    }

    expect(server.liveFiles()).toEqual(new Map([["x.md", mine]]));
    expect(server.liveDocuments()).toEqual(new Map([["x.md", original]]));
    expect(server.history(original ?? "").some((revision) => revision.deleted)).toBe(true);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});

describe("SyncEngine, given a rename it held back while the note waits on a deferred revision", () => {
  it("brings the renamed note back under its own id once another device deletes it", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: 5 });
    h.server.commit({ documentId: "b", path: "b.md", content: "b\n" });
    await h.engine.pull();
    // Another device's edit is over the download cap: the note waits on it.
    h.server.commit({ documentId: "b", path: "b.md", content: "b too large\n" });
    expect(await h.engine.pull()).toMatchObject({ deferred: 1 });
    // The rename waits for the note too; the push leaves it recorded.
    await h.vault.rename("b.md", "x.md");
    await h.engine.settled();
    expect(await h.engine.push()).toMatchObject({ committed: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", "b too large\n"]]));

    h.server.commit({ documentId: "b", path: "b.md", deleted: true });
    await h.engine.pull();
    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["x.md", "b\n"]]));
    expect(h.server.liveDocuments()).toEqual(new Map([["x.md", "b"]]));
    expect(h.server.history("b").some((revision) => revision.deleted)).toBe(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});

describe("SyncEngine, given a rename committed before another device's delete of the note", () => {
  it.each([
    ["unedited", "b\n"],
    ["edited", "b\nmine\n"],
  ] as const)("keeps the document under its own id at its new path and drops the delete (%s)", async (_variant, mine) => {
    const devices = twoDevices();
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "b.md", "b\n");
    const original = server.liveDocuments().get("b.md");
    expect(original).toBeDefined();

    await a.vault.rename("b.md", "x.md");
    if (mine !== "b\n") await a.vault.write("x.md", bytes(mine));
    await a.engine.settled();
    await b.vault.delete("b.md");
    await b.engine.settled();
    // The rename reaches the server first.
    await a.engine.push();

    for (let round = 0; round < 3; round++) {
      await b.engine.push();
      await a.engine.push();
      await b.engine.pull();
      await a.engine.pull();
    }

    expect(server.liveFiles()).toEqual(new Map([["x.md", mine]]));
    expect(server.liveDocuments()).toEqual(new Map([["x.md", original]]));
    expect(server.head(original ?? "")?.deleted).toBe(false);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
