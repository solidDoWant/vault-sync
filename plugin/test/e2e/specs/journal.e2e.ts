import { browser, expect } from "@wdio/globals";

import { harnessId } from "../environment";
import { callHarness, reloadPlugin } from "../obsidian";

// The IndexedDB journal inside Obsidian's renderer, on Obsidian's own
// IndexedDB (Chromium's, not fake-indexeddb): what it stores survives a new
// connection, and the journals vault-sync opens are keyed per vault.

describe("IndexedDB journal inside Obsidian", function () {
  it("reads back through a new connection everything it stored", async function () {
    const { written, read } = await callHarness("journalSurvivesReopen");
    expect(read).toBe(written);
  });

  // Journals are keyed by Obsidian's vault id (app.appId, not in the public
  // typings): it must exist and differ between vaults. That journals with
  // different keys in one IndexedDB origin are isolated is a unit test
  // (src/obsidian/journal.test.ts): reloadObsidian relaunches Obsidian with a
  // fresh browser profile, so two vaults never share an origin here.
  // wdio-obsidian-service (3.3.0) gives every vault switch a new
  // --user-data-dir and has no option to keep the old one, so the second
  // vault's cursor of 0 below holds trivially, even with a shared journal
  // key: it only shows the second vault starts from an empty journal. Make it
  // a real isolation check if the service ever lets a profile be reused.
  it("keys each vault's journal by its own Obsidian vault id", async function () {
    const key = { serverUrl: "https://e2e.invalid", vaultId: "isolation" };
    const primary = await callHarness("localVaultId");
    expect(primary).toMatch(/^\S+$/);
    await callHarness("setJournalCursor", key, "5");
    expect(await callHarness("journalCursor", key)).toBe("5");
    // A plugin reload keeps the id, and so the journal.
    expect(await reloadPlugin(harnessId)).toBe(true);
    expect(await callHarness("localVaultId")).toBe(primary);
    expect(await callHarness("journalCursor", key)).toBe("5");

    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });

    const second = await callHarness("localVaultId");
    expect(second).toMatch(/^\S+$/);
    expect(second).not.toBe(primary);
    expect(await callHarness("journalCursor", key)).toBe("0");
  });
});
