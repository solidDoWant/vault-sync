import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { browser, expect } from "@wdio/globals";

import { DocumentKind } from "../../../src/gen/vaultsync/v1/types_pb";
import type VaultSyncPlugin from "../../../src/main";
import { openSecondDevice, syncStatus, use, vaultFiles, vaultFolders, waitForIdle, type Device } from "../devices";
import { e2eEnvironment, pluginId } from "../environment";
import { configure, signInAs } from "../signin";

// Connecting a vault (docs/acceptance/phase-2.md, AC-02). Each vault is a
// fresh one opened in its own window of this Obsidian (devices.ts), signed in
// as a user of its own and connected to a new, empty remote vault, so no
// warning is due. An empty vault connects; a vault that already has notes,
// attachments and folders connects, and the server then holds exactly those
// files. Folder documents (engine.md §1, `FOLDER`) are AC-08's: the server's
// files here are its live documents of any other kind.

const subject = "plugin-e2e-connect-user";

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

/** Pseudo-random (incompressible) bytes from `seed`. */
function randomBytes(length: number, seed: number): Uint8Array {
  const content = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    content[index] = state & 0xff;
  }
  return content;
}

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// The populated vault's files, written to disk before Obsidian opens it.
const notes: Record<string, string> = {
  "Welcome.md": "# Welcome\n\nA note at the vault's root.\n",
  "Projects/Plan.md": "# Plan\n\n- [ ] first step\n",
  "Projects/Archive/Old plan.md": "An older plan, two folders deep.\n",
};
const attachments: Record<string, Uint8Array> = {
  "Attachments/Photo.png": randomBytes(300 * 1024 + 17, 0x2545f491),
  "Attachments/Manual.pdf": randomBytes(1024 * 1024 + 3, 0x68e31da4),
};
const folders = ["Attachments", "Projects", "Projects/Archive"];

/** A new folder on disk holding `files`. */
async function vaultOnDisk(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-sync-e2e-connect-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

/** Creates the remote vault `name` and connects the current device to it without confirming anything; returns the plugin's answer. */
function createAndConnect(name: string) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      return await plugin.connectVault(await plugin.createRemoteVault(vaultName), false);
    },
    pluginId,
    name,
  );
}

/** The current device's connected vault and the server's live files in it (every live document but folders): path to kind and content SHA-256. */
function serverFiles() {
  return browser.executeObsidian(async ({ app }, id, folder) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    const vaultId = plugin?.connectedVault?.id;
    if (plugin === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
    const decoder = new TextDecoder();
    const heads = new Map<string, { path: string; kind: DocumentKind; deleted: boolean; seq: bigint; hash: string }>();
    for (const revision of (await plugin.protocolClient().sync.listChanges({ vaultId, sinceSeq: 0n })).revisions) {
      const head = heads.get(revision.documentId);
      if (head !== undefined && revision.seq <= head.seq) continue;
      const blobId = revision.contentRef?.blobId ?? new Uint8Array();
      heads.set(revision.documentId, {
        path: decoder.decode(revision.path),
        kind: revision.kind,
        deleted: revision.deleted,
        seq: revision.seq,
        hash: `sha256:${[...blobId].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      });
    }
    const live: Record<string, { kind: DocumentKind; hash: string }> = {};
    for (const head of heads.values()) if (!head.deleted && head.kind !== folder) live[head.path] = { kind: head.kind, hash: head.hash };
    return { vault: plugin.connectedVault?.name ?? null, files: live };
  }, pluginId, DocumentKind.FOLDER);
}

describe("connecting a vault", function () {
  before(function () {
    // Each test's device is a vault on disk opened in the same desktop
    // Obsidian (devices.ts), which needs the vault's file-system path: the
    // Android app has none. Desktop and emulated mobile run this spec.
    if (e2eEnvironment.android) this.skip();
  });

  it("[AC-02] connects an empty vault", async function () {
    const device = await openSecondDevice("empty", await vaultOnDisk({}));
    await configure();
    expect(await signInAs(subject)).toBe(true);

    expect(await createAndConnect("e2e connect empty")).toBe("connected");
    await waitForIdle(device);

    expect(await serverFiles()).toEqual({ vault: "e2e connect empty", files: {} });
    expect(await vaultFiles()).toEqual({});
    expect(await vaultFolders()).toEqual([]);
  });

  it("[AC-02] connects a vault that already has notes, attachments and folders, and uploads them", async function () {
    const device: Device = await openSecondDevice("populated", await vaultOnDisk({ ...notes, ...attachments }));
    await configure();
    expect(await signInAs(subject)).toBe(true);

    expect(await createAndConnect("e2e connect populated")).toBe("connected");
    const expected: Record<string, { kind: DocumentKind; hash: string }> = {};
    for (const [file, text] of Object.entries(notes)) expected[file] = { kind: DocumentKind.TEXT, hash: sha256(text) };
    for (const [file, content] of Object.entries(attachments)) expected[file] = { kind: DocumentKind.BLOB, hash: sha256(content) };

    await use(device);
    await browser
      .waitUntil(async () => Object.keys((await serverFiles()).files).length >= Object.keys(expected).length)
      .catch(async () => {
        throw new Error(`the vault's files never all reached the server: ${JSON.stringify({ server: Object.keys((await serverFiles()).files).sort(), status: await syncStatus() })}`);
      });
    await waitForIdle(device);

    expect(await serverFiles()).toEqual({ vault: "e2e connect populated", files: expected });
    // Connecting changed nothing on the device.
    const local: Record<string, string> = {};
    for (const [file, text] of Object.entries(notes)) local[file] = text;
    for (const [file, content] of Object.entries(attachments)) local[file] = sha256(content);
    expect(await vaultFiles()).toEqual(local);
    expect(await vaultFolders()).toEqual(folders);
  });
});
