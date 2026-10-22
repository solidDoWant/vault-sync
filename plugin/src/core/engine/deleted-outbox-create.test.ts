import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// #866 (INV-3, PO-1, design §4.1 `outbox(D)`): an outbox create commits
// content from its document's file. One whose file the user deleted since has
// nothing to create and is dropped: committed, it would carry bytes from no
// file of the document (the server holding the blob, the upload never reads
// the file). One whose commit landed with its response lost is acknowledged
// by the pull that starts the push, so the push deletes the document instead,
// and no pull brings the file back.

describe("an outbox create whose file the user deleted", () => {
  it("is dropped, not committed, when it was never sent", async () => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    await h.vault.write("a.md", new TextEncoder().encode("a2\n"));
    await h.engine.settled();
    // The edit never reaches the server, but its content does.
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new Error("offline");
    };
    await expect(h.engine.push()).rejects.toThrow();
    h.server.interceptor = undefined;
    // A restore loses a: the resync rewrites the edit as a create under a new revision id, never sent.
    h.server.restoreTo(0n);
    expect((await h.engine.pull()).resynced).toBe(true);
    expect((await h.journal.listPending()).map((operation) => [operation.documentId, operation.baseRevisionId])).toEqual([["a", ""]]);

    await h.vault.delete("a.md");
    await h.engine.settled();
    for (let round = 0; round < 3; round++) {
      await h.engine.push();
      await h.engine.pull();
    }

    expect(h.server.history("a")).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument("a")).toBeUndefined();
    expect(await files(h.vault)).toEqual(new Map());
  });

  it("is deleted, not dropped, when its commit landed and the response was lost", async () => {
    const h = harness();
    await h.vault.write("b.md", new TextEncoder().encode("b1\n"));
    await h.engine.settled();
    // The create lands, but its response is lost: the operation stays in the outbox.
    let loseAck = true;
    h.server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && loseAck) {
        loseAck = false;
        throw new Error("connection reset");
      }
    };
    await expect(h.engine.push()).rejects.toThrow();
    const [sent] = await h.journal.listPending();
    expect(sent).toMatchObject({ baseRevisionId: "" });
    const documentId = sent?.documentId ?? "";
    expect(h.server.head(documentId)?.id).toBe(sent?.revisionId);

    await h.vault.delete("b.md");
    await h.engine.settled();
    for (let round = 0; round < 3; round++) {
      await h.engine.push();
      await h.engine.pull();
    }

    expect(h.server.history(documentId).map((revision) => [revision.id === sent?.revisionId, revision.deleted])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map());
  });
});
