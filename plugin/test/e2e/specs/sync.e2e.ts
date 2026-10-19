import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { reloadPlugin } from "../obsidian";
import { configure, dialog, isDialogOpen, issuerPost, signInAs, signInResult, startSignIn } from "../signin";

// Sync end to end (#25): two Obsidian vaults, each signed in with the device
// flow, connected to one server vault on the harness-started server. A file
// written in the first arrives in the second. The vault is created by its
// own user (`subject`), so the sign-in spec's user still has no vault.

const subject = "plugin-e2e-sync-user";
const remoteVaultName = "e2e two vaults";
const sharedText = "written in the primary vault\n";
// An attachment larger than two upload chunks and download ranges (768 KiB
// each by default, less for JSON clients), and not a multiple of either, so
// both are split and the last piece is a short one.
const attachmentPath = "Attachments/Photo.jpg";
const attachmentSize = 2 * 768 * 1024 + 12_345;

/** The plugin's sync status, connected vault and stored device. */
function syncState() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    const path = `${plugin.manifest.dir ?? ""}/data.json`;
    const stored = (await app.vault.adapter.exists(path)) ? (JSON.parse(await app.vault.adapter.read(path)) as { device?: { id?: string } }) : {};
    return {
      status: plugin.syncStatus,
      vault: plugin.connectedVault?.name ?? null,
      storedDeviceId: stored.device?.id ?? null,
      statusBar: document.querySelector(".vault-sync-status")?.textContent ?? null,
    };
  }, pluginId);
}

/** Creates the remote vault and connects this vault to it, or connects to the existing one; `confirmed` answers the non-empty warning. */
function connect(name: string, options: { create: boolean; confirmed: boolean }) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName, { create, confirmed }) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      const vault = create ? await plugin.createRemoteVault(vaultName) : (await plugin.listRemoteVaults()).find((candidate) => candidate.name === vaultName);
      if (vault === undefined) throw new Error(`no remote vault named ${vaultName}`);
      return await plugin.connectVault(vault, confirmed);
    },
    pluginId,
    name,
    options,
  );
}

/** The server's live paths in the connected vault, and the devices that committed them, read through the plugin's client. */
function remoteFiles() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    const vaultId = plugin?.connectedVault?.id;
    if (plugin === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
    const response = await plugin.protocolClient().sync.listChanges({ vaultId, sinceSeq: 0n });
    const decoder = new TextDecoder();
    return response.revisions.map((revision) => ({ path: decoder.decode(revision.path), deviceId: revision.deviceId })).sort((a, b) => a.path.localeCompare(b.path));
  }, pluginId);
}

function fileText(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    return file === null ? null : app.vault.read(file);
  }, path);
}

/**
 * Whether vault-sync's settings tab shows the server, issuer and client id
 * fields disabled. `display` builds the tab first, as opening it does; later
 * reads see what the plugin itself re-rendered.
 */
function settingsFieldsDisabled(display = false) {
  return browser.executeObsidian(
    ({ app }, id, build) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      const tab = (plugin as unknown as { settingTab?: { containerEl: HTMLElement; display(): void } } | undefined)?.settingTab;
      if (tab === undefined) throw new Error("vault-sync has no settings tab");
      if (build) tab.display();
      // Server URL, OIDC issuer URL, OIDC client ID: the first three text fields.
      return [...tab.containerEl.querySelectorAll<HTMLInputElement>("input[type=text]")].slice(0, 3).map((input) => input.disabled);
    },
    pluginId,
    display,
  );
}

/** Writes `size` pseudo-random (incompressible) bytes at `path`, creating its folder. */
function writeAttachment(path: string, size: number) {
  return browser.executeObsidian(
    async ({ app }, filePath, length) => {
      const content = new Uint8Array(length);
      let state = 0x9e3779b9;
      for (let index = 0; index < length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        content[index] = state & 0xff;
      }
      const folder = filePath.slice(0, filePath.lastIndexOf("/"));
      if (app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
      await app.vault.createBinary(filePath, content.buffer);
    },
    path,
    size,
  );
}

/** The size and SHA-256 (hex) of the file at `path` as Obsidian reads it, or null if there is none. */
function binaryDigest(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    if (file === null) return null;
    const content = await app.vault.readBinary(file);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
    return { size: content.byteLength, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  }, path);
}

async function waitForIdle(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const { status } = await syncState();
      return status.state === "idle" && status.pending === 0;
    },
    { timeoutMsg: "sync never became idle" },
  );
}

