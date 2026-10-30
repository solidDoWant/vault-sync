//go:build integration

package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

func TestLastRunsAreZeroBeforeAnyRun(t *testing.T) {
	runs, err := store.New(migratedPool(t)).LastRuns(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.LastRuns{}, runs)
}

func TestRecordedRetentionRunIsReadByAnotherReplica(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)
	recorder := openPool(t, cfg)
	_, err := store.Migrate(t.Context(), recorder, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	reader := store.New(openPool(t, cfg))

	before := time.Now()

	require.NoError(t, store.New(recorder).RecordMaintenanceRun(t.Context(), store.MaintenanceJobRetention))

	first, err := reader.LastRuns(t.Context())
	require.NoError(t, err)
	assert.WithinDuration(t, before, first.Retention, time.Minute)
	assert.True(t, first.Export.IsZero(), "no export yet")

	require.NoError(t, store.New(recorder).RecordMaintenanceRun(t.Context(), store.MaintenanceJobRetention))

	second, err := reader.LastRuns(t.Context())
	require.NoError(t, err)
	assert.True(t, second.Retention.After(first.Retention), "advanced from %v to %v", first.Retention, second.Retention)
}

func TestOnlyAnOKExportAdvancesTheLastSuccessfulExport(t *testing.T) {
	queries := store.New(migratedPool(t))

	require.NoError(t, queries.RecordExportRun(t.Context(), "failed"))

	runs, err := queries.LastRuns(t.Context())
	require.NoError(t, err)
	assert.True(t, runs.Export.IsZero(), "a failed first export is not a success")

	require.NoError(t, queries.RecordExportRun(t.Context(), "ok"))

	succeeded, err := queries.LastRuns(t.Context())
	require.NoError(t, err)
	assert.False(t, succeeded.Export.IsZero())

	for _, status := range []string{"partial", "failed"} {
		require.NoError(t, queries.RecordExportRun(t.Context(), status))

		runs, err := queries.LastRuns(t.Context())
		require.NoError(t, err)
		assert.Equal(t, succeeded.Export, runs.Export, "a %s export keeps the last success", status)
	}

	require.NoError(t, queries.RecordExportRun(t.Context(), "ok"))

	runs, err = queries.LastRuns(t.Context())
	require.NoError(t, err)
	assert.True(t, runs.Export.After(succeeded.Export), "a later ok export advances it")
	assert.True(t, runs.Retention.IsZero(), "an export is not a retention run")
}

// exportRoleConfig returns cfg connecting as a new role with exactly the
// database privileges docs/admin/backup-and-restore.md grants the export, on a ReadOnly
// pool as the export opens it.
func exportRoleConfig(t *testing.T, cfg store.Config, adminExec func(string)) store.Config {
	t.Helper()

	suffix := make([]byte, 8)
	_, _ = rand.Read(suffix)
	role := "vault_sync_export_" + hex.EncodeToString(suffix)
	password := hex.EncodeToString(suffix) + "-password"
	identifier := pgx.Identifier{role}.Sanitize()

	adminExec("CREATE ROLE " + identifier + " LOGIN PASSWORD '" + password + "'")
	t.Cleanup(func() {
		adminExec("DROP OWNED BY " + identifier)
		adminExec("DROP ROLE " + identifier)
	})

	adminExec("GRANT SELECT ON vaults, documents, revisions, blobs TO " + identifier)
	adminExec("GRANT INSERT, UPDATE ON export_status TO " + identifier)

	databaseURL, err := url.Parse(cfg.DSN)
	require.NoError(t, err)

	databaseURL.User = url.UserPassword(role, password)

	return store.Config{DSN: databaseURL.String(), ReadOnly: true}
}

func TestExportRoleWritesOnlyTheExportStatus(t *testing.T) {
	cfg := testinfra.PostgresConfig(t)
	adminPool := openPool(t, cfg)
	_, err := store.Migrate(t.Context(), adminPool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	admin := store.New(adminPool)
	adminExec := func(statement string) {
		_, err := adminPool.Exec(context.WithoutCancel(t.Context()), statement)
		require.NoError(t, err, statement)
	}

	exportPool := openPool(t, exportRoleConfig(t, cfg, adminExec))
	export := store.New(exportPool)

	require.NoError(t, export.RecordExportRun(t.Context(), "ok"))
	require.NoError(t, export.RecordExportRun(t.Context(), "partial"))

	runs, err := admin.LastRuns(t.Context())
	require.NoError(t, err)
	assert.False(t, runs.Export.IsZero())

	var count int
	require.NoError(t, exportPool.QueryRow(t.Context(), "SELECT count(*) FROM vaults").Scan(&count), "reads work")

	// Every other write is refused: the pool's sessions are read-only,
	// and even in a read-write transaction the role lacks the privilege.
	writes := []string{
		"INSERT INTO vaults (id, name, encryption) VALUES (gen_random_uuid(), 'v', 'none')",
		"UPDATE documents SET deleted = deleted",
		"DELETE FROM blobs",
		"INSERT INTO maintenance_runs (job, last_success_at) VALUES ('retention', now())",
		"UPDATE users SET oidc_subject = oidc_subject",
	}

	for _, statement := range writes {
		_, err := exportPool.Exec(t.Context(), statement)
		assertPgError(t, err, "25006", "read_only_sql_transaction: "+statement)

		err = pgx.BeginTxFunc(t.Context(), exportPool, pgx.TxOptions{AccessMode: pgx.ReadWrite}, func(tx pgx.Tx) error {
			_, err := tx.Exec(t.Context(), statement)

			return err
		})
		assertPgError(t, err, "42501", "insufficient_privilege: "+statement)
	}

	// Writes on the export status itself also stay outside the pool's
	// default read-only sessions.
	_, err = exportPool.Exec(t.Context(), "UPDATE export_status SET status = 'ok'")
	assertPgError(t, err, "25006", "read_only_sql_transaction")
}

func assertPgError(t *testing.T, err error, code, msg string) {
	t.Helper()

	var pgErr *pgconn.PgError
	if assert.True(t, errors.As(err, &pgErr), "%s: got %v", msg, err) {
		assert.Equal(t, code, pgErr.Code, msg)
	}
}
