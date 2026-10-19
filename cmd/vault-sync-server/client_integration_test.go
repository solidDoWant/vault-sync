//go:build integration

package main_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// Environment variables through which this test hands the running server
// and tokens to plugin/test/integration/protocol-client.integration.test.ts.
const (
	clientServerURLEnv    = "VAULT_SYNC_IT_SERVER_URL"
	clientTokenEnv        = "VAULT_SYNC_IT_TOKEN"
	clientForeignTokenEnv = "VAULT_SYNC_IT_FOREIGN_TOKEN"
)

// TestPluginProtocolClient runs the plugin's protocol client (TypeScript,
// plugin/src/core/protocol) against the real server binary backed by
// PostgreSQL and a fake OIDC issuer. The assertions live in the vitest suite
// plugin/vitest.integration.config.ts selects; this test provides the server
// and the tokens and fails if that suite fails.
func TestPluginProtocolClient(t *testing.T) {
	database := testinfra.PostgresConfig(t)

	// vitest's launcher runs `#!/usr/bin/env node`.
	_, err := exec.LookPath("node")
	require.NoError(t, err, "Node.js is required to run the plugin integration suite; use `nix develop`")

	pluginDir, err := filepath.Abs(filepath.Join("..", "..", "plugin"))
	require.NoError(t, err)

	// The locally installed vitest, run directly: unlike `npx vitest`, this
	// can never fall back to fetching a package from the network.
	vitest := filepath.Join(pluginDir, "node_modules", ".bin", "vitest")
	_, err = os.Stat(vitest)
	require.NoError(t, err, "plugin dependencies are not installed; run `make test-integration`, which installs them")

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	now := time.Now()
	token := authtest.Sign(t, key, issuer.Claims("plugin-integration-user", now))
	foreignToken := authtest.Sign(t, authtest.NewKey(t, jose.ES256), issuer.Claims("plugin-integration-user", now))

	binary := buildServer(t)
	// Starts a new process, with new addresses, if another process took
	// one of the ports first.
	apiAddress := testinfra.StartServer(t, "server", 30*time.Second, func(addresses testinfra.ServerAddresses) testinfra.ServerProcess {
		logs := &bytes.Buffer{}

		server := newChild(t, binary)
		server.Command.Env = []string{
			config.DatabaseURLEnv + "=" + database.DSN,
			config.ListenAddressEnv + "=" + addresses.API,
			config.MetricsListenAddressEnv + "=" + addresses.Metrics,
			config.OIDCIssuerURLEnv + "=" + issuer.URL,
			config.OIDCAudienceEnv + "=" + authtest.DefaultAudience,
		}
		server.Command.Stdout = logs
		server.Command.Stderr = logs

		// Registered before the server's cleanup, so it runs after the
		// server has been stopped and its output collected.
		t.Cleanup(func() {
			if t.Failed() {
				t.Logf("server logs:\n%s", logs.String())
			}
		})

		server.Start(t)

		return testinfra.ServerProcess{Exited: server.Exited(), Err: server.Err, Output: logs.String}
	}).API

	report := filepath.Join(t.TempDir(), "report.json")

	suite := newChild(t, vitest, "run",
		"--config", "vitest.integration.config.ts",
		"--reporter", "default", "--reporter", "json", "--outputFile.json", report,
	)
	suite.Command.Dir = pluginDir

	suite.Command.Env = append(os.Environ(),
		clientServerURLEnv+"=http://"+apiAddress,
		clientTokenEnv+"="+token,
		clientForeignTokenEnv+"="+foreignToken,
		"CI=1", // no watch mode, no interactive output
	)

	var output bytes.Buffer

	suite.Command.Stdout = &output
	suite.Command.Stderr = &output
	suite.Start(t)

	err = suite.Wait()
	require.NoError(t, err, "plugin integration suite failed:\n%s", output.String())
	t.Logf("plugin integration suite:\n%s", output.String())

	// The suite skips itself when it is not configured; make sure it ran.
	var summary struct {
		NumTotalTests  int `json:"numTotalTests"`
		NumPassedTests int `json:"numPassedTests"`
	}

	raw, err := os.ReadFile(report)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &summary))
	require.Positive(t, summary.NumTotalTests, "the plugin integration suite ran no tests")
	require.Equal(t, summary.NumTotalTests, summary.NumPassedTests, "every plugin integration test must run and pass, none skipped")
}
