import { createHash } from "node:crypto";

import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// File names across devices (docs/design/engine.md §6) against the
// harness-started server: unportable names refused with a reason, Unicode
// names stored and delivered in NFC, and long paths: a warning for a new one
// over 200 characters, and a path too long for one device skipped there with
// a notice while it syncs elsewhere. The first device is the primary vault,
// the second the second vault, given Windows' path rules (260 characters,
// its vault folder counted) whatever the host, so a path too long for it is
// one the first device holds. Its own user and remote vault. The tests share
// the vault and run in order.
//
// Each desktop CI runner (Linux, macOS, Windows) runs this spec, so each OS
// both writes and receives these names; the server holds one NFC spelling
// of each, which is what every other OS receives.

const subject = "plugin-e2e-names-user";
const remoteVaultName = "e2e names";
const host = process.platform;

const portable = "Portable after the refused ones.md";
/** Unportable names and the words their reason must hold. The case-only clash is with `clashOriginal`. */
const clashOriginal = "Clash.md";
const unportable = [
  { path: "Pipe|name.md", reason: /must not contain any of < > : " \| \? \*/ },
  { path: "CON.md", reason: /must not be a Windows reserved name/ },
  { path: "Ends in a dot.", reason: /must not end in a dot/ },
  { path: "clash.md", reason: /another live document has this path \(ignoring case/ },
];

/** Unicode names as created, and as the server and the other device must have them (NFC). */
const unicodeNames = [
  { created: "Café composed.md", nfc: "Café composed.md" },
  { created: "Café decomposed.md", nfc: "Café decomposed.md" },
  { created: "日本語のノート.md", nfc: "日本語のノート.md" },
  { created: "Ελληνικά/Σημειώσεις.md", nfc: "Ελληνικά/Σημειώσεις.md" },
  { created: "Party 🎉.md", nfc: "Party 🎉.md" },
];

/** A name written to disk decomposed, past Obsidian's normalization. */
const decomposedOnDisk = { created: "Nai\u0308ve on disk.md", nfc: "Na\u00efve on disk.md" };

const longFolder = "Long paths/";
/** A vault-relative path of exactly `length` UTF-16 code units, in `longFolder`. */
function longPath(length: number, fill: string): string {
  return `${longFolder}${fill.repeat(length - longFolder.length - ".md".length)}.md`;
}
const path200 = longPath(200, "a");
const path201 = longPath(201, "b");
// Within every name and path limit of the portable set, but over Windows'
// 260 characters once a vault folder is counted.
const path250 = longPath(250, "c");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function syncStatus() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    return plugin.syncStatus;
  }, pluginId);
}

async function waitForIdle(timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const status = await syncStatus();
      return status.state === "idle" && status.pending === 0;
    },
    { timeout: 60_000, interval: 500, timeoutMsg },
  );
}

/** Creates `path` with `text` through Obsidian's file adapter, creating its folder, as a file another program wrote. */
function createFile(path: string, text: string) {
  return browser.executeObsidian(
    async ({ app }, filePath, content) => {
      const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
      if (folder !== "" && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
      await app.vault.adapter.write(filePath, content);
    },
    path,
    text,
  );
}

/** Creates a note the way the user does in Obsidian. */
function createNote(path: string, text: string) {
  return browser.executeObsidian(
    async ({ app }, filePath, content) => {
      const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
      if (folder !== "" && app.vault.getFolderByPath(folder) === null) await app.vault.createFolder(folder);
      await app.vault.create(filePath, content);
    },
    path,
    text,
  );
}

function deleteFile(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    await app.vault.adapter.remove(filePath);
  }, path);
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

/** Each live path on the server with its content's SHA-256. */
async function serverFiles(): Promise<Record<string, string>> {
  const heads = new Map<string, { path: string; deleted: boolean; sha256: string }>();
  for (const revision of await callHarness("serverRevisions")) heads.set(revision.documentId, revision);
  const live: Record<string, string> = {};
  for (const head of heads.values()) if (!head.deleted) live[head.path] = head.sha256;
  return live;
}

async function waitForServer(paths: string[], timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const files = await serverFiles();
      return paths.every((path) => path in files);
    },
    { timeout: 60_000, interval: 500, timeoutMsg },
  );
}

