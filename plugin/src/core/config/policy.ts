import { isConflictCopyPath } from "../merge/conflict-name";
import { pathKey } from "../pathkey/pathkey";

// Which files of Obsidian's config folder sync (SPEC.md §8, #28). Paths here
// are relative to the config folder ("hotkeys.json", "plugins/x/main.js"),
// whatever the folder is called on this device.

/** The groups of config files a device may opt into, each off unless the user turns it on. */
export type ConfigCategory = "themes" | "snippets" | "hotkeys" | "appSettings" | "pluginList" | "corePluginSettings" | "plugins";

export const configCategories: readonly ConfigCategory[] = ["themes", "snippets", "hotkeys", "appSettings", "pluginList", "corePluginSettings", "plugins"];

/**
 * This device's config sync settings for one local vault. They are kept on
 * the device (the plugin's data, which never syncs) and never come from the
 * server, so every device opts in on its own (#52, decision 6253457638).
 */
export interface ConfigSyncSettings {
  /** The master toggle: while off, nothing under the config folder syncs, whatever the categories say. */
  enabled: boolean;
  categories: Record<ConfigCategory, boolean>;
}

/**
 * Off. Turning it on syncs themes, snippets and hotkeys; the plugin list and
 * plugin code and data, which decide what code runs on this device, stay off
 * until turned on as well. So do Obsidian's main settings and the core
 * plugin settings (#256): a device that turned config sync on before they
 * existed keeps its own editor and daily note settings until the user opts
 * in, rather than having them replaced by another device's on an upgrade.
 */
export const defaultConfigSyncSettings: Readonly<ConfigSyncSettings> = Object.freeze({
  enabled: false,
  categories: Object.freeze({ themes: true, snippets: true, hotkeys: true, appSettings: false, pluginList: false, corePluginSettings: false, plugins: false }),
});

/**
 * The core plugins of the pinned Obsidian (1.14.4) whose settings file,
 * `<id>.json` in the config folder, syncs with the core plugin settings
 * (#256; docs/plugin.md has the research). Missing: graph and workspaces,
 * whose files are device-local, and sync (Obsidian Sync's own state). A core
 * plugin a later Obsidian adds stays on the device until it is added here.
 */
export const corePluginSettingsIds: readonly string[] = [
  "audio-recorder",
  "backlink",
  "bases",
  "bookmarks",
  "canvas",
  "command-palette",
  "daily-notes",
  "editor-status",
  "file-explorer",
  "file-recovery",
  "footnotes",
  "global-search",
  "markdown-importer",
  "note-composer",
  "outgoing-link",
  "outline",
  "page-preview",
  "properties",
  "publish",
  "random-note",
  "slash-command",
  "slides",
  "switcher",
  "tag-pane",
  "templates",
  "webviewer",
  "word-count",
  "zk-prefixer",
];

const corePluginSettingsFiles: ReadonlySet<string> = new Set(corePluginSettingsIds.map((id) => `${id}.json`));

/**
 * Files Obsidian writes in the config folder for state that belongs to one
 * device, found by running the pinned Obsidian (docs/plugin.md lists them
 * with the research). They never sync under any setting, even if a category
 * would cover them.
 */
export const deviceLocalConfigFiles: readonly { pattern: string; reason: string }[] = [
  {
    pattern: "workspace.json",
    reason: "The desktop layout: open tabs and splits, their sizes, the sidebars, the active pane, each view's state and the recently opened files. Rewritten on every pane switch, tab change, split, sidebar toggle or resize and view-mode change.",
  },
  { pattern: "workspace-mobile.json", reason: "The same layout state for the mobile app, rewritten just as often." },
  { pattern: "workspace*.json", reason: "Any other layout file, such as workspaces.json, the layouts the Workspaces core plugin saves for this device's screen." },
  { pattern: "graph.json", reason: "The graph view's settings together with its current zoom level; rewritten when the graph view opens and on every zoom." },
];

/** The folder (under `plugins/`) vault-sync is installed in by default, which never syncs. */
export const ownPluginId = "vault-sync";

