import { describe, expect, it } from "vitest";

import type { VaultAdapter } from "./adapter";
import { ConformanceFailure, runConformanceCase, vaultAdapterConformance, type ConformanceCase } from "./conformance";
import { InMemoryVault } from "./memory";

const fast = { eventTimeoutMs: 200, quietPeriodMs: 10 };

describe("InMemoryVault", () => {
  describe("VaultAdapter conformance", () => {
    for (const testCase of vaultAdapterConformance) {
      it(testCase.name, async () => {
        await runConformanceCase(testCase, () => ({ adapter: new InMemoryVault() }), fast);
      });
    }
  });

  it("uses the injected clock for mtimes", async () => {
    let now = 1_000;
    const vault = new InMemoryVault({ now: () => now });
    await vault.write("a.md", new Uint8Array([1]));
    now = 2_000;
    await vault.rename("a.md", "b.md");
    expect(await vault.stat("b.md")).toEqual({ size: 1, mtime: 1_000 });
    await vault.write("b.md", new Uint8Array([2]));
    expect(await vault.stat("b.md")).toEqual({ size: 1, mtime: 2_000 });
  });

  it("keeps state consistent when a listener throws", async () => {
    const vault = new InMemoryVault();
    const seen: string[] = [];
    const errors: unknown[] = [];
    vault.watch(() => {
      throw new Error("listener bug");
    });
    vault.watch((event) => seen.push(event.type));
    const reported = new Promise<void>((resolve) => {
      vault.onListenerError = (error) => {
        errors.push(error);
        resolve();
      };
    });

    await vault.write("a.md", new Uint8Array([1]));
    await reported;

    expect(await vault.list()).toEqual(["a.md"]);
    expect(seen).toEqual(["create"]);
    expect(errors).toHaveLength(1);
  });
});

/**
 * The conformance suite must catch broken adapters, or the Obsidian adapter
 * passing it would prove nothing. Each mutant breaks one contract.
 */
describe("VaultAdapter conformance suite", () => {
  class SilentVault extends InMemoryVault {
    // Accepts listeners but never calls them.
    override watch(): () => void {
      return () => undefined;
    }
  }

  class ClobberingVault extends InMemoryVault {
    override async rename(from: string, to: string): Promise<void> {
      if ((await this.stat(to)) !== null) await this.delete(to);
      await super.rename(from, to);
    }
  }

  class AliasingVault extends InMemoryVault {
    private readonly raw = new Map<string, Uint8Array>();
    override async write(path: string, data: Uint8Array): Promise<void> {
      await super.write(path, data);
      this.raw.set(path, data);
    }
    override async read(path: string): Promise<Uint8Array> {
      await super.read(path);
      return this.raw.get(path) ?? new Uint8Array();
    }
  }

  class FlatVault extends InMemoryVault {
    override async write(path: string, data: Uint8Array): Promise<void> {
      await super.write(path.replaceAll("/", "_"), data);
    }
  }

  const mutants: [string, () => VaultAdapter, string][] = [
    ["an adapter that never reports events", () => new SilentVault(), "changes are reported as events in order"],
    ["an adapter whose rename overwrites", () => new ClobberingVault(), "rename onto an existing file fails and changes nothing"],
    ["an adapter that aliases caller buffers", () => new AliasingVault(), "stored content is isolated from caller buffers"],
    ["an adapter that mangles folder paths", () => new FlatVault(), "write creates missing parent folders"],
  ];

  for (const [name, create, caseName] of mutants) {
    it(`fails ${name}`, async () => {
      const testCase = vaultAdapterConformance.find((candidate: ConformanceCase) => candidate.name === caseName);
      expect(testCase).toBeDefined();
      if (testCase === undefined) return;
      await expect(runConformanceCase(testCase, () => ({ adapter: create() }), fast)).rejects.toBeInstanceOf(ConformanceFailure);
    });
  }
});
