package server

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/servicemetrics"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/version"
)

// Main runs the server command: it loads the configuration through lookup,
// connects to and migrates the database, and serves until ctx is canceled.
// It returns the process exit code.
func Main(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("vault-sync-server", flag.ContinueOnError)
	flags.SetOutput(stderr)
	showVersion := flags.Bool("version", false, "print the version and exit")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	if *showVersion {
		_, _ = fmt.Fprintln(stdout, version.String())

		return 0
	}

	cfg, err := config.Load(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(stderr, nil))
		logger.ErrorContext(ctx, "invalid configuration; see docs/admin/configuration.md", "problems", problemList(err))

		return 1
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server", "version", version.String())

	dependencies := DependencyMetrics{Database: store.NewMetrics(), ObjectStore: blobstore.NewMetrics(), OIDC: auth.NewMetrics()}
	cfg.Database.Metrics = dependencies.Database

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		logger.ErrorContext(ctx, "cannot open database", "error", err)

		return 1
	}
	defer pool.Close()

	if _, err := store.Migrate(ctx, pool, logger); err != nil {
		logger.ErrorContext(ctx, "cannot migrate database", "error", err)

		return 1
	}

	queries := store.New(pool)

	escrow, err := LoadEscrowChain(ctx, queries, cfg.Escrow)
	if err != nil {
		logger.ErrorContext(ctx, "cannot use the escrow chain", "error", err)

		return 1
	}

	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: cfg.OIDC.IssuerURL,
		Audience:  cfg.OIDC.Audience,
		Logger:    logger,
		Metrics:   dependencies.OIDC,
	})

	retained := retention.NewMetrics()

	blobs, err := startBlobs(ctx, cfg, queries, retained, dependencies.ObjectStore, logger)
	if err != nil {
		logger.ErrorContext(ctx, "cannot use the S3 object store", "error", err)

		return 1
	}

	authenticator := auth.NewAuthenticator(verifier, queries)
	hub := realtime.NewHub(realtime.Options{
		Authenticator:  authenticator,
		Store:          queries,
		AllowedOrigins: AllowedOrigins,
		Limits: realtime.Limits{
			MaxConnections:        cfg.Realtime.MaxConnections,
			MaxConnectionsPerUser: cfg.Realtime.MaxConnectionsPerUser,
			MaxSubscriptions:      cfg.Realtime.MaxSubscriptions,
		},
		Logger: logger,
	})

	// The hub keeps delivering notifications through the shutdown delay;
	// the server's drain stops it (Hub.Drain), and so does returning here
	// before the database closes.
	hubCtx, stopHub := context.WithCancel(context.WithoutCancel(ctx))
	hubDone := make(chan struct{})

	go func() {
		defer close(hubDone)

		hub.Run(hubCtx)
	}()

	defer func() {
		stopHub()
		<-hubDone
	}()

	// The refresher stops with ctx, or when Main returns; the pool closes
	// only after it has.
	serviceMetrics := servicemetrics.NewMetrics()
	refresher := &servicemetrics.Refresher{
		Store: queries, Metrics: serviceMetrics, EscrowRetiringKeyIDs: escrow.RetiringKeyIDs, Logger: logger,
	}
	refresherCtx, stopRefresher := context.WithCancel(ctx)
	refresherDone := make(chan struct{})

	go func() {
		defer close(refresherDone)

		refresher.Run(refresherCtx, cfg.ServiceMetricsInterval)
	}()

	defer func() {
		stopRefresher()
		<-refresherDone
	}()

	srv := New(Options{
		MaxRequestBytes:          cfg.MaxRequestBytes,
		WriteTimeout:             cfg.WriteTimeout,
		MaxConcurrentRPCsPerUser: cfg.MaxConcurrentRPCsPerUser,
		ShutdownDelay:            cfg.ShutdownDelay,
		ShutdownTimeout:          cfg.ShutdownTimeout,
		Database:                 pool,
		Authenticator:            authenticator,
		OIDCIssuerURL:            cfg.OIDC.IssuerURL,
		OIDCClientID:             cfg.OIDC.ClientID,
		Escrow:                   escrow,
		Devices:                  queries,
		Vaults:                   queries,
		Memberships:              queries,
		Membership:               &api.MembershipService{Store: queries, Escrow: escrow, Logger: logger},
		UserKeys:                 &api.UserKeyService{Store: queries, Logger: logger},
		VaultKeys:                &api.VaultKeyService{Keys: api.KeysOf(queries), Escrow: escrow, Logger: logger},
		EscrowJobs:               &api.EscrowJobService{Store: queries, Logger: logger},
		EscrowJobToken:           cfg.EscrowJobToken,
		Sync:                     &api.SyncService{Store: queries, Logger: logger},
		Blobs:                    blobs,
		Realtime:                 hub,
		Retention:                retained,
		ServiceMetrics:           serviceMetrics,
		Dependencies:             dependencies,
		Logger:                   logger,
	})

	if err := srv.ListenAndServe(ctx, cfg.ListenAddress, cfg.MetricsListenAddress, cfg.ServiceMetricsListenAddress); err != nil {
		logger.ErrorContext(ctx, "server stopped with an error", "error", err)

		return 1
	}

	return 0
}

