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
		logger.ErrorContext(ctx, "invalid configuration; see docs/configuration.md", "problems", problemList(err))

		return 1
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server", "version", version.String())

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
	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: cfg.OIDC.IssuerURL,
		Audience:  cfg.OIDC.Audience,
		Logger:    logger,
	})

	blobs, err := startBlobs(ctx, cfg, queries, logger)
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

	srv := New(Options{
		MaxRequestBytes:          cfg.MaxRequestBytes,
		WriteTimeout:             cfg.WriteTimeout,
		MaxConcurrentRPCsPerUser: cfg.MaxConcurrentRPCsPerUser,
		ShutdownDelay:            cfg.ShutdownDelay,
		ShutdownTimeout:          cfg.ShutdownTimeout,
		Database:                 pool,
		Authenticator:            authenticator,
		Devices:                  queries,
		Vaults:                   queries,
		Memberships:              queries,
		Sync:                     &api.SyncService{Store: queries, Logger: logger},
		Blobs:                    blobs,
		Realtime:                 hub,
		Logger:                   logger,
	})

	if err := srv.ListenAndServe(ctx, cfg.ListenAddress, cfg.MetricsListenAddress); err != nil {
		logger.ErrorContext(ctx, "server stopped with an error", "error", err)

		return 1
	}

	return 0
}

// s3CheckTimeout bounds the startup check that the bucket is reachable.
const s3CheckTimeout = 30 * time.Second

// startBlobs connects to the object store, checks that the bucket is
// reachable and starts the upload cleanup routine, which stops with ctx. It
// returns nil when no object store is configured.
func startBlobs(ctx context.Context, cfg config.Config, queries *store.Store, logger *slog.Logger) (*api.BlobService, error) {
	if cfg.S3 == nil {
		logger.WarnContext(ctx, "no S3 object store is configured (VAULT_SYNC_S3_*); blob uploads and downloads are disabled")

		return nil, nil
	}

	objects, err := blobstore.New(*cfg.S3)
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

	return &api.BlobService{
		Store:   queries,
		Objects: objects,
		Limits: api.BlobLimits{
			MaxChunkBytes:      cfg.Blobs.MaxChunkBytes,
			MaxBlobBytes:       cfg.Blobs.MaxSizeBytes,
			MaxUploadsPerVault: cfg.Blobs.MaxUploadsPerVault,
		},
		Logger: logger,
	}, nil
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
