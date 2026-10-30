import { browser } from "@wdio/globals";
import path from "node:path";

import type VaultSyncPlugin from "../../../src/main";
import { pluginId } from "../environment";
import { closeSettings, openSettings, type SettingsApp } from "../settings-ui";
import { configure, signInAs } from "../signin";

// Screenshots of vault-sync's settings tab for the user guide
// (docs/user/getting-started.md). Runs only when
// VAULT_SYNC_E2E_SCREENSHOTS_DIR names the output directory
// (scripts/docs-screenshots.sh, `make docs-screenshots`); wdio.conf.mts then
// runs this spec alone. It checks nothing: it only takes pictures.

const outputDir = process.env.VAULT_SYNC_E2E_SCREENSHOTS_DIR ?? "";
const subject = "plugin-e2e-docs-screenshots-user";

/** Creates a vault on the server and connects this vault to it. */
function createAndConnect(name: string) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName) => {
      const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (target === undefined) throw new Error("vault-sync is not loaded");
      const vault = await target.createRemoteVault(vaultName);
      if ((await target.connectVault(vault)) !== "connected") throw new Error("the new vault was not connected");
    },
    pluginId,
    name,
  );
}

function syncState() {
  return browser.executeObsidian(({ app }, id) => {
    const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (target === undefined) throw new Error("vault-sync is not loaded");
    return target.syncStatus.state;
  }, pluginId);
}

/** Saves a screenshot of the settings tab, scrolled to the section `heading` when given. */
async function capture(name: string, heading?: string) {
  const main = await browser.getWindowHandle();
  await openSettings();
  // Lets the tab finish drawing what it loads from the server (vaults, devices).
  await browser.executeObsidian(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  if (heading !== undefined) {
    await browser.executeObsidian(({ app }, wanted) => {
      const items = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll(".setting-item-heading") ?? [];
      const item = [...items].find((candidate) => candidate.querySelector(".setting-item-name")?.textContent === wanted);
      if (item === undefined) throw new Error(`no ${wanted} section`);
      item.scrollIntoView({ block: "start" });
    }, heading);
  }
  // Obsidian opens its settings in a window of their own.
  let settingsWindow: string | undefined;
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle);
    if ((await browser.getTitle()).startsWith("Settings")) settingsWindow = handle;
  }
  await browser.switchToWindow(settingsWindow ?? main);
  await browser.saveScreenshot(path.join(outputDir, `${name}.png`));
  await browser.switchToWindow(main);
  await closeSettings();
}

describe("user guide screenshots", function () {
  before(function () {
    if (outputDir === "") this.skip();
  });

  it("captures the settings tab signed out, and with a vault connected", async function () {
    await configure();
    await capture("settings-signed-out");

    if ((await signInAs(subject)) !== true) throw new Error("sign-in failed");

    await createAndConnect("Notes");
    await browser.waitUntil(async () => (await syncState()) === "idle", { timeoutMsg: "sync never became idle" });
    await capture("settings-connected", "Remote vault");
  });
});
