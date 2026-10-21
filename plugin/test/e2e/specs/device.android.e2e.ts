import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// Device checks of docs/testing/android.md that only a real Android device
// can make (sections 4, 5, 6 and 9), on the real Obsidian Android app in the
// emulator: the process killed mid-sync, the app sent to the background and
// its activity destroyed, and the network cut. Only wdio.android.conf.mts
// runs this file (wdio.conf.mts excludes `*.android.e2e.ts`). The spec
// drives the device with adb from Node, outside the app.
//
// The plugin reaches the server over the emulator's own network (10.0.2.2,
// the host's loopback), not through `adb reverse` as the other specs do:
// adb's traffic bypasses the device's network, so airplane mode would not
// cut it. The fake issuer stays on `adb reverse`; nothing here refreshes a
// token while the network is off.
//
// The tests share one sign-in and one connected vault, and run in order.

const subject = "plugin-e2e-android-device-user";
const remoteVaultName = "e2e android device";
const appId = "md.obsidian";
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const adb = process.env.ANDROID_HOME === undefined ? "adb" : path.join(process.env.ANDROID_HOME, "platform-tools", "adb");
const webview = `WEBVIEW_${appId}`;

/** The harness-started server as the emulator's own network reaches it. */
const serverOverDeviceNetwork = (() => {
  const url = new URL(e2eEnvironment.serverUrl);
  url.hostname = "10.0.2.2";
  return url.toString().replace(/\/$/, "");
})();

function shell(...args: string[]): string {
  return execFileSync(adb, ["-s", serial, "shell", ...args], { encoding: "utf8", timeout: 60_000 });
}

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

async function waitForIdle(timeoutMsg: string, timeout = 120_000) {
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
      if (file === null) await app.vault.create(filePath, content);
      else await app.vault.modify(file, content);
    },
    path,
    text,
  );
}

/** Each live path on the server with its content's SHA-256 (the newest revision of each document). */
function liveServerFiles(revisions: Awaited<ReturnType<typeof serverRevisions>>): Record<string, string> {
  const heads = new Map<string, { path: string; deleted: boolean; sha256: string }>();
  for (const revision of revisions) heads.set(revision.documentId, revision);
  const live: Record<string, string> = {};
  for (const head of heads.values()) if (!head.deleted) live[head.path] = head.sha256;
  return live;
}

function serverRevisions() {
  return callHarness("serverRevisions");
}

/** Sets a marker in the WebView's JavaScript context, which only a recreated WebView (a new Obsidian start) loses. */
function markWebView() {
  return browser.execute(() => {
    (window as unknown as { vaultSyncE2EMarker?: boolean }).vaultSyncE2EMarker = true;
  });
}

function webViewMarked() {
  return browser.execute(() => (window as unknown as { vaultSyncE2EMarker?: boolean }).vaultSyncE2EMarker === true);
}

/**
 * Brings Obsidian to the foreground (starting it if its process is gone)
 * and waits until WebdriverIO is attached to its WebView again, with the
 * vault open and vault-sync loaded.
 */
async function foregroundObsidian() {
  shell("am", "start", "-n", `${appId}/.MainActivity`);
  await browser.switchContext("NATIVE_APP");
  await browser.waitUntil(async () => (await browser.getContexts()).some((context) => (typeof context === "string" ? context : context.id) === webview), {
    timeout: 60_000,
    timeoutMsg: "Obsidian's WebView never came back",
  });
  await browser.switchContext(webview);
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute(
          (id) => {
            const service = (window as unknown as { wdioObsidianService?: unknown }).wdioObsidianService;
            const app = (window as unknown as { app?: { workspace?: { layoutReady?: boolean }; plugins?: { plugins: Record<string, { _loaded?: boolean } | undefined> } } }).app;
            return typeof service === "function" && app?.workspace?.layoutReady === true && app.plugins?.plugins[id]?._loaded === true;
          },
          pluginId,
        );
      } catch {
        // The WebView is still loading, or the attachment is being replaced.
        return false;
      }
    },
    { timeout: 120_000, interval: 500, timeoutMsg: "Obsidian never opened the vault with vault-sync loaded again" },
  );
}

/** Sends Obsidian to the background with the home button. */
function background() {
  shell("input", "keyevent", "KEYCODE_HOME");
}

