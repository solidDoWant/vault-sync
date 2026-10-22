import { describe, expect, it } from "vitest";

import { files, harness, text } from "./testing";

// #829, #840 (INV-8, INV-9, PO-12, design §4.6): the restore resync resolves
// an outbox operation whose base the restored server lacks. A live revision
// becomes a create under a new revision id, since a sealed operation is never
// edited (design §4.1, `outbox(D)`): its id may name a commit a server holds
// with the old fields. A delete is dropped, and the document it leaves with
// no file and nothing to send is forgotten.

describe("a restore that lost the base of an outbox edit", () => {
  it("re-creates it under a new revision id, so a newer backup holding the first commit does not refuse it", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    await h.vault.write("a.md", new TextEncoder().encode("a2\n"));
    await h.engine.settled();
    // The edit's commit lands, but its response is lost: the operation stays in the outbox.
    let loseAck = true;
    h.server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && loseAck) {
        loseAck = false;
        throw new Error("connection reset");
      }
    };
    await expect(h.engine.push()).rejects.toThrow();
    const [sent] = await h.journal.listPending();
    expect(h.server.head("a")?.id).toBe(sent?.revisionId);
    const newer = h.server.backup();

    // The operator restores an older backup, which lost a altogether; the resync rewrites the edit as a create.
    h.server.restoreTo(0n);
    expect((await h.engine.pull()).resynced).toBe(true);
    const [rewritten] = await h.journal.listPending();
    expect(rewritten).toMatchObject({ documentId: "a", baseRevisionId: "", contentHash: sent?.contentHash });

    // Then the newer backup, which holds the first commit: it is back by the time the create reaches the server,
    // after the pull that starts the push found nothing of a.
    let restored = false;
    h.server.interceptor = (method) => {
      if (method === "CommitRevision" && !restored) {
        restored = true;
        h.server.restoreBackup(newer);
      }
    };
    const rejected = [];
    for (let round = 0; round < 3; round++) {
      rejected.push(...(await h.engine.push()).rejected);
      await h.engine.pull();
    }

    expect(restored).toBe(true);
    expect(rejected).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect([...h.server.liveDocuments()]).toEqual([["a.md", "a"]]);
    expect(h.server.head("a")?.id).toBe(sent?.revisionId);
    expect(text(await h.vault.read("a.md"))).toBe("a2\n");
    expect(await files(h.vault)).toEqual(new Map([["a.md", "a2\n"]]));
  });
});

describe("a restore that lost the base of an outbox delete", () => {
  // The dropped delete leaves a live document with no file: the resync must
  // read the outbox after its rewrite to forget it. A document with a merge
  // owed, kept, would stay busy, so no push would forget it either.
  it("drops the delete and forgets the document with the merge it owed, so nothing asks to merge a lost revision again", async () => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    await h.vault.delete("a.md");
    await h.engine.settled();
    // The delete never reaches the server.
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new Error("offline");
    };
    await expect(h.engine.push()).rejects.toThrow();
    h.server.interceptor = undefined;
    expect((await h.journal.listPending()).map((operation) => [operation.documentId, operation.deleted])).toEqual([["a", true]]);
    // Another device's edit meets the delete: the merge is owed (the harness's hook defers it).
    h.server.commit({ documentId: "a", path: "a.md", content: "a2\n" }); // 2
    await h.engine.pull();
    expect((await h.journal.getDeferred("a"))?.reason).toBe("local-changes");
    expect(h.merges).toHaveLength(1);

    // The restore loses a: the delete has nothing left to delete, and the edit to merge is gone.
    h.server.restoreTo(0n);
    expect((await h.engine.pull()).resynced).toBe(true);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument("a")).toBeUndefined();
    for (let round = 0; round < 3; round++) {
      await h.engine.push();
      await h.engine.pull();
    }

    expect(h.merges).toHaveLength(1);
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.journal.listDocuments()).toEqual([]);
    expect(h.server.head("a")).toBeUndefined();
    expect(await files(h.vault)).toEqual(new Map());
  });
});
