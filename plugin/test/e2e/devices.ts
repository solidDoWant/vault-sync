import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { browser } from "@wdio/globals";

import { DocumentKind } from "../../src/gen/vaultsync/v1/types_pb";
import type VaultSyncPlugin from "../../src/main";
import { pluginId } from "./environment";
import { callHarness } from "./obsidian";
import { configure, signInAs } from "./signin";

// Two devices in one Obsidian. `reloadObsidian({ vault })` relaunches Obsidian
// with a fresh profile, which would drop the first vault's IndexedDB journal
// on every switch, so a device could never hold an unsynced edit across one.
// Instead the second device is a second vault opened in its own window of the
// same Obsidian, as "Open another vault" does: both run at once, each with
// its own vault-sync and journal (keyed by the vault's id).

/** A device: the WebDriver handle of its Obsidian window. */
export interface Device {
  name: string;
  handle: string;
}

/** The device whose window WebDriver drives now. */
export async function currentDevice(name: string): Promise<Device> {
  return { name, handle: await browser.getWindowHandle() };
}

/** Points every later `executeObsidian` at `device`'s window. */
export async function use(device: Device): Promise<void> {
  await browser.switchToWindow(device.handle);
}

/**
 * Opens a copy of the vault at `source` as a second device, in a new window
 * of this Obsidian, with the same plugins as the current vault (vault-sync
 * without its stored settings, the harness and wdio's helper), and switches
 * to it.
 */
export async function openSecondDevice(name: string, source: string): Promise<Device> {
  const firstBase = await callHarness("vaultBasePath");
  if (firstBase === null) throw new Error("the current vault has no base path");
  const before = await browser.getWindowHandles();

  const vault = await mkdtemp(path.join(tmpdir(), "vault-sync-e2e-device-"));
  await cp(path.resolve(source), vault, { recursive: true });
  await cp(path.join(firstBase, ".obsidian"), path.join(vault, ".obsidian"), {
    recursive: true,
  });
  await rm(path.join(vault, ".obsidian", "plugins", pluginId, "data.json"), {
    force: true,
  });
  await rm(path.join(vault, ".obsidian", "workspace.json"), { force: true });

  const opened = await browser.execute((vaultPath) => {
    const electron = (
      window as unknown as {
        electron: {
          ipcRenderer: {
            sendSync(channel: string, ...args: unknown[]): unknown;
          };
        };
      }
    ).electron;
    return electron.ipcRenderer.sendSync("vault-open", vaultPath, false);
  }, vault);
  if (opened !== true) throw new Error(`Obsidian did not open the second vault: ${String(opened)}`);

  let handle: string | undefined;
  await browser.waitUntil(
    async () => {
      handle = (await browser.getWindowHandles()).find((candidate) => !before.includes(candidate));
      return handle !== undefined;
    },
    { timeoutMsg: "the second vault's window never opened" },
  );
  if (handle === undefined) throw new Error("unreachable");
  const device = { name, handle };
  await use(device);

  // Community plugins start off in a vault Obsidian has not seen ("restricted
  // mode"): turn them on for this vault's id, as the launcher does for the
  // first, and load the window again so they load.
  await browser.waitUntil(async () => await browser.execute(() => (window as unknown as { app?: { appId?: string } }).app?.appId !== undefined), {
    timeoutMsg: "the second vault never started",
  });
  await browser.execute(() => {
    const app = (window as unknown as { app: { appId: string } }).app;
    localStorage.setItem(`enable-plugin-${app.appId}`, "true");
    window.location.reload();
  });
  await browser.waitUntil(
    async () =>
      await browser.execute((id) => {
        const app = (
          window as unknown as {
            app?: { plugins?: { plugins: Record<string, unknown> } };
            wdioObsidianService?: unknown;
          }
        ).app;
        return app?.plugins?.plugins[id] !== undefined && (window as unknown as { wdioObsidianService?: unknown }).wdioObsidianService !== undefined;
      }, pluginId),
    { timeoutMsg: "vault-sync never loaded in the second vault" },
  );
  return device;
}

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

/** Creates the remote vault and connects the current device to it, or connects to the existing one, past the non-empty warning. */
export function connect(name: string, create: boolean) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName, creating) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      const vault = creating ? await plugin.createRemoteVault(vaultName) : (await plugin.listRemoteVaults()).find((candidate) => candidate.name === vaultName);
      if (vault === undefined) throw new Error(`no remote vault named ${vaultName}`);
      return await plugin.connectVault(vault, true);
    },
    pluginId,
    name,
    create,
  );
}

/**
 * Takes `device` offline: vault-sync stops syncing (the vault is
 * disconnected) and keeps its journal, so its edits stay local until
 * `goOnline` connects it again and it resumes where it left off.
 */
export async function goOffline(device: Device): Promise<void> {
  await waitForIdle(device);
  await browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    await plugin.disconnectVault();
  }, pluginId);
}

export async function goOnline(device: Device, vaultName: string): Promise<void> {
  await use(device);
  if ((await connect(vaultName, false)) !== "connected") throw new Error(`${device.name} did not connect again`);
}

