package server

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"

	"github.com/solidDoWant/vault-sync/internal/config"
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

	srv := New(Options{
		MaxRequestBytes: cfg.MaxRequestBytes,
		ShutdownTimeout: cfg.ShutdownTimeout,
		Database:        pool,
		Logger:          logger,
	})

	if err := srv.ListenAndServe(ctx, cfg.ListenAddress, cfg.MetricsListenAddress); err != nil {
		logger.ErrorContext(ctx, "server stopped with an error", "error", err)

		return 1
	}

	return 0
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
