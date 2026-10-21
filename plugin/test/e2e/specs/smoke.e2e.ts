import { readFileSync } from "node:fs";

import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { e2eEnvironment, pluginId } from "../environment";
import { reloadPlugin, type PluginRegistry } from "../obsidian";

const manifest = JSON.parse(readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8")) as { version: string };

/** The vault-sync plugin's state in the running Obsidian. */
function pluginState() {
  return browser.executeObsidian(({ app }, id) => {
    const registry = (app as unknown as PluginRegistry).plugins;
    const plugin = registry.plugins[id];
    return {
      enabled: registry.enabledPlugins.has(id),
      loaded: plugin?._loaded === true,
      version: plugin?.manifest.version ?? null,
    };
  }, pluginId);
}

/** The paths of the files in the open vault, sorted. */
function vaultFiles() {
  return browser.executeObsidian(({ app }) =>
    app.vault
      .getFiles()
      .map((file) => file.path)
      .sort(),
  );
}

/** Calls ListVaults from inside Obsidian (Connect JSON over requestUrl). */
function listVaults(token: string | null) {
  // The field is `code`, not `status`: Appium (the Android app's driver)
  // takes a numeric `status` in a script's result for a legacy JSONWP
  // error code and fails the command.
  return browser.executeObsidian(
    async ({ obsidian }, url, bearer) => {
      const response = await obsidian.requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: "{}",
        headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
        throw: false,
      });
      return { code: response.status, body: response.text };
    },
    `${e2eEnvironment.serverUrl}/vaultsync.v1.VaultService/ListVaults`,
    token,
  );
}

/** The mobile UI is expected: emulated on desktop, or the real Android app. */
const mobileUI = e2eEnvironment.emulateMobile || e2eEnvironment.android;

describe("vault-sync in Obsidian", function () {
  it("runs in the configured UI mode and app (desktop, emulated mobile, or the Android app)", async function () {
    // The device's platform as Obsidian reports it, not the host's.
    const platform = await obsidianPage.getPlatform();
    expect(platform.isMobile).toBe(mobileUI);
    expect(platform.isDesktopApp).toBe(!e2eEnvironment.android);
    expect(platform.isAndroidApp).toBe(e2eEnvironment.android);
    expect(platform.isMobileApp).toBe(e2eEnvironment.android);
  });

  it("shows the sync status without opening the settings: in the status bar on desktop, as a ribbon icon on mobile (#420)", async function () {
    const shown = await browser.executeObsidian(() => ({
      bar: [...document.querySelectorAll(".status-bar .vault-sync-status")].map((element) => element.textContent),
      ribbon: [...document.querySelectorAll(".vault-sync-status-ribbon")].map((element) => element.getAttribute("aria-label")),
    }));
    if (mobileUI) {
      expect(shown.ribbon).toHaveLength(1);
      expect(shown.ribbon[0]).toMatch(/^Vault Sync: /);
    } else {
      expect(shown.bar).toHaveLength(1);
      expect(shown.bar[0]).toMatch(/^Vault Sync: /);
      expect(shown.ribbon).toEqual([]);
    }
  });

  it("loads and enables the built plugin", async function () {
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
    // Its onload completes without throwing.
    expect(await reloadPlugin(pluginId)).toBe(true);
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
  });

  it("opens a second vault, with the plugin loaded there too", async function () {
    const firstPath = obsidianPage.getVaultPath();
    expect(await vaultFiles()).toEqual(["Primary vault.md"]);

    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });

    expect(obsidianPage.getVaultPath()).not.toBe(firstPath);
    expect(await vaultFiles()).toEqual(["Second vault.md"]);
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
    expect(await reloadPlugin(pluginId)).toBe(true);
    expect((await obsidianPage.getPlatform()).isMobile).toBe(mobileUI);
  });

  it("reaches the harness-started server with the test token", async function () {
    const authorized = await listVaults(e2eEnvironment.token);
    expect(authorized.code).toBe(200);
    // The test user is a member of no vault, so the decoded ListVaults
    // response is empty (Connect JSON omits an empty list and page token).
    expect(JSON.parse(authorized.body)).toEqual({});

    // The token is what gets the request in: without it the server refuses.
    const anonymous = await listVaults(null);
    expect(anonymous.code).toBe(401);
    expect(anonymous.body).toContain("unauthenticated");
  });
});
