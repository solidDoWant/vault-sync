package server

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// rpcMetrics records per-procedure request counts and latencies. Procedures
// are a fixed set (Connect routes only known ones), so label cardinality is
// bounded.
type rpcMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func newRPCMetrics() *rpcMetrics {
	return &rpcMetrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_rpc_requests_total",
			Help: "RPCs handled, by full procedure name (for example /vaultsync.v1.ServerInfoService/GetServerInfo) and Connect status code (ok, unimplemented, ...). Calls rejected for authentication are counted with code unauthenticated. Requests rejected before reaching an RPC handler (oversized declared bodies, unknown routes, malformed messages) are not counted.",
		}, []string{"procedure", "code"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vault_sync_rpc_request_duration_seconds",
			Help:    "Time spent handling each RPC, by procedure and Connect status code.",
			Buckets: prometheus.DefBuckets,
		}, []string{"procedure", "code"}),
	}
}

func (metrics *rpcMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.requests, metrics.duration}
}

// DependencyMetrics are the metrics of the services the server depends on.
type DependencyMetrics struct {
	Database    *store.Metrics
	ObjectStore *blobstore.Metrics
	OIDC        *auth.Metrics
}

func (dependencies DependencyMetrics) collectors() []prometheus.Collector {
	var collected []prometheus.Collector
	if dependencies.Database != nil {
		collected = append(collected, dependencies.Database.Collectors()...)
	}

	if dependencies.ObjectStore != nil {
		collected = append(collected, dependencies.ObjectStore.Collectors()...)
	}

	if dependencies.OIDC != nil {
		collected = append(collected, dependencies.OIDC.Collectors()...)
	}

	return collected
}

// serverCollectors returns every vault_sync_* collector the server
// registers. Every such metric must be registered through this function:
// the Metrics table in docs/configuration.md is checked against it.
func serverCollectors(hub *realtime.Hub, rpc *rpcMetrics, concurrency *concurrencyMetrics, retained *retention.Metrics, dependencies DependencyMetrics) []prometheus.Collector {
	collected := append(rpc.collectors(), concurrency.collectors()...)
	if retained != nil {
		collected = append(collected, retained.Collectors()...)
	}

	collected = append(collected, dependencies.collectors()...)

	if hub != nil {
		collected = append(collected, hub.Collectors()...)
	}

	return collected
}

// newRegistry returns a registry holding the Go runtime and process
// metrics and the given collectors.
func newRegistry(collected []prometheus.Collector) *prometheus.Registry {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	registry.MustRegister(collected...)

	return registry
}

func (metrics *rpcMetrics) observe(procedure string, started time.Time, err error) {
	code := "ok"
	if err != nil {
		code = connect.CodeOf(err).String()
	}

	metrics.requests.WithLabelValues(procedure, code).Inc()
	metrics.duration.WithLabelValues(procedure, code).Observe(time.Since(started).Seconds())
}

// interceptor returns a Connect interceptor recording handler-side metrics.
func (metrics *rpcMetrics) interceptor() connect.Interceptor {
	return metricsInterceptor{metrics: metrics}
}

type metricsInterceptor struct {
	metrics *rpcMetrics
}

func (interceptor metricsInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().IsClient {
			return next(ctx, request)
		}

		started := time.Now()
		response, err := next(ctx, request)
		interceptor.metrics.observe(request.Spec().Procedure, started, err)

		return response, err
	}
}

func (interceptor metricsInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (interceptor metricsInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		started := time.Now()
		err := next(ctx, conn)
		interceptor.metrics.observe(conn.Spec().Procedure, started, err)

		return err
	}
}
