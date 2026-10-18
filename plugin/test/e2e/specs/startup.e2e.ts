import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// Obsidian fires a vault "create" event for every existing file while it
// indexes a vault at startup. The harness plugin watches an Obsidian adapter
// from its onload, i.e. through that indexing; the adapter must report none
// of it.

describe("Obsidian startup indexing", function () {
  it("is not reported as changes, while a later edit is", async function () {
    // Start Obsidian afresh on a vault with several files, nested ones too.
    await browser.reloadObsidian({ vault: "./test/e2e/vaults/indexing" });
    expect(
      await browser.executeObsidian(({ app }) =>
        app.vault
          .getFiles()
          .map((file) => file.path)
          .sort(),
      ),
    ).toEqual(["First note.md", "Folder/Nested/Deep note.md", "Folder/Second note.md", "Folder/data.txt"]);

    // An edit after startup is reported; anything reported before it came from indexing.
    await callHarness("modifyFile", "Folder/Nested/Deep note.md", "edited\n");
    await browser.waitUntil(async () => (await callHarness("eventsSinceLoad")).length > 0);
    expect(await callHarness("eventsSinceLoad")).toEqual([{ type: "modify", path: "Folder/Nested/Deep note.md" }]);
  });
});
