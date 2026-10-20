import { describe, expect, it } from "vitest";

import { files, harness, text, type Harness } from "./testing";

// Retention purged the revision at this device's cursor, so the server
// reports `diverged` and the engine resyncs (SPEC.md §6.1, §11), though the
// server lost nothing. A note another device changed meanwhile is a plain
// forward revision: applied when its file is unchanged, merged only when the
// user changed it. Merged instead, a remote delete keeps the unchanged file
// ("an edit wins over a delete") and the next push brings the note back
// (#480).

/** x.md and k.md synced at seqs 1 and 2; the cursor sits on k's revision. */
async function synced(h: Harness) {
  h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 1
  h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 2
  await h.engine.pull();
  expect(await h.journal.getCursor()).toBe(2n);
}

/** Another device moves k on; retention then purges `purged` (the cursor's revision k@2 among them). */
async function pullAfterPurge(h: Harness, purged: string[]) {
  h.server.commit({ documentId: "k", path: "k.md", content: "k2" });
  for (const revisionId of ["k@2", ...purged]) h.server.purge(revisionId);
  expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: h.server.currentHeadSeq });
}

/** The engine pushes: what it committed, and what the server holds afterwards. */
async function pushed(h: Harness) {
  const summary = await h.engine.push();
  return { committed: summary.committed, server: h.server.liveFiles(), x: h.server.head("x")?.deleted };
}

describe("SyncEngine resync after retention purged the cursor's revision (#480)", () => {
  it("applies another device's delete of a note the user never changed, and never commits it back", async () => {
    const h = harness({ merge: "default" });
    await synced(h);
    h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 3, carries x1's content

    await pullAfterPurge(h, ["x@1"]);

    expect(await files(h.vault)).toEqual(new Map([["k.md", "k2"]]));
    expect((await h.journal.getDocument("x"))?.deleted).toBe(true);
    expect(await h.journal.listConflicts()).toEqual([]);
    expect(await pushed(h)).toEqual({ committed: 0, server: new Map([["k.md", "k2"]]), x: true });
  });

  it("applies a delete that came after another device's edit, whose content differs from the file", async () => {
    const h = harness({ merge: "default" });
    await synced(h);
    h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 3
    h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 4, carries x2's content

    await pullAfterPurge(h, ["x@1", "x@3"]);

    expect(await files(h.vault)).toEqual(new Map([["k.md", "k2"]]));
    expect(await pushed(h)).toEqual({ committed: 0, server: new Map([["k.md", "k2"]]), x: true });
  });

  it("applies another device's rename and edit of an unchanged note without a conflict copy", async () => {
    const h = harness({ merge: "default" });
    await synced(h);
    h.server.commit({ documentId: "x", path: "y.md", content: "x2" }); // 3

    await pullAfterPurge(h, ["x@1"]);

    expect(await files(h.vault)).toEqual(new Map([["k.md", "k2"], ["y.md", "x2"]]));
    expect(await h.journal.listConflicts()).toEqual([]);
    expect(await pushed(h)).toEqual({ committed: 0, server: new Map([["k.md", "k2"], ["y.md", "x2"]]), x: false });
  });

  it("still keeps the user's edit of a note another device deleted", async () => {
    const h = harness({ merge: "default" });
    await synced(h);
    await h.vault.write("x.md", new TextEncoder().encode("mine"));
    h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 3

    await pullAfterPurge(h, ["x@1"]);

    expect(text(await h.vault.read("x.md"))).toBe("mine");
    expect(await pushed(h)).toMatchObject({ server: new Map([["k.md", "k2"], ["x.md", "mine"]]), x: false });
  });
});

describe("SyncEngine resync after a server restore, whose deletes are merged (SPEC.md §8)", () => {
  /** x synced at x2 (seq 3), the cursor on c's revision (seq 4); the restore then loses x2. */
  async function syncedThenRestored(h: Harness) {
    h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
    h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
    h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 3
    h.server.commit({ documentId: "c", path: "c.md", content: "c1" }); // 4
    await h.engine.pull();
    h.server.restoreTo(2n);
    // Another device commits on the restored server: k's edit takes seq 3, x2's seq.
    h.server.commit({ documentId: "k", path: "k.md", content: "k2" }); // 3
  }

  it("keeps a note's content the server lost when the cursor's seq holds another revision", async () => {
    const h = harness({ merge: "default" });
    await syncedThenRestored(h);
    h.server.commit({ documentId: "c", path: "c.md", content: "c1" }); // 4, another anchor
    h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 5, carries x1's content

    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    expect(text(await h.vault.read("x.md"))).toBe("x2");
  });

  it("keeps a note's content the server lost when retention also purged the cursor's revision", async () => {
    const h = harness({ merge: "default" });
    await syncedThenRestored(h);
    h.server.commit({ documentId: "c", path: "c.md", content: "c1" }); // 4
    h.server.commit({ documentId: "c", path: "c.md", content: "c2" }); // 5
    h.server.purge("c@4");
    h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 6, carries x1's content

    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    // x's synced seq 3 holds k's revision now: the server lost x2.
    expect(text(await h.vault.read("x.md"))).toBe("x2");
  });
});
