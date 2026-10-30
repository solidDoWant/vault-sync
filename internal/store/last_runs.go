package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaintenanceJobRetention names the retention job in maintenance_runs.
const MaintenanceJobRetention = "retention"

// exportStatusOK is the export summary status of a run that exported
// every document; only such a run advances the last successful export.
const exportStatusOK = "ok"

// RecordMaintenanceRun records that a run of job finished without errors
// now. Every replica records its own runs; the latest wins.
func (store *Store) RecordMaintenanceRun(ctx context.Context, job string) error {
	_, err := store.pool.Exec(ctx, `
		INSERT INTO maintenance_runs (job, last_success_at) VALUES ($1, now())
		ON CONFLICT (job) DO UPDATE SET last_success_at = excluded.last_success_at`, job)
	if err != nil {
		return fmt.Errorf("record %s run: %w", job, err)
	}

	return nil
}

// RecordExportRun records the end of an export run with its summary status
// (ok, partial or failed) in the single export_status row; a status of ok
// also advances the last successful export. It writes in an explicit
// read-write transaction, so it works on a ReadOnly pool, where every other
// statement stays read-only. The statement reads no column (the migration
// inserted the only row), so UPDATE on the table is the only privilege it
// needs.
func (store *Store) RecordExportRun(ctx context.Context, status string) error {
	err := pgx.BeginTxFunc(ctx, store.pool, pgx.TxOptions{AccessMode: pgx.ReadWrite}, func(tx pgx.Tx) error {
		statement := `UPDATE export_status SET finished_at = now(), status = $1`
		if status == exportStatusOK {
			statement += `, last_success_at = now()`
		}

		tag, err := tx.Exec(ctx, statement, status)
		if err == nil && tag.RowsAffected() != 1 {
			err = fmt.Errorf("export_status has %d rows, want 1", tag.RowsAffected())
		}

		return err
	})
	if err != nil {
		return fmt.Errorf("record export run: %w", err)
	}

	return nil
}

// LastRuns are the times of the last successful retention run and export;
// each is zero when there has been none.
type LastRuns struct {
	Retention time.Time
	Export    time.Time
}

// LastRuns returns when the retention job and the export last succeeded.
func (store *Store) LastRuns(ctx context.Context) (LastRuns, error) {
	var retention, export *time.Time

	err := store.pool.QueryRow(ctx, `
		SELECT
			(SELECT last_success_at FROM maintenance_runs WHERE job = $1),
			(SELECT last_success_at FROM export_status WHERE id)`, MaintenanceJobRetention).Scan(&retention, &export)
	if err != nil {
		return LastRuns{}, fmt.Errorf("read last runs: %w", err)
	}

	var runs LastRuns
	if retention != nil {
		runs.Retention = *retention
	}

	if export != nil {
		runs.Export = *export
	}

	return runs, nil
}