/** Signs `device` in as `subject` and connects it to the remote vault `vaultName`, creating it if `create`. */
export async function setUpDevice(device: Device, subject: string, vaultName: string, create: boolean): Promise<void> {
  await use(device);
  await configure();
  if ((await signInAs(subject)) !== true) throw new Error(`${device.name} did not sign in`);
  if ((await connect(vaultName, create)) !== "connected") throw new Error(`${device.name} did not connect`);
}

/** The current device's files outside the config folder, each with its text (Markdown) or SHA-256 (anything else). */
export function vaultFiles() {
  return browser.executeObsidian(async ({ app }) => {
    const files: Record<string, string> = {};
    for (const file of app.vault.getFiles()) {
      if (file.extension === "md") {
        files[file.path] = await app.vault.read(file);
      } else {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await app.vault.readBinary(file)));
        files[file.path] = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      }
    }
    return files;
  });
}

/** The current device's folders, without the vault root. */
export function vaultFolders() {
  return browser.executeObsidian(({ app }) =>
    app.vault
      .getAllFolders(false)
      .map((folder) => folder.path)
      .sort(),
  );
}

/** The text of the note at `path` on the current device, or null if there is none. */
export function fileText(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    return file === null ? null : app.vault.read(file);
  }, path);
}

/** Creates the note at `path` with `text`, or replaces its text, on the current device, creating its folders. */
export function writeNote(path: string, text: string) {
  return browser.executeObsidian(
    async ({ app }, filePath, content) => {
      const file = app.vault.getFileByPath(filePath);
      if (file !== null) {
        await app.vault.modify(file, content);
        return;
      }
      const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
      if (folder !== "" && app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
      await app.vault.create(filePath, content);
    },
    path,
    text,
  );
}

/** Writes `size` pseudo-random bytes from `seed` at `path` on the current device (creating or replacing the file) and returns their SHA-256 as `vaultFiles` shows it. */
export function writeBinary(path: string, size: number, seed: number) {
  return browser.executeObsidian(
    async ({ app }, filePath, length, start) => {
      const content = new Uint8Array(length);
      let state = start;
      for (let index = 0; index < length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        content[index] = state & 0xff;
      }
      const file = app.vault.getFileByPath(filePath);
      if (file !== null) {
        await app.vault.modifyBinary(file, content.buffer);
      } else {
        const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
        if (folder !== "" && app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
        await app.vault.createBinary(filePath, content.buffer);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
      return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    },
    path,
    size,
    seed,
  );
}

/** Renames or moves the file or folder at `from` to `to` on the current device, as the file explorer does. */
export function renamePath(from: string, to: string) {
  return browser.executeObsidian(
    async ({ app }, source, target) => {
      const item = app.vault.getAbstractFileByPath(source);
      if (item === null) throw new Error(`${source} does not exist`);
      const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
      if (folder !== "" && app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
      await app.fileManager.renameFile(item, target);
    },
    from,
    to,
  );
}

/** Deletes the file or folder (with everything in it) at `path` on the current device. */
export function deletePath(path: string) {
  return browser.executeObsidian(async ({ app }, target) => {
    const item = app.vault.getAbstractFileByPath(target);
    if (item === null) throw new Error(`${target} does not exist`);
    await app.vault.delete(item, true);
  }, path);
}

export function syncStatus() {
  return browser.executeObsidian(({ app }, id) => (app as unknown as Plugins).plugins.plugins[id]?.syncStatus ?? null, pluginId);
}

export async function waitForIdle(device: Device): Promise<void> {
  await use(device);
  await browser.waitUntil(
    async () => {
      const status = await syncStatus();
      return status?.state === "idle" && status.pending === 0;
    },
    {
      timeoutMsg: `sync never became idle on ${device.name}: ${JSON.stringify(await syncStatus())}`,
    },
  );
}

/** Waits until `device` holds `text` at `path` (null: no file there). */
export async function waitForText(device: Device, path: string, text: string | null): Promise<void> {
  await use(device);
  await browser.waitUntil(async () => (await fileText(path)) === text, {
    timeoutMsg: `${path} on ${device.name} never became ${JSON.stringify(text)}, it is ${JSON.stringify(await fileText(path))}`,
  });
}

/** Waits until `device`'s files (see `vaultFiles`) satisfy `check`. */
export async function waitForFiles(device: Device, check: (files: Record<string, string>) => boolean, what: string): Promise<void> {
  await use(device);
  await browser.waitUntil(async () => check(await vaultFiles()), {
    timeoutMsg: `${what} never held on ${device.name}: ${JSON.stringify(await vaultFiles())}`,
  });
}

/**
 * Waits until both devices are idle with the same files and folders, and
 * returns those files. A device that receives a change becomes idle only
 * after it applied it, so this waits on the files, then on idle again.
 */
export async function converged(first: Device, second: Device): Promise<Record<string, string>> {
  let files: Record<string, string> = {};
  let seen = "";
  const wait = browser.waitUntil(
    async () => {
      await waitForIdle(first);
      const firstFiles = await vaultFiles();
      const firstFolders = await vaultFolders();
      await waitForIdle(second);
      const secondFiles = await vaultFiles();
      const secondFolders = await vaultFolders();
      files = firstFiles;
      seen = JSON.stringify({
        [first.name]: {
          files: Object.keys(firstFiles).sort(),
          folders: firstFolders,
        },
        [second.name]: {
          files: Object.keys(secondFiles).sort(),
          folders: secondFolders,
        },
      });
      return JSON.stringify(sorted(firstFiles)) === JSON.stringify(sorted(secondFiles)) && JSON.stringify(firstFolders) === JSON.stringify(secondFolders);
    },
    { timeoutMsg: `${first.name} and ${second.name} never converged` },
  );
  await wait.catch((error: unknown) => {
    throw new Error(`${String(error)}: ${seen}`);
  });
  return files;
}

function sorted(files: Record<string, string>): [string, string][] {
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}

/** The paths among `files` that are conflict copies (engine.md §5, rule C). */
export function conflictCopies(files: Record<string, string>): string[] {
  return Object.keys(files).filter((path) => path.includes(" (Conflicted copy "));
}

/** A note's text as `serverHeads` shows it: its SHA-256. */
export function contentOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The server's live file documents in the connected vault (not folder documents), path to content SHA-256 (as `vaultFiles` shows binaries), read through the current device's client. */
export function serverHeads() {
  return browser.executeObsidian(async ({ app }, id, folderKind) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    const vaultId = plugin?.connectedVault?.id;
    if (plugin === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
    const decoder = new TextDecoder();
    const heads = new Map<string, { path: string; deleted: boolean; seq: bigint; hash: string }>();
    for (const revision of (await plugin.protocolClient().sync.listChanges({ vaultId, sinceSeq: 0n })).revisions) {
      // A folder has no content.
      if (revision.kind === folderKind) continue;
      const head = heads.get(revision.documentId);
      if (head !== undefined && revision.seq <= head.seq) continue;
      const blobId = revision.contentRef?.blobId ?? new Uint8Array();
      heads.set(revision.documentId, {
        path: decoder.decode(revision.path),
        deleted: revision.deleted,
        seq: revision.seq,
        hash: [...blobId].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
    }
    const live: Record<string, string> = {};
    for (const head of heads.values()) if (!head.deleted) live[head.path] = `sha256:${head.hash}`;
    return live;
  }, pluginId, DocumentKind.FOLDER);
}

/** Waits until the server's live documents, read from `device`, satisfy `check`: a change made there has been committed. */
export async function waitForServer(device: Device, check: (heads: Record<string, string>) => boolean, what: string): Promise<void> {
  await use(device);
  await browser.waitUntil(async () => check(await serverHeads()), {
    timeoutMsg: `${what} never reached the server from ${device.name}`,
  });
}

/**
 * Starts recording, in `device`'s window, what vault-sync sees and does: the
 * vault's file events, every sync status it shows, the window's visibility
 * and vault-sync's debug lines, each with its time. `syncRecording` returns
 * the record; a later call starts it over.
 */
export async function startSyncRecording(device: Device): Promise<void> {
  await use(device);
  await browser.executeObsidian(({ app }, id) => {
    const state = window as unknown as { vaultSyncRecording?: string[] };
    const installed = state.vaultSyncRecording !== undefined;
    state.vaultSyncRecording = [];
    const note = (what: string) => {
      state.vaultSyncRecording?.push(`${new Date().toISOString()} ${what}`);
    };
    note(`visibility ${document.visibilityState}`);
    if (installed) return;
    app.vault.on("create", (file) => {
      note(`vault create ${file.path}`);
    });
    app.vault.on("modify", (file) => {
      note(`vault modify ${file.path}`);
    });
    app.vault.on("delete", (file) => {
      note(`vault delete ${file.path}`);
    });
    app.vault.on("rename", (file, oldPath) => {
      note(`vault rename ${oldPath} -> ${file.path}`);
    });
    document.addEventListener("visibilitychange", () => {
      note(`visibility ${document.visibilityState}`);
    });
    const plugin = (app as unknown as { plugins: { plugins: Record<string, { showStatus(status: unknown): void } | undefined> } }).plugins.plugins[id];
    if (plugin !== undefined) {
      const show = plugin.showStatus.bind(plugin);
      plugin.showStatus = (status) => {
        note(`status ${JSON.stringify(status)}`);
        show(status);
      };
    }
    const debug = console.debug.bind(console);
    console.debug = (...args: unknown[]) => {
      note(`debug ${args.map(String).join(" ")}`);
      debug(...args);
    };
  }, pluginId);
}

/** What `startSyncRecording` recorded on `device` so far, one line per entry. */
export async function syncRecording(device: Device): Promise<string> {
  await use(device);
  const lines = await browser.executeObsidian(() => (window as unknown as { vaultSyncRecording?: string[] }).vaultSyncRecording ?? []);
  return `${device.name} (now ${new Date().toISOString()}):\n${lines.join("\n")}`;
}
