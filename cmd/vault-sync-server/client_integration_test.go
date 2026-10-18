//go:build integration

package main_test

import (
	"bytes"
	"encoding/json"
	"net/http"
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

	npx, err := exec.LookPath("npx")
	require.NoError(t, err, "npx (Node.js) is required to run the plugin integration suite; use `nix develop`")

	pluginDir, err := filepath.Abs(filepath.Join("..", "..", "plugin"))
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(pluginDir, "node_modules", ".bin", "vitest"))
	require.NoError(t, err, "plugin dependencies are not installed; run `make test-integration`, which installs them")

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	now := time.Now()
	token := authtest.Sign(t, key, issuer.Claims("plugin-integration-user", now))
	foreignToken := authtest.Sign(t, authtest.NewKey(t, jose.ES256), issuer.Claims("plugin-integration-user", now))

	binary := buildServer(t)
	apiAddress := freeAddress(t)
	metricsAddress := freeAddress(t)

	var logs bytes.Buffer

	server := exec.CommandContext(t.Context(), binary)
	server.Env = []string{
		config.DatabaseURLEnv + "=" + database.DSN,
		config.ListenAddressEnv + "=" + apiAddress,
		config.MetricsListenAddressEnv + "=" + metricsAddress,
		config.OIDCIssuerURLEnv + "=" + issuer.URL,
		config.OIDCAudienceEnv + "=" + authtest.DefaultAudience,
	}
	server.Stdout = &logs
	server.Stderr = &logs
	require.NoError(t, server.Start())

	t.Cleanup(func() {
		_ = server.Process.Kill()
		_ = server.Wait()

		if t.Failed() {
			t.Logf("server logs:\n%s", logs.String())
		}
	})

	require.Eventually(t, func() bool {
		status, err := httpGet("http://" + metricsAddress + "/readyz")

		return err == nil && status == http.StatusOK
	}, 30*time.Second, 50*time.Millisecond, "server must become ready")

	report := filepath.Join(t.TempDir(), "report.json")

	suite := exec.CommandContext(t.Context(), npx, "vitest", "run",
		"--config", "vitest.integration.config.ts",
		"--reporter", "default", "--reporter", "json", "--outputFile.json", report,
	)
	suite.Dir = pluginDir

	suite.Env = append(os.Environ(),
		clientServerURLEnv+"=http://"+apiAddress,
		clientTokenEnv+"="+token,
		clientForeignTokenEnv+"="+foreignToken,
		"CI=1", // no watch mode, no interactive output
	)
	output, err := suite.CombinedOutput()
	require.NoError(t, err, "plugin integration suite failed:\n%s", output)
	t.Logf("plugin integration suite:\n%s", output)

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
