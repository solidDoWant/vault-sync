import { defineConfig } from "vitest/config";

// Acceptance suites that run the sync engine against a real server. `make
// test` (vitest.config.ts) excludes them; the `integration`-tagged Go tests
// in cmd/vault-sync-server/acceptance_integration_test.go (`make
// acceptance`, `make test-integration`) start the server and run one file
// each.
export default defineConfig({
  test: {
    include: ["test/acceptance/**/*.acceptance.test.ts"],
    testTimeout: 10 * 60_000,
  },
});
