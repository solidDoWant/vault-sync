import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { callHarness } from "../obsidian";

// The conflict view (#27) inside a real Obsidian. The harness drives
// vault-sync's sync session against an in-memory server, so a real
// conflict copy and a real unmaterializable document come from the engine.
// The view is opened as its command opens it, its Compare button is
// clicked, and the copy is deleted the way a user would.

/** A file name longer than the 255 bytes every platform allows (SPEC.md §8): the engine cannot write it here. */
const overlongPath = `${"n".repeat(300)}.md`;

/** The text of every element of the conflict view that `selector` matches, in document order. */
function texts(selector: string) {
  return browser.executeObsidian((_, css) => [...document.querySelectorAll(`.vault-sync-conflict-view ${css}`)].map((element) => element.textContent), selector);
}

/** Clicks the first element of the conflict view that `selector` matches, as a user's click does. */
function click(selector: string) {
  return browser.executeObsidian((_, css) => {
    const element = document.querySelector<HTMLElement>(`.vault-sync-conflict-view ${css}`);
    if (element === null) throw new Error(`nothing matches ${css}`);
    element.click();
  }, selector);
}

/** Each open Markdown pane's file and where it sits on screen. */
function markdownPanes() {
  return browser.executeObsidian(({ app }) =>
    app.workspace.getLeavesOfType("markdown").map((leaf) => {
      const rect = leaf.view.containerEl.getBoundingClientRect();
      return { path: (leaf.view as unknown as { file: { path: string } | null }).file?.path ?? null, left: rect.left, right: rect.right, top: rect.top };
    }),
  );
}

describe("vault-sync conflict view", function () {
  let copy = "";

  before(async function () {
    await callHarness("setUpSession");
    await browser.executeObsidian(async ({ app }) => {
      await app.vault.create("Clash.md", "this device's version\n");
    });
    await callHarness("commitRemote", "doc-clash", "Clash.md", "the other device's version\n");
    await callHarness("commitRemote", "doc-overlong", overlongPath, "a name this device cannot hold\n");
    await callHarness("startSession");
    await browser.executeObsidian(async ({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      await plugin.showConflicts();
    }, pluginId);
  });

  it("lists the conflict with links to both versions", async function () {
    await browser.waitUntil(async () => (await texts(".vault-sync-conflict")).length > 0, { timeoutMsg: "the conflict view lists no conflict" });
    expect(await texts(".vault-sync-conflict")).toHaveLength(1);
    expect(await texts(".vault-sync-conflict .vault-sync-conflict-original")).toEqual(["Clash.md"]);
    const [copyText] = await texts(".vault-sync-conflict .vault-sync-conflict-copy");
    copy = copyText ?? "";
    expect(copy).toMatch(/^Clash \(conflict e2e-device \d{4}-\d{2}-\d{2} \d{6}\)\.md$/);
    expect((await texts(".vault-sync-conflict .vault-sync-conflict-reason"))[0]).toMatch(/Created on this device and on another one/);
    // The links name real files: the other device's version stayed in place, this device's is the copy.
    const contents = await browser.executeObsidian(
      async ({ app }, paths) => Promise.all(paths.map(async (path) => {
        const file = app.vault.getFileByPath(path);
        return file === null ? null : app.vault.read(file);
      })),
      ["Clash.md", copy],
    );
    expect(contents).toEqual(["the other device's version\n", "this device's version\n"]);
  });

  it("lists the document this device cannot hold with its server path and why", async function () {
    expect(await texts(".vault-sync-unmaterializable-path")).toEqual([overlongPath]);
    expect((await texts(".vault-sync-unmaterializable-reason"))[0]).toMatch(/name in the path is too long/);
  });

  it("opens both versions side by side with one click", async function () {
    await click(".vault-sync-compare");

    await browser.waitUntil(
      async () => {
        const paths = (await markdownPanes()).map((pane) => pane.path);
        return paths.includes("Clash.md") && paths.includes(copy);
      },
      { timeoutMsg: "Compare did not open both versions" },
    );
    if (!e2eEnvironment.emulateMobile) {
      // Obsidian on a phone shows one pane at a time; on desktop the copy is split off to the original's right.
      const panes = await markdownPanes();
      const original = panes.find((pane) => pane.path === "Clash.md");
      const copied = panes.find((pane) => pane.path === copy);
      expect(original).toBeDefined();
      expect(copied).toBeDefined();
      expect(copied?.top).toBe(original?.top);
      // Within a pixel: layout coordinates are fractional.
      expect(copied?.left ?? 0).toBeGreaterThan((original?.right ?? Infinity) - 1);
    }
  });

  it("clears the entry once the user deletes the conflict copy", async function () {
    await browser.executeObsidian(async ({ app }, path) => {
      const file = app.vault.getFileByPath(path);
      if (file === null) throw new Error(`no file ${path}`);
      await app.vault.delete(file);
    }, copy);

    await browser.waitUntil(async () => (await texts(".vault-sync-conflict")).length === 0, { timeoutMsg: "the deleted copy's conflict is still listed" });
    expect(await texts(".vault-sync-conflicts-empty")).toEqual(["No conflicts."]);
    // The document this device cannot hold is still listed: it is not a conflict.
    expect(await texts(".vault-sync-unmaterializable-path")).toEqual([overlongPath]);
  });
});
