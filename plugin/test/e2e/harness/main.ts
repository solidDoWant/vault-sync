import { Plugin } from "obsidian";

import { runConformanceCase, vaultAdapterConformance, type VaultAdapterFactory } from "../../../src/core/vault/conformance";
import { InMemoryVault } from "../../../src/core/vault/memory";

/** What the e2e specs get back from a case run inside Obsidian. */
export type CaseResult = { ok: true } | { ok: false; error: string };

/**
 * Test-only plugin, installed next to vault-sync by the e2e suite
 * (wdio.conf.mts bundles it). The specs reach it through
 * `browser.executeObsidian` to run code inside Obsidian's renderer that a
 * stringified function cannot carry, such as the VaultAdapter conformance
 * suite. Never shipped.
 */
export default class VaultSyncE2EHarness extends Plugin {
  /**
   * The adapter the conformance spec runs inside Obsidian. Until the Obsidian
   * adapter exists this is the in-memory one, which proves the harness; #24
   * switches this one line to the Obsidian adapter over `this.app`.
   */
  readonly adapterUnderTest: VaultAdapterFactory = () => ({ adapter: new InMemoryVault() });

  /** The conformance case names, in suite order. */
  conformanceCaseNames(): string[] {
    return vaultAdapterConformance.map((testCase) => testCase.name);
  }

  /** Runs one conformance case against a fresh adapter from adapterUnderTest. */
  async runConformanceCase(name: string): Promise<CaseResult> {
    const testCase = vaultAdapterConformance.find((candidate) => candidate.name === name);
    if (testCase === undefined) return { ok: false, error: `no conformance case named ${JSON.stringify(name)}` };
    try {
      await runConformanceCase(testCase, this.adapterUnderTest);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }
}
