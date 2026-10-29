import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { callHarness } from "../obsidian";

// The conflict view inside a real Obsidian. The harness drives vault-sync's
// sync session against an in-memory server, so a real conflict copy and real
// skipped documents come from the engine.
// The view is opened as its command opens it, its Compare button is
// clicked, and the copy is deleted the way a user would.

/** A file name longer than the 255 bytes every platform allows (docs/design/engine.md §6): the engine cannot write it here. */
const overlongPath = `${"n".repeat(300)}.md`;

/** A name with an accent typed as a separate character (NFD), which Obsidian's normalizePath would store in NFC, so the vault refuses it. */
const decomposedPath = `Cafe${String.fromCodePoint(0x301)}.md`;

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
    await callHarness("commitRemote", "doc-decomposed", decomposedPath, "a name Obsidian would store under another spelling\n");
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
    expect(copy).toMatch(/^Clash \(Conflicted copy e2e-device \d{12}\)\.md$/);
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

  it("lists the documents this device cannot hold with their server paths and why", async function () {
    expect(await texts(".vault-sync-skipped-path")).toEqual([overlongPath, decomposedPath]);
    const reasons = await texts(".vault-sync-skipped-reason");
    expect(reasons[0]).toMatch(/name in the path is too long/);
    expect(reasons[1]).toMatch(/refused to create a file at this path/);
  });

  it("shows a notice and draws the view again when a link's file is gone", async function () {
    // The copy disappears between the view's drawing and the click: Obsidian no longer finds it.
    await browser.executeObsidian(({ app }, path) => {
      const vault = app.vault as unknown as { getFileByPath(path: string): unknown; e2eGetFileByPath?: (path: string) => unknown };
      vault.e2eGetFileByPath = vault.getFileByPath.bind(vault);
      vault.getFileByPath = (candidate: string) => (candidate === path ? null : vault.e2eGetFileByPath?.(candidate));
      const heading = document.querySelector<HTMLElement>(".vault-sync-conflict-view h4");
      if (heading === null) throw new Error("the conflict view shows nothing");
      heading.dataset.e2eDrawn = "before";
    }, copy);
    try {
      await click(".vault-sync-conflict-copy");

      await browser.waitUntil(async () => (await browser.executeObsidian(() => [...document.querySelectorAll(".notice")].map((notice) => notice.textContent).join("\n"))).includes("no longer exists"), {
        timeoutMsg: "no notice said the file is gone",
      });
      await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".vault-sync-conflict-view [data-e2e-drawn]") === null && document.querySelector(".vault-sync-conflict-view h4") !== null), {
        timeoutMsg: "the conflict view was not drawn again",
      });
    } finally {
      await browser.executeObsidian(({ app }) => {
        const vault = app.vault as unknown as { getFileByPath(path: string): unknown; e2eGetFileByPath?: (path: string) => unknown };
        if (vault.e2eGetFileByPath !== undefined) vault.getFileByPath = vault.e2eGetFileByPath;
        delete vault.e2eGetFileByPath;
      });
    }
    // The redraw ran while the copy seemed gone, so it showed no conflict; the copy is back now.
    await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("vault-sync-conflicts")[0]?.view as unknown as { refresh(): Promise<void> } | undefined;
      if (view === undefined) throw new Error("the conflict view is not open");
      await view.refresh();
    });
    await browser.waitUntil(async () => (await texts(".vault-sync-compare")).length > 0, { timeoutMsg: "the conflict is not listed again" });
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
    // The documents this device cannot hold are still listed: they are not conflicts.
    expect(await texts(".vault-sync-skipped-path")).toEqual([overlongPath, decomposedPath]);
  });
});
