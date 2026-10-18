// Package server wires the vault-sync HTTP server: the ConnectRPC API on one
// listener and /metrics, /healthz and /readyz on a separate one (SPEC.md §12).
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/cors"

	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
)

// AllowedOrigins are the Obsidian app origins allowed to call the API from a
// browser context (SPEC.md §4.1): desktop, mobile (iOS) and mobile (Android).
var AllowedOrigins = []string{"app://obsidian.md", "capacitor://localhost", "http://localhost"}

// HTTP server limits. They bound slow or oversized clients (SPEC.md §2,
// principle 4); request bodies are bounded separately by MaxRequestBytes.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = time.Minute
	idleTimeout       = 2 * time.Minute
	maxHeaderBytes    = 64 << 10
	readinessTimeout  = 2 * time.Second
	corsMaxAgeSeconds = 2 * 60 * 60
)

// Pinger reports whether the database is reachable. *pgxpool.Pool
// implements it.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Options configures a Server.
type Options struct {
	// MaxRequestBytes bounds every request body, after decompression.
	MaxRequestBytes int64
	// ShutdownDelay is how long, once shutdown starts, /readyz fails while
	// the API still serves new connections, so load balancers stop routing
	// here before any connection is refused.
	ShutdownDelay time.Duration
	// ShutdownTimeout bounds how long in-flight requests, and Drainers, may
	// drain after ShutdownDelay.
	ShutdownTimeout time.Duration
	// Drainers own long-lived connections that the HTTP server does not
	// track once upgraded (the realtime hub's WebSockets, SPEC.md §6.4).
	Drainers []Drainer
	// Database is checked by /readyz.
	Database Pinger
	// Authenticator validates bearer tokens. When nil, every procedure not
	// in PublicProcedures is rejected as unauthenticated.
	Authenticator *auth.Authenticator
	// Devices stores devices. When nil, DeviceService is unimplemented.
	Devices api.DeviceStore
	// Vaults stores vaults. When nil, VaultService is unimplemented.
	Vaults api.VaultStore
	// Memberships resolves callers' vault roles for every procedure in
	// VaultProcedures. When nil, every caller is treated as a non-member.
	Memberships authz.MembershipStore
	// Sync serves SyncService. When nil, SyncService is unimplemented. Its
	// Logger defaults to Logger.
	Sync *api.SyncService
	// Blobs serves BlobService. When nil, BlobService is unimplemented. Its
	// Logger defaults to Logger.
	Blobs *api.BlobService
	// Logger receives server logs. Request bodies, tokens and vault paths
	// are never logged.
	Logger *slog.Logger
}

// Drainer is told when the server drains, so that it can end long-lived
// connections the HTTP server's own drain does not wait for. The realtime
// hub implements it by closing every WebSocket with close code 1001 ("going
// away"), so clients reconnect to another instance (SPEC.md §12).
type Drainer interface {
	// Drain is called once, after /readyz has started failing and new
	// connections are no longer accepted, concurrently with the drain of
	// in-flight requests. It returns once its connections are closed, or
	// with ctx's error when ctx (bounded by ShutdownTimeout) ends first.
	Drain(ctx context.Context) error
}

// Server serves the API and the metrics/health endpoints.
type Server struct {
	options  Options
	api      http.Handler
	metrics  http.Handler
	draining atomic.Bool
}

// New builds a Server.
func New(options Options) *Server {
	registry, rpcMetrics := newRegistry()

	srv := &Server{options: options}
	srv.api = newAPIHandler(options, rpcMetrics)
	srv.metrics = srv.newMetricsHandler(registry)

	return srv
}

// Handler returns the API handler.
func (srv *Server) Handler() http.Handler {
	return srv.api
}

// MetricsHandler returns the handler for /metrics, /healthz and /readyz.
func (srv *Server) MetricsHandler() http.Handler {
	return srv.metrics
}

// PublicProcedures are the only procedures served without authentication.
// Every other procedure, including any added later, requires a valid bearer
// token (SPEC.md §9.1): the authentication interceptor is installed on every
// service and denies by default.
var PublicProcedures = []string{
	vaultsyncv1connect.ServerInfoServiceGetServerInfoProcedure,
}

// VaultProcedures classifies every vault-scoped procedure (every procedure
// whose request carries a vault_id) as a read or a write (SPEC.md §9.2). The
// authorization interceptor resolves the caller's role in the vault before
// the handler runs: non-members get NOT_FOUND and viewers calling a write get
// PERMISSION_DENIED. A request carrying a vault_id for a procedure missing
// here is rejected.
var VaultProcedures = map[string]authz.Access{
	vaultsyncv1connect.SyncServiceListChangesProcedure:        authz.Read,
	vaultsyncv1connect.SyncServiceGetRevisionProcedure:        authz.Read,
	vaultsyncv1connect.SyncServiceGetDocumentHistoryProcedure: authz.Read,
	vaultsyncv1connect.SyncServiceCommitRevisionProcedure:     authz.Write,
	vaultsyncv1connect.BlobServiceDownloadBlobProcedure:       authz.Read,
	vaultsyncv1connect.BlobServiceBeginBlobProcedure:          authz.Write,
	vaultsyncv1connect.BlobServicePutBlobChunkProcedure:       authz.Write,
	vaultsyncv1connect.BlobServiceCommitBlobProcedure:         authz.Write,
}