describe("file names across devices", function () {
  before(async function () {
    // Android's shared storage has rules of its own (platform.e2e.ts); the
    // emulator job covers the Android scenarios (device.android.e2e.ts).
    if (e2eEnvironment.android) this.skip();
    await configure();
    expect(await signInAs(subject)).toBe(true);
    await createNote(clashOriginal, "the original\n");
    expect(await connect(remoteVaultName, { create: true, confirmed: false })).toBe("connected");
    await waitForServer([clashOriginal], "the first note never reached the server");
    await waitForIdle("sync never became idle after connecting");
  });

  it("[AC-19] refuses unportable names with a clear reason, and keeps syncing the other files", async function () {
    // Windows cannot hold any of these names, and a case-insensitive file
    // system (macOS, Windows) cannot hold two names that differ only by case.
    if (host === "win32") this.skip();
    const names = host === "linux" ? unportable : unportable.filter((name) => name.path !== "clash.md");
    for (const name of names) await createFile(name.path, `${name.path} stays on this device\n`);
    await createNote(portable, "synced although the others were refused\n");

    try {
      await expectRefused(names);
    } finally {
      // Removing them clears the refusals, also for the next tests.
      for (const name of names) await deleteFile(name.path);
    }
    await waitForIdle("sync never became idle once the refused files were gone");
    expect((await callHarness("syncProblems")).refused).toEqual([]);
  });

  async function expectRefused(names: typeof unportable) {
    await waitForServer([portable], "a portable file never reached the server after the refused ones");
    let problems: Awaited<ReturnType<typeof callHarness<"syncProblems">>> | undefined;
    await browser
      .waitUntil(async () => (problems = await callHarness("syncProblems")).refused.length === names.length, { timeout: 60_000, interval: 500 })
      .catch(() => {
        throw new Error(`the refused names never all showed up; last: ${JSON.stringify(problems)}`);
      });
    const refused = (await callHarness("syncProblems")).refused;
    for (const name of names) {
      const entry = refused.find((candidate) => candidate.path === name.path);
      expect(entry?.reason).toMatch(name.reason);
    }
    const status = await syncStatus();
    expect(status.state).toBe("error");
    expect(status.message).toContain("refused");

    // Nothing refused is on the server, the clash's original is untouched, and
    // the files stay on this device.
    const server = await serverFiles();
    for (const name of names) expect(server[name.path]).toBeUndefined();
    expect(server[clashOriginal]).toBe(sha256("the original\n"));
    const local = await callHarness("vaultDigests");
    for (const name of names) expect(local[name.path]).toBe(sha256(`${name.path} stays on this device\n`));
  }

  it("[AC-20] stores Unicode names in NFC", async function () {
    for (const name of unicodeNames) await createFile(name.created, `${name.nfc}\n`);
    // Obsidian's own calls normalize a name to NFC, so the decomposed one is
    // also written to disk as is, as macOS or another program spells it.
    await callHarness("writeFileOnDisk", decomposedOnDisk.created, `${decomposedOnDisk.nfc}\n`);
    await waitForServer(
      [...unicodeNames, decomposedOnDisk].map((name) => name.nfc),
      "the Unicode names never reached the server in NFC",
    );
    await waitForIdle("sync never became idle after the Unicode names");
    const server = await serverFiles();
    for (const name of [...unicodeNames, decomposedOnDisk]) expect(server[name.nfc]).toBe(sha256(`${name.nfc}\n`));
    // No other spelling of any of them.
    expect(Object.keys(server).filter((path) => path !== path.normalize("NFC"))).toEqual([]);
  });

  it("[AC-26] warns about a new path longer than 200 characters", async function () {
    // Windows cannot hold the 250-character path in the vault folder.
    if (host === "win32") this.skip();
    await callHarness("recordNotices");
    await createNote(path200, "200 characters\n");
    await createNote(path201, "201 characters\n");
    await createNote(path250, "250 characters\n");
    await waitForServer([path200, path201, path250], "the long paths never reached the server");
    await waitForIdle("sync never became idle after the long paths");

    const notices = await callHarness("notices");
    const warned = (path: string) => notices.some((notice) => notice.includes(path) && notice.includes("longer than 200 characters"));
    expect(warned(path200)).toBe(false);
    expect(warned(path201)).toBe(true);
    expect(warned(path250)).toBe(true);
  });

  describe("on a second device with Windows' path limit", function () {
    let root: string | null = null;

    before(async function () {
      if (e2eEnvironment.android) this.skip();
      await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });
      await configure();
      expect(await signInAs(subject)).toBe(true);
      await callHarness("recordNotices");
      await callHarness("useWindowsPathRules");
      root = await callHarness("vaultBasePath");
      expect(await connect(remoteVaultName, { create: false, confirmed: true })).toBe("connected");
      await waitForServer(["Second vault.md"], "the second vault's own file never reached the server");
      await browser.waitUntil(async () => portable in (await callHarness("vaultDigests")) || host === "win32", { timeout: 60_000, timeoutMsg: "the first device's files never arrived" });
      await waitForIdle("sync never became idle on the second device");
    });

    it("[AC-20] receives the Unicode names exactly as the server has them", async function () {
      const local = await callHarness("vaultDigests");
      for (const name of [...unicodeNames, decomposedOnDisk]) expect(local[name.nfc]).toBe(sha256(`${name.nfc}\n`));
      expect(Object.keys(local).filter((path) => path !== path.normalize("NFC"))).toEqual([]);
    });

    it("[AC-26] skips a path too long for this device with a notice, while the rest syncs and the server keeps it", async function () {
      if (host === "win32") this.skip();
      expect(root).not.toBeNull();
      // Windows' MAX_PATH: 260 UTF-16 code units with the terminator; the vault folder and a separator count.
      const tooLong = [path200, path201, path250].filter((path) => (root ?? "").length + 1 + path.length > 259);
      expect(tooLong).toContain(path250);

      const local = await callHarness("vaultDigests");
      const server = await serverFiles();
      for (const path of tooLong) {
        expect(local[path]).toBeUndefined();
        expect(server[path]).toBeDefined();
      }
      expect((await callHarness("syncProblems")).skipped).toEqual(tooLong.map((path) => ({ path, reason: "path-too-long" })).sort((a, b) => a.path.localeCompare(b.path)));
      const notices = await callHarness("notices");
      for (const path of tooLong) expect(notices.some((notice) => notice.includes(path) && notice.includes("not synced to this device"))).toBe(true);
      // Everything else arrived.
      const expected = Object.fromEntries(Object.entries(server).filter(([path]) => !tooLong.includes(path)));
      expect(local).toEqual(expected);
    });
  });
});
