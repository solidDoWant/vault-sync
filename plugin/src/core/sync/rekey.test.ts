import { create } from "@bufbuild/protobuf";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { ReplaceRevisionCiphertextRequestSchema } from "../../gen/vaultsync/v1/vault_key_pb";
import { blobId, deriveSubkey, seal } from "../e2ee/e2ee";
import { contentAad, pathAad } from "../e2ee/revision";
import { createProtocolClient } from "../protocol/client";
import type { InMemoryServer } from "./memory-server";
import { reencryptHistory } from "./rekey";
import { Device, type TestKeyring, encryptedServer } from "./testing";
import { uploadBlob } from "./upload";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Every stored revision. */
function revisions(server: InMemoryServer): Revision[] {
  const all: Revision[] = [];
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) all.push(server.revisionAt(seq));
  return all;
}

/** Every stored revision in plain form, by id: what re-encryption must keep. */
function plainHistory(server: InMemoryServer, keys: TestKeyring) {
  return new Map(
    revisions(server).map((revision) => {
      const blob = revision.contentRef === undefined ? undefined : server.contentOf(revision);
      const plain = keys.reveal(revision, blob);
      return [revision.id, { seq: revision.seq, documentId: revision.documentId, parent: revision.parentRevId, deleted: revision.deleted, path: plain.path, content: plain.content === undefined ? undefined : decoder.decode(plain.content) }];
    }),
  );
}

/** An owner's job client on `server`. */
function owner(server: InMemoryServer) {
  return createProtocolClient({ transport: server.transport });
}

/**
 * An encrypted vault whose history spans epochs 1 to 3: edits, a folder, a
 * conflict copy, a rename and a tombstone; two devices of one user.
 */
async function vaultWithHistory() {
  const { server, keys } = encryptedServer();
  let clock = Date.UTC(2026, 9, 30, 12, 0);
  const a = new Device(server, "device-a", { keys, now: () => clock, userName: "Alice" }, { now: () => clock });
  const b = new Device(server, "device-b", { keys, now: () => clock, userName: "Alice" }, { now: () => clock });
  await a.vault.createFolder("Projects");
  await a.write("Projects/plan.md", "one\ntwo\n");
  await a.write("conflicted.md", "one\n");
  await a.write("gone.md", "deleted content\n");
  await a.write("shared.md", "same bytes\n");
  await a.write("copy.md", "same bytes\n");
  await a.sync();
  await b.sync();
  keys.rotate();
  clock += 60_000;
  await a.write("conflicted.md", "ONE\n");
  await b.write("conflicted.md", "uno\n");
  await a.vault.delete("gone.md");
  await a.vault.rename("Projects/plan.md", "Projects/renamed.md");
  await a.sync();
  clock += 60_000;
  await b.sync();
  await a.sync();
  keys.rotate();
  await a.write("Projects/renamed.md", "one\ntwo\nthree\n");
  await a.sync();
  await b.sync();
  return { server, keys, a, b };
}

/** Asserts that every stored revision is on `epoch` and opens to the same plain history as `before`. */
function expectHistoryOn(server: InMemoryServer, keys: TestKeyring, epoch: number, before: ReturnType<typeof plainHistory>) {
  for (const revision of revisions(server)) expect(revision.epoch, revision.id).toBe(epoch);
  expect(plainHistory(server, keys)).toEqual(before);
}