export interface ConfigPolicyOptions {
  settings: ConfigSyncSettings;
  /**
   * This plugin's own folders, relative to the config folder (e.g.
   * "plugins/vault-sync"): its code, and its data with the device's refresh
   * token. `plugins/vault-sync` is always included.
   */
  ownFolders?: readonly string[];
}

/**
 * Whether `relative` (a path inside the config folder) never syncs on this
 * device under any setting: a device-local file, or this plugin's own
 * folder. Matched ignoring case and Unicode form, as a case-insensitive
 * disk would match it.
 */
export function neverSynced(relative: string, ownFolders: readonly string[] = []): boolean {
  if (!wellFormed(relative)) return true;
  const key = comparable(relative);
  if (!key.includes("/") && (key === "graph.json" || /^workspace.*\.json$/u.test(key))) return true;
  const folders = [`plugins/${ownPluginId}`, ...ownFolders].map((folder) => comparable(folder.replace(/\/+$/u, "")));
  return folders.some((folder) => key === folder || key.startsWith(`${folder}/`));
}

/**
 * `path` as any disk might take it: by path key (case and Unicode form
 * ignored), and without the trailing dots and spaces Windows drops from a
 * name.
 */
function comparable(path: string): string {
  return pathKey(path)
    .split("/")
    .map((segment) => segment.replace(/[. ]+$/u, ""))
    .join("/");
}

/**
 * The category that covers `relative` (a path inside the config folder), if
 * any. None covers a conflict copy, at any depth, nor anything in a folder
 * renamed as one: the copy of a config file stays on the device that made it
 * (SPEC.md §8, #365).
 */
export function configCategoriesOf(relative: string): ConfigCategory[] {
  if (isConflictCopyPath(relative)) return [];
  const segments = relative.split("/");
  const [first] = segments;
  if (segments.length === 1) {
    if (first === "appearance.json") return ["themes", "snippets"];
    if (first === "hotkeys.json") return ["hotkeys"];
    // types.json holds the vault's property types, which Obsidian groups with its main settings.
    if (first === "app.json" || first === "types.json") return ["appSettings"];
    if (first === "community-plugins.json" || first === "core-plugins.json" || first === "core-plugins-migration.json") return ["pluginList"];
    if (corePluginSettingsFiles.has(relative)) return ["corePluginSettings"];
    return [];
  }
  if (first === "themes") return ["themes"];
  if (first === "snippets") return ["snippets"];
  // A file inside a plugin's own folder, not a loose file in plugins/.
  if (first === "plugins" && segments.length >= 3) return ["plugins"];
  return [];
}

/**
 * Whether `relative` (a path inside the config folder) syncs: config sync is
 * on, a category covering the path is on, and the path is not one that never
 * syncs. Everything else under the config folder stays on this device.
 */
export function configPathSynced(relative: string, options: ConfigPolicyOptions): boolean {
  const { settings } = options;
  if (!settings.enabled || neverSynced(relative, options.ownFolders)) return false;
  return configCategoriesOf(relative).some((category) => settings.categories[category]);
}

const categoryNames: Record<ConfigCategory, string> = {
  themes: "themes",
  snippets: "CSS snippets",
  hotkeys: "hotkeys",
  appSettings: "Obsidian's main settings",
  pluginList: "the enabled plugin list",
  corePluginSettings: "core plugin settings",
  plugins: "plugins",
};

/**
 * What to tell the user after sync changed config files (`relative` paths):
 * Obsidian reads them at startup and keeps its own copy, so they take effect
 * only after a reload, which the plugin never does on its own. Undefined if
 * none of them belongs to a category.
 */
export function configReloadMessage(relative: readonly string[]): string | undefined {
  const touched = new Set<ConfigCategory>();
  for (const path of relative) {
    const [category] = configCategoriesOf(path);
    if (category !== undefined) touched.add(category);
  }
  if (touched.size === 0) return undefined;
  const names = configCategories.filter((category) => touched.has(category)).map((category) => categoryNames[category]);
  return `Sync changed Obsidian's settings (${names.join(", ")}). Reload Obsidian to apply them: run "Reload app without saving" from the command palette. Until then, Obsidian keeps using the old settings and may write them back.`;
}

/** No empty, "." or ".." segment. */
function wellFormed(relative: string): boolean {
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