// s3CheckTimeout bounds the startup check that the bucket is reachable.
const s3CheckTimeout = 30 * time.Second

// startBlobs connects to the object store, checks that the bucket is
// reachable and starts the upload cleanup routine and the retention job,
// which stop with ctx. It returns nil when no object store is configured.
func startBlobs(ctx context.Context, cfg config.Config, queries *store.Store, retained *retention.Metrics, objectMetrics *blobstore.Metrics, logger *slog.Logger) (*api.BlobService, error) {
	if cfg.S3 == nil {
		logger.WarnContext(ctx, "no S3 object store is configured (VAULT_SYNC_S3_*); blob uploads and downloads are disabled")

		return nil, nil
	}

	objects, err := blobstore.NewWithMetrics(*cfg.S3, objectMetrics)
	if err != nil {
		return nil, err
	}

	checkCtx, cancel := context.WithTimeout(ctx, s3CheckTimeout)
	defer cancel()

	if err := objects.Check(checkCtx); err != nil {
		return nil, err
	}

	cleaner := &blobstore.Cleaner{Store: queries, Objects: objects, TTL: cfg.Blobs.UploadTTL, Logger: logger}
	go cleaner.Run(ctx, blobstore.DefaultCleanupInterval)

	// Every revision references a complete blob, so without an object
	// store there is nothing to retain or collect.
	job := &retention.Job{
		Store:   queries,
		Objects: objects,
		Policy:  store.RetentionPolicy{KeepAll: cfg.Retention.KeepAll, KeepDaily: cfg.Retention.KeepDaily},
		Grace:   cfg.Retention.BlobGrace,
		Metrics: retained,

		MarkerHorizon: cfg.Retention.PurgeMarkerHorizon,
		Logger:        logger,
	}
	go job.Run(ctx, retention.DefaultInterval)

	return &api.BlobService{
		Store:   queries,
		Objects: objects,
		Limits:  blobLimits(cfg.Blobs),
		Metrics: objectMetrics,
		Logger:  logger,
	}, nil
}

// blobLimits returns the blob service's limits for the configuration. The
// server sets MaxMessageBytes itself.
func blobLimits(blobs config.BlobConfig) api.BlobLimits {
	return api.BlobLimits{
		MaxChunkBytes:      blobs.MaxChunkBytes,
		MaxBlobBytes:       blobs.MaxSizeBytes,
		MaxUploadsPerVault: blobs.MaxUploadsPerVault,
		UploadReclaimIdle:  blobs.UploadReclaimIdle,
	}
}

// problemList flattens errors.Join trees into one message per problem.
func problemList(err error) []string {
	var joined interface{ Unwrap() []error }
	if !errors.As(err, &joined) {
		return []string{err.Error()}
	}

	var problems []string
	for _, problem := range joined.Unwrap() {
		problems = append(problems, problem.Error())
	}

	return problems
}
