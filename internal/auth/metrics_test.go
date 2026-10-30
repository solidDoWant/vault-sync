package auth_test

import (
	"math"
	"net/http"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
)

// metricValue returns the value of the unlabeled metric name among metrics'
// collectors.
func metricValue(t *testing.T, metrics *auth.Metrics, name string) float64 {
	t.Helper()

	registry := prometheus.NewPedanticRegistry()
	registry.MustRegister(metrics.Collectors()...)

	families, err := registry.Gather()
	require.NoError(t, err)

	for _, family := range families {
		if family.GetName() != name {
			continue
		}

		require.Len(t, family.GetMetric(), 1)

		metric := family.GetMetric()[0]
		if metric.GetCounter() != nil {
			return metric.GetCounter().GetValue()
		}

		return metric.GetGauge().GetValue()
	}

	require.Failf(t, "metric not gathered", "%s", name)

	return 0
}

func TestKeySetMetricsRecordRefreshesAndTheirFailures(t *testing.T) {
	issuer := authtest.NewTLSIssuer(t)
	key := issuer.AddKey(t, jose.RS256)
	clock := newClock()
	metrics := auth.NewMetrics()
	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL:          issuer.URL,
		Audience:           authtest.DefaultAudience,
		HTTPClient:         issuer.Client(),
		Now:                clock.Now,
		MinRefreshInterval: minRefreshInterval,
		MaxKeyAge:          time.Hour,
		Metrics:            metrics,
	})

	assert.True(t, math.IsNaN(metricValue(t, metrics, "vault_sync_oidc_jwks_age_seconds")), "no age before the first refresh")

	_, err := verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err)

	assert.Zero(t, metricValue(t, metrics, "vault_sync_oidc_jwks_age_seconds"))
	assert.Zero(t, metricValue(t, metrics, "vault_sync_oidc_jwks_refresh_failures_total"))

	clock.Advance(90 * time.Minute)
	assert.Equal(t, (90 * time.Minute).Seconds(), metricValue(t, metrics, "vault_sync_oidc_jwks_age_seconds"))

	// The key set is stale, so the next token refreshes it; the issuer fails.
	issuer.SetMiddleware(func(http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusServiceUnavailable)
		})
	})

	_, err = verifier.Verify(t.Context(), authtest.Sign(t, key, issuer.Claims("alice", clock.Now())))
	require.NoError(t, err, "the cached keys stay in use")

	assert.Equal(t, 1.0, metricValue(t, metrics, "vault_sync_oidc_jwks_refresh_failures_total"))
	assert.Equal(t, (90 * time.Minute).Seconds(), metricValue(t, metrics, "vault_sync_oidc_jwks_age_seconds"), "a failed refresh keeps the age")
}
