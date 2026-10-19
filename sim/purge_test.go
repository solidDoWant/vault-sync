//go:build sim

package sim_test

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// purgedRevision is a revision the retention policy purged during a run,
// with its parent at the time, so the invariant checks can tell a purge
// (SPEC.md §11) from a lost acknowledged write.
type purgedRevision struct {
	ID     uuid.UUID
	Seq    int64
	Parent uuid.NullUUID
}

// agedPolicy is the deployment's default retention policy, which a run
// applies to revisions it ages past it.
var agedPolicy = store.RetentionPolicy{KeepAll: retention.DefaultKeepAll, KeepDaily: retention.DefaultKeepDaily}

// ageAndPurge makes revisionIDs of vaultID look 100 days old, all from the
// same UTC day and in their seq order, and applies the default retention
// policy to their documents with the server's own purge (PurgeRevisions), as
// the retention job would once that much time had passed. Of each
// document's aged revisions the newest, and the head, are kept; it returns
// the revisions purged.
func ageAndPurge(ctx context.Context, db *pgxpool.Pool, vaultID uuid.UUID, revisionIDs []uuid.UUID) ([]purgedRevision, error) {
	type aged struct {
		purgedRevision

		document uuid.UUID
	}

	var revisions []aged

	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			UPDATE revisions SET created_at = date_trunc('day', now() - interval '100 days', 'UTC') + interval '1 hour' + seq * interval '1 millisecond'
			WHERE vault_id = $1 AND id = ANY($2)
			RETURNING id, seq, parent_rev_id, document_id`, vaultID, revisionIDs)
		if err != nil {
			return err
		}

		revisions, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (aged, error) {
			var revision aged

			err := row.Scan(&revision.ID, &revision.Seq, &revision.Parent, &revision.document)

			return revision, err
		})

		return err
	})
	if err != nil {
		return nil, fmt.Errorf("age revisions: %w", err)
	}

	if len(revisions) != len(revisionIDs) {
		return nil, fmt.Errorf("aged %d of %d revisions: some are not in vault %s", len(revisions), len(revisionIDs), vaultID)
	}

	vault := store.New(db).InVault(vaultID)
	documents := map[uuid.UUID]bool{}

	for _, revision := range revisions {
		if documents[revision.document] {
			continue
		}

		documents[revision.document] = true

		if _, err := vault.PurgeRevisions(ctx, revision.document, agedPolicy, 1000); err != nil {
			return nil, fmt.Errorf("purge document %s: %w", revision.document, err)
		}
	}

	var remaining []uuid.UUID

	err = db.QueryRow(ctx, `SELECT COALESCE(array_agg(id), '{}') FROM revisions WHERE vault_id = $1 AND id = ANY($2)`, vaultID, revisionIDs).Scan(&remaining)
	if err != nil {
		return nil, fmt.Errorf("read remaining revisions: %w", err)
	}

	kept := map[uuid.UUID]bool{}
	for _, id := range remaining {
		kept[id] = true
	}

	var purged []purgedRevision

	for _, revision := range revisions {
		if !kept[revision.ID] {
			purged = append(purged, revision.purgedRevision)
		}
	}

	return purged, nil
}
