package store

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics are the Prometheus metrics of one connection pool. Set
// Config.Metrics before Open to record them.
type Metrics struct {
	acquired    prometheus.GaugeFunc
	idle        prometheus.GaugeFunc
	waiting     prometheus.Gauge
	acquireTime prometheus.Histogram
	queryErrors prometheus.Counter

	// pool is the pool Open created; nil before.
	pool atomic.Pointer[pgxpool.Pool]
}

// NewMetrics returns unregistered pool metrics.
func NewMetrics() *Metrics {
	metrics := &Metrics{
		waiting: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vault_sync_db_pool_waiting_acquires",
			Help: "Requests for a PostgreSQL connection from this replica's pool in progress. Sustained values near the pool size mean the pool is too small or the database is slow.",
		}),
		acquireTime: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "vault_sync_db_pool_acquire_duration_seconds",
			Help:    "Time to get a PostgreSQL connection from this replica's pool, including waiting for one and opening it.",
			Buckets: prometheus.DefBuckets,
		}),
		queryErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_sync_db_query_errors_total",
			Help: "PostgreSQL queries and statements that failed, including those the server expects and handles (such as a commit losing a race) and those canceled with their request. Alert on a sustained rise.",
		}),
	}

	metrics.acquired = prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "vault_sync_db_pool_acquired_connections",
		Help: "PostgreSQL connections of this replica's pool in use.",
	}, func() float64 { return metrics.stat(func(stat *pgxpool.Stat) int32 { return stat.AcquiredConns() }) })
	metrics.idle = prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "vault_sync_db_pool_idle_connections",
		Help: "Open PostgreSQL connections idle in this replica's pool.",
	}, func() float64 { return metrics.stat(func(stat *pgxpool.Stat) int32 { return stat.IdleConns() }) })

	return metrics
}

// Collectors returns the metrics, for registration.
func (metrics *Metrics) Collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.acquired, metrics.idle, metrics.waiting, metrics.acquireTime, metrics.queryErrors}
}

func (metrics *Metrics) stat(value func(*pgxpool.Stat) int32) float64 {
	pool := metrics.pool.Load()
	if pool == nil {
		return 0
	}

	return float64(value(pool.Stat()))
}

// metricsTracer records acquires and failed queries. pgxpool and pgx call it
// for every pool connection.
type metricsTracer struct {
	metrics *Metrics
}

var (
	_ pgx.QueryTracer       = metricsTracer{}
	_ pgxpool.AcquireTracer = metricsTracer{}
)

type acquireStartedKey struct{}

func (tracer metricsTracer) TraceAcquireStart(ctx context.Context, _ *pgxpool.Pool, _ pgxpool.TraceAcquireStartData) context.Context {
	tracer.metrics.waiting.Inc()

	return context.WithValue(ctx, acquireStartedKey{}, time.Now())
}

func (tracer metricsTracer) TraceAcquireEnd(ctx context.Context, _ *pgxpool.Pool, _ pgxpool.TraceAcquireEndData) {
	tracer.metrics.waiting.Dec()

	if started, ok := ctx.Value(acquireStartedKey{}).(time.Time); ok {
		tracer.metrics.acquireTime.Observe(time.Since(started).Seconds())
	}
}

func (tracer metricsTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}

func (tracer metricsTracer) TraceQueryEnd(_ context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if data.Err != nil {
		tracer.metrics.queryErrors.Inc()
	}
}
