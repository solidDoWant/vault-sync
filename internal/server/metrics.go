package server

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// rpcMetrics records per-procedure request counts and latencies. Procedures
// are a fixed set (Connect routes only known ones), so label cardinality is
// bounded.
type rpcMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func newRegistry() (*prometheus.Registry, *rpcMetrics) {
	registry := prometheus.NewRegistry()

	metrics := &rpcMetrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_rpc_requests_total",
			Help: "RPCs handled, by procedure and Connect status code.",
		}, []string{"procedure", "code"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "vault_sync_rpc_request_duration_seconds",
			Help:    "RPC handling time, by procedure and Connect status code.",
			Buckets: prometheus.DefBuckets,
		}, []string{"procedure", "code"}),
	}

	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		metrics.requests,
		metrics.duration,
	)

	return registry, metrics
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
