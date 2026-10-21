import { browser, expect } from "@wdio/globals";

import { pluginId } from "../environment";
import { callHarness } from "../obsidian";

// Config folder sync (#28, SPEC.md §8) in the real Obsidian: vault-sync's
// sync session against the harness's in-memory server, over this vault's
// real config folder. Obsidian rewrites workspace.json (workspace-mobile.json
// in the mobile UI) on every pane switch and layout change; none of it may
// ever be uploaded.

const everything = { enabled: true, categories: { themes: true, snippets: true, hotkeys: true, appSettings: true, pluginList: true, corePluginSettings: true, plugins: true } };

/** The layout file Obsidian keeps in this UI mode. */
async function layoutFile(): Promise<string> {
  return browser.executeObsidian(({ app, obsidian }) => `${app.vault.configDir}/${obsidian.Platform.isMobile ? "workspace-mobile.json" : "workspace.json"}`);
}

/** The layout file's content, or null. */
async function layout(path: string): Promise<string | null> {
  return browser.executeObsidian(async ({ app }, file) => ((await app.vault.adapter.exists(file)) ? app.vault.adapter.read(file) : null), path);
}

/**
 * Waits until Obsidian has made the config writes it makes after it starts,
 * each debounced (#326): app.json, appearance.json and core-plugins.json,
 * which the fixture vault does not have, and community-plugins.json, which it
 * saves again a second after it has loaded every enabled plugin (the harness
 * among them, which watches for that save from its onload). The themes and
 * plugin list categories sync the last three, so a session that starts
 * earlier may push before one of them is written, then commit it on its next
 * sync.
 */
async function settingsWritten(): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.executeObsidian(async ({ app }) => {
        for (const file of ["app.json", "appearance.json", "core-plugins.json"]) if (!(await app.vault.adapter.exists(`${app.vault.configDir}/${file}`))) return false;
        return true;
      })) && (await callHarness("configWritesSinceLoad")).includes("community-plugins.json"),
    { timeoutMsg: "Obsidian never wrote its settings files" },
  );
}

