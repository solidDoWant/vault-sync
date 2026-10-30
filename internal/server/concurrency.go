package server

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
)

// errTooManyConcurrentRPCs rejects a call from a user already at the limit.
var errTooManyConcurrentRPCs = errors.New("too many concurrent requests from this user; retry once earlier requests complete")

// userLimiter bounds each user's in-flight authenticated RPCs on this
// replica (SPEC.md §12). It holds no cross-replica or client-visible state:
// a user's entry exists only while one of their RPCs is in flight, so idle
// users cost nothing and the map is bounded by the RPCs in flight.
type userLimiter struct {
	limit int

	mu       sync.Mutex
	inFlight map[uuid.UUID]int

	metrics *concurrencyMetrics
}

// concurrencyMetrics are the limiter's Prometheus metrics. No metric is
// labeled by user, so their cardinality is bounded.
type concurrencyMetrics struct {
	rejections    *prometheus.CounterVec
	inFlight      prometheus.Gauge
	inFlightUsers prometheus.Gauge
}

func newConcurrencyMetrics() *concurrencyMetrics {
	return &concurrencyMetrics{
		rejections: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_sync_rpc_concurrency_rejections_total",
			Help: "Authenticated RPCs rejected with resource_exhausted because their user already had VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER calls in flight on this replica, by procedure. These calls are also counted in vault_sync_rpc_requests_total with code resource_exhausted.",
		}, []string{"procedure"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vault_sync_rpc_in_flight",
			Help: "Authenticated RPCs in flight on this replica, counted until their response is written.",
		}),
		inFlightUsers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "vault_sync_rpc_in_flight_users",
			Help: "Users with at least one authenticated RPC in flight on this replica.",
		}),
	}
}

func (metrics *concurrencyMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{metrics.rejections, metrics.inFlight, metrics.inFlightUsers}
}

func newUserLimiter(limit int, metrics *concurrencyMetrics) *userLimiter {
	return &userLimiter{limit: limit, inFlight: map[uuid.UUID]int{}, metrics: metrics}
}

// acquire takes one of user's slots, or reports false when user already
// holds the limit. It never waits.
func (limiter *userLimiter) acquire(user uuid.UUID) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	count := limiter.inFlight[user]
	if count >= limiter.limit {
		return false
	}

	limiter.inFlight[user] = count + 1
	limiter.metrics.inFlight.Inc()
	limiter.metrics.inFlightUsers.Set(float64(len(limiter.inFlight)))

	return true
}

// release returns one of user's slots, forgetting the user when it was
// their last.
func (limiter *userLimiter) release(user uuid.UUID) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	if count := limiter.inFlight[user]; count > 1 {
		limiter.inFlight[user] = count - 1
	} else {
		delete(limiter.inFlight, user)
	}

	limiter.metrics.inFlight.Dec()
	limiter.metrics.inFlightUsers.Set(float64(len(limiter.inFlight)))
}

// rpcSlot is the slot one HTTP request holds, if any. The interceptor
// fills it once the caller is authenticated; the HTTP middleware that
// created it releases it after the response is written. Both run on the
// request's goroutine (Connect runs handlers synchronously in ServeHTTP).
type rpcSlot struct {
	limiter *userLimiter
	user    uuid.UUID
	held    bool
}

func (slot *rpcSlot) release() {
	if slot.held {
		slot.held = false
		slot.limiter.release(slot.user)
	}
}

type rpcSlotKey struct{}

// holdRPCSlots releases the slot a request's RPC takes only once next has
// returned, that is, once its response has been written (or the write
// failed, at the latest when the write timeout expires). A client that stops
// reading its responses therefore keeps holding its slots, and cannot open
// more calls to grow the server's buffers.
func holdRPCSlots(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		slot := &rpcSlot{}
		defer slot.release()

		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), rpcSlotKey{}, slot)))
	})
}

// interceptor returns a Connect interceptor, installed after
// authentication, that takes a slot for every authenticated RPC and
// rejects the call with RESOURCE_EXHAUSTED (reason
// ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS), before its handler runs, when
// the caller has none left. Unauthenticated (public) procedures are not
// counted.
func (limiter *userLimiter) interceptor() connect.Interceptor {
	return limitInterceptor{limiter: limiter}
}

type limitInterceptor struct {
	limiter *userLimiter
}

// admit takes a slot for the caller in ctx. The returned function releases
// it when the request has no HTTP-level slot to hand it to.
func (interceptor limitInterceptor) admit(ctx context.Context, procedure string) (func(), error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return func() {}, nil
	}

	slot, ok := ctx.Value(rpcSlotKey{}).(*rpcSlot)
	if ok && slot.held {
		return func() {}, nil
	}

	if !interceptor.limiter.acquire(user.ID) {
		interceptor.limiter.metrics.rejections.WithLabelValues(procedure).Inc()

		return nil, api.ReasonError(connect.CodeResourceExhausted,
			vaultsyncv1.ErrorReason_ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS, errTooManyConcurrentRPCs)
	}

	if !ok {
		// Without the middleware the slot can only be held until the
		// handler returns.
		return func() { interceptor.limiter.release(user.ID) }, nil
	}

	slot.limiter, slot.user, slot.held = interceptor.limiter, user.ID, true

	return func() {}, nil
}

func (interceptor limitInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().IsClient {
			return next(ctx, request)
		}

		release, err := interceptor.admit(ctx, request.Spec().Procedure)
		if err != nil {
			return nil, err
		}
		defer release()

		return next(ctx, request)
	}
}

func (interceptor limitInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (interceptor limitInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		release, err := interceptor.admit(ctx, conn.Spec().Procedure)
		if err != nil {
			return err
		}
		defer release()

		return next(ctx, conn)
	}
}
