//go:build integration

package store_test

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// When PostgreSQL resets the server's idle connections (a restart, a
// failover, an idle-connection reaper), the next queries reconnect instead of
// failing (SPEC.md §12).
func TestQueriesSurviveResetConnections(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)
	pool := openPool(t, cfg)

	_, err := store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	queries := store.New(pool)

	const concurrency = 4

	// Fill the pool with several connections.
	upsertConcurrently := func(subject string) []error {
		errs := make([]error, concurrency)

		var group sync.WaitGroup

		for index := range concurrency {
			group.Go(func() {
				_, errs[index] = queries.UpsertUser(t.Context(), testIssuer, subject, "")
			})
		}

		group.Wait()

		return errs
	}

	for _, err := range upsertConcurrently("before") {
		require.NoError(t, err)
	}

	require.GreaterOrEqual(t, pool.Stat().IdleConns(), int32(2), "the pool must hold several idle connections")

	admin, err := pgx.Connect(t.Context(), cfg.DSN)
	require.NoError(t, err)

	t.Cleanup(func() { _ = admin.Close(context.WithoutCancel(t.Context())) })

	const otherBackends = `FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`

	var terminated int

	require.NoError(t, admin.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) `+otherBackends).Scan(&terminated))
	require.Positive(t, terminated)

	require.Eventually(t, func() bool {
		var remaining int

		return admin.QueryRow(t.Context(), `SELECT count(*) `+otherBackends).Scan(&remaining) == nil && remaining == 0
	}, 10*time.Second, 10*time.Millisecond, "terminated backends must exit")

	// Every connection in the pool is now dead, yet no query fails.
	_, err = queries.UpsertUser(t.Context(), testIssuer, "after", "")
	require.NoError(t, err)

	for index, err := range upsertConcurrently("concurrently after") {
		require.NoError(t, err, "query %d", index)
	}
}
