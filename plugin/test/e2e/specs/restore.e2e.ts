import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import {
  conflictCopies,
  connect,
  contentOf,
  currentDevice,
  goOffline,
  serverHeads,
  use,
  vaultFiles,
  waitForIdle,
  writeBinary,
  writeNote,
  type Device,
} from "../devices";
import { e2eEnvironment, pluginId } from "../environment";
import { configure, signInAs } from "../signin";

// A device after a restore from an export (docs/acceptance/phase-6.md, P6-03;
// docs/design/restore-from-export.md §7). A device syncs a vault, the admin
// exports it, and the device then goes offline and changes files the export
// does not have. The admin restores the export into a new vault (the e2e
// driver runs the export job and `import -from-export`, e2e_restore_test.go),
// and the device connects its existing folder to the restored vault. The
// connect rule (engine.md §12, X2) puts every file through rule W: identical
// files bind with no change, a file that differs is kept, and a file only
// the device has is uploaded. No file on the device is lost or overwritten.

const subject = "plugin-e2e-restore-user";
const lostVault = "e2e restore lost";
const restoredVault = "e2e restore restored";

const identical = "Notes/Same.md";
const identicalText = "# Same\n\nThe export and the device hold this text.\n";
const picture = "Attachments/Picture.png";
const edited = "Edited.md";
const exportedText = "# Edited\n\nThe text the export holds.\n";
const editedText =
  "# Edited\n\nThe text the export holds.\n\nA line the device wrote after the export.\n";
const localOnly = "Only here.md";
const localOnlyText =
  "# Only here\n\nThe device wrote this after the export.\n";

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

interface RestoreReport {
  status: string;
  fallback: unknown[] | null;
  missing: unknown[] | null;
  skipped: unknown[] | null;
}

/** Asks the e2e driver to run one of the admin's steps on the main server. */
async function admin<Result>(
  action: "export" | "restore",
  body: object = {},
): Promise<Result> {
  const url = process.env.VAULT_SYNC_E2E_RESTORE_CONTROL_URL;
  if (url === undefined || url === "")
    throw new Error(
      "VAULT_SYNC_E2E_RESTORE_CONTROL_URL is not set; run the e2e suite with `make test-e2e`",
    );
  const response = await fetch(`${url}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`the driver's ${action} failed: ${await response.text()}`);
  return (await response.json()) as Result;
}

/** The id of the connected vault. */
function connectedVaultId() {
  return browser.executeObsidian(
    ({ app }, id) =>
      (app as unknown as Plugins).plugins.plugins[id]?.connectedVault?.id ??
      null,
    pluginId,
  );
}

/** Creates the remote vault `name` without connecting to it, and returns its id. */
function createRemoteVault(name: string) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      return (await plugin.createRemoteVault(vaultName)).id;
    },
    pluginId,
    name,
  );
}

/** How many revisions the connected vault's log holds at `path`. */
function revisionsAt(path: string) {
  return browser.executeObsidian(
    async ({ app }, id, filePath) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      const vaultId = plugin?.connectedVault?.id;
      if (plugin === undefined || vaultId === undefined)
        throw new Error("vault-sync is not connected");
      const decoder = new TextDecoder();
      return (
        await plugin
          .protocolClient()
          .sync.listChanges({ vaultId, sinceSeq: 0n })
      ).revisions.filter(
        (revision) => decoder.decode(revision.path) === filePath,
      ).length;
    },
    pluginId,
    path,
  );
}

/** The device's files as `serverHeads` shows them: path to content SHA-256. */
function asHeads(files: Record<string, string>): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const [path, value] of Object.entries(files))
    heads[path] = value.startsWith("sha256:") ? value : contentOf(value);
  return heads;
}

describe("a device after a restore from an export", function () {
  let device: Device;
  // The files the test vault starts with.
  let initial: string[];

  before(async function () {
    // The export job runs only on Linux (its atomic directory swap uses
    // renameat2), and the driver runs it on the test host. The Android run
    // skips this spec, as it does the escrow spec's export steps.
    if (e2eEnvironment.android || process.platform !== "linux") this.skip();
    device = await currentDevice("Laptop");
    await configure();
    expect(await signInAs(subject)).toBe(true);
    initial = Object.keys(await vaultFiles());
  });

  it("[P6-03] connects its existing folder to the restored vault and loses nothing", async function () {
    // The device syncs the vault that is later lost.
    expect(await connect(lostVault, true)).toBe("connected");
    await writeNote(identical, identicalText);
    await writeNote(edited, exportedText);
    const pictureHash = await writeBinary(picture, 64 * 1024 + 5, 0x1f2e3d4c);
    await browser.waitUntil(
      async () => {
        const heads = await serverHeads();
        return [identical, edited, picture, ...initial].every(
          (path) => path in heads,
        );
      },
      {
        timeoutMsg: `the files never reached the server: ${JSON.stringify(await serverHeads())}`,
      },
    );
    await waitForIdle(device);
    const lostId = await connectedVaultId();
    if (lostId === null) throw new Error("the device is not connected");

    // The admin's export job runs.
    const { export: exported } = await admin<{ export: string }>("export");

    // The device goes offline and changes its files after the export.
    await goOffline(device);
    await writeNote(edited, editedText);
    await writeNote(localOnly, localOnlyText);

    // The vault is lost, and the admin restores the export into a new, empty vault.
    const restoredId = await createRemoteVault(restoredVault);
    const restore = await admin<{ code: number; report: RestoreReport }>(
      "restore",
      {
        export: exported,
        sourceVault: lostId,
        targetVault: restoredId,
        subject,
      },
    );
    expect(restore.report.status).toBe("ok");
    expect(restore.code).toBe(0);

    // The device connects its existing folder to the restored vault.
    await use(device);
    expect(await connect(restoredVault, false)).toBe("connected");
    expect(await connectedVaultId()).toBe(restoredId);

    // Wait until the device and the restored vault hold the same files.
    let files: Record<string, string> = {};
    await browser
      .waitUntil(async () => {
        await waitForIdle(device);
        files = await vaultFiles();
        return (
          JSON.stringify(Object.entries(asHeads(files)).sort()) ===
          JSON.stringify(Object.entries(await serverHeads()).sort())
        );
      })
      .catch(async () => {
        throw new Error(
          `the device and the restored vault never held the same files: ${JSON.stringify({ device: files, server: await serverHeads() })}`,
        );
      });

    // The identical files are matched with no change: no copy, and no new revision on top of the restored one.
    expect(files[identical]).toBe(identicalText);
    expect(files[picture]).toBe(pictureHash);
    expect(await revisionsAt(identical)).toBe(1);
    expect(await revisionsAt(picture)).toBe(1);

    // The local-only file is uploaded.
    expect(files[localOnly]).toBe(localOnlyText);

    // The edited file is kept: the device's text is at its path (merged) or in a conflict copy beside it.
    const copies = conflictCopies(files);
    expect(
      copies.every((copy) => copy.startsWith("Edited (Conflicted copy ")),
    ).toBe(true);
    const editedVersions = [edited, ...copies].map((path) => files[path]);
    expect(
      editedVersions.some((text) =>
        text?.includes("A line the device wrote after the export."),
      ),
    ).toBe(true);

    // Nothing else came or went: the device holds its files, plus at most the conflict copy of the edited file.
    expect(
      Object.keys(files)
        .filter((path) => !copies.includes(path))
        .sort(),
    ).toEqual([...initial, picture, edited, identical, localOnly].sort());
  });
});
