import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { copyOf, files, harness, syncedOnBoth, twoDevices } from "./testing";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/**
 * Two devices synced on a note; then the second edits it without pushing,
 * the first edits and pushes, and retention purges the revision both
 * started from: the second device's merge base (SPEC.md §11, review of #219).
 */
async function purgedBase() {
  const devices = twoDevices();
  await syncedOnBoth(devices, "plan.md", lines("one", "two", "three"));
  await devices.b.vault.write("plan.md", bytes(lines("one", "two (from b)", "three")));
  await devices.a.vault.write("plan.md", bytes(lines("one (from a)", "two", "three")));
  await devices.a.engine.push();
  const [document] = await devices.a.journal.listDocuments();
  const documentId = document?.documentId ?? "";
  const [base] = devices.server.history(documentId);
  if (base === undefined) throw new Error("no base revision");
  return { ...devices, documentId, base };
}

describe("SyncEngine when blob garbage collection removes an upload before its commit (SPEC.md §11)", () => {
  it("uploads the content again and commits it in the same push", async () => {
    const h = harness();
    await h.vault.write("note.md", bytes("old content, written again\n"));
    const hash = sha256Hex(bytes("old content, written again\n"));
    let collected = 0;
    h.server.interceptor = (method) => {
      // The collector deletes the (still unreferenced) blob between BeginBlob and CommitRevision, once.
      if (method === "CommitRevision" && collected++ === 0) h.server.collectBlob(hash);
    };

    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 1, pending: 0, rejected: [] });
    expect(h.server.liveFiles()).toEqual(new Map([["note.md", "old content, written again\n"]]));
    expect(h.server.hasBlob(hash)).toBe(true);
  });

  it("never drops a pending delete whose commit is refused for missing content", async () => {
    const h = harness();
    await h.vault.write("note.md", bytes("to be deleted\n"));
    await h.engine.push();
    const [document] = await h.journal.listDocuments();
    const documentId = document?.documentId ?? "";
    await h.vault.delete("note.md");
    // A tombstone's content is the head's, which collection keeps; here the
    // server has lost that blob anyway: it refuses the delete's content_ref
    // and reports the blob as not uploaded.
    const hash = sha256Hex(bytes("to be deleted\n"));
    h.server.interceptor = (method, request) => {
      if (method === "CommitRevision" && (request as { deleted: boolean }).deleted) throw new ConnectError("content_ref is not a complete blob", Code.FailedPrecondition);
    };
    h.server.responseInterceptor = (method, request, response) => {
      if (method === "BeginBlob" && bytesToHex((request as { blobId: Uint8Array }).blobId) === hash) Object.assign(response as object, { complete: false, receivedSize: 0n });
    };

    await expect(h.engine.push()).rejects.toThrow(/not a complete blob/);

    const pending = await h.journal.listPending();
    expect(pending.map((operation) => ({ documentId: operation.documentId, deleted: operation.deleted }))).toEqual([{ documentId, deleted: true }]);
    // Once the server accepts it, the same delete is committed.
    h.server.interceptor = undefined;
    h.server.responseInterceptor = undefined;
    await h.engine.push();
    expect(h.server.head(documentId)?.deleted).toBe(true);
    expect(h.server.head(documentId)?.id).toBe(pending[0]?.revisionId);
  });
});

describe("SyncEngine when retention purged a merge base (SPEC.md §8, §11)", () => {
  it("finishes the pull, keeps the remote version in place and the local one as a logged conflict copy, and advances the cursor", async () => {
    const { server, a, b, documentId, base } = await purgedBase();
    server.purge(base.id);

    const summary = await b.engine.pull();

    expect(summary.cursor).toBe(server.currentHeadSeq);
    expect(await b.journal.getCursor()).toBe(server.currentHeadSeq);
    const copy = copyOf("plan", ".md", "device-b");
    const expected = new Map([
      ["plan.md", lines("one (from a)", "two", "three")],
      [copy, lines("one", "two (from b)", "three")],
    ]);
    expect(await files(b.vault)).toEqual(expected);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect((await b.journal.listConflicts()).map(({ documentId: id, path, reason, copyPath }) => ({ id, path, reason, copyPath }))).toEqual([
      { id: documentId, path: "plan.md", reason: "base-purged", copyPath: copy },
    ]);

    // Nothing is lost: the copy reaches the server and the other device.
    await b.engine.push();
    await a.engine.pull();
    expect(server.liveFiles()).toEqual(expected);
    expect(await files(a.vault)).toEqual(expected);
  });

  it("does not hold up the rest of the vault: later revisions of other documents still arrive", async () => {
    const { server, b, base } = await purgedBase();
    server.purge(base.id);
    server.commit({ documentId: "other", path: "later.md", content: "after the purge\n" });

    await b.engine.pull();

    expect((await files(b.vault)).get("later.md")).toBe("after the purge\n");
    expect(await b.journal.getCursor()).toBe(server.currentHeadSeq);
  });

  it("treats the base's blob gone from storage (DownloadBlob NOT_FOUND) the same way", async () => {
    const { server, b, base } = await purgedBase();
    const baseBlob = bytesToHex(base.contentRef?.blobId ?? new Uint8Array());
    server.interceptor = (method, request) => {
      if (method === "DownloadBlob" && bytesToHex((request as { blobId: Uint8Array }).blobId) === baseBlob) throw new ConnectError("blob not found", Code.NotFound);
    };

    await b.engine.pull();

    expect(await b.journal.getCursor()).toBe(server.currentHeadSeq);
    expect(await files(b.vault)).toEqual(
      new Map([
        ["plan.md", lines("one (from a)", "two", "three")],
        [copyOf("plan", ".md", "device-b"), lines("one", "two (from b)", "three")],
      ]),
    );
  });

  it("still fails the pull, keeping the cursor, when fetching the base fails for another reason", async () => {
    const { server, b } = await purgedBase();
    const cursor = await b.journal.getCursor();
    server.interceptor = (method) => {
      if (method === "GetRevision") throw new ConnectError("try later", Code.Unavailable);
    };

    await expect(b.engine.pull()).rejects.toThrow(/try later/);

    expect(await b.journal.getCursor()).toBe(cursor);
    expect((await files(b.vault)).get("plan.md")).toBe(lines("one", "two (from b)", "three"));
  });
});
