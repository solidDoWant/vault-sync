import { browser, expect } from "@wdio/globals";

import { vaultAdapterConformance } from "../../../src/core/vault/conformance";
import { harnessId } from "../environment";
import type { CaseResult, default as VaultSyncE2EHarness } from "../harness/main";

// Runs the shared VaultAdapter conformance suite (src/core/vault/conformance.ts)
// inside Obsidian's renderer, through the harness plugin, against the adapter
// it names in `adapterUnderTest`. Case names come from the suite itself, so a
// case added there runs here without changes.

/** Calls a method of the harness plugin inside Obsidian. */
function callHarness(method: keyof VaultSyncE2EHarness, ...parameters: unknown[]): Promise<unknown> {
  return browser.executeObsidian(
    async ({ app }, id, name, args) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error(`plugin ${id} is not loaded`);
      const target = plugin as Record<string, ((...values: unknown[]) => unknown) | undefined>;
      const run = target[name];
      if (typeof run !== "function") throw new Error(`plugin ${id} has no method ${name}`);
      return await run.apply(plugin, args);
    },
    harnessId,
    method,
    parameters,
  );
}

describe("VaultAdapter conformance inside Obsidian", function () {
  it("runs the harness built from the current suite", async function () {
    expect(await callHarness("conformanceCaseNames")).toEqual(vaultAdapterConformance.map((testCase) => testCase.name));
  });

  for (const testCase of vaultAdapterConformance) {
    it(testCase.name, async function () {
      const result: CaseResult = await callHarness("runConformanceCase", testCase.name) as CaseResult;
      expect(result).toEqual({ ok: true });
    });
  }
});
