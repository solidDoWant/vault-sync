import { configDefaults, defineConfig } from "vitest/config";

// The engine property suite's size (src/core/engine/properties.test.ts,
// docs/design/engine-path-ownership.md §9.3): 2,000 cases per property at a
// fixed seed by default, as `make test` runs it; `make test-properties` sets
// VAULT_SYNC_PROPERTY_RUNS (100,000 a night) and VAULT_SYNC_PROPERTY_SEED.
// src/core has no Node types, so the values reach the suite through vitest's
// provide/inject.
function integer(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer of at least ${String(min)}, got ${JSON.stringify(raw)}`);
  return value;
}

export default defineConfig({
  test: {
    // ../sim is the simulation harness (SPEC.md §13); its pure unit tests run
    // here too.
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "../sim/**/*.test.ts"],
    // Network-backed suites run only from `make test-integration`
    // (vitest.integration.config.ts) and `make test-sim` (vitest.sim.config.ts).
    // `**` does not reach outside the root, so ../sim is spelled out.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "../sim/node_modules/**", "../sim/**/*.sim.test.ts"],
    provide: {
      properties: {
        runs: integer("VAULT_SYNC_PROPERTY_RUNS", 2000, 1),
        seed: integer("VAULT_SYNC_PROPERTY_SEED", 563, 0),
      },
    },
  },
});
