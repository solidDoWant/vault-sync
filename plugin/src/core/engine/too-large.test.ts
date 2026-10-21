import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import type { DocumentState, JournalChanges } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { threeWayMerge, type MergeHook } from "./merge";
import { Crash, files, harness, type Harness } from "./testing";

// A remote revision whose content is larger than the client's download cap
// (#316, SPEC.md §8) is deferred as `too-large`: the engine never downloads
// (or allocates) its content, nothing on disk changes, and the cursor moves
// past it so the rest of the change feed is applied. A later revision of the
// document within the cap is applied as usual and drops the deferral.

const cap = 10;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const sized = (length: number, fill = "x") => fill.repeat(length);

/** Records the blob id (hex) of every DownloadBlob call the engine makes. */
function recordDownloads(h: Harness): string[] {
  const downloads: string[] = [];
  h.server.interceptor = (method, request) => {
    if (method === "DownloadBlob") downloads.push(bytesToHex((request as { blobId: Uint8Array }).blobId));
  };
  return downloads;
}

const blobOf = (revision: Revision) => bytesToHex(revision.contentRef?.blobId ?? new Uint8Array());

describe("SyncEngine with remote revisions over its download cap (#316)", () => {
  it("defers a revision one byte over the cap without downloading it, and applies the revisions after it", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    const big = h.server.commit({ documentId: "big", path: "big.bin", content: sized(cap + 1) });
    h.server.commit({ documentId: "after", path: "after.md", content: "after\n" });
    const downloads = recordDownloads(h);

    const summary = await h.engine.pull();

    expect(summary).toMatchObject({ applied: 1, deferred: 1, cursor: h.server.currentHeadSeq });
    expect(await h.journal.getCursor()).toBe(h.server.currentHeadSeq);
    expect(downloads).not.toContain(blobOf(big));
    expect(await files(h.vault)).toEqual(new Map([["after.md", "after\n"]]));
    expect(await h.engine.tooLarge()).toEqual([{ documentId: "big", path: "big.bin", size: BigInt(cap + 1), revision: expect.objectContaining({ revisionId: big.id }) as unknown, localPath: undefined }]);

    // Not downloaded on the next pull or push either, nor after a restart.
    await h.engine.pull();
    await h.engine.push();
    h.restart();
    await h.engine.push();
    expect(downloads).not.toContain(blobOf(big));
    expect((await h.engine.tooLarge()).map((document) => document.path)).toEqual(["big.bin"]);
  });

  it("applies a revision of exactly the cap", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    h.server.commit({ documentId: "edge", path: "edge.bin", content: sized(cap) });

    const summary = await h.engine.pull();

    expect(summary).toMatchObject({ applied: 1, deferred: 0 });
    expect(await files(h.vault)).toEqual(new Map([["edge.bin", sized(cap)]]));
    expect(await h.engine.tooLarge()).toEqual([]);
  });

  it("applies a later revision of the document within the cap and drops the deferral", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    h.server.commit({ documentId: "doc", path: "doc.bin", content: sized(cap + 1) });
    await h.engine.pull();
    expect((await h.engine.tooLarge()).map((document) => document.path)).toEqual(["doc.bin"]);

    h.server.commit({ documentId: "doc", path: "doc.bin", content: "small\n" });
    const summary = await h.engine.pull();

    expect(summary).toMatchObject({ applied: 1, deferred: 0 });
    expect(await files(h.vault)).toEqual(new Map([["doc.bin", "small\n"]]));
    expect(await h.engine.tooLarge()).toEqual([]);
    expect(await h.journal.getDeferred("doc")).toBeUndefined();
  });

  it("keeps the earlier version of a known document on disk, and reports where it is", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    h.server.commit({ documentId: "doc", path: "doc.bin", content: "early\n" });
    await h.engine.pull();

    const big = h.server.commit({ documentId: "doc", path: "moved/doc.bin", content: sized(cap + 1) });
    await h.engine.pull();
    await h.engine.push();

    expect(await files(h.vault)).toEqual(new Map([["doc.bin", "early\n"]]));
    expect(h.server.head("doc")?.id).toBe(big.id);
    expect(await h.engine.tooLarge()).toEqual([expect.objectContaining({ documentId: "doc", path: "moved/doc.bin", localPath: "doc.bin" })]);
  });

  it("never overwrites or deletes a local edit, and holds the edit back until a revision within the cap arrives", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    h.server.commit({ documentId: "doc", path: "doc.md", content: "base\n" });
    await h.engine.pull();
    await h.vault.write("doc.md", bytes("local edit\n"));

    const big = h.server.commit({ documentId: "doc", path: "doc.md", content: sized(cap + 1) });
    await h.engine.pull();
    const calls: string[] = [];
    h.server.interceptor = (method) => {
      calls.push(method);
    };
    const pushed = await h.engine.push();

    // Held back: never sent against a base the server has moved past.
    expect(calls.filter((method) => method === "BeginBlob" || method === "CommitRevision")).toEqual([]);
    expect(pushed).toMatchObject({ committed: 0, pending: 0 });
    expect(h.server.head("doc")?.id).toBe(big.id);
    expect(await files(h.vault)).toEqual(new Map([["doc.md", "local edit\n"]]));

    // A revision within the cap merges with the local edit: it is kept.
    h.server.commit({ documentId: "doc", path: "doc.md", content: "remote\n" });
    await h.engine.push();

    expect(await h.engine.tooLarge()).toEqual([]);
    expect([...(await files(h.vault)).values()]).toContain("local edit\n");
    expect([...h.server.liveFiles().values()]).toContain("local edit\n");
  });

  it("defers an over-cap head without downloading it when a resync hands a known document to the merge path", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    h.server.commit({ documentId: "doc", path: "doc.md", content: "base\n" });
    await h.engine.pull();
    const big = h.server.commit({ documentId: "doc", path: "doc.md", content: sized(cap + 1) });
    h.server.commit({ documentId: "other", path: "other.md", content: "other\n" });
    await h.engine.pull();
    // A database restore loses the last revision: the cursor is now ahead of the head.
    h.server.restoreTo(big.seq);
    const downloads = recordDownloads(h);

    const summary = await h.engine.pull();

    expect(summary.resynced).toBe(true);
    expect(downloads).not.toContain(blobOf(big));
    expect((await files(h.vault)).get("doc.md")).toBe("base\n");
    expect((await h.engine.tooLarge()).map((document) => document.path)).toEqual(["doc.md"]);
  });

  it("finishes a merge interrupted after its result reached the disk before deferring a newer revision over the cap", async () => {
    // The merge of r1 reached the disk; the crash came before the rebase,
    // and r2 (too large) arrived before the merge resumed.
    let deferredOnce = false;
    const merge: MergeHook = (request) => {
      if (!deferredOnce) {
        deferredOnce = true;
        return Promise.resolve({ status: "deferred" });
      }
      return threeWayMerge(request);
    };
    class CrashBeforeRebase extends InMemoryJournal {
      crashBefore: string | undefined;
      override async putDocument(state: DocumentState): Promise<void> {
        if (state.revisionId === this.crashBefore) {
          this.crashBefore = undefined;
          throw new Crash("before the rebase");
        }
        await super.putDocument(state);
      }
      // Bindings writes a document row in one transaction.
      override async transact(changes: JournalChanges): Promise<void> {
        if (changes.putDocuments?.some((state) => state.revisionId === this.crashBefore) === true) {
          this.crashBefore = undefined;
          throw new Crash("before the rebase");
        }
        await super.transact(changes);
      }
    }
    const journal = new CrashBeforeRebase();
    const h = harness({ merge, journal, maxDownloadBytes: 100 });
    h.server.commit({ documentId: "a", path: "a.md", content: "one\ntwo\nthree\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("one (local)\ntwo\nthree\n"));
    const r1 = h.server.commit({ documentId: "a", path: "a.md", content: "one\ntwo (remote)\nthree\n" });
    await h.engine.pull();
    journal.crashBefore = r1.id;
    await expect(h.engine.push()).rejects.toThrow(Crash);
    const merged = "one (local)\ntwo (remote)\nthree\n";
    expect(await files(h.vault)).toEqual(new Map([["a.md", merged]]));
    const r2 = h.server.commit({ documentId: "a", path: "a.md", content: sized(101) });
    h.restart();

    await h.engine.push();

    expect(await files(h.vault)).toEqual(new Map([["a.md", merged]]));
    expect((await h.journal.getDocument("a"))?.revisionId).toBe(r1.id);
    expect((await h.journal.getDeferred("a"))?.revision.revisionId).toBe(r2.id);
    expect((await h.engine.tooLarge()).map((document) => document.path)).toEqual(["a.md"]);
  });

  it("applies a deferred revision at an engine start whose cap now fits it", async () => {
    const small = harness({ merge: "default", maxDownloadBytes: cap });
    small.server.commit({ documentId: "doc", path: "doc.bin", content: sized(cap + 1) });
    await small.engine.pull();
    small.engine.dispose();

    const larger = harness({ merge: "default", maxDownloadBytes: cap + 1, server: small.server, vault: small.vault, journal: small.journal });
    await larger.engine.push();

    expect(await files(larger.vault)).toEqual(new Map([["doc.bin", sized(cap + 1)]]));
    expect(await larger.engine.tooLarge()).toEqual([]);
  });
});
