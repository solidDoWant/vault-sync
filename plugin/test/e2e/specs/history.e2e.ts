import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// History browsing and restore (#26, SPEC.md §11) in a real Obsidian against
// the harness-started server: the history view of a synced note lists its
// revisions with time and device, previews one, and restores it; a deleted
// note is found among the deleted files and restored. Its own user and
// remote vault, so the other specs' vaults are untouched.

const subject = "plugin-e2e-history-user";
const remoteVaultName = "e2e history";
const note = "History.md";
const firstVersion = "the first version\n";
const secondVersion = "the second version\n";

function fileText(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    return file === null ? null : app.vault.read(file);
  }, path);
}

/** How many revisions the server has of the note, read through the plugin's client. */
function remoteRevisions(path: string) {
  return browser.executeObsidian(
    async ({ app }, id, filePath) => {
      const vaultSync = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      const vaultId = vaultSync?.connectedVault?.id;
      if (vaultSync === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
      const response = await vaultSync.protocolClient().sync.listChanges({ vaultId, sinceSeq: 0n });
      const decoder = new TextDecoder();
      return response.revisions.filter((revision) => decoder.decode(revision.path) === filePath).length;
    },
    pluginId,
    path,
  );
}

async function waitForIdle(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }, id) => {
        const vaultSync = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
        return vaultSync?.syncStatus.state === "idle" && vaultSync.syncStatus.pending === 0;
      }, pluginId),
    { timeoutMsg: "sync never became idle" },
  );
}

/** The rows of the open history view. */
function historyRows() {
  return browser.executeObsidian(() => [...document.querySelectorAll<HTMLElement>(".vault-sync-history-entry")].map((row) => row.textContent));
}

/** Clicks the history view's row `index` (0 is the newest). */
function clickRow(index: number) {
  return browser.executeObsidian((_, at) => {
    const row = document.querySelectorAll<HTMLElement>(".vault-sync-history-entry")[at];
    if (row === undefined) throw new Error(`no history row ${String(at)}`);
    row.click();
  }, index);
}

/**
 * The paths rendered in `selector` (the first match inside the history view):
 * each element of class vault-sync-path, with its tag, text, dir attribute and
 * computed unicode-bidi, so a test sees whether a path is isolated (#605,
 * #615) and not only the label's text, which is the same either way.
 */
function renderedPaths(selector: string) {
  return browser.executeObsidian((_, target) => {
    const element = document.querySelector(`.vault-sync-history ${target}`);
    if (element === null) throw new Error(`no ${target} in the history view`);
    return [...element.querySelectorAll<HTMLElement>(".vault-sync-path")].map((path) => ({
      tag: path.tagName.toLowerCase(),
      text: path.textContent,
      dir: path.getAttribute("dir"),
      unicodeBidi: getComputedStyle(path).unicodeBidi,
    }));
  }, selector);
}

/** What renderedPaths returns for a label that holds `path` once, isolated. */
function isolated(path: string) {
  return [{ tag: "span", text: path, dir: "auto", unicodeBidi: "isolate" }];
}

function previewText() {
  return browser.executeObsidian(() => document.querySelector(".vault-sync-history-text")?.textContent ?? null);
}

/** Clicks the history view's "Restore this version" button. */
function clickRestore() {
  return browser.executeObsidian(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".vault-sync-history button")].find((candidate) => candidate.textContent === "Restore this version");
    if (button === undefined) throw new Error("no restore button");
    button.click();
  });
}

/** Closes the history view as the user would, with Escape. */
async function closeHistory() {
  await browser.keys("Escape");
  await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".vault-sync-history") === null), { timeoutMsg: "the history view stayed open" });
}

