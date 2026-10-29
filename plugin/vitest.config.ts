import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Network-backed suites run only from `make test-integration`
    // (vitest.integration.config.ts) and `make acceptance`
    // (vitest.acceptance.config.ts).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "**/*.acceptance.test.ts"],
  },
});