describe("syncing between two vaults", function () {
  let firstDeviceId: string | null = null;
  let attachmentDigest: Awaited<ReturnType<typeof binaryDigest>> = null;

  it("locks the server and identity provider settings while a sign-in runs", async function () {
    await configure();
    expect(await settingsFieldsDisabled(true)).toEqual([false, false, false]);

    await startSignIn();
    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    // Still signed out, but the device flow has captured these settings.
    expect(await settingsFieldsDisabled()).toEqual([true, true, true]);

    expect(await issuerPost("/device/approve", { user_code: (await dialog())?.userCode ?? "", subject })).toBe(204);
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });
    expect(await signInResult()).toBe(true);
    await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the sign-in dialog stayed open" });
    // Signed in: still locked.
    expect(await settingsFieldsDisabled()).toEqual([true, true, true]);
  });

  it("creates a remote vault from the primary vault and pushes its files", async function () {
    expect((await syncState()).status.state).toBe("not-connected");

    // The remote vault is empty, so the primary vault's file needs no warning.
    expect(await connect(remoteVaultName, { create: true, confirmed: false })).toBe("connected");
    await browser.executeObsidian(async ({ app }, text) => {
      await app.vault.create("Shared.md", text);
    }, sharedText);

    await browser.waitUntil(async () => (await remoteFiles()).some((file) => file.path === "Shared.md"), { timeoutMsg: "Shared.md never reached the server" });
    await waitForIdle();
    const state = await syncState();
    expect(state.vault).toBe(remoteVaultName);
    firstDeviceId = state.storedDeviceId;
    expect(firstDeviceId).not.toBeNull();
    // Every commit carries this install's registered device.
    expect(await remoteFiles()).toEqual([
      { path: "Primary vault.md", deviceId: firstDeviceId },
      { path: "Shared.md", deviceId: firstDeviceId },
    ]);
    if (!e2eEnvironment.emulateMobile) expect(state.statusBar).toBe("Vault Sync: idle");
  });

  it("pushes an attachment larger than one upload chunk", async function () {
    await writeAttachment(attachmentPath, attachmentSize);
    attachmentDigest = await binaryDigest(attachmentPath);
    expect(attachmentDigest?.size).toBe(attachmentSize);

    await browser.waitUntil(async () => (await remoteFiles()).some((file) => file.path === attachmentPath), { timeoutMsg: "the attachment never reached the server" });
    await waitForIdle();
    expect(await remoteFiles()).toContainEqual({ path: attachmentPath, deviceId: firstDeviceId });
  });

  it("keeps its device registration and resumes sync after a plugin reload", async function () {
    expect(await reloadPlugin(pluginId)).toBe(true);

    await waitForIdle();
    expect((await syncState()).storedDeviceId).toBe(firstDeviceId);
  });

  it("brings the file to a second vault, after warning that both vaults have files", async function () {
    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });
    await configure();
    expect(await signInAs(subject)).toBe(true);

    // Both sides have files: connecting needs the user's confirmation, and nothing starts without it.
    expect(await connect(remoteVaultName, { create: false, confirmed: false })).toBe("needs-confirmation");
    expect((await syncState()).status.state).toBe("not-connected");
    expect(await connect(remoteVaultName, { create: false, confirmed: true })).toBe("connected");

    await browser.waitUntil(async () => (await fileText("Shared.md")) === sharedText, { timeoutMsg: "Shared.md never arrived in the second vault" });
    expect(await fileText("Primary vault.md")).not.toBeNull();
    await waitForIdle();

    // The second vault is another install: a device of its own, and its own file is pushed with it.
    const state = await syncState();
    expect(state.storedDeviceId).not.toBeNull();
    expect(state.storedDeviceId).not.toBe(firstDeviceId);
    expect(await remoteFiles()).toEqual([
      { path: attachmentPath, deviceId: firstDeviceId },
      { path: "Primary vault.md", deviceId: firstDeviceId },
      { path: "Second vault.md", deviceId: state.storedDeviceId },
      { path: "Shared.md", deviceId: firstDeviceId },
    ]);
  });

  it("brings the attachment to the second vault byte for byte", async function () {
    expect(attachmentDigest).not.toBeNull();
    await browser.waitUntil(async () => (await binaryDigest(attachmentPath))?.sha256 === attachmentDigest?.sha256, { timeoutMsg: "the attachment never arrived whole in the second vault" });
    expect(await binaryDigest(attachmentPath)).toEqual(attachmentDigest);
  });
});
