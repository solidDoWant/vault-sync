import { createHash } from "node:crypto";

import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// Robustness against the harness-started server: Obsidian killed mid-upload
// and mid-download, and the server unreachable for a while. Killing is
// `reloadObsidian()` without a vault, which ends Obsidian's session (its
// process) and starts it again on the same vault and profile, so the
// journal survives as it does when the app is killed. Its own user and
// remote vault, so the other specs' vaults are untouched. The tests share
// the vault and run in order.

const subject = "plugin-e2e-robustness-user";
const remoteVaultName = "e2e robustness";
const notes = ["Killed/One.md", "Killed/Two.md", "Killed/Three.md", "Killed/Four.md"];
// Larger than two download ranges, so it is downloaded in several calls.
const attachmentPath = "Attachments/Large.bin";
const attachmentSize = 2 * 768 * 1024 + 4_321;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function syncStatus() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    return { ...plugin.syncStatus, statusBar: document.querySelector(".vault-sync-status")?.textContent ?? null };
  }, pluginId);
}

async function waitForIdle(timeoutMsg: string, timeout = 90_000) {
  await browser.waitUntil(
    async () => {
      const status = await syncStatus();
      return status.state === "idle" && status.pending === 0;
    },
    { timeout, interval: 500, timeoutMsg },
  );
}

/** Creates `path` with `text`, or replaces its content, as a user edit lands on disk. */
function writeNote(path: string, text: string) {
  return browser.executeObsidian(
    async ({ app }, filePath, content) => {
      const file = app.vault.getFileByPath(filePath);
      if (file === null) {
        const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
        if (folder !== "" && app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
        await app.vault.create(filePath, content);
      } else await app.vault.modify(file, content);
    },
    path,
    text,
  );
}

/** Writes `size` pseudo-random bytes at `path`, creating its folder, and returns their SHA-256. */
function writeAttachment(path: string, size: number) {
  return browser.executeObsidian(
    async ({ app }, filePath, length) => {
      const content = new Uint8Array(length);
      let state = 0x2545f491;
      for (let index = 0; index < length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        content[index] = state & 0xff;
      }
      const folder = filePath.slice(0, filePath.lastIndexOf("/"));
      if (app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
      await app.vault.createBinary(filePath, content.buffer);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
      return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    path,
    size,
  );
}

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

function serverRevisions() {
  return callHarness("serverRevisions");
}

/** Each live path on the server with its content's SHA-256 (the newest revision of each document). */
function liveServerFiles(revisions: Awaited<ReturnType<typeof serverRevisions>>): Record<string, string> {
  const heads = new Map<string, { path: string; deleted: boolean; sha256: string }>();
  for (const revision of revisions) heads.set(revision.documentId, revision);
  const live: Record<string, string> = {};
  for (const head of heads.values()) if (!head.deleted) live[head.path] = head.sha256;
  return live;
}

/** Kills Obsidian and starts it again on the same vault, and waits until vault-sync is loaded. */
async function killAndRestart() {
  await browser.reloadObsidian();
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }, id) => {
        const plugins = (app as unknown as { plugins: { plugins: Record<string, { _loaded?: boolean } | undefined> } }).plugins.plugins;
        return plugins[id]?._loaded === true;
      }, pluginId),
    { timeoutMsg: "vault-sync never loaded after the restart" },
  );
}

