import { describe, expect, it } from "vitest";

import type { ListChangesRequest } from "../../gen/vaultsync/v1/sync_pb";
import { InMemoryJournal } from "../journal/memory";
import { files, harness, text, type Harness } from "./testing";

// Issue #155: a server restored from a backup that then commits until its
// head_seq is back at or above a device's cursor. head_seq alone cannot show
// the restore; the anchor of the revision at the cursor (SPEC.md §6.1) does.

const encoder = new TextEncoder();

/** Records every ListChanges request the engine sends. */
function recordListChanges(h: Harness): ListChangesRequest[] {
  const requests: ListChangesRequest[] = [];
  h.server.interceptor = (method, request) => {
    if (method === "ListChanges") requests.push(request as ListChangesRequest);
  };
  return requests;
}

/** Synced at seq 3 (a at a2, b at b1), then restored to seq 1 and committed past seq 3 again. */
async function restoredPastTheCursor(h: Harness): Promise<void> {
  h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
  h.server.commit({ documentId: "b", path: "b.md", content: "b1\n" }); // 2
  await h.engine.pull();
  // This device's own edit, acknowledged (#874: one it only pulled is its writer's to send again).
  await h.vault.write("a.md", encoder.encode("a2 from this device's sync\n")); // 3
  await h.engine.settled();
  await h.engine.push();
  expect(await h.journal.getCursor()).toBe(3n);

  // The restore loses seq 2 and 3; other devices commit seq 2 to 4 anew.
  h.server.restoreTo(1n);
  // (The in-memory server derives revision ids from seqs; a's new revision is
  // at seq 4 so that its id differs from the lost one, as real ids would.)
  h.server.commit({ documentId: "c", path: "c.md", content: "c1\n" }); // 2
  h.server.commit({ documentId: "d", path: "d.md", content: "d1\n" }); // 3
  h.server.commit({ documentId: "a", path: "a.md", content: "a edited on the restored server\n" }); // 4
  expect(h.server.currentHeadSeq).toBeGreaterThanOrEqual(3n);
}

describe("SyncEngine detects a restored server whose head passed the cursor again", () => {
  it("resyncs, and afterwards holds every post-restore revision without losing local content", async () => {
    const h = harness({ merge: "default" });
    await restoredPastTheCursor(h);

    expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: 4n });

    const contents = await files(h.vault);
    // Every post-restore revision is here: c and d as new documents, a's
    // edit merged with the content this device had.
    expect(contents.get("c.md")).toBe("c1\n");
    expect(contents.get("d.md")).toBe("d1\n");
    const all = [...contents.values()].join("");
    expect(all).toContain("a edited on the restored server");
    // Nothing local is overwritten or deleted: a's lost revision and b,
    // which the restored server lacks, stay.
    expect(all).toContain("a2 from this device's sync");
    expect(contents.get("b.md")).toBe("b1\n");
  });

  it("hands documents the journal knows at lost revisions to the merge path", async () => {
    const h = harness();
    await restoredPastTheCursor(h);

    await h.engine.pull();

    expect(h.merges.map((request) => request.remote.documentId)).toEqual(["a"]);
    expect(text(h.merges[0]?.local.content ?? null)).toBe("a2 from this device's sync\n");
    expect(text(await h.vault.read("a.md"))).toBe("a2 from this device's sync\n");
    // b's journal state no longer claims a seq of the restored server.
    expect((await h.journal.getDocument("b"))?.seq).toBe(0n);
    // The resync anchors the cursor at the restored server's revision there,
    // so a later pull checks it and finds no divergence.
    expect(await h.journal.getCursorAnchor()).toEqual(h.server.revisionAt(4n).anchor);
    expect(await h.engine.pull()).toMatchObject({ resynced: false, cursor: 4n });
  });

  it("detects the restore after the cursor moved onto this device's own commit", async () => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    await h.vault.write("mine.md", encoder.encode("written here\n"));
    await h.engine.push(); // 2, the cursor moves onto it
    expect(await h.journal.getCursor()).toBe(2n);

    h.server.restoreTo(1n);
    h.server.commit({ documentId: "x", path: "x.md", content: "x1\n" }); // 2

    expect(await h.engine.pull()).toMatchObject({ resynced: true });
    expect(text(await h.vault.read("x.md"))).toBe("x1\n");
    expect(text(await h.vault.read("mine.md"))).toBe("written here\n");
  });
});

describe("SyncEngine against a server that was not restored", () => {
  it("sends the cursor's anchor with every pull and never resyncs", async () => {
    const h = harness();
    const requests = recordListChanges(h);
    for (let round = 1; round <= 3; round++) {
      h.server.commit({ documentId: `n${String(round)}`, path: `n${String(round)}.md`, content: `n${String(round)}\n` });
      h.server.commit({ documentId: "a", path: "a.md", content: `a${String(round)}\n` });
      h.server.commit({ documentId: "b", path: "b.md", content: `b${String(round)}\n` });
      expect(await h.engine.pull()).toMatchObject({ resynced: false });
      await h.vault.write(`mine${String(round)}.md`, encoder.encode("local\n"));
      expect(await h.engine.push()).toMatchObject({ committed: 1 });
    }
    expect(await h.engine.pull()).toMatchObject({ resynced: false, cursor: h.server.currentHeadSeq });

    // Every request after the first carries the anchor of the revision at its cursor.
    const anchored = requests.filter((request) => request.sinceSeq > 0n);
    expect(anchored.length).toBeGreaterThan(3);
    for (const request of anchored) expect(request.sinceAnchor).toEqual(h.server.revisionAt(request.sinceSeq).anchor);
    expect(requests.filter((request) => request.sinceSeq === 0n).every((request) => request.sinceAnchor.length === 0)).toBe(true);
  });

  it("pulls without an anchor, as before, from a cursor stored without one", async () => {
    const journal = new InMemoryJournal();
    const h = harness({ journal });
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    h.server.commit({ documentId: "b", path: "b.md", content: "b1\n" }); // 2
    // A journal written before cursor anchors: synced through seq 1.
    await h.engine.pull();
    await journal.resetCursor(1n);
    const requests = recordListChanges(h);

    expect(await h.engine.pull()).toMatchObject({ resynced: false, cursor: 2n });
    expect(requests[0]?.sinceAnchor).toEqual(new Uint8Array());
    expect(await journal.getCursorAnchor()).toEqual(h.server.revisionAt(2n).anchor);
  });
});