/** Runs an Obsidian command by id. */
async function command(id: string): Promise<void> {
  await browser.executeObsidian(({ app }, commandId) => {
    (app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(commandId);
  }, id);
}

/**
 * The open settings tab's rows that have a toggle (the config sync rows):
 * name, description, and the toggle's state. Read from the tab's own element,
 * since Obsidian does not render the settings in the main document.
 */
async function configSyncRows(): Promise<{ name: string; description: string; on: boolean }[]> {
  return browser.executeObsidian(({ app }) =>
    [...((app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.querySelectorAll(".setting-item") ?? [])]
      .map((item) => ({
        name: item.querySelector(".setting-item-name")?.textContent ?? "",
        description: item.querySelector(".setting-item-description")?.textContent ?? "",
        toggle: item.querySelector(".checkbox-container"),
      }))
      .filter((row) => row.toggle !== null)
      .map((row) => ({ name: row.name, description: row.description, on: row.toggle?.classList.contains("is-enabled") === true })),
  );
}

describe("Config folder sync", function () {
  it("is off by default, warns about the risk, and stores the choice in this vault's plugin data", async function () {
    await browser.executeObsidian(({ app }, id) => {
      const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
      setting.open();
      setting.openTabById(id);
    }, pluginId);
    const [toggle, ...categories] = await configSyncRows();
    expect(toggle?.name).toMatch(/^Sync the config folder/u);
    expect(toggle?.on).toBe(false);
    expect(toggle?.description).toContain("Security risk");
    expect(toggle?.description).toContain("plugin code, run on this device");
    expect(toggle?.description).toContain("only for vaults you trust");
    expect(categories).toEqual([]);

    await browser.executeObsidian(({ app }) => {
      const tab = (app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab;
      tab?.containerEl.querySelector<HTMLElement>(".setting-item .checkbox-container")?.click();
    });
    await browser.waitUntil(async () => (await configSyncRows()).length > 1, { timeoutMsg: "the categories never showed" });
    expect((await configSyncRows()).map(({ name, on }) => ({ name, on }))).toEqual([
      { name: expect.stringMatching(/^Sync the config folder/u) as unknown as string, on: true },
      { name: "Themes", on: true },
      { name: "CSS snippets", on: true },
      { name: "Hotkeys", on: true },
      { name: "Main settings", on: false },
      { name: "Enabled plugin list", on: false },
      { name: "Core plugin settings", on: false },
      { name: "Plugin code and data", on: false },
    ]);
    const stored = await browser.executeObsidian(async ({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, { loadData(): Promise<unknown> }> } }).plugins.plugins[id];
      return JSON.stringify(await plugin?.loadData());
    }, pluginId);
    expect((JSON.parse(stored) as { configSync?: { enabled: boolean } }).configSync?.enabled).toBe(true);
  });

  afterEach(async function () {
    // An open settings window must not outlive the test that opened it, even when it failed.
    await browser.executeObsidian(({ app }) => {
      (app as unknown as { setting: { close(): void } }).setting.close();
    });
  });

  it("uploads nothing from the config folder while off, whatever categories are selected", async function () {
    await settingsWritten();
    await callHarness("setUpSession");
    await callHarness("setConfigSync", { ...everything, enabled: false });
    await callHarness("startSession");

    expect((await callHarness("serverState")).paths).toEqual(["Synced.md"]);
  });

  it("uploads nothing when panes are switched or the layout changes, with every category on", async function () {
    await callHarness("setUpSession");
    await browser.executeObsidian(async ({ app }) => {
      await app.vault.create("First.md", "# First\n");
      await app.vault.create("Second.md", "# Second\n");
    });
    await settingsWritten();
    await callHarness("setConfigSync", everything);
    await callHarness("startSession");
    const before = await callHarness("serverState");
    const filesBefore = await callHarness("serverFiles");
    // The config folder synced: the enabled plugin list and the main settings at least, never the layout or vault-sync's own folder.
    const configDir = await browser.executeObsidian(({ app }) => app.vault.configDir);
    expect(before.paths).toContain(`${configDir}/community-plugins.json`);
    expect(before.paths).toContain(`${configDir}/app.json`);
    expect(before.paths.filter((path) => /workspace|graph\.json|plugins\/vault-sync\//u.test(path))).toEqual([]);

    const file = await layoutFile();
    await callHarness("watchConfigFolder");
    const layoutBefore = await layout(file);
    await browser.executeObsidian(async ({ app }) => {
      const first = app.vault.getFileByPath("First.md");
      const second = app.vault.getFileByPath("Second.md");
      if (first === null || second === null) throw new Error("notes missing");
      await app.workspace.getLeaf(false).openFile(first);
      await app.workspace.getLeaf("tab").openFile(second);
      const [leaf] = app.workspace.getLeavesOfType("markdown");
      if (leaf !== undefined) app.workspace.setActiveLeaf(leaf, { focus: true });
      await app.workspace.getLeaf("split", "vertical").openFile(second);
    });
    await command("app:toggle-left-sidebar");
    await command("app:toggle-right-sidebar");
    // Obsidian saves the layout a moment after a change: wait until it has, and the adapter has reported it.
    await browser.waitUntil(async () => (await layout(file)) !== layoutBefore && (await callHarness("reportedConfigChanges")).length > 0, { timeoutMsg: "Obsidian never saved the layout" });
    expect(await callHarness("reportedConfigChanges")).toContain(file.slice(configDir.length + 1));

    // Compared together, so a failure names each file the sync committed and its content.
    const committed = await callHarness("syncSession");
    expect({ committed, files: await callHarness("serverFiles") }).toEqual({ committed: 0, files: filesBefore });
    expect(await callHarness("serverState")).toEqual(before);
  });

  it("applies a remote change of the plugin list and tells the user to reload, without reloading Obsidian", async function () {
    const configDir = await browser.executeObsidian(({ app }) => app.vault.configDir);
    const path = `${configDir}/community-plugins.json`;
    const list = await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), path);
    const remote = JSON.stringify([...(JSON.parse(list) as string[]), "plugin-from-another-device"]);
    // Marks this window and this vault-sync instance: a reload of Obsidian, or of the plugin, would lose them.
    await browser.executeObsidian(({ app }, id) => {
      (window as unknown as { configSyncMarker?: unknown }).configSyncMarker = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
    }, pluginId);

    await callHarness("commitOnServer", path, remote);
    await callHarness("syncSession");

    expect(await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), path)).toBe(remote);
    await browser.waitUntil(async () => (await browser.executeObsidian(() => [...document.querySelectorAll(".notice")].map((notice) => notice.textContent).join("\n"))).includes("Reload Obsidian"), {
      timeoutMsg: "no notice asked to reload",
    });
    const notices = await browser.executeObsidian(() => [...document.querySelectorAll(".notice")].map((notice) => notice.textContent));
    expect(notices.find((notice) => notice.includes("Reload Obsidian"))).toContain("the enabled plugin list");
    expect(
      await browser.executeObsidian(({ app }, id) => (window as unknown as { configSyncMarker?: unknown }).configSyncMarker === (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id], pluginId),
    ).toBe(true);
  });
});
