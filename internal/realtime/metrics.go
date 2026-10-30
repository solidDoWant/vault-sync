package realtime

import (
	"math"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// metrics are the hub's Prometheus metrics. Every label has a fixed set of
// values.
type metrics struct {
	connections        prometheus.Gauge
	refusals           *prometheus.CounterVec
	disconnects        *prometheus.CounterVec
	notifications      prometheus.Counter
	listenerUp         prometheus.Gauge
	listenerReconnects prometheus.Counter
}

func newMetrics() *metrics {
	return &metrics{
		connections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vault_sync_realtime_connections",
			Help: "Open realtime WebSocket connections on this replica.",
		}),
		refusals: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_realtime_refused_upgrades_total",
			Help: "Realtime WebSocket upgrades refused, by reason: origin, unauthenticated, protocol, user_limit, instance_limit, draining, unavailable.",
		}, []string{"reason"}),
		disconnects: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_realtime_disconnects_total",
			Help: "Realtime WebSocket connections ended, by reason: client, drain, slow_client, rate_limit, invalid_frame, frame_too_large, token_expired, ping_timeout, write_failed.",
		}, []string{"reason"}),
		notifications: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_realtime_notifications_total",
			Help: "vault_changed frames queued to realtime clients.",
		}),
		listenerUp: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vault_sync_realtime_listener_up",
			Help: "1 while this replica listens for commits (PostgreSQL LISTEN), 0 while it reconnects. Alert if it stays 0.",
		}),
		listenerReconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_realtime_listener_reconnects_total",
			Help: "Times the commit listener lost its database connection and reconnected.",
		}),
	}
}

// Collectors returns the hub's Prometheus metrics, for registration.
func (hub *Hub) Collectors() []prometheus.Collector {
	return []prometheus.Collector{
		hub.metrics.connections,
		hub.metrics.refusals,
		hub.metrics.disconnects,
		hub.metrics.notifications,
		hub.metrics.listenerUp,
		hub.metrics.listenerReconnects,
	}
}

// tokenBucket limits a connection's inbound frame rate. It is used by one
// goroutine only.
type tokenBucket struct {
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(rate float64, burst int, now time.Time) *tokenBucket {
	return &tokenBucket{rate: rate, burst: float64(burst), tokens: float64(burst), last: now}
}

// allow takes a token if one is available.
func (bucket *tokenBucket) allow(now time.Time) bool {
	elapsed := now.Sub(bucket.last).Seconds()
	bucket.last = now
	bucket.tokens = math.Min(bucket.burst, bucket.tokens+math.Max(0, elapsed)*bucket.rate)

	if bucket.tokens < 1 {
		return false
	}

	bucket.tokens--

	return true
}
