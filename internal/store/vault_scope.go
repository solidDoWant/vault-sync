package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned when a document, revision or blob does not exist in
// the vault it was looked up in, including when it exists in another vault.
var ErrNotFound = errors.New("not found")

// VaultStore runs queries scoped to one vault. Every query it runs filters by
// its vault id, so an id belonging to another vault is simply not found:
// cross-vault access cannot be expressed through it (SPEC.md §5).
//
// Handlers obtain the vault id from the authorization layer
// (internal/authz), never directly from the request, so a VaultStore is only
// ever built for a vault the caller is a member of.
type VaultStore struct {
	store   *Store
	vaultID uuid.UUID
}

// InVault returns a store handle scoped to vaultID.
func (store *Store) InVault(vaultID uuid.UUID) *VaultStore {
	return &VaultStore{store: store, vaultID: vaultID}
}

// VaultID returns the id of the vault the handle is scoped to.
func (vault *VaultStore) VaultID() uuid.UUID {
	return vault.vaultID
}

// Document is a file with a stable identity across renames.
type Document struct {
	ID        uuid.UUID
	VaultID   uuid.UUID
	Kind      string
	HeadRevID uuid.UUID
	PathKey   string
	Deleted   bool
	CreatedAt time.Time
}

// Revision is one immutable entry in a document's history.
type Revision struct {
	ID          uuid.UUID
	DocumentID  uuid.UUID
	VaultID     uuid.UUID
	Seq         int64
	ParentRevID uuid.NullUUID
	// ContentRef is the blob id of the content, or nil.
	ContentRef []byte
	Path       string
	Deleted    bool
	DeviceID   uuid.UUID
	CreatedAt  time.Time
}

// Blob is a content-addressed blob's metadata.
type Blob struct {
	VaultID   uuid.UUID
	BlobID    []byte
	Size      int64
	State     string
	CreatedAt time.Time
}

// Document returns the document id in this vault, or ErrNotFound.
func (vault *VaultStore) Document(ctx context.Context, id uuid.UUID) (Document, error) {
	var document Document

	err := vault.store.pool.QueryRow(ctx, `
		SELECT id, vault_id, kind, head_rev_id, path_key, deleted, created_at
		FROM documents WHERE vault_id = $1 AND id = $2`, vault.vaultID, id).
		Scan(&document.ID, &document.VaultID, &document.Kind, &document.HeadRevID, &document.PathKey, &document.Deleted, &document.CreatedAt)

	return document, notFound(err, "look up document")
}

// Revision returns the revision id in this vault, or ErrNotFound.
func (vault *VaultStore) Revision(ctx context.Context, id uuid.UUID) (Revision, error) {
	var revision Revision

	err := vault.store.pool.QueryRow(ctx, `
		SELECT id, document_id, vault_id, seq, parent_rev_id, content_ref, path, deleted, device_id, created_at
		FROM revisions WHERE vault_id = $1 AND id = $2`, vault.vaultID, id).
		Scan(&revision.ID, &revision.DocumentID, &revision.VaultID, &revision.Seq, &revision.ParentRevID,
			&revision.ContentRef, &revision.Path, &revision.Deleted, &revision.DeviceID, &revision.CreatedAt)

	return revision, notFound(err, "look up revision")
}

// Blob returns the blob blobID in this vault, or ErrNotFound.
func (vault *VaultStore) Blob(ctx context.Context, blobID []byte) (Blob, error) {
	var blob Blob

	err := vault.store.pool.QueryRow(ctx, `
		SELECT vault_id, blob_id, size, state, created_at
		FROM blobs WHERE vault_id = $1 AND blob_id = $2`, vault.vaultID, blobID).
		Scan(&blob.VaultID, &blob.BlobID, &blob.Size, &blob.State, &blob.CreatedAt)

	return blob, notFound(err, "look up blob")
}

func notFound(err error, action string) error {
	if err == nil {
		return nil
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}

	return fmt.Errorf("%s: %w", action, err)
}
