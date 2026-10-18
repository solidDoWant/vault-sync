import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ../sim is the simulation harness (SPEC.md §13); its pure unit tests run
    // here too.
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "../sim/**/*.test.ts"],
    // Network-backed suites run only from `make test-integration`
    // (vitest.integration.config.ts) and `make test-sim` (vitest.sim.config.ts).
    // `**` does not reach outside the root, so ../sim is spelled out.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "../sim/node_modules/**", "../sim/**/*.sim.test.ts"],
  },
});
