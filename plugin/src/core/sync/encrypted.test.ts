import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { deriveSubkey, seal } from "../e2ee/e2ee";
import { contentAad } from "../e2ee/revision";
import { sha256Hex } from "../hash";
import type { VaultKeyring } from "./codec";
import { InMemoryServer } from "./memory-server";
import { RemoteContentError } from "./remote";
import { Device, type TestKeyring, containsBytes, encryptedServer } from "./testing";

const encoder = new TextEncoder();

/** Two devices of one user on an encrypted in-memory vault at epoch 1. */
function setup(options: Parameters<typeof encryptedServer>[0] = {}) {
  const { server, keys } = encryptedServer(options);
  const a = new Device(server, "device-a", { keys });
  const b = new Device(server, "device-b", { keys });
  return { server, keys, a, b };
}

/** A device's view of `keys` without the keys of some epochs, until an owner grants them. */
class WithheldKeyring implements VaultKeyring {
  private readonly withheld: Set<number>;

  constructor(
    private readonly keys: TestKeyring,
    withheld: number[],
  ) {
    this.withheld = new Set(withheld);
  }

  grant(epoch: number): void {
    this.withheld.delete(epoch);
  }

  refresh(): Promise<number> {
    return this.keys.refresh();
  }

  epochKey(epoch: number): Uint8Array | undefined {
    return this.withheld.has(epoch) ? undefined : this.keys.epochKey(epoch);
  }

  conversionSeq(): bigint {
    return this.keys.conversionSeq();
  }
}

/** The head revision of the document at `path` on `device`. */
async function headOf(device: Device, path: string) {
  const entry = [...(await device.journal.load()).docs.values()].find((doc) => doc.path === path);
  if (entry === undefined) throw new Error(`no document at ${path}`);
  const head = device.server.head(entry.documentId);
  if (head === undefined) throw new Error(`no head for ${path}`);
  return head;
}

/**
 * Two devices of one user on `server` make edits that merge (AC-11), edits
 * that conflict (AC-12), a rename and a delete; resolves with both devices'
 * files once they converged.
 */
async function editMergeConflictRenameDelete(server: InMemoryServer, keys: TestKeyring | undefined) {
  let clock = Date.UTC(2026, 9, 30, 12, 0);
  const encryption = keys === undefined ? {} : { keys };
  const a = new Device(server, "device-a", { now: () => clock, userName: "Alice", ...encryption }, { now: () => clock });
  const b = new Device(server, "device-b", { now: () => clock, userName: "Alice", ...encryption }, { now: () => clock });
  await a.write("merged.md", "one\ntwo\nthree\n");
  await a.write("conflicted.md", "one\ntwo\nthree\n");
  await a.write("renamed.md", "kept content\n");
  await a.write("deleted.md", "deleted content\n");
  await a.sync();
  await b.sync();

  clock += 60_000;
  await a.write("merged.md", "ONE\ntwo\nthree\n");
  await a.write("conflicted.md", "ONE\ntwo\nthree\n");
  await a.vault.rename("renamed.md", "moved.md");
  await a.vault.delete("deleted.md");
  await b.write("merged.md", "one\ntwo\nTHREE\n");
  await b.write("conflicted.md", "uno\ntwo\nthree\n");
  await a.sync();
  clock += 60_000;
  await b.sync();
  await a.sync();
  return { a: await a.files(), b: await b.files() };
}