describe("vault-sync on an Android device", function () {
  before(async function () {
    if (!(await obsidianPage.getPlatform()).isAndroidApp) throw new Error("device.android.e2e.ts runs only on the Android app (wdio.android.conf.mts)");
  });

  after(function () {
    // Leave the emulator as the next spec expects it.
    shell("settings", "put", "global", "always_finish_activities", "0");
    shell("cmd", "connectivity", "airplane-mode", "disable");
  });

  it("resumes a sync after Obsidian's process is killed mid-push, with the vault equal to the server and no duplicate revision (section 5)", async function () {
    await configure(serverOverDeviceNetwork);
    expect(await signInAs(subject)).toBe(true);
    const notes = ["Killed/One.md", "Killed/Two.md", "Killed/Three.md", "Killed/Four.md"];
    for (const note of notes) await writeNote(note, `${note} before the kill\n`);

    // The session the connection starts pushes, and the server answers its
    // first commit, but vault-sync never sees that answer: the push is in
    // progress, with a commit the server holds and the device does not know
    // about, when the process dies.
    await callHarness("loseCommitResponses");
    const connected = await browser.executeObsidian(
      async ({ app }, id, name) => {
        const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
        if (plugin === undefined) throw new Error("vault-sync is not loaded");
        return await plugin.connectVault(await plugin.createRemoteVault(name));
      },
      pluginId,
      remoteVaultName,
    );
    expect(connected).toBe("connected");
    await browser.waitUntil(async () => (await callHarness("answeredCommits")) >= 1, { timeout: 60_000, timeoutMsg: "the session never committed" });
    expect((await syncStatus()).state).toBe("syncing");

    shell("am", "force-stop", appId);
    expect(shell("pidof", appId).trim()).toBe("");
    await foregroundObsidian();

    await waitForIdle("sync never resumed and became idle after the relaunch");
    const local = await callHarness("vaultDigests");
    for (const note of notes) expect(local[note]).toBe(sha256(`${note} before the kill\n`));
    const revisions = await serverRevisions();
    expect(liveServerFiles(revisions)).toEqual(local);
    // Every file was written once, so the server holds one revision of each
    // document and one document per path: the commit answered before the
    // kill was recognized, not committed again.
    expect(revisions.map((revision) => revision.path).sort()).toEqual(Object.keys(local).sort());
    expect(new Set(revisions.map((revision) => revision.documentId)).size).toBe(revisions.length);
  });

  it("pushes an edit made just before Obsidian went to the background, once it is back (section 6)", async function () {
    const note = "Background.md";
    const text = "edited, then switched away\n";
    await markWebView();
    await writeNote(note, text);
    background();
    // The time in the background is the scenario, not a wait for a condition.
    await browser.pause(10_000);
    await foregroundObsidian();
    // Only backgrounded: the same WebView, not a new Obsidian start.
    expect(await webViewMarked()).toBe(true);

    await browser.waitUntil(async () => liveServerFiles(await serverRevisions())[note] === sha256(text), {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: "the edit never reached the server",
    });
    expect((await callHarness("vaultDigests"))[note]).toBe(sha256(text));
  });

  it("keeps and pushes an edit when Android destroys the activity on the switch (\"Don't keep activities\", section 6)", async function () {
    shell("settings", "put", "global", "always_finish_activities", "1");
    const note = "Destroyed activity.md";
    const text = "edited, then the activity was destroyed\n";
    await markWebView();
    await writeNote(note, text);
    background();
    await foregroundObsidian();
    // The activity, and with it the WebView, was destroyed and Obsidian
    // started again: the scenario really happened.
    expect(await webViewMarked()).toBe(false);

    await browser.waitUntil(async () => liveServerFiles(await serverRevisions())[note] === sha256(text), {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: "the edit never reached the server",
    });
    expect((await callHarness("vaultDigests"))[note]).toBe(sha256(text));
    shell("settings", "put", "global", "always_finish_activities", "0");
  });

  it("reports offline while the network is cut and pushes the edits made meanwhile once it is back (sections 4 and 9)", async function () {
    await waitForIdle("sync was not idle before the network was cut");
    const edited = "Killed/One.md";
    const created = "Offline.md";
    const editedText = "edited in airplane mode\n";
    const createdText = "created in airplane mode\n";

    shell("cmd", "connectivity", "airplane-mode", "enable");
    await writeNote(edited, editedText);
    await writeNote(created, createdText);
    await browser.waitUntil(async () => (await syncStatus()).state === "offline", {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: "the status never went offline with the network cut",
    });
    const offline = await syncStatus();
    expect(offline.pending).toBeGreaterThan(0);
    const local = await callHarness("vaultDigests");
    expect(local[edited]).toBe(sha256(editedText));
    expect(local[created]).toBe(sha256(createdText));

    shell("cmd", "connectivity", "airplane-mode", "disable");
    await waitForIdle("sync never became idle after the network came back");
    const after = liveServerFiles(await serverRevisions());
    expect(after[edited]).toBe(sha256(editedText));
    expect(after[created]).toBe(sha256(createdText));
    expect(after).toEqual(await callHarness("vaultDigests"));
  });
});
