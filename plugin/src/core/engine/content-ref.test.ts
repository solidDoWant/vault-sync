import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { InMemoryVault } from "../vault/memory";
import { harness, testDeviceName, testStamp } from "./testing";

// A content reference is a hash and the size of the content with that hash
// (SPEC.md §6.2). The engine never names a blob at another content's size:
// a rule-W move (design §4.4, PO-8) of a file whose bytes changed since its
// outbox was recorded commits the moved bytes with their own size (#775). A
// size from the older content asks the server for a blob at a size it does
// not have, which the server refuses on every push.

const bytes = (value: string) => new TextEncoder().encode(value);

describe("content references of a moved file", () => {
  it("pairs the moved bytes' hash with their own size when the file changed after its outbox was recorded", async () => {
    const h = harness({ merge: "default" });
    // The size each request names a blob at: BeginBlob's and CommitRevision's, and the offset of the 1-byte probe at a blob's end.
    const named: { hash: string; size: bigint }[] = [];
    let offline = false;
    h.server.interceptor = (method, request) => {
      const blob = request as { blobId?: Uint8Array; size?: bigint; offset?: bigint; length?: number; contentRef?: { blobId: Uint8Array; size: bigint } };
      if (blob.contentRef !== undefined) named.push({ hash: bytesToHex(blob.contentRef.blobId), size: blob.contentRef.size });
      else if (method === "BeginBlob" && blob.blobId !== undefined && blob.size !== undefined) named.push({ hash: bytesToHex(blob.blobId), size: blob.size });
      else if (method === "DownloadBlob" && blob.blobId !== undefined && blob.length === 1 && blob.offset !== undefined) named.push({ hash: bytesToHex(blob.blobId), size: blob.offset });
      if (method === "CommitRevision" && offline) throw new ConnectError("offline", Code.Unavailable);
    };
    h.server.commit({ documentId: "S", path: "other.md", content: "same" });
    await h.engine.pull();
    // The create of x.md is recorded, and its commit never gets through.
    await h.vault.write("x.md", bytes("a long local draft of the note"));
    offline = true;
    await h.engine.push().catch(() => undefined);
    await h.engine.settled();
    offline = false;
    expect(await h.journal.listPending()).toHaveLength(1);
    // The user then renames the note to n.md and saves bytes the server
    // already holds (another note's) in it, and another device takes n.md:
    // the pull moves the unpushed file aside under its own id (rule W(a)).
    await h.vault.rename("x.md", "n.md");
    await h.vault.write("n.md", bytes("same"));
    h.server.commit({ documentId: "R", path: "n.md", content: "remote" });
    await h.engine.pull();

    await h.engine.push();
    await h.engine.settled();
    await h.engine.pull();

    const sizes = new Map([
      [sha256Hex(bytes("a long local draft of the note")), 30n],
      [sha256Hex(bytes("same")), 4n],
    ]);
    expect(named.length).toBeGreaterThan(0);
    for (const reference of named) expect(reference).toEqual({ hash: reference.hash, size: sizes.get(reference.hash) });
    expect(await h.journal.listPending()).toEqual([]);
    const live = h.server.liveFiles();
    expect(live.get("n.md")).toBe("remote");
    expect(live.get(`n (conflict ${testDeviceName} ${testStamp}).md`)).toBe("same");
  });

  it("gives a create moved by an intent recorded without the content's size the size of the moved file", async () => {
    // A displace intent as journals recorded it before #775 (no size), open
    // at a crash: the create's outbox holds the draft, the file holds "same".
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "S", path: "other.md", content: "same" });
    await h.engine.pull();
    await h.vault.write("n.md", bytes("same"));
    await h.engine.settled();
    h.engine.dispose();
    const draft = bytes("a long local draft of the note");
    await h.journal.addPending({ revisionId: "create", documentId: "N", baseRevisionId: "", path: "n.md", contentHash: sha256Hex(draft), size: BigInt(draft.length), kind: "text", deleted: false });
    const hash = sha256Hex(bytes("same"));
    const copy = `n (conflict ${testDeviceName} ${testStamp}).md`;
    const record = { id: "record", documentId: "N", path: "n.md", reason: "path-taken" as const, copyPath: copy, copyHash: hash, remoteRevisionId: "", at: 0 };
    await h.journal.putIntent({ kind: "displace", documentId: "N", steps: { from: "n.md", to: copy, hash, record, recreate: false } });
    h.restart();

    await h.engine.pull();
    expect(await h.journal.listPending()).toMatchObject([{ documentId: "N", path: copy, contentHash: hash, size: 4n }]);
    await h.engine.push();
    await h.engine.settled();

    expect(await h.journal.listPending()).toEqual([]);
    expect(h.server.liveFiles().get(copy)).toBe("same");
  });

  it("pushes a create moved by an intent recorded without the content's size whose file changed as the intent finished", async () => {
    // A displace intent as journals recorded it before #775 (no size), open
    // at a crash, its move done: the copy holds "same", bytes the server
    // already holds (another note's). The user saves the copy again just as
    // recovery finishes the intent, so the size of the recorded content is
    // known nowhere, and then undoes the save. No outbox may name that
    // content at another size: the upload's probe of the server's blob would
    // fail on every push.
    const copy = `n (conflict ${testDeviceName} ${testStamp}).md`;
    let reads = 0;
    let vault: InMemoryVault | undefined;
    const h = harness({
      merge: "default",
      wrapVault: (inner) => {
        vault = inner;
        return {
          list: () => inner.list(),
          stat: (file) => inner.stat(file),
          watch: (listener) => inner.watch(listener),
          write: (file, data, precondition) => inner.write(file, data, precondition),
          rename: (from, to) => inner.rename(from, to),
          delete: (file, precondition) => inner.delete(file, precondition),
          read: async (file) => {
            // Recovery reads the copy to find the move done, then reads it again for its size.
            if (file === copy && armed && ++reads === 2) await inner.write(copy, bytes("saved again"));
            return inner.read(file);
          },
        };
      },
    });
    let armed = false;
    h.server.commit({ documentId: "S", path: "other.md", content: "same" });
    await h.engine.pull();
    await h.vault.write(copy, bytes("same"));
    await h.engine.settled();
    h.engine.dispose();
    const draft = bytes("a long local draft of the note");
    await h.journal.addPending({ revisionId: "create", documentId: "N", baseRevisionId: "", path: "n.md", contentHash: sha256Hex(draft), size: BigInt(draft.length), kind: "text", deleted: false });
    const hash = sha256Hex(bytes("same"));
    const record = { id: "record", documentId: "N", path: "n.md", reason: "path-taken" as const, copyPath: copy, copyHash: hash, remoteRevisionId: "", at: 0 };
    await h.journal.putIntent({ kind: "displace", documentId: "N", steps: { from: "n.md", to: copy, hash, record, recreate: false } });
    h.restart();
    armed = true;

    await h.engine.pull();
    for (const operation of await h.journal.listPending()) expect(operation.contentHash === hash ? operation.size : 4n).toBe(4n);
    // The user undoes the save: the copy holds the recorded content again.
    await h.vault.write(copy, bytes("same"));
    await h.engine.push();
    await h.engine.settled();
    await h.engine.push();

    expect(vault).toBeDefined();
    expect(await h.journal.listPending()).toEqual([]);
    expect(h.server.liveFiles().get(copy)).toBe("same");
  });

  it("names a recreate's create by the recorded content's size when the moved file changes as the intent finishes", async () => {
    // A recreate intent (a document the server lost, displaced under its
    // own id) with its recorded size, open at a crash, its move done: the
    // copy holds "same". The user saves the copy again just as recovery
    // finishes the intent. The create must pair the recorded hash with the
    // recorded size, never with the size of the file's newer bytes (#775).
    const copy = `n (conflict ${testDeviceName} ${testStamp}).md`;
    let armed = false;
    let reads = 0;
    const h = harness({
      merge: "default",
      wrapVault: (inner) => ({
        list: () => inner.list(),
        stat: (file) => inner.stat(file),
        watch: (listener) => inner.watch(listener),
        write: (file, data, precondition) => inner.write(file, data, precondition),
        rename: (from, to) => inner.rename(from, to),
        delete: (file, precondition) => inner.delete(file, precondition),
        read: async (file) => {
          // Recovery reads the copy to find the move done; any later read finds it saved again.
          if (file === copy && armed && ++reads === 2) await inner.write(copy, bytes("saved again"));
          return inner.read(file);
        },
      }),
    });
    h.server.commit({ documentId: "N", path: "n.md", content: "same" });
    await h.engine.pull();
    await h.engine.settled();
    h.engine.dispose();
    await h.vault.rename("n.md", copy);
    const hash = sha256Hex(bytes("same"));
    const record = { id: "record", documentId: "N", path: "n.md", reason: "path-taken" as const, copyPath: copy, copyHash: hash, remoteRevisionId: "", at: 0 };
    await h.journal.putIntent({ kind: "displace", documentId: "N", steps: { from: "n.md", to: copy, hash, size: 4, record, recreate: true } });
    h.restart();
    armed = true;

    await h.engine.pull();

    expect(await h.journal.listPending()).toMatchObject([{ documentId: "N", baseRevisionId: "", path: copy, contentHash: hash, size: 4n, deleted: false }]);
  });
});
