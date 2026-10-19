package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RetentionPolicy decides which revisions the retention job purges (SPEC.md
// §11). Ages are measured by the database clock from a revision's
// created_at. A document's head revision, live or a tombstone, is never
// purged.
type RetentionPolicy struct {
	// KeepAll keeps every revision younger than this.
	KeepAll time.Duration
	// KeepDaily thins revisions older than KeepAll but younger than this to
	// the newest revision of each UTC day. Older revisions are thinned to
	// the newest revision of each ISO week (weeks start on Monday, UTC).
	// It is never below KeepAll.
	KeepDaily time.Duration
}

// DocumentRef names a document for maintenance.
type DocumentRef struct {
	VaultID    uuid.UUID
	DocumentID uuid.UUID
}

// BlobRef names a blob for maintenance.
type BlobRef struct {
	VaultID uuid.UUID
	BlobID  []byte
}

// purgeableRevisions selects the revisions of documents the policy no longer
// keeps: among the revisions older than KeepAll ($keepAll), every revision
// but the newest of its bucket, a UTC day for revisions younger than
// KeepDaily ($keepDaily) and an ISO week (UTC) for older ones. The zone is
// part of the bucket, so a day and the week starting on it never merge.
// The head is the newest revision of its document, so it is always the
// newest of its bucket; callers exclude it explicitly as well. The caller
// supplies the WHERE condition on r (scope) and the parameters $1 ($keepAll,
// in microseconds) and $2 ($keepDaily); scope's parameters start at $3.
const purgeableRevisions = `
	SELECT ranked.id, ranked.document_id, ranked.vault_id, ranked.seq FROM (
		SELECT r.id, r.document_id, r.vault_id, r.seq,
			row_number() OVER (
				PARTITION BY r.document_id,
					r.created_at >= now() - $2 * interval '1 microsecond',
					CASE WHEN r.created_at >= now() - $2 * interval '1 microsecond'
						THEN date_trunc('day', r.created_at, 'UTC')
						ELSE date_trunc('week', r.created_at, 'UTC')
					END
				ORDER BY r.seq DESC) AS rank
		FROM revisions r
		WHERE r.created_at < now() - $1 * interval '1 microsecond' AND %s
	) AS ranked
	JOIN documents d ON d.vault_id = ranked.vault_id AND d.id = ranked.document_id
	WHERE ranked.rank > 1 AND ranked.id <> d.head_rev_id`

// RetentionCandidates returns up to limit documents, across all vaults, that
// have revisions policy purges.
//
// Like ReapableBlobUploads, it is not scoped to a vault: it serves the
// background retention job, never a request, and only names documents; the
// job purges each through InVault.
func (store *Store) RetentionCandidates(ctx context.Context, policy RetentionPolicy, limit int) ([]DocumentRef, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT DISTINCT purgeable.vault_id, purgeable.document_id
		FROM (`+fmt.Sprintf(purgeableRevisions, "true")+`) AS purgeable
		LIMIT $3`, policy.KeepAll.Microseconds(), policy.KeepDaily.Microseconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("list retention candidates: %w", err)
	}

	refs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (DocumentRef, error) {
		var ref DocumentRef

		err := row.Scan(&ref.VaultID, &ref.DocumentID)

		return ref, err
	})
	if err != nil {
		return nil, fmt.Errorf("list retention candidates: %w", err)
	}

	return refs, nil
}

// PurgeRevisions deletes up to limit of document documentID's revisions that
// policy no longer keeps, oldest first, in one transaction, and returns how
// many it deleted. The head revision is never deleted.
//
// The purged revision's child is re-parented onto the purged revision's
// parent first (issue #58), so parent_rev_id always names a revision that
// exists: the nearest retained ancestor, or none if every older revision is
// gone. Every blob a purged revision referenced is marked released, which
// starts its garbage-collection grace period (CollectBlob).
//
// The document row is locked with SKIP LOCKED: if a commit to the document,
// or another server process's purge of it, holds the lock, PurgeRevisions
// returns 0 and nil at once, and a later run retries. Concurrent purges by
// several server processes therefore never wait for or conflict with each
// other.
func (vault *VaultStore) PurgeRevisions(ctx context.Context, documentID uuid.UUID, policy RetentionPolicy, limit int) (int, error) {
	purged := 0

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var head uuid.UUID

		err := tx.QueryRow(ctx, `
			SELECT head_rev_id FROM documents WHERE vault_id = $1 AND id = $2 FOR NO KEY UPDATE SKIP LOCKED`,
			vault.vaultID, documentID).Scan(&head)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}

		if err != nil {
			return fmt.Errorf("lock document: %w", err)
		}

		rows, err := tx.Query(ctx, `
			SELECT purgeable.id FROM (`+fmt.Sprintf(purgeableRevisions, "r.vault_id = $3 AND r.document_id = $4")+`) AS purgeable
			ORDER BY purgeable.seq
			LIMIT $5`, policy.KeepAll.Microseconds(), policy.KeepDaily.Microseconds(), vault.vaultID, documentID, limit)
		if err != nil {
			return fmt.Errorf("list purgeable revisions: %w", err)
		}

		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return fmt.Errorf("list purgeable revisions: %w", err)
		}

		var released [][]byte

		for _, id := range ids {
			if id == head {
				// Never reached: the head is the newest revision of its
				// bucket. Kept so that no change to the query can ever
				// purge a head.
				continue
			}

			content, err := vault.purgeRevision(ctx, tx, documentID, id)
			if err != nil {
				return err
			}

			if content != nil {
				released = append(released, content)
			}

			purged++
		}

		return vault.releaseBlobs(ctx, tx, released)
	})
	if err != nil {
		return 0, err
	}

	return purged, nil
}

// purgeRevision re-parents revision id's children onto its parent and
// deletes it, returning its content reference.
func (vault *VaultStore) purgeRevision(ctx context.Context, tx pgx.Tx, documentID, id uuid.UUID) ([]byte, error) {
	// The parent is read in the statement, not from the listing: an
	// earlier purge in this transaction may have re-parented this revision.
	_, err := tx.Exec(ctx, `
		UPDATE revisions SET parent_rev_id = (
			SELECT parent_rev_id FROM revisions WHERE vault_id = $1 AND id = $3)
		WHERE vault_id = $1 AND document_id = $2 AND parent_rev_id = $3`, vault.vaultID, documentID, id)
	if err != nil {
		return nil, fmt.Errorf("re-parent revisions: %w", err)
	}

	var content []byte

	err = tx.QueryRow(ctx, `DELETE FROM revisions WHERE vault_id = $1 AND document_id = $2 AND id = $3 RETURNING content_ref`,
		vault.vaultID, documentID, id).Scan(&content)
	if err != nil {
		return nil, fmt.Errorf("delete revision: %w", err)
	}

	return content, nil
}

// releaseBlobs starts the garbage-collection grace period of blobs, in a
// fixed order so that concurrent purges sharing blobs cannot deadlock.
func (vault *VaultStore) releaseBlobs(ctx context.Context, tx pgx.Tx, blobs [][]byte) error {
	if len(blobs) == 0 {
		return nil
	}

	slices.SortFunc(blobs, bytes.Compare)
	blobs = slices.CompactFunc(blobs, bytes.Equal)

	for _, blobID := range blobs {
		_, err := tx.Exec(ctx, `UPDATE blobs SET released_at = now() WHERE vault_id = $1 AND blob_id = $2`, vault.vaultID, blobID)
		if err != nil {
			return fmt.Errorf("release blob: %w", err)
		}
	}

	return nil
}

// ReleasedBlobs returns up to limit blobs, across all vaults, whose last
// release by a purge is older than grace, longest released first. They are
// candidates for CollectBlob, which checks that no revision references them.
//
// Not scoped to a vault, like RetentionCandidates.
func (store *Store) ReleasedBlobs(ctx context.Context, grace time.Duration, limit int) ([]BlobRef, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT vault_id, blob_id FROM blobs
		WHERE released_at < now() - $1 * interval '1 microsecond'
		ORDER BY released_at
		LIMIT $2`, grace.Microseconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("list released blobs: %w", err)
	}

	return collectBlobRefs(rows)
}

