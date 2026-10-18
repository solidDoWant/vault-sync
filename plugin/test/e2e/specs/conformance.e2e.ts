import { expect } from "@wdio/globals";

import { vaultAdapterConformance } from "../../../src/core/vault/conformance";
import { callHarness } from "../obsidian";

// Runs the shared VaultAdapter conformance suite (src/core/vault/conformance.ts)
// inside Obsidian's renderer, through the harness plugin, against the adapter
// it names in `adapterUnderTest`: the Obsidian adapter (src/obsidian), over
// the emptied test vault. Case names come from the suite itself, so a
// case added there runs here without changes.

describe("VaultAdapter conformance inside Obsidian", function () {
  it("runs the harness built from the current suite", async function () {
    expect(await callHarness("conformanceCaseNames")).toEqual(vaultAdapterConformance.map((testCase) => testCase.name));
  });

  for (const testCase of vaultAdapterConformance) {
    it(testCase.name, async function () {
      const result = await callHarness("runConformanceCase", testCase.name);
      expect(result).toEqual({ ok: true });
    });
  }
});
