import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import {
  converged,
  currentDevice,
  deletePath,
  fileText,
  openSecondDevice,
  renamePath,
  setUpDevice,
  use,
  vaultFolders,
  waitForFiles,
  waitForIdle,
  waitForText,
  writeBinary,
  writeNote,
  type Device,
} from "../devices";
import { pluginId } from "../environment";

// Basic sync between two devices (docs/acceptance/phase-2.md, AC-04 to
// AC-09): A is the primary test vault, B a second vault open in its own
// window of the same Obsidian (devices.ts). Both are signed in as one user
// and connected to one server vault, and every change is made through
// Obsidian's vault API, as the user's edits are.

const subject = "plugin-e2e-basic-sync-user";
const remoteVaultName = "e2e basic sync";

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

/** The server's head of the live document at `path`, and every revision of that document, read through the current device's client. */
function remoteDocumentAt(path: string) {
  return browser.executeObsidian(
    async ({ app }, id, documentPath) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      const vaultId = plugin?.connectedVault?.id;
      if (plugin === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
      const client = plugin.protocolClient();
      const decoder = new TextDecoder();
      const heads = new Map<string, { path: string; deleted: boolean; seq: bigint }>();
      for (const revision of (await client.sync.listChanges({ vaultId, sinceSeq: 0n })).revisions) {
        const head = heads.get(revision.documentId);
        if (head === undefined || revision.seq > head.seq)
          heads.set(revision.documentId, {
            path: decoder.decode(revision.path),
            deleted: revision.deleted,
            seq: revision.seq,
          });
      }
      const documentId = [...heads.entries()].find(([, head]) => head.path === documentPath && !head.deleted)?.[0];
      if (documentId === undefined) return null;
      const history = await client.sync.getDocumentHistory({
        vaultId,
        documentId,
      });
      return {
        documentId,
        paths: history.revisions.map((revision) => decoder.decode(revision.path)),
      };
    },
    pluginId,
    path,
  );
}