// PendingBlobDeletions returns up to limit blobs, across all vaults, whose
// row CollectBlob deleted and whose object has not been deleted yet
// (DeleteBlobObject), oldest first.
//
// Not scoped to a vault, like RetentionCandidates.
func (store *Store) PendingBlobDeletions(ctx context.Context, limit int) ([]BlobRef, error) {
	rows, err := store.pool.Query(ctx, `SELECT vault_id, blob_id FROM blob_deletions ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending blob deletions: %w", err)
	}

	return collectBlobRefs(rows)
}

func collectBlobRefs(rows pgx.Rows) ([]BlobRef, error) {
	refs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (BlobRef, error) {
		var ref BlobRef

		err := row.Scan(&ref.VaultID, &ref.BlobID)

		return ref, err
	})
	if err != nil {
		return nil, fmt.Errorf("list blobs: %w", err)
	}

	return refs, nil
}

// CollectBlob deletes blob blobID's row if no revision references it and a
// purge released it more than grace ago, and records that its object must
// be deleted (DeleteBlobObject). It reports whether this call deleted the
// row. A blob found referenced again is no longer considered released.
//
// The row is locked with SKIP LOCKED. A commit referencing the blob holds a
// KEY SHARE lock on it from its check that the blob is complete until it
// commits, so CollectBlob skips such a blob, and a commit that starts
// checking while CollectBlob holds the lock finds the blob gone (not
// complete) once it is released. Another server process collecting the
// same blob is skipped the same way: false, nil.
func (vault *VaultStore) CollectBlob(ctx context.Context, blobID []byte, grace time.Duration) (bool, error) {
	collected := false

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var locked []byte

		err := tx.QueryRow(ctx, `
			SELECT blob_id FROM blobs
			WHERE vault_id = $1 AND blob_id = $2 AND released_at < now() - $3 * interval '1 microsecond'
			FOR UPDATE SKIP LOCKED`, vault.vaultID, blobID, grace.Microseconds()).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}

		if err != nil {
			return fmt.Errorf("lock blob: %w", err)
		}

		// A separate statement, so it sees every revision committed before
		// the lock was granted.
		var referenced bool

		err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revisions WHERE vault_id = $1 AND content_ref = $2)`,
			vault.vaultID, blobID).Scan(&referenced)
		if err != nil {
			return fmt.Errorf("check blob references: %w", err)
		}

		if referenced {
			_, err = tx.Exec(ctx, `UPDATE blobs SET released_at = NULL WHERE vault_id = $1 AND blob_id = $2`, vault.vaultID, blobID)
			if err != nil {
				return fmt.Errorf("unrelease blob: %w", err)
			}

			return nil
		}

		_, err = tx.Exec(ctx, `DELETE FROM blobs WHERE vault_id = $1 AND blob_id = $2`, vault.vaultID, blobID)
		if err != nil {
			return fmt.Errorf("delete blob: %w", err)
		}

		_, err = tx.Exec(ctx, `INSERT INTO blob_deletions (vault_id, blob_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			vault.vaultID, blobID)
		if err != nil {
			return fmt.Errorf("record blob deletion: %w", err)
		}

		collected = true

		return nil
	})
	if err != nil {
		return false, err
	}

	return collected, nil
}

// DeleteBlobObject finishes the deletion CollectBlob recorded for blobID:
// it calls deleteObject, which must delete the blob's object (succeeding if
// it is already gone), and then removes the record. It reports whether this
// call deleted the object.
//
// The record is held with FOR UPDATE SKIP LOCKED while the object is
// deleted, so another server process skips it (false, nil) and an upload of
// the same blob waits in AwaitBlobDeletion before writing the object. The
// object is left alone, and the record dropped, if the blob is complete
// again (it was uploaded anew since); while an upload of the blob is in
// progress, the record stays for a later run. If deleteObject fails, the
// record stays too.
func (vault *VaultStore) DeleteBlobObject(ctx context.Context, blobID []byte, deleteObject func(context.Context) error) (bool, error) {
	deleted := false

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var locked []byte

		err := tx.QueryRow(ctx, `
			SELECT blob_id FROM blob_deletions WHERE vault_id = $1 AND blob_id = $2 FOR UPDATE SKIP LOCKED`,
			vault.vaultID, blobID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}

		if err != nil {
			return fmt.Errorf("lock blob deletion: %w", err)
		}

		var exists, uploading bool

		err = tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM blobs WHERE vault_id = $1 AND blob_id = $2),
				EXISTS (SELECT 1 FROM blob_uploads WHERE vault_id = $1 AND blob_id = $2 AND state = 'uploading')`,
			vault.vaultID, blobID).Scan(&exists, &uploading)
		if err != nil {
			return fmt.Errorf("check blob: %w", err)
		}

		switch {
		case uploading && !exists:
			// The upload may be composing the object right now.
			return nil
		case !exists:
			if err := deleteObject(ctx); err != nil {
				return err
			}

			deleted = true
		}

		_, err = tx.Exec(ctx, `DELETE FROM blob_deletions WHERE vault_id = $1 AND blob_id = $2`, vault.vaultID, blobID)
		if err != nil {
			return fmt.Errorf("remove blob deletion: %w", err)
		}

		return nil
	})
	if err != nil {
		return false, err
	}

	return deleted, nil
}

// AwaitBlobDeletion waits until no server process is deleting blob blobID's
// object (DeleteBlobObject). An upload calls it before writing the blob's
// object: a deletion that starts later sees the upload in progress and
// leaves the object alone, so a re-uploaded object is never deleted.
func (vault *VaultStore) AwaitBlobDeletion(ctx context.Context, blobID []byte) error {
	// FOR SHARE conflicts only with the FOR UPDATE lock DeleteBlobObject
	// holds while it deletes the object; the statement is its own
	// transaction, so the share lock ends with it.
	_, err := vault.store.pool.Exec(ctx, `
		SELECT 1 FROM blob_deletions WHERE vault_id = $1 AND blob_id = $2 FOR SHARE`, vault.vaultID, blobID)
	if err != nil {
		return fmt.Errorf("wait for blob deletion: %w", err)
	}

	return nil
}
