package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// VaultRetention is a vault's retention override (SPEC.md §11).
type VaultRetention struct {
	VaultID uuid.UUID
	Policy  RetentionPolicy
	// Updated is when the override was last set, by the database clock.
	Updated time.Time
}

// SetVaultRetention makes vault vaultID follow policy instead of the
// deployment-wide retention policy, replacing any override it has. It
// returns ErrVaultNotFound if the vault does not exist. The caller checks the
// policy against the operator's bounds; the database only refuses a
// non-positive KeepAll or a KeepDaily below KeepAll.
//
// The override is the operator's (the retention subcommand); no API sets
// it. Every server process reads it on each retention run, so it applies
// from the next run on every replica.
func (store *Store) SetVaultRetention(ctx context.Context, vaultID uuid.UUID, policy RetentionPolicy) error {
	_, err := store.pool.Exec(ctx, `
		INSERT INTO vault_retention (vault_id, keep_all, keep_daily) VALUES ($1, $2, $3)
		ON CONFLICT (vault_id) DO UPDATE SET keep_all = EXCLUDED.keep_all, keep_daily = EXCLUDED.keep_daily,
			updated_at = now()`, vaultID, policy.KeepAll.Microseconds(), policy.KeepDaily.Microseconds())

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" { // foreign_key_violation
		return ErrVaultNotFound
	}

	if err != nil {
		return fmt.Errorf("set vault retention: %w", err)
	}

	return nil
}

// UnsetVaultRetention removes vault vaultID's override, so it follows the
// deployment-wide policy again, and reports whether it had one.
func (store *Store) UnsetVaultRetention(ctx context.Context, vaultID uuid.UUID) (bool, error) {
	tag, err := store.pool.Exec(ctx, `DELETE FROM vault_retention WHERE vault_id = $1`, vaultID)
	if err != nil {
		return false, fmt.Errorf("unset vault retention: %w", err)
	}

	return tag.RowsAffected() > 0, nil
}

// VaultRetentions returns up to limit overrides of vaults whose id sorts
// after after (uuid.Nil for the first page), in vault id order.
func (store *Store) VaultRetentions(ctx context.Context, after uuid.UUID, limit int) ([]VaultRetention, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT vault_id, keep_all, keep_daily, updated_at FROM vault_retention
		WHERE vault_id > $1 ORDER BY vault_id LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list vault retention: %w", err)
	}

	overrides, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (VaultRetention, error) {
		var (
			override           VaultRetention
			keepAll, keepDaily int64
		)

		err := row.Scan(&override.VaultID, &keepAll, &keepDaily, &override.Updated)
		override.Policy = RetentionPolicy{
			KeepAll:   time.Duration(keepAll) * time.Microsecond,
			KeepDaily: time.Duration(keepDaily) * time.Microsecond,
		}

		return override, err
	})
	if err != nil {
		return nil, fmt.Errorf("list vault retention: %w", err)
	}

	return overrides, nil
}