describe("basic sync between two devices", function () {
  let a: Device;
  let b: Device;

  before(async function () {
    a = await currentDevice("A");
    await setUpDevice(a, subject, remoteVaultName, true);
    await waitForIdle(a);
    b = await openSecondDevice("B", "./test/e2e/vaults/second");
    await setUpDevice(b, subject, remoteVaultName, false);
    await converged(a, b);
  });

  it("[AC-04] a note created on A appears on B", async function () {
    await use(a);
    await writeNote("Created on A.md", "created on A\n");
    await waitForText(b, "Created on A.md", "created on A\n");
  });

  it("[AC-05] an edit on A appears on B", async function () {
    await use(a);
    await writeNote("Created on A.md", "created on A\nedited on A\n");
    await waitForText(b, "Created on A.md", "created on A\nedited on A\n");
  });

  it("[AC-06] a delete on A is applied on B", async function () {
    await use(a);
    await deletePath("Created on A.md");
    await waitForText(b, "Created on A.md", null);
    const files = await converged(a, b);
    expect(files["Created on A.md"]).toBeUndefined();
  });

  it("[AC-07] a rename or move on A is applied on B, and the document keeps its history", async function () {
    await use(a);
    await writeNote("Rename me.md", "first version\n");
    await waitForText(b, "Rename me.md", "first version\n");
    await use(a);
    await writeNote("Rename me.md", "second version\n");
    await waitForText(b, "Rename me.md", "second version\n");
    await waitForIdle(a);
    const before = await remoteDocumentAt("Rename me.md");
    expect(before).not.toBeNull();

    await renamePath("Rename me.md", "Moved/Renamed.md");
    await waitForText(b, "Moved/Renamed.md", "second version\n");
    await converged(a, b);
    expect(await fileText("Rename me.md")).toBeNull();

    // The same document moved, with its earlier versions in its history.
    await use(a);
    const after = await remoteDocumentAt("Moved/Renamed.md");
    expect(after?.documentId).toBe(before?.documentId);
    expect(after?.paths).toContain("Rename me.md");
    expect(after?.paths).toContain("Moved/Renamed.md");
    expect(after?.paths.length).toBeGreaterThanOrEqual(3);
  });

  it("[AC-08] folders are created, renamed and deleted, with and without files, and an empty folder deleted on A stays deleted", async function () {
    await use(a);
    await browser.executeObsidian(async ({ app }) => {
      await app.vault.createFolder("Empty");
    });
    await writeNote("Projects/Plan.md", "the plan\n");
    await waitForText(b, "Projects/Plan.md", "the plan\n");
    await browser.waitUntil(
      async () => (await vaultFolders()).includes("Empty"),
      { timeoutMsg: "the empty folder never reached B" },
    );

    await use(a);
    await renamePath("Projects", "Archive");
    await renamePath("Empty", "Still empty");
    await waitForText(b, "Archive/Plan.md", "the plan\n");
    await browser.waitUntil(
      async () => (await vaultFolders()).includes("Still empty"),
      { timeoutMsg: "the renamed empty folder never reached B" },
    );
    let folders = (await converged(a, b), await vaultFolders());
    expect(folders).toContain("Archive");
    expect(folders).toContain("Still empty");
    expect(folders).not.toContain("Projects");
    expect(folders).not.toContain("Empty");

    await use(a);
    await deletePath("Archive");
    await deletePath("Still empty");
    await waitForText(b, "Archive/Plan.md", null);
    await browser.waitUntil(
      async () => !(await vaultFolders()).includes("Still empty"),
      { timeoutMsg: "the deleted empty folder stayed on B" },
    );
    await converged(a, b);

    // Another full sync on each device brings nothing back.
    for (const device of [a, b]) {
      await use(device);
      await writeNote(`Nudge ${device.name}.md`, "a change to sync\n");
    }
    await waitForFiles(a, (files) => "Nudge B.md" in files, "B's note on A");
    await waitForFiles(b, (files) => "Nudge A.md" in files, "A's note on B");
    await converged(a, b);
    for (const device of [a, b]) {
      await use(device);
      folders = await vaultFolders();
      expect(folders).not.toContain("Still empty");
      expect(folders).not.toContain("Archive");
    }
  });

  it("[AC-09] an image and a PDF of a few MB arrive byte for byte; a file over the size limit is skipped with a notice and other files still sync", async function () {
    await use(a);
    const image = await writeBinary("Attachments/Photo.png", 3 * 1024 * 1024 + 517, 0x1234567);
    const pdf = await writeBinary("Attachments/Paper.pdf", 4 * 1024 * 1024 + 89, 0x7654321);
    await waitForFiles(b, (files) => files["Attachments/Photo.png"] === image && files["Attachments/Paper.pdf"] === pdf, "both attachments");

    // The e2e server's limit is 8 MiB (cmd/vault-sync-server/e2e_test.go).
    await use(a);
    await writeBinary("Attachments/Too big.zip", 9 * 1024 * 1024, 0x2468ace);
    await writeNote("After the big file.md", "still syncing\n");
    await waitForText(b, "After the big file.md", "still syncing\n");
    await use(a);
    await writeNote("After the big file.md", "still syncing\nedited\n");
    await waitForText(b, "After the big file.md", "still syncing\nedited\n");
    expect(await fileText("Attachments/Too big.zip")).toBeNull();

    // A lists the file, with the reason, in its conflict view.
    await use(a);
    await browser.executeObsidian(async ({ app }, id) => {
      await (app as unknown as Plugins).plugins.plugins[id]?.showConflicts();
    }, pluginId);
    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(() =>
          [...document.querySelectorAll(".vault-sync-too-large-file")].some((item) => item.textContent.includes("Attachments/Too big.zip") && item.textContent.includes("more than the size limit")),
        ),
      {
        timeoutMsg: "the conflict view never listed the file over the size limit",
      },
    );
  });
});
