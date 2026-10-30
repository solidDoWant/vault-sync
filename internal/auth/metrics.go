package auth

import (
	"math"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Metrics are the Prometheus metrics of the OIDC issuer's key set.
type Metrics struct {
	refreshFailures prometheus.Counter
	age             prometheus.GaugeFunc

	// lastRefresh is the latest successful refresh, with the clock that
	// timed it; nil until the first one.
	lastRefresh atomic.Pointer[keySetRefresh]
}

type keySetRefresh struct {
	now       func() time.Time
	fetchedAt time.Time
}

// NewMetrics returns unregistered key set metrics.
func NewMetrics() *Metrics {
	metrics := &Metrics{
		refreshFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_oidc_jwks_refresh_failures_total",
			Help: "Fetches of the OIDC issuer's discovery document and key set that failed; the server keeps using the keys it has.",
		}),
	}

	metrics.age = prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "vault_sync_oidc_jwks_age_seconds",
		Help: "Seconds since this replica last fetched the OIDC issuer's key set successfully; NaN before the first fetch. Keys are fetched when a token needs them and at most hourly, so on an idle replica the age keeps growing; alert on a high age together with refresh failures.",
	}, metrics.ageSeconds)

	return metrics
}

// Collectors returns the metrics, for registration.
func (metrics *Metrics) Collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.refreshFailures, metrics.age}
}

func (metrics *Metrics) ageSeconds() float64 {
	last := metrics.lastRefresh.Load()
	if last == nil {
		return math.NaN()
	}

	return last.now().Sub(last.fetchedAt).Seconds()
}

// observeRefresh records one fetch of the key set, started at startedAt.
func (metrics *Metrics) observeRefresh(now func() time.Time, startedAt time.Time, err error) {
	if metrics == nil {
		return
	}

	if err != nil {
		metrics.refreshFailures.Inc()

		return
	}

	metrics.lastRefresh.Store(&keySetRefresh{now: now, fetchedAt: startedAt})
}
