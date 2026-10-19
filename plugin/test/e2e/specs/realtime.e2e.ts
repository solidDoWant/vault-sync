import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// The realtime channel end to end (#193): with vault-sync's pull timer off,
// a note another device commits must still arrive, because the server
// notifies this device over the WebSocket and it pulls. The vault and its
// user are this spec's own.

const subject = "plugin-e2e-realtime-user";
const remoteVaultName = "e2e realtime";

function fileText(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    return file === null ? null : app.vault.read(file);
  }, path);
}

function syncStatus() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    return plugin.syncStatus;
  }, pluginId);
}

describe("the realtime channel", function () {
  it("brings another device's change without the pull timer", async function () {
    await configure();
    expect(await signInAs(subject)).toBe(true);
    await callHarness("disablePullTimer");

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
    await browser.waitUntil(
      async () => {
        const status = await syncStatus();
        return status.state === "idle" && status.pending === 0;
      },
      { timeoutMsg: "sync never became idle" },
    );

    // After the session's first pull: only a notification (or the
    // subscribe's own pull, if the subscription is not set up yet) brings it.
    await callHarness("commitFromAnotherDevice", "From the laptop.md", "committed on another device\n");
    await browser.waitUntil(async () => (await fileText("From the laptop.md")) === "committed on another device\n", {
      timeoutMsg: "the other device's note never arrived",
    });

    // The subscription is certainly up now: this one arrives on its notification.
    await callHarness("commitFromAnotherDevice", "Second note.md", "and another one\n");
    await browser.waitUntil(async () => (await fileText("Second note.md")) === "and another one\n", {
      timeoutMsg: "the second note never arrived",
    });
  });
});
