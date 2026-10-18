import { browser, expect } from "@wdio/globals";

import { pluginId } from "../environment";
import { callHarness, reloadPlugin } from "../obsidian";

// Disabling and re-enabling vault-sync resumes sync from the journal instead
// of starting over. The harness drives vault-sync's sync session against an
// in-memory server, over the open vault's IndexedDB journal, opened through
// a new connection for each start: only what it stored survives the
// plugin's disable/enable cycle.

function fileText(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    return file === null ? null : app.vault.read(file);
  }, path);
}

describe("vault-sync disabled and re-enabled", function () {
  it("resumes from the journal without a full resync", async function () {
    await callHarness("setUpSession");

    // First sync on this device: the whole feed, from seq 0.
    expect(await callHarness("startSession")).toEqual({ cursor: "1", applied: 1, listChangesSince: ["0"] });
    expect(await fileText("Synced.md")).toBe("synced from the server\n");

    // Obsidian's own disable and enable path: onunload, then onload.
    expect(await reloadPlugin(pluginId)).toBe(true);

    // Sync starts again from the stored cursor: nothing is pulled again or rewritten.
    expect(await callHarness("startSession")).toEqual({ cursor: "1", applied: 0, listChangesSince: ["1"] });

    // A user edit after re-enabling is reported once, by the new session
    // only: the disabled plugin's session no longer watches the vault.
    await callHarness("modifyFile", "Synced.md", "edited locally\n");
    await callHarness("modifyFile", "Synced.md", "edited again\n");
    await browser.waitUntil(async () => ((await callHarness("sessionLocalChanges"))[1] ?? []).length >= 2);
    expect(await callHarness("sessionLocalChanges")).toEqual([
      [],
      [
        { type: "modify", path: "Synced.md" },
        { type: "modify", path: "Synced.md" },
      ],
    ]);
  });
});
