import { expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { vaultAdapterConformance } from "../../../src/core/vault/conformance";
import { callHarness } from "../obsidian";

// Runs the shared VaultAdapter conformance suite (src/core/vault/conformance.ts)
// inside Obsidian's renderer, through the harness plugin, against the adapter
// it names in `adapterUnderTest`: the Obsidian adapter (src/obsidian), over
// the emptied test vault. Case names come from the suite itself, so a
// case added there runs here without changes.

/**
 * Cases that fail on the Android app for a known bug, each with its issue.
 * Skipped there until the bug is fixed; they run everywhere else.
 */
const knownAndroidFailures: Record<string, string> = {
  // Android's shared storage folds case, and Obsidian refuses the rename
  // with "Destination file already exists!" (#544).
  "rename that changes only letter case is allowed": "#544",
};

describe("VaultAdapter conformance inside Obsidian", function () {
  it("runs the harness built from the current suite", async function () {
    expect(await callHarness("conformanceCaseNames")).toEqual(vaultAdapterConformance.map((testCase) => testCase.name));
  });

  for (const testCase of vaultAdapterConformance) {
    it(testCase.name, async function () {
      if (testCase.name in knownAndroidFailures && (await obsidianPage.getPlatform()).isAndroidApp) this.skip();
      const result = await callHarness("runConformanceCase", testCase.name);
      expect(result).toEqual({ ok: true });
    });
  }
});
