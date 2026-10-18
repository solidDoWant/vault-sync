import { readFileSync } from "node:fs";

import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { e2eEnvironment, pluginId } from "../environment";

// Obsidian's plugin registry is not in its public typings.
interface PluginRegistry {
  plugins: {
    enabledPlugins: Set<string>;
    plugins: Record<string, { _loaded?: boolean; manifest: { version: string } } | undefined>;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
  };
}

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

/**
 * Runs the plugin's load again through Obsidian's own enable path and reports
 * whether it succeeded. The registry state alone cannot tell: Obsidian marks a
 * plugin loaded before calling its `onload`, and when `onload` throws (or its
 * promise rejects) it only logs "Plugin failure" and leaves the plugin
 * registered and enabled. `enablePlugin` resolves only after `onload` has
 * settled and resolves `false` when it failed, so this needs no waiting.
 * `disablePlugin` first, because `enablePlugin` is a no-op for a plugin that is
 * already registered; neither call changes the saved enabled-plugin list.
 */
function reloadPlugin() {
  return browser.executeObsidian(async ({ app }, id) => {
    const registry = (app as unknown as PluginRegistry).plugins;
    await registry.disablePlugin(id);
    return registry.enablePlugin(id);
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
      return { status: response.status, body: response.text };
    },
    `${e2eEnvironment.serverUrl}/vaultsync.v1.VaultService/ListVaults`,
    token,
  );
}

describe("vault-sync in Obsidian", function () {
  it("runs in the configured UI mode (desktop, or emulated mobile)", async function () {
    const platform = await obsidianPage.getPlatform();
    expect(platform.isMobile).toBe(e2eEnvironment.emulateMobile);
    expect(platform.isDesktopApp).toBe(true);
  });

  it("loads and enables the built plugin", async function () {
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
    // Its onload completes without throwing.
    expect(await reloadPlugin()).toBe(true);
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
  });

  it("opens a second vault, with the plugin loaded there too", async function () {
    const firstPath = obsidianPage.getVaultPath();
    expect(await vaultFiles()).toEqual(["Primary vault.md"]);

    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });

    expect(obsidianPage.getVaultPath()).not.toBe(firstPath);
    expect(await vaultFiles()).toEqual(["Second vault.md"]);
    expect(await pluginState()).toEqual({ enabled: true, loaded: true, version: manifest.version });
    expect(await reloadPlugin()).toBe(true);
    expect((await obsidianPage.getPlatform()).isMobile).toBe(e2eEnvironment.emulateMobile);
  });

  it("reaches the harness-started server with the test token", async function () {
    const authorized = await listVaults(e2eEnvironment.token);
    expect(authorized.status).toBe(200);
    // The test user is a member of no vault, so the decoded ListVaults
    // response is empty (Connect JSON omits an empty list and page token).
    expect(JSON.parse(authorized.body)).toEqual({});

    // The token is what gets the request in: without it the server refuses.
    const anonymous = await listVaults(null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toContain("unauthenticated");
  });
});
