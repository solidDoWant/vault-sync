import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { deriveSubkey, seal } from "../e2ee/e2ee";
import { contentAad } from "../e2ee/revision";
import { sha256Hex } from "../hash";
import { RemoteContentError } from "./remote";
import { Device, containsBytes, encryptedServer } from "./testing";

const encoder = new TextEncoder();

/** Two devices of one user on an encrypted in-memory vault at epoch 1. */
function setup(options: Parameters<typeof encryptedServer>[0] = {}) {
  const { server, keys } = encryptedServer(options);
  const a = new Device(server, "device-a", { keys });
  const b = new Device(server, "device-b", { keys });
  return { server, keys, a, b };
}

/** The head revision of the document at `path` on `device`. */
async function headOf(device: Device, path: string) {
  const entry = [...(await device.journal.load()).docs.values()].find((doc) => doc.path === path);
  if (entry === undefined) throw new Error(`no document at ${path}`);
  const head = device.server.head(entry.documentId);
  if (head === undefined) throw new Error(`no head for ${path}`);
  return head;
}

describe("sync in an end-to-end encrypted vault", () => {
  it("syncs notes, folders and edits between devices while the server holds only ciphertext", async () => {
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
});
