//go:build integration

package store_test

import (
	"log/slog"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func openPool(t *testing.T, cfg store.Config) *pgxpool.Pool {
	t.Helper()

	pool, err := store.Open(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	return pool
}

// migratedPool returns a pool on a fresh, fully migrated database.
func migratedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	pool := openPool(t, testinfra.PostgresConfig(t))

	_, err := store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	return pool
}

func appliedVersionCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()

	var count int
	require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM schema_migrations").Scan(&count))

	return count
}

func TestMigrateCreatesSchemaOnEmptyDatabase(t *testing.T) {
	pool := openPool(t, testinfra.PostgresConfig(t))

	applied, err := store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)
	assert.Positive(t, applied)
	assert.Equal(t, applied, appliedVersionCount(t, pool))

	rows, err := pool.Query(t.Context(), "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
	require.NoError(t, err)

	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)

	// SPEC.md §5 minus the Phase 4 (key_slots) and Phase 5 (yjs_updates)
	// tables, plus blob upload sessions, pending blob deletions and the
	// migration ledger.
	assert.ElementsMatch(t, []string{
		"users", "devices", "vaults", "vault_members", "documents", "revisions", "blobs",
		"blob_uploads", "blob_upload_chunks", "blob_deletions", "schema_migrations",
	}, tables)
}

func TestMigrateConcurrentStartersApplyOnce(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)

	// Each "server process" has its own pool, so its own sessions.
	const servers = 4

	pools := make([]*pgxpool.Pool, servers)
	for index := range pools {
		pools[index] = openPool(t, cfg)
	}

	var (
		start   sync.WaitGroup
		done    sync.WaitGroup
		applied [servers]int
		errs    [servers]error
	)

	start.Add(1)

	for index, pool := range pools {
		done.Go(func() {
			start.Wait()

			applied[index], errs[index] = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
		})
	}

	start.Done()
	done.Wait()

	total := 0

	for index := range pools {
		require.NoError(t, errs[index], "server %d", index)

		total += applied[index]

		// Every server starts: it can use the schema after migrating.
		var vaults int
		require.NoError(t, pools[index].QueryRow(t.Context(), "SELECT count(*) FROM vaults").Scan(&vaults))
	}

	versions := appliedVersionCount(t, pools[0])
	assert.Positive(t, versions)
	assert.Equal(t, versions, total, "each migration must be applied by exactly one server")
}

// schemaSnapshot describes everything a migration could change.
func schemaSnapshot(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()

	rows, err := pool.Query(t.Context(), `
		SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' nullable=' || is_nullable || ' default=' || coalesce(column_default, '')
		FROM information_schema.columns WHERE table_schema = 'public'
		UNION ALL
		SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
		FROM pg_constraint WHERE connamespace = 'public'::regnamespace
		UNION ALL
		SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
		UNION ALL
		SELECT 'migration ' || version || ' ' || name || ' ' || applied_at FROM schema_migrations
		ORDER BY 1`)
	require.NoError(t, err)

	snapshot, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)

	return snapshot
}

func TestMigrateIsIdempotent(t *testing.T) {
	pool := migratedPool(t)
	before := schemaSnapshot(t, pool)

	applied, err := store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)
	assert.Zero(t, applied)
	assert.Equal(t, before, schemaSnapshot(t, pool))
}

func TestMigrateRejectsRewrittenHistory(t *testing.T) {
	pool := migratedPool(t)

	_, err := pool.Exec(t.Context(), "UPDATE schema_migrations SET name = 'something_else' WHERE version = 1")
	require.NoError(t, err)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.ErrorContains(t, err, "must never change")
}

func TestMigrateReleasesLock(t *testing.T) {
	pool := migratedPool(t)

	// A failed run must not leave the advisory lock held by a pooled
	// connection, or later starters would block forever.
	_, err := pool.Exec(t.Context(), "UPDATE schema_migrations SET name = 'something_else' WHERE version = 1")
	require.NoError(t, err)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.Error(t, err)

	var locks int
	require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())").Scan(&locks))
	assert.Zero(t, locks, "advisory locks still held after Migrate returned")
}
