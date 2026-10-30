// Package server wires the vault-sync HTTP server: the ConnectRPC API on one
// listener, /metrics, /healthz and /readyz on a second one and the
// service-wide /metrics on a third (SPEC.md §12).
package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/cors"
	"golang.org/x/sync/singleflight"

	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/servicemetrics"
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
	// metricsWriteTimeout bounds metrics, health and readiness responses.
	// The metrics listener serves no long-lived connections, so a plain
	// http.Server WriteTimeout applies there.
	metricsWriteTimeout = time.Minute
	maxHeaderBytes      = 64 << 10
	readinessTimeout    = 2 * time.Second
	corsMaxAgeSeconds   = 2 * 60 * 60
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
	// WriteTimeout bounds how long writing an API response may take,
	// counted from its first byte, so a client that stops reading cannot
	// hold a connection and handler indefinitely. It does not bound how
	// long the handler runs before it responds, and it does not apply to
	// the realtime WebSocket once upgraded. Zero means
	// config.DefaultWriteTimeout.
	WriteTimeout time.Duration
	// MaxConcurrentRPCsPerUser bounds the authenticated RPCs one user may
	// have in flight on this server, from authentication until the
	// response is written. Further calls are rejected at once with
	// RESOURCE_EXHAUSTED, before their handler runs. Zero means
	// config.DefaultMaxConcurrentRPCsPerUser.
	MaxConcurrentRPCsPerUser int
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
	// OIDCIssuerURL and OIDCClientID are the identity provider clients sign
	// in with, advertised to unauthenticated callers by GetServerInfo. Both
	// are public; never put a secret here.
	OIDCIssuerURL string
	OIDCClientID  string
	// Escrow is the deployment's escrow public key and default, published
	// by GetServerInfo; CreateVault refuses escrow vaults without a key.
	Escrow api.Escrow
	// Devices stores devices. When nil, DeviceService is unimplemented.
	Devices api.DeviceStore
	// Vaults stores vaults. When nil, VaultService is unimplemented.
	Vaults api.VaultStore
	// Memberships resolves callers' vault roles for every procedure in
	// VaultProcedures. When nil, every caller is treated as a non-member.
	Memberships authz.MembershipStore
	// Membership serves MembershipService. When nil, MembershipService is
	// unimplemented. Its Logger defaults to Logger.
	Membership *api.MembershipService
	// UserKeys serves UserKeyService. When nil, UserKeyService is
	// unimplemented. Its Logger defaults to Logger.
	UserKeys *api.UserKeyService
	// VaultKeys serves VaultKeyService. When nil, VaultKeyService is
	// unimplemented. Its Logger defaults to Logger; its response limit is
	// the send limit.
	VaultKeys *api.VaultKeyService
	// EscrowJobs serves EscrowJobService, the export job's escrow rotation
	// writes, to callers presenting EscrowJobToken only. Without a token
	// every call is refused as unauthenticated; when nil, the service is
	// unimplemented behind the token check. Its Logger defaults to Logger.
	EscrowJobs *api.EscrowJobService
	// EscrowJobToken is the static bearer token of EscrowJobService
	// (VAULT_SYNC_ESCROW_JOB_TOKEN_FILE).
	EscrowJobToken []byte
	// Sync serves SyncService. When nil, SyncService is unimplemented. Its
	// Logger defaults to Logger.
	Sync *api.SyncService
	// Blobs serves BlobService. When nil, BlobService is unimplemented. Its
	// Logger defaults to Logger.
	Blobs *api.BlobService
	// Realtime serves the realtime WebSocket at realtime.Path and is drained
	// with the server. When nil, the realtime channel is not served.
	Realtime *realtime.Hub
	// Retention holds the retention job's metrics, served with the
	// server's. When nil, they are not served.
	Retention *retention.Metrics
	// ServiceMetrics holds the service-wide metrics, served on their own
	// listener. When nil, that listener serves no metrics.
	ServiceMetrics *servicemetrics.Metrics
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
	options Options
	api     http.Handler
	metrics http.Handler
	// serviceMetrics serves the service-wide /metrics.
	serviceMetrics http.Handler
	draining       atomic.Bool
	// readiness shares one database ping among concurrent /readyz calls.
	readiness singleflight.Group
}

