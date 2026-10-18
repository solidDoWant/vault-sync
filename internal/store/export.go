package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// AllVaults returns up to limit vaults in ascending id order, starting after
// the vault id after (uuid.Nil for the first page), regardless of
// membership. Role is empty. It exists for the export job (SPEC.md §4),
// which archives every vault; request handlers must use ListVaults.
func (store *Store) AllVaults(ctx context.Context, after uuid.UUID, limit int) ([]Vault, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT id, name, encryption, escrow, head_seq, created_at
		FROM vaults
		WHERE id > $1
		ORDER BY id
		LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list all vaults: %w", err)
	}

	vaults, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Vault, error) {
		var vault Vault

		err := row.Scan(&vault.ID, &vault.Name, &vault.Encryption, &vault.Escrow, &vault.HeadSeq, &vault.CreatedAt)

		return vault, err
	})
	if err != nil {
		return nil, fmt.Errorf("list all vaults: %w", err)
	}

	return vaults, nil
}

// LiveDocument is a document's state at some seq, when it is not deleted.
type LiveDocument struct {
	ID         uuid.UUID
	RevisionID uuid.UUID
	Path       string
	// ContentRef is the content's blob id and Size its stored size.
	ContentRef []byte
	Size       int64
}

// LiveDocumentsAt returns up to limit documents of this vault as they were
// when the vault's head_seq was seq, in ascending document id order,
// starting after the document id after (uuid.Nil for the first page). Each
// document is represented by its latest revision with a seq of at most seq;
// documents created later, and documents whose revision at seq is a
// tombstone, are left out.
//
// Revisions are immutable and become visible in seq order (CommitRevision),
// so every page describes the same point in time without holding a
// transaction open between pages.
func (vault *VaultStore) LiveDocumentsAt(ctx context.Context, seq int64, after uuid.UUID, limit int) ([]LiveDocument, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT d.id, h.id, h.path, h.content_ref, b.size
		FROM documents d
		CROSS JOIN LATERAL (
			SELECT r.id, r.path, r.content_ref, r.deleted
			FROM revisions r
			WHERE r.document_id = d.id AND r.vault_id = d.vault_id AND r.seq <= $2
			ORDER BY r.seq DESC
			LIMIT 1
		) h
		JOIN blobs b ON b.vault_id = d.vault_id AND b.blob_id = h.content_ref
		WHERE d.vault_id = $1 AND d.id > $3 AND NOT h.deleted
		ORDER BY d.id
		LIMIT $4`, vault.vaultID, seq, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list live documents: %w", err)
	}

	documents, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (LiveDocument, error) {
		var document LiveDocument

		err := row.Scan(&document.ID, &document.RevisionID, &document.Path, &document.ContentRef, &document.Size)

		return document, err
	})
	if err != nil {
		return nil, fmt.Errorf("list live documents: %w", err)
	}

	return documents, nil
}
