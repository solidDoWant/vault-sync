package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrVaultNotDeleted is returned by UndeleteVault for a vault that is not
// deleted.
var ErrVaultNotDeleted = errors.New("vault is not deleted")

// vaultPurgeTables are the tables holding a vault's rows, in an order that
// deletes every row before the rows it references.
var vaultPurgeTables = []string{
	"vault_log_entries", "key_slots", "vault_key_epochs", "vault_invitations", "vault_members", "vault_retention",
	"purged_revisions", "blob_upload_chunks", "blob_uploads", "blob_deletions",
	"revisions", "documents", "blobs",
}

// PurgeableVaults returns up to limit vaults deleted more than age ago, or
// whose purge has started, longest deleted first. It serves the retention
// job, never a request.
func (store *Store) PurgeableVaults(ctx context.Context, age time.Duration, limit int) ([]uuid.UUID, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT id FROM vaults
		WHERE purged_at IS NOT NULL OR deleted_at < now() - $1 * interval '1 microsecond'
		ORDER BY deleted_at
		LIMIT $2`, age.Microseconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("list purgeable vaults: %w", err)
	}

	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, fmt.Errorf("list purgeable vaults: %w", err)
	}

	return ids, nil
}

// PurgeVaultRows starts the purge of vaultID if it was deleted more than age
// ago, or continues one already started: in one transaction it marks the
// vault purged, so it can no longer be undeleted, and deletes every row of
// the vault except its vaults row. The caller then deletes the vault's
// objects and calls DeleteVaultRecord. It reports false, changing nothing,
// when the vault is gone, not deleted, or deleted more recently (for example
// undeleted since it was listed).
func (store *Store) PurgeVaultRows(ctx context.Context, vaultID uuid.UUID, age time.Duration) (bool, error) {
	purging := false

	err := pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE vaults SET purged_at = coalesce(purged_at, now())
			WHERE id = $1 AND (purged_at IS NOT NULL OR deleted_at < now() - $2 * interval '1 microsecond')`,
			vaultID, age.Microseconds())
		if err != nil {
			return fmt.Errorf("mark vault purged: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return nil
		}

		purging = true

		for _, table := range vaultPurgeTables {
			if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE vault_id = $1`, vaultID); err != nil {
				return fmt.Errorf("purge vault %s: %w", table, err)
			}
		}

		return nil
	})
	if err != nil {
		return false, err
	}

	return purging, nil
}

// DeleteVaultRecord deletes the vaults row of vaultID once PurgeVaultRows
// has purged its rows and the caller has deleted its objects. It reports
// whether this call deleted it.
func (store *Store) DeleteVaultRecord(ctx context.Context, vaultID uuid.UUID) (bool, error) {
	tag, err := store.pool.Exec(ctx, `DELETE FROM vaults WHERE id = $1 AND purged_at IS NOT NULL`, vaultID)
	if err != nil {
		return false, fmt.Errorf("delete purged vault: %w", err)
	}

	return tag.RowsAffected() == 1, nil
}

// UndeleteVault restores the deleted vaultID: its members can use it again.
// It is an operator action and is allowed even when it takes an owner above
// the owned-vault limit. It returns ErrVaultNotFound when the vault does not
// exist or its purge has started, and ErrVaultNotDeleted when it is not
// deleted.
func (store *Store) UndeleteVault(ctx context.Context, vaultID uuid.UUID) error {
	var restored, deleted bool

	// The outer query reads the vault as it was before the statement: a
	// purge that started concurrently leaves it deleted and not restored.
	err := store.pool.QueryRow(ctx, `
		WITH restored AS (
			UPDATE vaults SET deleted_at = NULL
			WHERE id = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL
			RETURNING id
		)
		SELECT EXISTS (SELECT 1 FROM restored), v.deleted_at IS NOT NULL
		FROM vaults v WHERE v.id = $1`, vaultID).Scan(&restored, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrVaultNotFound
	}

	if err != nil {
		return fmt.Errorf("undelete vault: %w", err)
	}

	switch {
	case restored:
		return nil
	case !deleted:
		return ErrVaultNotDeleted
	default:
		return ErrVaultNotFound
	}
}
