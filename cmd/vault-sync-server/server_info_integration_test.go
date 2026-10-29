//go:build integration

package main_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
)

// publicServerInfoFields are the only fields GetServerInfo may return to an
// unauthenticated caller (SPEC.md §9.1). A new field must be public by
// design; this list is maintained by hand so that adding one is a reviewed
// decision, in step with TestSchemaServerInfoResponseHasOnlyPublicFields in
// internal/api/schema_test.go, which pins the schema's full field set.
var publicServerInfoFields = []string{"version", "protocolVersion", "maxRealtimeSubscriptions", "oidcIssuerUrl", "oidcClientId", "escrowPublicKey", "escrowKeyId", "escrowDefault"}

// Every replica advertises, without authentication, the identity provider
// clients sign in with, and nothing secret from its configuration.
func TestGetServerInfoAdvertisesTheIdentityProviderWithoutSecrets(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)

	const clientID = "obsidian-plugin"

	first := cluster.start(t, "first", binary, config.OIDCClientIDEnv+"="+clientID)
	second := cluster.start(t, "second", binary, config.OIDCClientIDEnv+"="+clientID)

	databaseURL, err := url.Parse(cluster.database.DSN)
	require.NoError(t, err)

	databasePassword, _ := databaseURL.User.Password()

	secrets := map[string]string{
		"database URL": cluster.database.DSN, "database password": databasePassword,
		"first's database URL": first.databaseDSN, "second's database URL": second.databaseDSN,
	}

	for name, path := range map[string]string{"S3 access key id": cluster.objects.AccessKeyIDFile, "S3 secret access key": cluster.objects.SecretAccessKeyFile} {
		content, err := os.ReadFile(path)
		require.NoError(t, err)

		secrets[name] = strings.TrimSpace(string(content))
	}

	for _, server := range []*instance{first, second} {
		body := unauthenticatedServerInfo(t, server.apiURL)

		var fields map[string]any
		require.NoError(t, json.Unmarshal([]byte(body), &fields))

		assert.Equal(t, cluster.issuer.URL, fields["oidcIssuerUrl"], "%s advertises the issuer", server.name)
		assert.Equal(t, clientID, fields["oidcClientId"], "%s advertises the plugin's client id", server.name)

		for field := range fields {
			assert.True(t, slices.Contains(publicServerInfoFields, field), "%s returns unexpected field %q", server.name, field)
		}

		for name, secret := range secrets {
			if secret != "" {
				assert.NotContains(t, body, secret, "%s leaks the %s", server.name, name)
			}
		}
	}
}

// unauthenticatedServerInfo calls GetServerInfo with the Connect JSON codec
// and no Authorization header, and returns the response body.
func unauthenticatedServerInfo(t *testing.T, apiURL string) string {
	t.Helper()

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, apiURL+"/vaultsync.v1.ServerInfoService/GetServerInfo", strings.NewReader("{}"))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")

	response, err := httpClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode, "body: %s", body)

	return string(body)
}
