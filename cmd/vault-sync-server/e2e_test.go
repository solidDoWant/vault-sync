//go:build e2e

package main_test

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// Environment variables through which this driver hands the running server
// and a test token to the plugin e2e suite (plugin/test/e2e/environment.ts).
const (
	e2eServerURLEnv = "VAULT_SYNC_E2E_SERVER_URL"
	e2eTokenEnv     = "VAULT_SYNC_E2E_TOKEN"
)

// TestPluginE2E runs the plugin e2e suite (plugin/wdio.conf.mts): the built
// plugin inside a real, pinned Obsidian driven by WebdriverIO through
// wdio-obsidian-service, against the real server binary backed by
// PostgreSQL and the S3-compatible store, and a fake OIDC issuer. The
// assertions live in plugin/test/e2e/specs; this test provides the server
// and the token and fails if the suite fails. Run it with `make test-e2e`
// (scripts/test-e2e.sh), which starts the dependencies, builds the plugin
// and, on Linux, provides a headless X server; on macOS and Windows CI wraps
// it in scripts/with-native-s3.sh; see docs/testing/e2e.md.
func TestPluginE2E(t *testing.T) {
	// Unlike the integration tests, the e2e suite never skips: a run
	// without its database would prove nothing.
	require.NotEmpty(t, os.Getenv(testinfra.DatabaseURLEnv), "%s must point at PostgreSQL; run `make test-e2e`", testinfra.DatabaseURLEnv)

	// Nor does it run without its object store: a spec that syncs content
	// must fail, not skip, when there is nowhere to put the blobs.
	for _, variable := range []string{testinfra.S3EndpointEnv, testinfra.S3RegionEnv, testinfra.S3AccessKeyEnv, testinfra.S3SecretKeyEnv} {
		require.NotEmpty(t, os.Getenv(variable), "%s must be set for the S3-compatible store; run `make test-e2e`", variable)
	}

	database := testinfra.PostgresConfig(t)

	_, err := exec.LookPath("node")
	require.NoError(t, err, "Node.js is required to run the plugin e2e suite; use `nix develop`")

	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	require.NoError(t, err)

	pluginDir := filepath.Join(repoRoot, "plugin")

	// The locally installed WebdriverIO CLI, run with node directly: it
	// works the same on every OS (no .cmd shims) and never fetches a
	// package from the network, unlike npx.
	wdio := filepath.Join(pluginDir, "node_modules", "@wdio", "cli", "bin", "wdio.js")
	_, err = os.Stat(wdio)
	require.NoError(t, err, "plugin dependencies are not installed; run `make test-e2e`, which installs them")

	_, err = os.Stat(filepath.Join(pluginDir, "dist", "main.js"))
	require.NoError(t, err, "the plugin is not built; run `make test-e2e`, which builds it")

	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	token := authtest.Sign(t, key, issuer.Claims("plugin-e2e-user", time.Now()))

	binary := testinfra.BuildServer(t, repoRoot)
	apiAddress := testinfra.FreeAddress(t)
	metricsAddress := testinfra.FreeAddress(t)

	serverEnv := []string{
		config.DatabaseURLEnv + "=" + database.DSN,
		config.ListenAddressEnv + "=" + apiAddress,
		config.MetricsListenAddressEnv + "=" + metricsAddress,
		config.OIDCIssuerURLEnv + "=" + issuer.URL,
		config.OIDCAudienceEnv + "=" + authtest.DefaultAudience,
		config.LogLevelEnv + "=warn",
		// Stop at once when the test ends.
		config.ShutdownDelayEnv + "=0s",
	}

	bucket := testinfra.S3Bucket(t)
	serverEnv = append(serverEnv,
		config.S3EndpointEnv+"="+bucket.Endpoint,
		config.S3RegionEnv+"="+bucket.Region,
		config.S3BucketEnv+"="+bucket.Bucket,
		config.S3AccessKeyIDFileEnv+"="+bucket.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv+"="+bucket.SecretAccessKeyFile,
		config.S3ForcePathStyleEnv+"=true",
	)

	logs := &bytes.Buffer{}
	server := testinfra.NewChild(t, binary)
	// The OS environment (Windows needs SYSTEMROOT and friends) without
	// any VAULT_SYNC_* settings of the caller, then the test's own.
	server.Command.Env = append(withoutServerSettings(os.Environ()), serverEnv...)
	server.Command.Stdout = logs
	server.Command.Stderr = logs

	// Registered before the server's cleanup, so it runs after the server
	// has been stopped and its output collected.
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server logs:\n%s", logs.String())
		}
	})

	server.Start(t)

	require.Eventually(t, func() bool {
		response, err := http.Get("http://" + metricsAddress + "/readyz")
		if err != nil {
			return false
		}

		defer func() { _ = response.Body.Close() }()

		_, _ = io.Copy(io.Discard, response.Body)

		return response.StatusCode == http.StatusOK
	}, 60*time.Second, 50*time.Millisecond, "server must become ready")

	suite := testinfra.NewChild(t, "node", wdio, "run", "wdio.conf.mts")
	suite.Command.Dir = pluginDir

	suite.Command.Env = append(os.Environ(),
		e2eServerURLEnv+"=http://"+apiAddress,
		e2eTokenEnv+"="+token,
		"CI=1", // no interactive output
	)
	// Streamed, so that a slow first run (it downloads Obsidian) shows
	// progress.
	suite.Command.Stdout = os.Stdout
	suite.Command.Stderr = os.Stderr
	suite.Start(t)

	require.NoError(t, suite.Wait(), "plugin e2e suite failed (see its output above)")
}

// withoutServerSettings drops every VAULT_SYNC_* variable from environ.
func withoutServerSettings(environ []string) []string {
	kept := make([]string, 0, len(environ))

	for _, variable := range environ {
		if strings.HasPrefix(variable, "VAULT_SYNC_") {
			continue
		}

		kept = append(kept, variable)
	}

	return kept
}