func newAPIHandler(options Options, metrics *rpcMetrics) http.Handler {
	// One option set for every service. Interceptors run outermost first:
	// metrics, then authentication, then vault authorization, so rejected
	// calls are still counted and authorization always knows the caller.
	handlerOptions := []connect.HandlerOption{
		connect.WithInterceptors(
			metrics.interceptor(),
			auth.NewInterceptor(options.Authenticator, PublicProcedures, options.Logger),
			authz.NewInterceptor(options.Memberships, VaultProcedures, options.Logger),
		),
		// Bounds the decoded (and decompressed) message size.
		connect.WithReadMaxBytes(int(options.MaxRequestBytes)),
		// Bounds every response message the same way. DownloadBlob caps
		// its ranges at the chunk size, which fits within this limit.
		connect.WithSendMaxBytes(int(options.MaxRequestBytes)),
	}

	var devices vaultsyncv1connect.DeviceServiceHandler = vaultsyncv1connect.UnimplementedDeviceServiceHandler{}
	if options.Devices != nil {
		devices = api.DeviceService{Devices: options.Devices, Logger: options.Logger}
	}

	var vaults vaultsyncv1connect.VaultServiceHandler = vaultsyncv1connect.UnimplementedVaultServiceHandler{}
	if options.Vaults != nil {
		vaults = api.VaultService{Vaults: options.Vaults, Logger: options.Logger}
	}

	var syncHandler vaultsyncv1connect.SyncServiceHandler = vaultsyncv1connect.UnimplementedSyncServiceHandler{}

	if options.Sync != nil {
		service := *options.Sync
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		syncHandler = service
	}

	var blobs vaultsyncv1connect.BlobServiceHandler = vaultsyncv1connect.UnimplementedBlobServiceHandler{}

	if options.Blobs != nil {
		service := *options.Blobs
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		blobs = service
	}

	mux := http.NewServeMux()
	mux.Handle(vaultsyncv1connect.NewServerInfoServiceHandler(api.ServerInfoService{}, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewVaultServiceHandler(vaults, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewDeviceServiceHandler(devices, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewSyncServiceHandler(syncHandler, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewBlobServiceHandler(blobs, handlerOptions...))

	corsHandler := cors.New(cors.Options{
		AllowedOrigins: AllowedOrigins,
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: append(connectcors.AllowedHeaders(), "Authorization"),
		ExposedHeaders: connectcors.ExposedHeaders(),
		MaxAge:         corsMaxAgeSeconds,
	})

	return corsHandler.Handler(limitRequestBody(options.MaxRequestBytes, mux))
}

// limitRequestBody rejects bodies declared larger than limit outright and
// stops reading any body after limit bytes, so no body is buffered beyond
// the limit.
func limitRequestBody(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.ContentLength > limit {
			http.Error(writer, "request body too large", http.StatusRequestEntityTooLarge)

			return
		}

		request.Body = http.MaxBytesReader(writer, request.Body, limit)
		next.ServeHTTP(writer, request)
	})
}

func (srv *Server) newMetricsHandler(registry *prometheus.Registry) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /readyz", srv.readyz)

	return mux
}

func (srv *Server) readyz(writer http.ResponseWriter, request *http.Request) {
	if srv.draining.Load() {
		http.Error(writer, "shutting down", http.StatusServiceUnavailable)

		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), readinessTimeout)
	defer cancel()

	if err := srv.options.Database.Ping(ctx); err != nil {
		srv.options.Logger.WarnContext(ctx, "readiness check failed: database unreachable", "error", err)
		http.Error(writer, "database unreachable", http.StatusServiceUnavailable)

		return
	}

	_, _ = writer.Write([]byte("ok\n"))
}

// ListenAndServe listens on the API and metrics addresses and serves until
// ctx is canceled (see Serve).
func (srv *Server) ListenAndServe(ctx context.Context, apiAddress, metricsAddress string) error {
	var listenConfig net.ListenConfig

	apiListener, err := listenConfig.Listen(ctx, "tcp", apiAddress)
	if err != nil {
		return fmt.Errorf("listen for API: %w", err)
	}

	metricsListener, err := listenConfig.Listen(ctx, "tcp", metricsAddress)
	if err != nil {
		_ = apiListener.Close()

		return fmt.Errorf("listen for metrics: %w", err)
	}

	return srv.Serve(ctx, apiListener, metricsListener)
}