describe("history and restore", function () {
  it("signs in and syncs a note with two versions", async function () {
    await configure();
    expect(await signInAs(subject)).toBe(true);
    await browser.executeObsidian(
      async ({ app }, id, name) => {
        const vaultSync = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
        if (vaultSync === undefined) throw new Error("vault-sync is not loaded");
        await vaultSync.connectVault(await vaultSync.createRemoteVault(name), true);
      },
      pluginId,
      remoteVaultName,
    );
    await browser.executeObsidian(async ({ app }, path, text) => {
      await app.vault.create(path, text);
    }, note, firstVersion);
    await browser.waitUntil(async () => (await remoteRevisions(note)) === 1, { timeoutMsg: "the first version never reached the server" });
    await waitForIdle();
    await browser.executeObsidian(
      async ({ app }, path, text) => {
        const file = app.vault.getFileByPath(path);
        if (file === null) throw new Error(`no ${path}`);
        await app.vault.modify(file, text);
      },
      note,
      secondVersion,
    );
    await browser.waitUntil(async () => (await remoteRevisions(note)) === 2, { timeoutMsg: "the second version never reached the server" });
    await waitForIdle();
  });

  it("lists the note's revisions with time and device, previews one and restores it as a new head", async function () {
    await browser.executeObsidian(async ({ app }, id, path) => {
      await (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id]?.showHistory(path);
    }, pluginId, note);
    await browser.waitUntil(async () => (await historyRows()).length === 2, { timeoutMsg: "the history view never listed two revisions" });
    const rows = await historyRows();
    for (const row of rows) expect(row).toContain(" · this device · ");
    expect(rows[0]).toContain("(current)");

    await clickRow(1);
    await browser.waitUntil(async () => (await previewText()) === firstVersion, { timeoutMsg: "the preview never showed the first version" });
    await clickRestore();

    await browser.waitUntil(async () => (await fileText(note)) === firstVersion, { timeoutMsg: "the note never showed the restored version" });
    await browser.waitUntil(async () => (await historyRows()).length === 3, { timeoutMsg: "the history view never listed the restore" });
    expect(await remoteRevisions(note)).toBe(3);
    await closeHistory();
  });

  it("finds the deleted note among the deleted files and restores it", async function () {
    await browser.executeObsidian(async ({ app }, path) => {
      const file = app.vault.getFileByPath(path);
      if (file === null) throw new Error(`no ${path}`);
      await app.vault.delete(file);
    }, note);
    await browser.waitUntil(async () => (await remoteRevisions(note)) === 4, { timeoutMsg: "the delete never reached the server" });
    await waitForIdle();

    await browser.executeObsidian(async ({ app }, id) => {
      await (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id]?.browseDeletedFiles();
    }, pluginId);
    await browser.waitUntil(async () => browser.executeObsidian(() => [...document.querySelectorAll(".suggestion-item")].some((item) => item.textContent === "History.md")), {
      timeoutMsg: "the deleted note was never listed",
    });
    // The only deleted file is the selected suggestion: Enter chooses it.
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await historyRows()).length === 4, { timeoutMsg: "the deleted note's history was never listed" });
    expect((await historyRows())[0]).toContain("deleted History.md");
    // The path in the title and in the row is laid out on its own (#605).
    expect(await renderedPaths(".modal-title")).toEqual(isolated(note));
    expect(await renderedPaths(".vault-sync-history-entry")).toEqual(isolated(note));

    await clickRow(0);
    await browser.waitUntil(async () => (await previewText()) === firstVersion, { timeoutMsg: "the preview never showed the content at the delete" });
    await clickRestore();

    await browser.waitUntil(async () => (await fileText(note)) === firstVersion, { timeoutMsg: "the deleted note never came back" });
    expect(await remoteRevisions(note)).toBe(5);
    await closeHistory();
  });
  describe("for a member who may not restore (#527)", function () {
    /** Opens the harness's two-version history as `role`, previews the older version and returns what the preview offers once the role check settled. */
    async function previewOlderAs(role: "viewer" | "editor" | "unknown") {
      await callHarness("openHistoryAs", role);
      await browser.waitUntil(async () => (await historyRows()).length === 2, { timeoutMsg: "the history view never listed two revisions" });
      await clickRow(1);
      await browser.waitUntil(async () => (await previewText()) === "the older version\n", { timeoutMsg: "the preview never showed the older version" });
      // The role check settles into either the restore button or the viewer's note.
      await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".vault-sync-history-viewer") !== null || [...document.querySelectorAll(".vault-sync-history button")].some((button) => button.textContent === "Restore this version")), {
        timeoutMsg: "the preview offered neither a restore nor the viewer's note",
      });
      const offered = await browser.executeObsidian(() => ({
        restore: [...document.querySelectorAll(".vault-sync-history button")].some((button) => button.textContent === "Restore this version"),
        viewerNote: document.querySelector(".vault-sync-history-viewer")?.textContent ?? null,
      }));
      await closeHistory();
      return offered;
    }

    it("hides Restore this version from a viewer and says why", async function () {
      expect(await previewOlderAs("viewer")).toEqual({ restore: false, viewerNote: "You can view this vault but not change it, so you cannot restore versions." });
    });

    it("offers Restore this version to an editor", async function () {
      expect(await previewOlderAs("editor")).toEqual({ restore: true, viewerNote: null });
    });

    it("offers Restore this version when the role cannot be read, leaving the decision to the server", async function () {
      expect(await previewOlderAs("unknown")).toEqual({ restore: true, viewerNote: null });
    });
  });

});