describe("robustness", function () {
  it("[AC-17] resumes a sync after Obsidian is killed mid-upload, with no file lost and no duplicate revision", async function () {
    await configure();
    expect(await signInAs(subject)).toBe(true);
    for (const note of notes) await writeNote(note, `${note} before the kill\n`);

    // The server answers the session's first commit, but vault-sync never
    // sees the answer: the upload is in progress, with a commit the server
    // holds and the device does not know about, when Obsidian is killed.
    await callHarness("loseCommitResponses");
    expect(await connect(remoteVaultName, { create: true, confirmed: false })).toBe("connected");
    await browser.waitUntil(async () => (await callHarness("answeredCommits")) >= 1, { timeoutMsg: "the session never committed" });
    expect((await syncStatus()).state).toBe("syncing");

    await killAndRestart();

    await waitForIdle("sync never resumed and became idle after the restart");
    const local = await callHarness("vaultDigests");
    for (const note of notes) expect(local[note]).toBe(sha256(`${note} before the kill\n`));
    const revisions = await serverRevisions();
    expect(liveServerFiles(revisions)).toEqual(local);
    // Every file was written once: one revision per document and one
    // document per path, so the commit answered before the kill was not
    // committed again.
    expect(revisions.map((revision) => revision.path).sort()).toEqual(Object.keys(local).sort());
    expect(new Set(revisions.map((revision) => revision.documentId)).size).toBe(revisions.length);
  });

  it("[AC-18] works locally and shows offline while the server is unreachable, and catches up once it is back", async function () {
    await callHarness("installServerSwitch");
    await waitForIdle("sync was not idle before the server went away");
    const edited = "Killed/One.md";
    const created = "Offline.md";
    const editedText = "edited while the server was unreachable\n";
    const createdText = "created while the server was unreachable\n";

    await callHarness("setServerReachable", false);
    try {
      await writeNote(edited, editedText);
      await writeNote(created, createdText);
      let last: Awaited<ReturnType<typeof syncStatus>> | undefined;
      await browser
        .waitUntil(async () => (last = await syncStatus()).state === "offline", { timeout: 90_000, interval: 500 })
        .catch(() => {
          throw new Error(`the status never went offline; last status: ${JSON.stringify(last)}`);
        });
      const offline = await syncStatus();
      expect(offline.pending).toBeGreaterThan(0);
      if (!e2eEnvironment.emulateMobile) expect(offline.statusBar).toContain("offline");
      // The vault works as usual: the edits are on disk and can be read back.
      const local = await callHarness("vaultDigests");
      expect(local[edited]).toBe(sha256(editedText));
      expect(local[created]).toBe(sha256(createdText));
    } finally {
      await callHarness("setServerReachable", true);
    }

    await waitForIdle("sync never caught up after the server came back");
    const after = liveServerFiles(await serverRevisions());
    expect(after[edited]).toBe(sha256(editedText));
    expect(after[created]).toBe(sha256(createdText));
    expect(after).toEqual(await callHarness("vaultDigests"));
  });

  it("[AC-17] leaves no half-written file when Obsidian is killed mid-download, and downloads it whole on the next start", async function () {
    const digest = await writeAttachment(attachmentPath, attachmentSize);
    await browser.waitUntil(async () => liveServerFiles(await serverRevisions())[attachmentPath] === digest, { timeoutMsg: "the attachment never reached the server" });
    await waitForIdle("sync was not idle after the attachment upload");

    // A second device: its download of the attachment stops after the first range.
    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });
    await configure();
    expect(await signInAs(subject)).toBe(true);
    await callHarness("holdDownloadOf", digest);
    expect(await connect(remoteVaultName, { create: false, confirmed: true })).toBe("connected");
    await browser.waitUntil(async () => (await callHarness("heldDownloads")) >= 1, { timeoutMsg: "the attachment's download never reached its second range" });
    expect((await callHarness("vaultDigests"))[attachmentPath]).toBeUndefined();

    await killAndRestart();

    // Nothing half-written at any point: the file is absent or whole.
    await browser.waitUntil(
      async () => {
        const local = (await callHarness("vaultDigests"))[attachmentPath];
        if (local !== undefined && local !== digest) throw new Error(`the attachment is on disk with other content (SHA-256 ${local})`);
        return local === digest;
      },
      { timeout: 90_000, timeoutMsg: "the attachment never arrived after the restart" },
    );
    await waitForIdle("sync never became idle after the restart");
    const revisions = await serverRevisions();
    expect(revisions.filter((revision) => revision.path === attachmentPath)).toHaveLength(1);
    expect(liveServerFiles(revisions)).toEqual(await callHarness("vaultDigests"));
  });
});
