import { defineConfig } from "vitest/config";

// Suites that talk to a real server over the network. `make test`
// (vitest.config.ts) excludes them; `make test-integration` runs them through
// cmd/vault-sync-server/client_integration_test.go, which starts the server.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
  },
});
