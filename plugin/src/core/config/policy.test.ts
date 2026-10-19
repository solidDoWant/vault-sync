import { describe, expect, it } from "vitest";

import { configPathSynced, configReloadMessage, defaultConfigSyncSettings, neverSynced, type ConfigCategory, type ConfigSyncSettings } from "./policy";

const none: Record<ConfigCategory, boolean> = { themes: false, snippets: false, hotkeys: false, pluginList: false, plugins: false };
const all: Record<ConfigCategory, boolean> = { themes: true, snippets: true, hotkeys: true, pluginList: true, plugins: true };

function settings(enabled: boolean, categories: Partial<Record<ConfigCategory, boolean>>): ConfigSyncSettings {
  return { enabled, categories: { ...none, ...categories } };
}

// Written out here, not read from the policy: what each category must cover.
const covered: { path: string; categories: ConfigCategory[] }[] = [
  { path: "themes/Minimal/theme.css", categories: ["themes"] },
  { path: "themes/Minimal/manifest.json", categories: ["themes"] },
  { path: "appearance.json", categories: ["themes", "snippets"] },
  { path: "snippets/wide.css", categories: ["snippets"] },
  { path: "hotkeys.json", categories: ["hotkeys"] },
  { path: "community-plugins.json", categories: ["pluginList"] },
  { path: "core-plugins.json", categories: ["pluginList"] },
  { path: "plugins/dataview/main.js", categories: ["plugins"] },
  { path: "plugins/dataview/manifest.json", categories: ["plugins"] },
  { path: "plugins/dataview/data.json", categories: ["plugins"] },
  { path: "plugins/dataview/styles.css", categories: ["plugins"] },
  { path: "plugins/dataview/lib/nested.js", categories: ["plugins"] },
];

// Config files no category covers: they stay on the device.
const uncovered = ["app.json", "types.json", "bookmarks.json", "daily-notes.json", "templates.json", "plugins/loose.js", "other/file.json", "themes", "snippets"];

// Never synced under any setting (#28): device-local files and this plugin's own folder.
const forbidden = [
  "workspace.json",
  "workspace-mobile.json",
  "workspaces.json",
  "graph.json",
  "Workspace.json",
  "WORKSPACE-MOBILE.JSON",
  "workspace.json.",
  "plugins/vault-sync/data.json",
  "plugins/vault-sync/main.js",
  "plugins/vault-sync/manifest.json",
  "plugins/Vault-Sync/data.json",
  "plugins/vault-sync./data.json",
  "plugins/dataview/../vault-sync/data.json",
  "plugins//data.json",
  "./hotkeys.json",
];

describe("config sync policy", () => {
  it("is off by default", () => {
    expect(defaultConfigSyncSettings.enabled).toBe(false);
  });

  it("syncs nothing under the config folder while off, whatever the categories say", () => {
    for (const { path } of covered) expect(configPathSynced(path, { settings: settings(false, all) }), path).toBe(false);
  });

  it("syncs each path exactly when a category covering it is on", () => {
    for (const { path, categories } of covered) {
      for (const category of Object.keys(none) as ConfigCategory[]) {
        expect(configPathSynced(path, { settings: settings(true, { [category]: true }) }), `${path} with only ${category}`).toBe(categories.includes(category));
      }
      expect(configPathSynced(path, { settings: settings(true, {}) }), `${path} with no category`).toBe(false);
    }
  });

  it("never syncs config files no category covers", () => {
    for (const path of uncovered) expect(configPathSynced(path, { settings: settings(true, all) }), path).toBe(false);
  });

  it("never syncs workspace*.json, the graph view's state, or this plugin's own folder, even with every category on", () => {
    for (const path of forbidden) {
      expect(neverSynced(path), path).toBe(true);
      expect(configPathSynced(path, { settings: settings(true, all) }), path).toBe(false);
    }
  });

  it("never syncs the folder this plugin is installed in, under any name", () => {
    const options = { settings: settings(true, all), ownFolders: ["plugins/vault-sync-beta"] };
    expect(configPathSynced("plugins/vault-sync-beta/data.json", options)).toBe(false);
    expect(configPathSynced("plugins/VAULT-SYNC-BETA/main.js", options)).toBe(false);
    expect(configPathSynced("plugins/vault-sync-beta2/main.js", options)).toBe(true);
    expect(configPathSynced("plugins/vault-sync/data.json", options)).toBe(false);
  });

  it("tells the user to reload after a plugin list change, and says nothing for files no category covers", () => {
    const message = configReloadMessage(["community-plugins.json"]);
    expect(message).toContain("the enabled plugin list");
    expect(message).toMatch(/Reload Obsidian/u);
    expect(configReloadMessage(["plugins/dataview/main.js", "hotkeys.json"])).toContain("hotkeys, plugins");
    expect(configReloadMessage(["app.json", "hotkeys (conflict laptop 2026-10-18 040506).json"])).toBeUndefined();
    expect(configReloadMessage([])).toBeUndefined();
  });
});
