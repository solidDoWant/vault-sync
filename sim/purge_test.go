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
	// Head: the revision was its document's head when it was purged.
	// Retention never purges a head (SPEC.md §11), so such a purge is never
	// excused (see excusable).
	Head bool
}

// excusable is what the invariant checks may excuse of purged: the
// revisions that were not a document's head. A purged head (a lost
// acknowledged write, SPEC.md §2 principle 1) stays a history and seq
// violation.
func excusable(purged []purgedRevision) []purgedRevision {
	var excused []purgedRevision

	for _, revision := range purged {
		if !revision.Head {
			excused = append(excused, revision)
		}
	}

	return excused
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

	documentIDs := make([]uuid.UUID, 0, len(revisions))
	for _, revision := range revisions {
		documentIDs = append(documentIDs, revision.document)
	}

	var heads []uuid.UUID

	err = db.QueryRow(ctx, `SELECT COALESCE(array_agg(head_rev_id), '{}') FROM documents WHERE vault_id = $1 AND id = ANY($2)`, vaultID, documentIDs).Scan(&heads)
	if err != nil {
		return nil, fmt.Errorf("read document heads: %w", err)
	}

	isHead := make(map[uuid.UUID]bool, len(heads))
	for _, head := range heads {
		isHead[head] = true
	}

	vault := store.New(db).InVault(vaultID)
	documents := map[uuid.UUID]bool{}

	for _, revision := range revisions {
		if documents[revision.document] {
			continue
		}

		documents[revision.document] = true

		if _, _, err := vault.PurgeRevisions(ctx, revision.document, agedPolicy, 1000); err != nil {
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
			revision.Head = isHead[revision.ID]
			purged = append(purged, revision.purgedRevision)
		}
	}

	return purged, nil
}