// New builds a Server.
func New(options Options) *Server {
	if options.Realtime != nil {
		// The hub's WebSockets outlive the HTTP server's own drain.
		options.Drainers = append(slices.Clip(options.Drainers), options.Realtime)
	}

	if options.WriteTimeout <= 0 {
		options.WriteTimeout = config.DefaultWriteTimeout
	}

	if options.MaxConcurrentRPCsPerUser <= 0 {
		options.MaxConcurrentRPCsPerUser = config.DefaultMaxConcurrentRPCsPerUser
	}

	rpcMetrics := newRPCMetrics()
	concurrency := newConcurrencyMetrics()
	registry := newRegistry(serverCollectors(options.Realtime, rpcMetrics, concurrency, options.Retention))

	srv := &Server{options: options}
	srv.api = newAPIHandler(options, rpcMetrics, newUserLimiter(options.MaxConcurrentRPCsPerUser, concurrency))
	srv.metrics = srv.newMetricsHandler(registry)

	if options.ServiceMetrics == nil {
		options.ServiceMetrics = servicemetrics.NewMetrics()
	}

	srv.serviceMetrics = options.ServiceMetrics.Handler()

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

// ServiceMetricsHandler returns the handler for the service-wide /metrics.
func (srv *Server) ServiceMetricsHandler() http.Handler {
	return srv.serviceMetrics
}

// PublicProcedures are the only procedures served without authentication.
// Every other procedure, including any added later, requires a valid bearer
// token (SPEC.md §9.1): the authentication interceptor is installed on every
// service and denies by default.
var PublicProcedures = []string{
	vaultsyncv1connect.ServerInfoServiceGetServerInfoProcedure,
}

// VaultProcedures classifies every vault-scoped procedure (every procedure
// whose request carries a vault_id) as a read, a write or a manage (owner
// only) procedure (SPEC.md §9.2). The authorization interceptor resolves the
// caller's role in the vault before the handler runs: non-members get
// NOT_FOUND, viewers calling a write and non-owners calling a manage
// procedure get PERMISSION_DENIED. A request carrying a vault_id for a procedure missing
// here is rejected.
var VaultProcedures = map[string]authz.Access{
	vaultsyncv1connect.SyncServiceListChangesProcedure:            authz.Read,
	vaultsyncv1connect.SyncServiceGetRevisionProcedure:            authz.Read,
	vaultsyncv1connect.SyncServiceGetDocumentHistoryProcedure:     authz.Read,
	vaultsyncv1connect.SyncServiceCommitRevisionProcedure:         authz.Write,
	vaultsyncv1connect.BlobServiceDownloadBlobProcedure:           authz.Read,
	vaultsyncv1connect.BlobServiceBeginBlobProcedure:              authz.Write,
	vaultsyncv1connect.BlobServicePutBlobChunkProcedure:           authz.Write,
	vaultsyncv1connect.BlobServiceCommitBlobProcedure:             authz.Write,
	vaultsyncv1connect.MembershipServiceCreateInvitationProcedure: authz.Manage,
	vaultsyncv1connect.MembershipServiceListInvitationsProcedure:  authz.Manage,
	vaultsyncv1connect.MembershipServiceRevokeInvitationProcedure: authz.Manage,
	vaultsyncv1connect.MembershipServiceListMembersProcedure:      authz.Manage,
	vaultsyncv1connect.MembershipServiceUpdateMemberRoleProcedure: authz.Manage,
	vaultsyncv1connect.MembershipServiceRemoveMemberProcedure:     authz.Manage,
	// Any member may leave; the last owner cannot (SPEC.md §9.2).
	vaultsyncv1connect.MembershipServiceLeaveVaultProcedure: authz.Read,
	// Every member reads the epochs and their own key slots, which they
	// need to read the vault; only owners wrap keys (SPEC.md §9.3).
	vaultsyncv1connect.VaultKeyServiceListKeySlotsProcedure: authz.Read,
	vaultsyncv1connect.VaultKeyServiceListEpochsProcedure:   authz.Read,
	// Every member replays the membership log (docs/design/crypto.md), and
	// so does a newcomer holding a pending invitation's id before it signs
	// its redeem entry (docs/design/encryption.md).
	vaultsyncv1connect.VaultKeyServiceListLogEntriesProcedure:   authz.ReadOrInvitation,
	vaultsyncv1connect.VaultKeyServiceListMissingSlotsProcedure: authz.Manage,
	vaultsyncv1connect.VaultKeyServiceRotateEpochProcedure:      authz.Manage,
	vaultsyncv1connect.VaultKeyServiceAddKeySlotsProcedure:      authz.Manage,
	// Only owners run the re-key job and retire epochs
	// (docs/design/encryption.md, "Re-encrypting history").
	vaultsyncv1connect.VaultKeyServiceListStaleRevisionsProcedure:        authz.Manage,
	vaultsyncv1connect.VaultKeyServiceReplaceRevisionCiphertextProcedure: authz.Manage,
	vaultsyncv1connect.VaultKeyServiceRetireEpochProcedure:               authz.Manage,
	vaultsyncv1connect.VaultKeyServiceConvertVaultProcedure:              authz.Manage,
	// Only owners delete a vault (docs/design/sharing.md).
	vaultsyncv1connect.VaultServiceDeleteVaultProcedure: authz.Manage,
}

func newAPIHandler(options Options, metrics *rpcMetrics, limiter *userLimiter) http.Handler {
	// One option set for every service. Interceptors run outermost first:
	// metrics, then authentication, then the per-user concurrency limit,
	// then vault authorization, so rejected calls are still counted, the
	// limit is keyed by the authenticated caller and checked before any
	// database work, and authorization always knows the caller.
	handlerOptions := []connect.HandlerOption{
		connect.WithInterceptors(
			metrics.interceptor(),
			auth.NewInterceptor(options.Authenticator, PublicProcedures, options.Logger),
			limiter.interceptor(),
			authz.NewInterceptor(options.Memberships, VaultProcedures, options.Logger),
		),
		// Bounds the decoded (and decompressed) message size.
		connect.WithReadMaxBytes(int(options.MaxRequestBytes)),
		// Bounds every response message by the bytes sent (after
		// compression, when the client accepts it). Pages of revisions and
		// DownloadBlob ranges are cut to fit it in the request's codec:
		// binary ranges at the chunk size, JSON ranges smaller, as base64
		// expands them by a third.
		connect.WithSendMaxBytes(int(options.MaxRequestBytes)),
	}

	var devices vaultsyncv1connect.DeviceServiceHandler = vaultsyncv1connect.UnimplementedDeviceServiceHandler{}
	if options.Devices != nil {
		devices = api.DeviceService{Devices: options.Devices, Logger: options.Logger}
	}

	var vaults vaultsyncv1connect.VaultServiceHandler = vaultsyncv1connect.UnimplementedVaultServiceHandler{}
	if options.Vaults != nil {
		// Pages of vaults are cut to fit the send limit, so a client can
		// always list all of its vaults.
		vaults = api.VaultService{
			Vaults: options.Vaults,
			Limits: api.VaultLimits{MaxResponseBytes: int(options.MaxRequestBytes)},
			Escrow: options.Escrow,
			Logger: options.Logger,
		}
	}

	var syncHandler vaultsyncv1connect.SyncServiceHandler = vaultsyncv1connect.UnimplementedSyncServiceHandler{}

	if options.Sync != nil {
		service := *options.Sync
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		// Pages of revisions are cut to fit the send limit, so a client
		// can always advance its cursor (SPEC.md §6.1).
		if service.Limits.MaxResponseBytes <= 0 || service.Limits.MaxResponseBytes > int(options.MaxRequestBytes) {
			service.Limits.MaxResponseBytes = int(options.MaxRequestBytes)
		}

		syncHandler = service
	}

	var blobs vaultsyncv1connect.BlobServiceHandler = vaultsyncv1connect.UnimplementedBlobServiceHandler{}

	if options.Blobs != nil {
		service := *options.Blobs
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		// JSON chunks and ranges are cut to fit the request and send
		// limit once base64-encoded (SPEC.md §6.2).
		if service.Limits.MaxMessageBytes <= 0 || service.Limits.MaxMessageBytes > options.MaxRequestBytes {
			service.Limits.MaxMessageBytes = options.MaxRequestBytes
		}

		blobs = service
	}

	var membership vaultsyncv1connect.MembershipServiceHandler = vaultsyncv1connect.UnimplementedMembershipServiceHandler{}

	if options.Membership != nil {
		service := *options.Membership
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		membership = service
	}

	var userKeys vaultsyncv1connect.UserKeyServiceHandler = vaultsyncv1connect.UnimplementedUserKeyServiceHandler{}

	if options.UserKeys != nil {
		service := *options.UserKeys
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		userKeys = service
	}

	var vaultKeys vaultsyncv1connect.VaultKeyServiceHandler = vaultsyncv1connect.UnimplementedVaultKeyServiceHandler{}

	if options.VaultKeys != nil {
		service := *options.VaultKeys
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		// Pages of slots and epochs are cut to fit the send limit.
		if service.Limits.MaxResponseBytes <= 0 || service.Limits.MaxResponseBytes > int(options.MaxRequestBytes) {
			service.Limits.MaxResponseBytes = int(options.MaxRequestBytes)
		}

		vaultKeys = service
	}

	mux := http.NewServeMux()
	serverInfo := api.ServerInfoService{OIDCIssuerURL: options.OIDCIssuerURL, OIDCClientID: options.OIDCClientID, Escrow: options.Escrow}

	if options.Realtime != nil {
		serverInfo.MaxRealtimeSubscriptions = uint32(options.Realtime.MaxSubscriptions()) //nolint:gosec // bounded by configuration.

		// The hub authenticates and authorizes its upgrades itself, with
		// the same authenticator and membership checks (SPEC.md §6.4).
		mux.Handle("GET "+realtime.Path, options.Realtime)
	}

	mux.Handle(vaultsyncv1connect.NewServerInfoServiceHandler(serverInfo, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewVaultServiceHandler(vaults, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewDeviceServiceHandler(devices, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewMembershipServiceHandler(membership, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewUserKeyServiceHandler(userKeys, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewVaultKeyServiceHandler(vaultKeys, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewSyncServiceHandler(syncHandler, handlerOptions...))
	mux.Handle(vaultsyncv1connect.NewBlobServiceHandler(blobs, handlerOptions...))

	// The escrow job service authenticates by its job token alone: neither
	// the OIDC authenticator nor vault authorization is in its chain, so a
	// user's token never reaches it. Without a token it refuses every call.
	var escrowJobs vaultsyncv1connect.EscrowJobServiceHandler = vaultsyncv1connect.UnimplementedEscrowJobServiceHandler{}

	if options.EscrowJobs != nil && len(options.EscrowJobToken) > 0 {
		service := *options.EscrowJobs
		if service.Logger == nil {
			service.Logger = options.Logger
		}

		escrowJobs = service
	}

	mux.Handle(vaultsyncv1connect.NewEscrowJobServiceHandler(escrowJobs,
		connect.WithInterceptors(metrics.interceptor(), auth.NewJobTokenInterceptor(options.EscrowJobToken)),
		connect.WithReadMaxBytes(int(options.MaxRequestBytes)),
		connect.WithSendMaxBytes(int(options.MaxRequestBytes)),
	))

	corsHandler := cors.New(cors.Options{
		AllowedOrigins: AllowedOrigins,
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: append(connectcors.AllowedHeaders(), "Authorization"),
		ExposedHeaders: connectcors.ExposedHeaders(),
		MaxAge:         corsMaxAgeSeconds,
	})

	// holdRPCSlots wraps the mux directly, so an RPC's slot is held until
	// Connect has written its response.
	return limitResponseTime(options.WriteTimeout, corsHandler.Handler(limitRequestBody(options.MaxRequestBytes, holdRPCSlots(mux))))
}

// limitResponseTime bounds how long writing each API response may take:
// the connection's write deadline is set to timeout from the response's
// first byte (its status line, body or flush), so a client that sends a
// request and then stops reading blocks the write only until the deadline;
// the write then fails and the connection is closed. The handler itself is
// not bounded and its context carries no deadline, so long work such as a
// blob commit's compose (SPEC §6.2) runs to completion however long it
// takes.
//
// It applies to every route, so routes added later are bounded too. The
// realtime WebSocket is exempt: its 101 response is informational and
// starts no deadline, and once the connection is hijacked none is set
// (TestRealtimeWebSocketOutlivesTheWriteTimeout).
func limitResponseTime(timeout time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		limited := &deadlineWriter{ResponseWriter: writer, timeout: timeout}
		next.ServeHTTP(limited, request)
		// A handler that wrote nothing gets its response written by
		// net/http after it returns; bound that write too.
		limited.start()
	})
}

// deadlineWriter sets the connection's write deadline when the response
// starts. Flush, Hijack and Unwrap keep streaming, the WebSocket upgrade and
// http.ResponseController working through the wrapper.
type deadlineWriter struct {
	http.ResponseWriter
	timeout time.Duration
	started bool
}

func (writer *deadlineWriter) start() {
	if writer.started {
		return
	}

	writer.started = true
	// It fails only for writers without deadlines (test recorders), which
	// have no connection to bound.
	_ = http.NewResponseController(writer.ResponseWriter).SetWriteDeadline(time.Now().Add(writer.timeout))
}

func (writer *deadlineWriter) WriteHeader(status int) {
	// Informational responses (101 Switching Protocols before a WebSocket
	// hijack) do not start the final response.
	if status >= http.StatusOK {
		writer.start()
	}

	writer.ResponseWriter.WriteHeader(status)
}

func (writer *deadlineWriter) Write(data []byte) (int, error) {
	writer.start()

	return writer.ResponseWriter.Write(data)
}

func (writer *deadlineWriter) Flush() {
	writer.start()

	_ = http.NewResponseController(writer.ResponseWriter).Flush()
}

// Hijack hands the connection to the caller (the realtime WebSocket), after
// which no HTTP response follows and no deadline may be set on it.
func (writer *deadlineWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	writer.started = true

	return http.NewResponseController(writer.ResponseWriter).Hijack() //nolint:wrapcheck // passed through unchanged
}

func (writer *deadlineWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
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

	if err := srv.pingDatabase(request.Context()); err != nil {
		http.Error(writer, "database unreachable", http.StatusServiceUnavailable)

		return
	}

	_, _ = writer.Write([]byte("ok\n"))
}

// pingDatabase pings the database, sharing one ping among concurrent calls,
// so a burst of readiness checks against a slow database holds at most one
// pool connection. The ping is bounded by readinessTimeout and does not end
// when the caller that started it goes away. No result outlives its ping,
// so every check reflects this replica's pool now.
func (srv *Server) pingDatabase(ctx context.Context) error {
	results := srv.readiness.DoChan("database", func() (any, error) {
		pingCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), readinessTimeout)
		defer cancel()

		err := srv.options.Database.Ping(pingCtx)
		if err != nil {
			srv.options.Logger.WarnContext(pingCtx, "readiness check failed: database unreachable", "error", err)
		}

		return nil, err
	})

	select {
	case result := <-results:
		return result.Err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ListenAndServe listens on the API, metrics and service-wide metrics
// addresses and serves until ctx is canceled (see Serve).
func (srv *Server) ListenAndServe(ctx context.Context, apiAddress, metricsAddress, serviceMetricsAddress string) error {
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

	serviceMetricsListener, err := listenConfig.Listen(ctx, "tcp", serviceMetricsAddress)
	if err != nil {
		_ = apiListener.Close()
		_ = metricsListener.Close()

		return fmt.Errorf("listen for service-wide metrics: %w", err)
	}

	return srv.Serve(ctx, apiListener, metricsListener, serviceMetricsListener)
}

// Serve serves the API on apiListener, metrics/health on metricsListener
// and the service-wide metrics on serviceMetricsListener until ctx is
// canceled. It then reports not ready on /readyz, keeps serving
// the API for ShutdownDelay (closing each connection after its response),
// stops accepting connections, runs the Drainers, and waits up to
// ShutdownTimeout for in-flight API requests and the Drainers before closing
// the remaining connections. It returns nil after a clean drain, an
// error wrapping context.DeadlineExceeded if the timeout forced connections
// closed, or the error that stopped a listener.
func (srv *Server) Serve(ctx context.Context, apiListener, metricsListener, serviceMetricsListener net.Listener) error {
	errorLog := slog.NewLogLogger(srv.options.Logger.Handler(), slog.LevelWarn)
	baseContext := func(net.Listener) context.Context { return context.WithoutCancel(ctx) }

	apiServer := &http.Server{
		Handler:           srv.closeConnectionsWhileDraining(srv.api),
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
		WriteTimeout:      metricsWriteTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          errorLog,
		BaseContext:       baseContext,
	}

	serviceMetricsServer := &http.Server{
		Handler:           srv.serviceMetrics,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      metricsWriteTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          errorLog,
		BaseContext:       baseContext,
	}

	serveErrors := make(chan error, 3)

	go func() { serveErrors <- serve(apiServer, apiListener, "API") }()
	go func() { serveErrors <- serve(metricsServer, metricsListener, "metrics") }()
	go func() { serveErrors <- serve(serviceMetricsServer, serviceMetricsListener, "service-wide metrics") }()

	srv.options.Logger.InfoContext(ctx, "server started",
		"api_address", apiListener.Addr().String(),
		"metrics_address", metricsListener.Addr().String(),
		"service_metrics_address", serviceMetricsListener.Addr().String())

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
	// (to another instance) instead of reusing this one. Idle connections
	// stay open until Shutdown: closing them now would reset a request a
	// client is sending on one at this moment (issue #154), which is why
	// this is not http.Server.SetKeepAlivesEnabled(false).
	srv.draining.Store(true)

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

	if err := serviceMetricsServer.Shutdown(shutdownCtx); err != nil {
		_ = serviceMetricsServer.Close()
	}

	if serveErr == nil && shutdownErr == nil {
		srv.options.Logger.InfoContext(ctx, "server stopped")
	}

	return errors.Join(serveErr, shutdownErr)
}

// closeConnectionsWhileDraining has every response whose header is written
// once shutdown has started close its connection after it is written, so
// the client's next request opens a connection a load balancer routes to
// another instance. The decision is made when the header is written, not
// when the request starts, so a request already in flight when shutdown
// starts closes its connection too. A successful WebSocket upgrade (101)
// keeps its own header; a refused one closes its connection.
func (srv *Server) closeConnectionsWhileDraining(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		next.ServeHTTP(&drainingWriter{ResponseWriter: writer, draining: &srv.draining}, request)
	})
}

// drainingWriter adds Connection: close to a response whose header is
// written while draining is set.
type drainingWriter struct {
	http.ResponseWriter

	draining    *atomic.Bool
	wroteHeader bool
}

func (writer *drainingWriter) WriteHeader(status int) {
	if !writer.wroteHeader && status >= http.StatusOK {
		writer.wroteHeader = true

		if writer.draining.Load() {
			writer.Header().Set("Connection", "close")
		}
	}

	writer.ResponseWriter.WriteHeader(status)
}

func (writer *drainingWriter) Write(data []byte) (int, error) {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}

	return writer.ResponseWriter.Write(data)
}

// Flush writes the header first, as the wrapped writer's Flush would.
func (writer *drainingWriter) Flush() {
	_ = writer.FlushError()
}

// FlushError is Flush returning the wrapped writer's error, so
// http.ResponseController.Flush reports a write error (a client gone)
// instead of hiding it until the next Write.
func (writer *drainingWriter) FlushError() error {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}

	return http.NewResponseController(writer.ResponseWriter).Flush()
}

// Hijack hands over the connection (a WebSocket upgrade), header untouched.
func (writer *drainingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(writer.ResponseWriter).Hijack()
}

// Unwrap lets http.ResponseController reach the wrapped writer.
func (writer *drainingWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
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
