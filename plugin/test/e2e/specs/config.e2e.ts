import { browser, expect } from "@wdio/globals";

import { pluginId } from "../environment";
import { callHarness } from "../obsidian";

// Config folder sync (#28, SPEC.md §8) in the real Obsidian: vault-sync's
// sync session against the harness's in-memory server, over this vault's
// real config folder. Obsidian rewrites workspace.json (workspace-mobile.json
// in the mobile UI) on every pane switch and layout change; none of it may
// ever be uploaded.

const everything = { enabled: true, categories: { themes: true, snippets: true, hotkeys: true, pluginList: true, plugins: true } };

/** The layout file Obsidian keeps in this UI mode. */
async function layoutFile(): Promise<string> {
  return browser.executeObsidian(({ app, obsidian }) => `${app.vault.configDir}/${obsidian.Platform.isMobile ? "workspace-mobile.json" : "workspace.json"}`);
}

/** The layout file's content, or null. */
async function layout(path: string): Promise<string | null> {
  return browser.executeObsidian(async ({ app }, file) => ((await app.vault.adapter.exists(file)) ? app.vault.adapter.read(file) : null), path);
}

/**
 * Waits until Obsidian has written its settings files (app.json,
 * appearance.json), which it does a few seconds after it starts.
 * appearance.json syncs with the themes category, so a session that should
 * see a settled config folder starts only after that.
 */
async function settingsWritten(): Promise<void> {
  await browser.waitUntil(() => browser.executeObsidian(async ({ app }) => (await app.vault.adapter.exists(`${app.vault.configDir}/app.json`)) && app.vault.adapter.exists(`${app.vault.configDir}/appearance.json`)), {
    timeoutMsg: "Obsidian never wrote its settings files",
  });
}

/** Runs an Obsidian command by id. */
async function command(id: string): Promise<void> {
  await browser.executeObsidian(({ app }, commandId) => {
    (app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(commandId);
  }, id);
}

describe("Config folder sync", function () {
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
    // The config folder synced: the enabled plugin list at least, never the layout or vault-sync's own folder.
    const configDir = await browser.executeObsidian(({ app }) => app.vault.configDir);
    expect(before.paths).toContain(`${configDir}/community-plugins.json`);
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

    expect(await callHarness("syncSession")).toBe(0);
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