describe("sync in an end-to-end encrypted vault", () => {
  it("[P4-01] syncs notes, folders and edits between devices while the server holds only ciphertext for contents and paths", async () => {
    const { server, a, b } = setup();
    await a.vault.createFolder("Secret folder");
    await a.write("Secret folder/Plan of the heist.md", "the vault code is 4815\n");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "Secret folder/Plan of the heist.md": "the vault code is 4815\n" });
    expect(await b.vault.listFolders()).toContain("Secret folder");

    await b.write("Secret folder/Plan of the heist.md", "the vault code is 1623\n");
    await b.sync();
    await a.sync();
    expect(await a.files()).toEqual({ "Secret folder/Plan of the heist.md": "the vault code is 1623\n" });

    const stored = server.storedBytes();
    for (const plaintext of ["Secret folder", "Plan of the heist", "vault code", "4815", "1623"]) {
      expect(containsBytes(stored, encoder.encode(plaintext)), plaintext).toBe(false);
    }
    // The server's copy decrypts to the devices' files.
    expect(server.liveFiles()).toEqual(new Map([["Secret folder/Plan of the heist.md", "the vault code is 1623\n"]]));
  });

  it("[P4-02] merges, makes conflict copies, renames and deletes between a user's devices exactly as in a plaintext vault", async () => {
    const plaintext = await editMergeConflictRenameDelete(new InMemoryServer(), undefined);
    const { server, keys } = encryptedServer();
    const encrypted = await editMergeConflictRenameDelete(server, keys);

    expect(encrypted.b).toEqual(encrypted.a);
    expect(encrypted.a).toEqual(plaintext.a);
    expect(new Map(Object.entries(encrypted.a))).toEqual(server.liveFiles());
    // AC-11: the edits of different lines merge; AC-12: the edits of one line leave a conflict copy of the device whose commit lost.
    expect(encrypted.a["merged.md"]).toBe("ONE\ntwo\nTHREE\n");
    expect(encrypted.a["conflicted.md"]).toBe("ONE\ntwo\nthree\n");
    const copies = Object.entries(encrypted.a).filter(([path]) => path !== "conflicted.md" && path.startsWith("conflicted"));
    expect(copies.map(([, content]) => content)).toEqual(["uno\ntwo\nthree\n"]);
    expect(encrypted.a["moved.md"]).toBe("kept content\n");
    expect(Object.keys(encrypted.a)).not.toContain("renamed.md");
    expect(Object.keys(encrypted.a)).not.toContain("deleted.md");

    const stored = server.storedBytes();
    for (const plaintextBytes of ["conflicted", "moved", "THREE", "uno"]) {
      expect(containsBytes(stored, encoder.encode(plaintextBytes)), plaintextBytes).toBe(false);
    }
  });

  it("syncs an attachment of a few MB arrives byte for byte through ranged transfers", async () => {
    const { a, b } = setup({ maxDownloadBytes: 256 << 10, maxChunkBytes: 256 << 10 });
    const image = new Uint8Array(3 << 20);
    for (let index = 0; index < image.length; index++) image[index] = (index * 7919) % 251;
    await a.vault.write("photo.png", image);
    await a.sync();
    await b.sync();
    const received = await b.vault.read("photo.png");
    expect(received.length).toBe(image.length);
    expect(sha256Hex(received)).toBe(sha256Hex(image));
  });

  it("[P4-08] re-encrypts and lands a commit sealed under an epoch a rotation replaced", async () => {
    const { server, keys, a, b } = setup();
    await a.write("note.md", "first\n");
    await a.sync();
    await b.sync();
    await a.write("note.md", "second\n");
    // The rotation lands after A sealed its commit under epoch 1, before the server handles it.
    let rotations = 0;
    server.interceptor = (method) => {
      if (method === "CommitRevision" && rotations === 0) {
        rotations++;
        keys.rotate();
      }
    };
    await a.sync();
    server.interceptor = undefined;
    expect(rotations).toBe(1);
    const head = await headOf(a, "note.md");
    expect(head.epoch).toBe(2);
    expect((await a.journal.load()).pending).toEqual([]);
    await b.sync();
    expect(await b.files()).toEqual({ "note.md": "second\n" });
  });

  it("seals the content of a rename and of a delete under the current epoch after a rotation", async () => {
    const { server, keys, a, b } = setup();
    await a.write("kept.md", "kept content\n");
    await a.write("gone.md", "deleted content\n");
    await a.sync();
    await b.sync();
    keys.rotate();
    await a.vault.rename("kept.md", "moved.md");
    await a.vault.delete("gone.md");
    await a.sync();
    const moved = await headOf(a, "moved.md");
    expect(moved.epoch).toBe(2);
    // The content of each revision opens with that revision's epoch.
    expect(server.reader(moved, server.contentOf(moved)).content).toEqual(encoder.encode("kept content\n"));
    const tombstone = server.history((await headOf(b, "gone.md")).documentId).at(-1);
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.epoch).toBe(2);
    if (tombstone === undefined) throw new Error("no tombstone");
    expect(server.reader(tombstone, server.contentOf(tombstone)).content).toEqual(encoder.encode("deleted content\n"));
    await b.sync();
    expect(await b.files()).toEqual({ "moved.md": "kept content\n" });
  });

  it("keeps a path's path_key across rotations, keyed by epoch 1", async () => {
    const { server, keys, a } = setup();
    const pathKeys: string[] = [];
    server.interceptor = (method, request) => {
      if (method === "CommitRevision") pathKeys.push(bytesToHex((request as { pathKey: Uint8Array }).pathKey));
    };
    await a.write("Note.md", "one\n");
    await a.sync();
    keys.rotate();
    await a.write("Note.md", "two\n");
    await a.sync();
    expect(pathKeys).toHaveLength(2);
    expect(pathKeys[1]).toBe(pathKeys[0]);
    expect((await headOf(a, "Note.md")).epoch).toBe(2);
  });

  it("refuses a blob that decrypts but is not the content its blob id names", async () => {
    const { server, keys, a, b } = setup();
    await a.write("note.md", "genuine\n");
    await a.sync();
    const head = await headOf(a, "note.md");
    const key = keys.epochKey(1);
    if (key === undefined) throw new Error("no key");
    // Validly sealed under the epoch, but another plaintext than the blob id's.
    server.corruptBlob(head, seal(deriveSubkey(key, "content"), encoder.encode("forged!\n"), contentAad(server.vaultId, 1)));
    await expect(b.sync()).rejects.toBeInstanceOf(RemoteContentError);
    expect(await b.files()).toEqual({});
  });

  // Fails until the engine keeps back only that document: https://github.com/solidDoWant/vault-sync/issues/1344
  it.skip("keeps back only the document whose epoch key the device lacks after a key sync, and applies it at a later sync once the key arrives", async () => {
    const { keys, a, server } = setup();
    await a.write("old.md", "under epoch 1\n");
    await a.sync();
    keys.rotate();
    await a.write("new.md", "under epoch 2\n");
    await a.sync();
    // A newcomer's device that an owner has granted epoch 2 but not epoch 1 yet.
    const granted = new WithheldKeyring(keys, [1]);
    const b = new Device(server, "device-b", { keys: granted });
    await b.sync().catch(() => undefined);
    expect(await b.files()).toEqual({ "new.md": "under epoch 2\n" });
    granted.grant(1);
    await b.sync();
    expect(await b.files()).toEqual({ "new.md": "under epoch 2\n", "old.md": "under epoch 1\n" });
  });
});
