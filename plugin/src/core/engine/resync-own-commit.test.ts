import { describe, expect, it } from "vitest";

import { files, harness, text, type Harness } from "./testing";

// Issue #892 (design §4.6, INV-3, PO-12): an own commit whose acknowledgement
// only a restore resync's head brings is still this device's write. A later
// restore that loses it, with another head and the file unchanged, must not
// pull that head over it: this device sends its write again under its own id.

const encoder = new TextEncoder();

/**
 * This device edits a.md to a2 and pushes it. Between the push's pull and its
 * commit the server is restored (losing the cursor's revision) and another
 * device commits; the commit lands on the restored server, its response is
 * lost, and the next pull resyncs and finds it as a's head.
 */
async function acknowledgedOnlyByAResyncHead(h: Harness): Promise<void> {
  h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
  h.server.commit({ documentId: "b", path: "b.md", content: "b1\n" }); // 2
  await h.engine.pull();
  await h.vault.write("a.md", encoder.encode("a2 from this device\n"));
  await h.engine.settled();
  let restored = false;
  h.server.interceptor = (method) => {
    if (method !== "CommitRevision" || restored) return;
    restored = true;
    h.server.restoreTo(1n);
    h.server.commit({ documentId: "c", path: "c.md", content: "c1\n" }); // 2, another anchor
  };
  let lose = true;
  h.server.responseInterceptor = (method) => {
    if (method === "CommitRevision" && lose) {
      lose = false;
      throw new Error("connection reset");
    }
  };
  await expect(h.engine.push()).rejects.toThrow();
  h.server.interceptor = undefined;
  h.server.responseInterceptor = undefined;
  expect(text(h.server.contentOf(h.server.revisionAt(3n)))).toBe("a2 from this device\n");
  expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: 3n });
  expect(await h.journal.listPending()).toEqual([]);
  expect((await h.journal.getDocument("a"))?.revisionId).toBe(h.server.revisionAt(3n).id);
}

describe("SyncEngine resync, an own commit a resync's head acknowledged", () => {
  it("records the commit's anchor, as a commit response does", async () => {
    const h = harness();
    await acknowledgedOnlyByAResyncHead(h);
    expect((await h.journal.getDocument("a"))?.anchor).toEqual(h.server.revisionAt(3n).anchor);
  });

  it("re-pushes the write under its own id when a later restore loses it and the head differs", async () => {
    const h = harness();
    await acknowledgedOnlyByAResyncHead(h);

    // The second restore loses this device's commit: a's head is a1 again.
    h.server.restoreTo(2n);
    expect(await h.engine.pull()).toMatchObject({ resynced: true });
    await h.engine.push();
    await h.engine.pull();

    expect(text(await h.vault.read("a.md"))).toBe("a2 from this device\n");
    expect(h.merges).toEqual([]);
    const head = h.server.head("a");
    expect(head?.deviceId).not.toBe("");
    expect(head === undefined ? "" : text(h.server.contentOf(head))).toBe("a2 from this device\n");
    expect((await files(h.vault)).size).toBe(3);
  });

  it("records the anchor of an own create a resync's head acknowledged", async () => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    h.server.commit({ documentId: "b", path: "b.md", content: "b1\n" }); // 2
    await h.engine.pull();
    await h.vault.write("mine.md", encoder.encode("written here\n"));
    await h.engine.settled();
    let restored = false;
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision" || restored) return;
      restored = true;
      h.server.restoreTo(1n);
      h.server.commit({ documentId: "c", path: "c.md", content: "c1\n" }); // 2, another anchor
    };
    let lose = true;
    h.server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && lose) {
        lose = false;
        throw new Error("connection reset");
      }
    };
    await expect(h.engine.push()).rejects.toThrow();
    h.server.interceptor = undefined;
    h.server.responseInterceptor = undefined;

    expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: 3n });
    const created = h.server.revisionAt(3n);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument(created.documentId)).toMatchObject({ revisionId: created.id, anchor: created.anchor });
  });

  it("acknowledges an own commit a resync's head descends from before deciding the head", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    h.server.commit({ documentId: "b", path: "b.md", content: "b1\n" }); // 2
    await h.engine.pull();
    await h.vault.write("a.md", encoder.encode("a2 from this device\n"));
    await h.engine.settled();
    let restored = false;
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision" || restored) return;
      restored = true;
      h.server.restoreTo(1n);
      h.server.commit({ documentId: "c", path: "c.md", content: "c1\n" }); // 2, another anchor
    };
    let lose = true;
    h.server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && lose) {
        lose = false;
        throw new Error("connection reset");
      }
    };
    await expect(h.engine.push()).rejects.toThrow();
    h.server.interceptor = undefined;
    h.server.responseInterceptor = undefined;
    const own = h.server.revisionAt(3n);
    // Another device edits on top of this device's commit: the head descends from it.
    h.server.commit({ documentId: "a", path: "a.md", content: "a3 on top of a2\n" }); // 4

    expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: 4n });

    expect(await h.journal.listPending()).toEqual([]);
    expect(text(await h.vault.read("a.md"))).toBe("a3 on top of a2\n");
    expect([...(await files(h.vault)).keys()].sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(await h.journal.getDocument("a")).toMatchObject({ revisionId: h.server.revisionAt(4n).id, prior: expect.arrayContaining([own.id]) as unknown });
  });
});
