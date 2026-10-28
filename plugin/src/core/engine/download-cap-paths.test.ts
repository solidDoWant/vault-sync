import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import type { HistoryEntry } from "./history";
import { deferMerge } from "./merge";
import { InMemoryServer } from "./memory-server";
import { DownloadCapError } from "./remote";
import { files, harness, type Harness } from "./testing";

// #410 item 3: every download the engine makes honours its download cap
// (SPEC.md §8, #316), not only the pull's download of a revision's content:
// the merge base, a merge retried for a deferral an engine with a higher cap
// recorded, and a history entry read whole or downloaded for a restore.

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

const hashOf = (content: string) => sha256Hex(bytes(content));

describe("the merge base and the download cap (#410 item 3)", () => {
  it.each([
    { size: cap, downloaded: true },
    { size: cap + 1, downloaded: false },
  ])("downloads a base of $size bytes only within the cap, and keeps both versions either way", async ({ size, downloaded }) => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    // This device committed the base itself, so it held content the cap would refuse.
    const base = sized(size);
    await h.vault.write("doc.md", bytes(base));
    await h.engine.settled();
    await h.engine.push();
    await h.vault.write("doc.md", bytes("mine\n"));
    await h.engine.settled();
    h.server.commit({ documentId: (await h.journal.findDocumentByPath("doc.md"))?.documentId ?? "", path: "doc.md", content: "theirs\n" });
    const downloads = recordDownloads(h);

    await h.engine.pull();

    expect(downloads.includes(hashOf(base))).toBe(downloaded);
    const contents = [...(await files(h.vault)).values()].sort();
    expect(contents).toEqual(["mine\n", "theirs\n"]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });
});

describe("a merge retry of a deferral over the download cap (#410 item 3)", () => {
  it("never downloads the revision, keeps the local edit, and reports it as too large", async () => {
    const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 64 });
    const vault = new InMemoryVault();
    const journal = new InMemoryJournal();
    // An engine with a higher cap deferred the merge (its hook deferred it).
    const before = harness({ server, vault, journal, merge: deferMerge, maxDownloadBytes: 100 });
    before.server.commit({ documentId: "doc", path: "doc.md", content: "base\n" });
    await before.engine.pull();
    await before.vault.write("doc.md", bytes("local edit\n"));
    await before.engine.settled();
    const big = sized(cap + 1);
    before.server.commit({ documentId: "doc", path: "doc.md", content: big });
    await before.engine.pull();
    expect((await journal.listDeferred()).map(({ reason }) => reason)).toEqual(["local-changes"]);

    const h = harness({ server, vault, journal, merge: "default", maxDownloadBytes: cap });
    const downloads = recordDownloads(h);
    await h.engine.push();

    expect(downloads).not.toContain(hashOf(big));
    expect((await h.journal.listDeferred()).map(({ reason }) => reason)).toEqual(["too-large"]);
    expect((await h.engine.tooLarge()).map(({ path, size }) => ({ path, size }))).toEqual([{ path: "doc.md", size: BigInt(cap + 1) }]);
    expect(await files(h.vault)).toEqual(new Map([["doc.md", "local edit\n"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["doc.md", big]]));
  });

  it("still retries a deferral of exactly the cap", async () => {
    const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 64 });
    const vault = new InMemoryVault();
    const journal = new InMemoryJournal();
    const before = harness({ server, vault, journal, merge: deferMerge, maxDownloadBytes: 100 });
    before.server.commit({ documentId: "doc", path: "doc.md", content: "base\n" });
    await before.engine.pull();
    await before.vault.write("doc.md", bytes("local edit\n"));
    await before.engine.settled();
    const edge = sized(cap);
    before.server.commit({ documentId: "doc", path: "doc.md", content: edge });
    await before.engine.pull();

    const h = harness({ server, vault, journal, merge: "default", maxDownloadBytes: cap });
    const downloads = recordDownloads(h);
    await h.engine.push();

    expect(downloads).toContain(hashOf(edge));
    expect(await h.journal.listDeferred()).toEqual([]);
    expect([...(await files(h.vault)).values()].sort()).toEqual(["local edit\n", edge].sort());
  });
});

describe("history downloads and the download cap (#410 item 3)", () => {
  async function entryOf(h: Harness, content: string): Promise<HistoryEntry> {
    await h.vault.write("doc.md", bytes(content));
    await h.engine.settled();
    await h.engine.push();
    await h.vault.write("doc.md", bytes("later\n"));
    await h.engine.settled();
    await h.engine.push();
    const documentId = (await h.journal.findDocumentByPath("doc.md"))?.documentId ?? "";
    const entry = (await h.engine.history(documentId)).entries.find((candidate) => candidate.contentHash === hashOf(content));
    if (entry === undefined) throw new Error("no history entry");
    return entry;
  }

  it("refuses to read a whole entry over the cap without downloading it, and reads one of exactly the cap", async () => {
    const h = harness({ maxDownloadBytes: cap });
    const over = await entryOf(h, sized(cap + 1, "o"));
    const edge = await entryOf(h, sized(cap, "e"));
    const downloads = recordDownloads(h);

    await expect(h.engine.readRevision(over)).rejects.toThrow(DownloadCapError);
    expect(downloads).toEqual([]);
    // A preview of its start is still allowed.
    expect(await h.engine.readRevision(over, 4)).toEqual(bytes("oooo"));

    expect(await h.engine.readRevision(edge)).toEqual(bytes(sized(cap, "e")));
  });

  it.each([
    { size: cap, restored: true },
    { size: cap + 1, restored: false },
  ])("downloads a collected entry of $size bytes for a restore only within the cap", async ({ size, restored }) => {
    const h = harness({ maxDownloadBytes: cap });
    const content = sized(size, "r");
    const entry = await entryOf(h, content);
    let refused = false;
    const downloads: string[] = [];
    h.server.interceptor = (method, request) => {
      if (method === "DownloadBlob") downloads.push(bytesToHex((request as { blobId: Uint8Array }).blobId));
      if (method === "CommitRevision" && !refused) {
        refused = true;
        throw new ConnectError("content_ref is not a complete blob", Code.FailedPrecondition);
      }
    };

    const restore = h.engine.restore(entry);

    if (restored) {
      await restore;
      expect(h.server.liveFiles()).toEqual(new Map([["doc.md", content]]));
    } else {
      await expect(restore).rejects.toMatchObject({ name: "RestoreError", reason: "too-large" });
      expect(downloads).not.toContain(hashOf(content));
      expect(h.server.liveFiles()).toEqual(new Map([["doc.md", "later\n"]]));
    }
  });
});
