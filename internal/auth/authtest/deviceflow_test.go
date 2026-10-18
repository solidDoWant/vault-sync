package authtest_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

func postForm(t *testing.T, target string, form url.Values) (int, map[string]any) {
	t.Helper()

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target, strings.NewReader(form.Encode()))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	body := map[string]any{}
	if response.StatusCode != http.StatusNoContent {
		_ = json.NewDecoder(response.Body).Decode(&body)
	}

	return response.StatusCode, body
}

func TestDeviceFlow(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	flow := issuer.EnableDeviceFlow(t, key, authtest.DeviceFlowOptions{})

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, issuer.URL+"/.well-known/openid-configuration", nil)
	require.NoError(t, err)

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	discovery := map[string]any{}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&discovery))
	require.NoError(t, response.Body.Close())
	assert.Equal(t, issuer.URL+"/device", discovery["device_authorization_endpoint"])
	assert.Equal(t, issuer.URL+"/token", discovery["token_endpoint"])

	status, body := postForm(t, issuer.URL+"/device", url.Values{"client_id": {"someone-else"}})
	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Equal(t, "invalid_client", body["error"])

	status, authorization := postForm(t, issuer.URL+"/device", url.Values{"client_id": {authtest.DefaultAudience}, "scope": {"openid offline_access"}})
	require.Equal(t, http.StatusOK, status)

	deviceCode, _ := authorization["device_code"].(string)
	userCode, _ := authorization["user_code"].(string)
	poll := url.Values{"client_id": {authtest.DefaultAudience}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {deviceCode}}

	status, body = postForm(t, issuer.URL+"/token", poll)
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "authorization_pending", body["error"])

	status, _ = postForm(t, issuer.URL+"/device/approve", url.Values{"user_code": {userCode}})
	require.Equal(t, http.StatusNoContent, status)

	status, tokens := postForm(t, issuer.URL+"/token", poll)
	require.Equal(t, http.StatusOK, status)
	assert.NotEmpty(t, tokens["access_token"])

	// A device code is redeemed once.
	status, body = postForm(t, issuer.URL+"/token", poll)
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "invalid_grant", body["error"])

	refresh := url.Values{"client_id": {authtest.DefaultAudience}, "grant_type": {"refresh_token"}, "refresh_token": {tokens["refresh_token"].(string)}}
	status, _ = postForm(t, issuer.URL+"/token", refresh)
	assert.Equal(t, http.StatusOK, status)

	flow.RevokeRefreshTokens()

	status, body = postForm(t, issuer.URL+"/token", refresh)
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "invalid_grant", body["error"])
	assert.Equal(t, 2, flow.Refreshes())
}

func TestDeviceFlowApprovesAsSubject(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	issuer.EnableDeviceFlow(t, key, authtest.DeviceFlowOptions{Subject: "default-user"})

	tests := []struct {
		name    string
		subject string
		want    string
	}{
		{name: "named subject", subject: "second-user", want: "second-user"},
		{name: "default subject", subject: "", want: "default-user"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, authorization := postForm(t, issuer.URL+"/device", url.Values{"client_id": {authtest.DefaultAudience}})
			require.Equal(t, http.StatusOK, status)

			userCode, _ := authorization["user_code"].(string)
			status, _ = postForm(t, issuer.URL+"/device/approve", url.Values{"user_code": {userCode}, "subject": {test.subject}})
			require.Equal(t, http.StatusNoContent, status)

			deviceCode, _ := authorization["device_code"].(string)
			poll := url.Values{"client_id": {authtest.DefaultAudience}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {deviceCode}}
			status, tokens := postForm(t, issuer.URL+"/token", poll)
			require.Equal(t, http.StatusOK, status)
			assert.Equal(t, test.want, subjectOf(t, tokens["access_token"]))

			// A refresh keeps the subject the authorization was approved as.
			refreshToken, _ := tokens["refresh_token"].(string)
			refresh := url.Values{"client_id": {authtest.DefaultAudience}, "grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
			status, refreshed := postForm(t, issuer.URL+"/token", refresh)
			require.Equal(t, http.StatusOK, status)
			assert.Equal(t, test.want, subjectOf(t, refreshed["access_token"]))
		})
	}
}

func subjectOf(t *testing.T, token any) string {
	t.Helper()

	raw, ok := token.(string)
	require.True(t, ok)

	parsed, err := jose.ParseSigned(raw, []jose.SignatureAlgorithm{jose.ES256})
	require.NoError(t, err)

	claims := map[string]any{}
	require.NoError(t, json.Unmarshal(parsed.UnsafePayloadWithoutVerification(), &claims))

	subject, _ := claims["sub"].(string)

	return subject
}