describe("re-encrypting history (the re-key job)", () => {
  it("[P4-09] moves every revision, tombstone, folder and conflict copy onto the current epoch and retires the old epochs except 1", async () => {
    const { server, keys, a, b } = await vaultWithHistory();
    const before = plainHistory(server, keys);
    const epochs = new Set(revisions(server).map((revision) => revision.epoch));
    expect(epochs).toEqual(new Set([1, 2, 3]));
    expect(revisions(server).some((revision) => revision.deleted)).toBe(true);
    const filesBefore = await a.files();
    expect(Object.keys(filesBefore).filter((path) => path.startsWith("conflicted"))).toHaveLength(2);

    const staleAtStart = staleCount(server);
    const result = await reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 2 });

    expect(result.epoch).toBe(3);
    expect(result.moved).toBe(staleAtStart);
    expectHistoryOn(server, keys, 3, before);
    expect([...server.retiredEpochs].sort()).toEqual([2]);
    expect(result.retired).toEqual([2]);
    // The old ciphertext is unreferenced, so cleanup deletes it, and the devices still sync and read history.
    expect(server.collectUnreferencedBlobs()).toBeGreaterThan(0);
    await a.sync();
    await b.sync();
    const c = new Device(server, "device-c", { keys });
    await c.sync();
    expect(await c.files()).toEqual(filesBefore);
    expect(await b.files()).toEqual(filesBefore);
    expect(server.liveFiles()).toEqual(new Map(Object.entries(filesBefore)));
  });

  it("does nothing more on a second run, and retires nothing in a vault still on epoch 1", async () => {
    const { server, keys } = encryptedServer();
    const device = new Device(server, "device-a", { keys });
    await device.write("note.md", "only epoch 1\n");
    await device.sync();
    const result = await reencryptHistory(owner(server), server.vaultId, keys);
    expect(result).toEqual({ epoch: 1, moved: 0, retired: [] });
    expect(server.retiredEpochs.size).toBe(0);
  });

  it("[P4-09] restarts with the newer target when a rotation lands during the job, and ends on the newest epoch", async () => {
    const { server, keys } = await vaultWithHistory();
    const before = plainHistory(server, keys);
    let rewrites = 0;
    server.interceptor = (method) => {
      if (method === "ReplaceRevisionCiphertext" && ++rewrites === 3) keys.rotate();
    };
    const result = await reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 3 });
    server.interceptor = undefined;
    expect(server.currentEpoch).toBe(4);
    expect(result.epoch).toBe(4);
    expectHistoryOn(server, keys, 4, before);
    expect([...server.retiredEpochs].sort()).toEqual([2, 3]);
  });

  it("[P4-09] ends with every revision on the newest epoch when two runs race", async () => {
    const { server, keys } = await vaultWithHistory();
    const before = plainHistory(server, keys);
    const staleAtStart = staleCount(server);
    const [first, second] = await Promise.all([reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 2 }), reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 2 })]);
    expectHistoryOn(server, keys, 3, before);
    // Each revision was moved by exactly one of the runs; the other's rewrite lost.
    expect(first.moved + second.moved).toBe(staleAtStart);
    expect([...server.retiredEpochs]).toEqual([2]);
  });

  it("[P4-09] leaves sync unaffected while devices edit during the job", async () => {
    const { server, keys, a, b } = await vaultWithHistory();
    const history = plainHistory(server, keys);
    await Promise.all([
      reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 1 }),
      (async () => {
        await a.write("Projects/renamed.md", "edited during the job\n");
        await a.write("new.md", "new during the job\n");
        await a.sync();
        await b.sync();
        await b.write("new.md", "new during the job, then edited\n");
        await b.sync();
      })(),
    ]);
    server.collectUnreferencedBlobs();
    await a.sync();
    await b.sync();
    expect(await a.files()).toEqual(await b.files());
    expect((await a.files())["new.md"]).toBe("new during the job, then edited\n");
    expect((await a.files())["Projects/renamed.md"]).toBe("edited during the job\n");
    expect(server.liveFiles()).toEqual(new Map(Object.entries(await a.files())));
    for (const revision of revisions(server)) expect(revision.epoch).toBe(3);
    // The history from before the job is unchanged in plain form.
    const after = plainHistory(server, keys);
    for (const [id, plain] of history) expect(after.get(id)).toEqual(plain);
    expect((await a.journal.load()).pending).toEqual([]);
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("resumes and completes after an interrupted run", async () => {
    const { server, keys } = await vaultWithHistory();
    const before = plainHistory(server, keys);
    const staleAtStart = staleCount(server);
    let rewrites = 0;
    server.interceptor = (method) => {
      if (method === "ReplaceRevisionCiphertext" && ++rewrites === 4) throw new Error("the app closed");
    };
    await expect(reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 2 })).rejects.toThrow();
    server.interceptor = undefined;
    const stale = staleCount(server);
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(staleAtStart);
    expect(server.retiredEpochs.size).toBe(0);

    const result = await reencryptHistory(owner(server), server.vaultId, keys, { pageSize: 2 });
    expect(result.moved).toBe(stale);
    expectHistoryOn(server, keys, 3, before);
    expect([...server.retiredEpochs]).toEqual([2]);
  });

  it("re-reads a revision whose blob a re-key moved and cleanup deleted while a device pulled it", async () => {
    const { server, keys } = encryptedServer();
    const device = new Device(server, "device-a", { keys });
    await device.write("note.md", "moved under the reader\n");
    await device.sync();
    keys.rotate();
    const stored = revisions(server)[0];
    if (stored?.contentRef === undefined) throw new Error("no revision");
    // The job's ciphertext of the revision under epoch 2, uploaded ahead.
    const key = keys.epochKey(2);
    if (key === undefined) throw new Error("no key");
    const content = encoder.encode("moved under the reader\n");
    const sealed = seal(deriveSubkey(key, "content"), content, contentAad(server.vaultId, 2));
    const newBlobId = blobId(sealed);
    await uploadBlob(owner(server), server.vaultId, newBlobId, sealed);
    const oldBlob = bytesToHex(stored.contentRef.blobId);
    let moves = 0;
    server.interceptor = (method, request) => {
      if (method !== "DownloadBlob" || bytesToHex((request as { blobId: Uint8Array }).blobId) !== oldBlob || moves > 0) return;
      moves++;
      // Between the reader's ListChanges and its download, the revision moves to epoch 2 and its old blob is collected.
      server.replaceCiphertext(
        create(ReplaceRevisionCiphertextRequestSchema, {
          vaultId: server.vaultId,
          revisionId: stored.id,
          fromEpoch: 1,
          toEpoch: 2,
          path: seal(deriveSubkey(key, "path"), encoder.encode("note.md"), pathAad(server.vaultId, stored.documentId, 2)),
          contentRef: { blobId: newBlobId, size: BigInt(sealed.length) },
        }),
      );
      server.collectUnreferencedBlobs();
    };
    const reader = new Device(server, "device-b", { keys });
    await reader.sync();
    server.interceptor = undefined;
    expect(moves).toBe(1);
    expect(await reader.files()).toEqual({ "note.md": "moved under the reader\n" });
  });
});

/** How many stored revisions are not on the server's current epoch. */
function staleCount(server: InMemoryServer): number {
  return revisions(server).filter((revision) => revision.epoch !== server.currentEpoch).length;
}
