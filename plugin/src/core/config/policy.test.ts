import { describe, expect, it } from "vitest";

import { conflictCopyPath, conflictFolderPath } from "../merge/conflict-name";
import { configPathSynced, configReloadMessage, defaultConfigSyncSettings, neverSynced, type ConfigCategory, type ConfigSyncSettings } from "./policy";

const none: Record<ConfigCategory, boolean> = { themes: false, snippets: false, hotkeys: false, appSettings: false, pluginList: false, corePluginSettings: false, plugins: false };
const all: Record<ConfigCategory, boolean> = { themes: true, snippets: true, hotkeys: true, appSettings: true, pluginList: true, corePluginSettings: true, plugins: true };

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
  { path: "core-plugins-migration.json", categories: ["pluginList"] },
  { path: "app.json", categories: ["appSettings"] },
  { path: "types.json", categories: ["appSettings"] },
  // Every core plugin of Obsidian 1.14.4 that may keep a settings file (#256), but graph, workspaces and sync.
  ...[
    "file-explorer",
    "global-search",
    "switcher",
    "backlink",
    "canvas",
    "outgoing-link",
    "tag-pane",
    "footnotes",
    "properties",
    "page-preview",
    "daily-notes",
    "templates",
    "note-composer",
    "command-palette",
    "slash-command",
    "editor-status",
    "bookmarks",
    "markdown-importer",
    "zk-prefixer",
    "random-note",
    "outline",
    "word-count",
    "slides",
    "audio-recorder",
    "file-recovery",
    "publish",
    "bases",
    "webviewer",
  ].map((id): { path: string; categories: ConfigCategory[] } => ({ path: `${id}.json`, categories: ["corePluginSettings"] })),
  { path: "plugins/dataview/main.js", categories: ["plugins"] },
  { path: "plugins/dataview/manifest.json", categories: ["plugins"] },
  { path: "plugins/dataview/data.json", categories: ["plugins"] },
  { path: "plugins/dataview/styles.css", categories: ["plugins"] },
  { path: "plugins/dataview/lib/nested.js", categories: ["plugins"] },
];

// Config files no category covers: they stay on the device.
const uncovered = [
  // Obsidian Sync's state, and a loose JSON file no core plugin of 1.14.4 writes (a future core plugin, or a community plugin's file).
  "sync.json",
  "starred-notes.json",
  "unknown.json",
  "daily-notes.json.bak",
  "daily-notes",
  "app.json/nested.json",
  "bookmarks/x.json",
  "plugins/loose.js",
  "other/file.json",
  "themes",
  "snippets",
];

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

  it("leaves Obsidian's main settings and the core plugin settings off once turned on, like the plugin list and plugin code (#256)", () => {
    expect(defaultConfigSyncSettings.categories).toEqual({ themes: true, snippets: true, hotkeys: true, appSettings: false, pluginList: false, corePluginSettings: false, plugins: false });
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

  it("never syncs a conflict copy of a config file, at any depth, under any category (#365)", () => {
    const date = new Date(Date.UTC(2026, 9, 18, 4, 5, 6));
    const copies = [
      "hotkeys (conflict b 2026-10-18 040506).json",
      "snippets/wide (conflict b 2026-10-18 040506).css",
      "snippets/wide (conflict My Laptop 2026-10-18 040506 2).css",
      "themes/Minimal/theme (conflict b 2026-10-18 040506).css",
      "plugins/dataview/data (conflict b 2026-10-18 040506).json",
      "plugins/dataview/lib/nested (conflict b 2026-10-18 040506).js",
      "plugins/dataview/README (conflict b 2026-10-18 040506)",
      "plugins/dataview (conflict b 2026-10-18 040506)/data.json",
      "themes/Minimal (conflict b 2026-10-18 040506)/theme.css",
      // As the engine names them: a device name with characters a file name cannot hold, a counter, a folder renamed as a copy.
      conflictCopyPath("snippets/wide.css", "Phone: \"main\" (old)", date, 3) ?? "",
      conflictCopyPath("plugins/dataview/data.json", "", date) ?? "",
      conflictFolderPath("plugins/dataview", "data.json", "b", date, 2) ?? "",
      conflictCopyPath(`snippets/${"x".repeat(300)}.css`, "b", date) ?? "",
    ];
    for (const path of copies) {
      expect(path, "a name the namer produced").not.toBe("");
      expect(neverSynced(path), path).toBe(false);
      expect(configPathSynced(path, { settings: settings(true, all) }), path).toBe(false);
    }
    // Names only like a conflict copy's still sync.
    const lookalikes = ["snippets/wide (conflict).css", "snippets/wide (conflict b).css", "snippets/conflict b 2026-10-18 040506.css", "snippets/wide (conflict b 2026-10-18 0405).css", "plugins/dataview/data (conflict b 2026-10-18 040506) old.json"];
    for (const path of lookalikes) expect(configPathSynced(path, { settings: settings(true, all) }), path).toBe(true);
  });

  it("names the main settings and the core plugin settings in the reload notice (#256)", () => {
    expect(configReloadMessage(["app.json"])).toContain("Obsidian's main settings");
    expect(configReloadMessage(["types.json"])).toContain("Obsidian's main settings");
    expect(configReloadMessage(["daily-notes.json", "hotkeys.json"])).toContain("hotkeys, core plugin settings");
  });

  it("tells the user to reload after a plugin list change, and says nothing for files no category covers", () => {
    const message = configReloadMessage(["community-plugins.json"]);
    expect(message).toContain("the enabled plugin list");
    expect(message).toMatch(/Reload Obsidian/u);
    expect(configReloadMessage(["plugins/dataview/main.js", "hotkeys.json"])).toContain("hotkeys, plugins");
    expect(configReloadMessage(["unknown.json", "hotkeys (conflict laptop 2026-10-18 040506).json"])).toBeUndefined();
    expect(configReloadMessage([])).toBeUndefined();
  });
});