// Serve serves the API on apiListener and metrics/health on metricsListener
// until ctx is canceled. It then reports not ready on /readyz, keeps serving
// the API for ShutdownDelay (closing each connection after its response),
// stops accepting connections, runs the Drainers, and waits up to
// ShutdownTimeout for in-flight API requests and the Drainers before closing
// the remaining connections. It returns nil after a clean drain, an
// error wrapping context.DeadlineExceeded if the timeout forced connections
// closed, or the error that stopped a listener.
func (srv *Server) Serve(ctx context.Context, apiListener, metricsListener net.Listener) error {
	errorLog := slog.NewLogLogger(srv.options.Logger.Handler(), slog.LevelWarn)
	baseContext := func(net.Listener) context.Context { return context.WithoutCancel(ctx) }

	apiServer := &http.Server{
		Handler:           srv.api,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          errorLog,
		BaseContext:       baseContext,
	}
	metricsServer := &http.Server{
		Handler:           srv.metrics,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          errorLog,
		BaseContext:       baseContext,
	}

	serveErrors := make(chan error, 2)

	go func() { serveErrors <- serve(apiServer, apiListener, "API") }()
	go func() { serveErrors <- serve(metricsServer, metricsListener, "metrics") }()

	srv.options.Logger.InfoContext(ctx, "server started",
		"api_address", apiListener.Addr().String(),
		"metrics_address", metricsListener.Addr().String())

	var serveErr error

	select {
	case <-ctx.Done():
		srv.options.Logger.InfoContext(ctx, "shutting down",
			"delay", srv.options.ShutdownDelay.String(), "timeout", srv.options.ShutdownTimeout.String())
	case serveErr = <-serveErrors:
		srv.options.Logger.ErrorContext(ctx, "listener failed; shutting down", "error", serveErr)
	}

	// Fail readiness first and keep serving for ShutdownDelay, so load
	// balancers stop routing here before any connection is refused.
	// Responses meanwhile close their connections, so clients reconnect
	// (to another instance) instead of reusing this one.
	srv.draining.Store(true)
	apiServer.SetKeepAlivesEnabled(false)

	if serveErr == nil && srv.options.ShutdownDelay > 0 {
		timer := time.NewTimer(srv.options.ShutdownDelay)

		select {
		case <-timer.C:
		case serveErr = <-serveErrors:
			timer.Stop()
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), srv.options.ShutdownTimeout)
	defer cancel()

	// Shutdown runs the drainers once it has closed the listeners.
	drained := srv.registerDrainers(apiServer, shutdownCtx)

	// Drain the API first; metrics and readiness stay up meanwhile.
	shutdownErr := apiServer.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		_ = apiServer.Close()
		shutdownErr = fmt.Errorf("drain API requests: %w", shutdownErr)

		srv.options.Logger.WarnContext(ctx, "shutdown timeout reached; closed remaining connections")
	}

	shutdownErr = errors.Join(shutdownErr, waitForDrainers(shutdownCtx, drained))

	if err := metricsServer.Shutdown(shutdownCtx); err != nil {
		_ = metricsServer.Close()
	}

	if serveErr == nil && shutdownErr == nil {
		srv.options.Logger.InfoContext(ctx, "server stopped")
	}

	return errors.Join(serveErr, shutdownErr)
}

// registerDrainers has apiServer's Shutdown run every Drainer, bounded by
// ctx. The returned channel yields their joined error once all returned.
func (srv *Server) registerDrainers(apiServer *http.Server, ctx context.Context) <-chan error {
	drained := make(chan error, 1)

	if len(srv.options.Drainers) == 0 {
		drained <- nil

		return drained
	}

	apiServer.RegisterOnShutdown(func() {
		errs := make([]error, len(srv.options.Drainers))

		var group sync.WaitGroup

		for index, drainer := range srv.options.Drainers {
			group.Go(func() { errs[index] = drainer.Drain(ctx) })
		}

		group.Wait()

		drained <- errors.Join(errs...)
	})

	return drained
}

// waitForDrainers waits for the drainers' result, but no longer than ctx: a
// drainer ignoring ctx cannot hold up the shutdown.
func waitForDrainers(ctx context.Context, drained <-chan error) error {
	var err error

	select {
	case err = <-drained:
	case <-ctx.Done():
		// Prefer the drainers' own result if they finished meanwhile.
		select {
		case err = <-drained:
		default:
			err = ctx.Err()
		}
	}

	if err != nil {
		return fmt.Errorf("drain long-lived connections: %w", err)
	}

	return nil
}

func serve(server *http.Server, listener net.Listener, name string) error {
	err := server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}

	return fmt.Errorf("serve %s: %w", name, err)
}
