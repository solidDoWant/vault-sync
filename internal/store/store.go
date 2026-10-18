// Package store owns the server's PostgreSQL connection pool and schema
// (SPEC.md §5). The schema is applied by embedded, forward-only migrations
// (see Migrate).
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Config describes how to connect to PostgreSQL.
type Config struct {
	// DSN is a libpq connection string (URL or keyword/value form). It must
	// not carry sslcert/sslkey: pgx reads those once, but client certificates
	// rotate (SPEC.md §3). Use TLSCertFile/TLSKeyFile instead.
	DSN string

	// TLSCertFile and TLSKeyFile are the PEM client certificate and key. They
	// are re-read for every new connection, so a rotated certificate is used
	// without restarting the server. Both or neither must be set.
	TLSCertFile string
	TLSKeyFile  string

	// TLSCAFile is a PEM bundle of CAs trusted to sign the server certificate.
	// It is re-read for every new connection. When set, the server
	// certificate chain and host name are always verified (verify-full),
	// regardless of the DSN's sslmode.
	TLSCAFile string
}

// NewPoolConfig parses cfg into a pgxpool configuration. Setting any TLS file
// requires a DSN sslmode that enables TLS (require, verify-ca or
// verify-full); plaintext fallbacks (sslmode=prefer) are removed.
func NewPoolConfig(cfg Config) (*pgxpool.Config, error) {
	if cfg.DSN == "" {
		return nil, errors.New("database DSN is required")
	}

	poolConfig, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		// pgx redacts the password from the DSN it echoes in parse errors.
		return nil, fmt.Errorf("invalid database DSN: %w", err)
	}

	if err := applyTLSFiles(&poolConfig.ConnConfig.Config, cfg); err != nil {
		return nil, err
	}

	// Check every connection before handing it out. A connection that
	// PostgreSQL reset while it sat idle in the pool (a restart, a
	// failover, an idle reaper) then fails its ping instead of the caller's
	// query, and the pool retries with another, or a new, connection
	// (SPEC.md §12). pgx's default pings only connections idle for over a
	// second, which a busy pool's connections rarely are.
	poolConfig.ShouldPing = func(context.Context, pgxpool.ShouldPingParams) bool { return true }

	return poolConfig, nil
}

// Open creates a connection pool for cfg and verifies that the database is
// reachable.
func Open(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	poolConfig, err := NewPoolConfig(cfg)
	if err != nil {
		return nil, err
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create database pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()

		return nil, fmt.Errorf("connect to database: %w", err)
	}

	return pool, nil
}
