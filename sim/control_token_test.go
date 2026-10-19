//go:build sim

package sim_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

// TestTokenExpiryOutlivesTheTestDeadline: a run's token stays valid until
// after the `go test` deadline (SIM_TIMEOUT), however far away it is, so a
// long single-seed run never fails with UNAUTHENTICATED (#110).
func TestTokenExpiryOutlivesTheTestDeadline(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	tests := []struct {
		name        string
		deadline    time.Time
		hasDeadline bool
		expected    time.Time
	}{
		{name: "deadline in five hours", deadline: now.Add(5 * time.Hour), hasDeadline: true, expected: now.Add(5*time.Hour + tokenExpiryMargin)},
		{name: "deadline in a minute", deadline: now.Add(time.Minute), hasDeadline: true, expected: now.Add(time.Minute + tokenExpiryMargin)},
		{name: "no deadline", expected: now.Add(unboundedTokenLifetime)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.expected, tokenExpiry(test.deadline, test.hasDeadline, now))
		})
	}
}

// TestControlMintsTokensUntilTheirExpiry: the control endpoint's tokens
// expire at its tokenExpiry, not after a fixed hour.
func TestControlMintsTokensUntilTheirExpiry(t *testing.T) {
	issuer := authtest.NewIssuer(t)
	key := issuer.AddKey(t, jose.ES256)
	expiry := time.Now().Add(3 * time.Hour).Truncate(time.Second)

	server := httptest.NewServer((&control{issuer: issuer, key: key, tokenExpiry: expiry}).handler())
	t.Cleanup(server.Close)

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/token", strings.NewReader("{}"))
	require.NoError(t, err)

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	require.Equal(t, http.StatusOK, response.StatusCode)

	var body struct {
		Token string `json:"token"`
	}

	require.NoError(t, json.NewDecoder(response.Body).Decode(&body))

	parts := strings.Split(body.Token, ".")
	require.Len(t, parts, 3, "a compact JWT")

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)

	var claims struct {
		Expiry  int64  `json:"exp"`
		Subject string `json:"sub"`
	}

	require.NoError(t, json.Unmarshal(payload, &claims))
	assert.Equal(t, expiry.Unix(), claims.Expiry)
	assert.NotEmpty(t, claims.Subject)
}
