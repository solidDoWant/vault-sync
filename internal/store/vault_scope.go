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
	// Kind is the document's kind; kinds do not change in v1.
	Kind string
	// ContentRef is the blob id of the content, or nil.
	ContentRef []byte
	// ContentSize is the stored size of the ContentRef blob (zero without
	// content). It always comes from the blobs table, never from a client.
	ContentSize int64
	Path        string
	Deleted     bool
	DeviceID    uuid.UUID
	// UserID is the user DeviceID belongs to.
	UserID    uuid.UUID
	CreatedAt time.Time
	// Anchor is a random value PostgreSQL assigned when it stored the
	// revision; a restored database never reproduces it (SPEC.md §6.1).
	Anchor uuid.UUID
}

// Blob is a content-addressed blob's metadata.
type Blob struct {
	VaultID   uuid.UUID
	BlobID    []byte
	Size      int64
	State     string
	CreatedAt time.Time
}

// querier is a pool or a transaction.
type querier interface {
	Query(ctx context.Context, sql string, arguments ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, arguments ...any) pgx.Row
}

// Document returns the document id in this vault, or ErrNotFound.
func (vault *VaultStore) Document(ctx context.Context, id uuid.UUID) (Document, error) {
	return vault.document(ctx, vault.store.pool, id, "")
}

// document looks up a document; lock is empty or a row-locking clause.
func (vault *VaultStore) document(ctx context.Context, db querier, id uuid.UUID, lock string) (Document, error) {
	var document Document

	err := db.QueryRow(ctx, `
		SELECT id, vault_id, kind, head_rev_id, path_key, deleted, created_at
		FROM documents WHERE vault_id = $1 AND id = $2 `+lock, vault.vaultID, id).
		Scan(&document.ID, &document.VaultID, &document.Kind, &document.HeadRevID, &document.PathKey, &document.Deleted, &document.CreatedAt)

	return document, notFound(err, "look up document")
}

// selectRevisions selects every Revision field. Callers append a WHERE
// clause on r (revisions) that always includes r.vault_id.
const selectRevisions = `
	SELECT r.id, r.document_id, r.vault_id, r.seq, r.parent_rev_id, d.kind, r.content_ref, COALESCE(b.size, 0),
		r.path, r.deleted, r.device_id, dev.user_id, r.created_at, r.anchor
	FROM revisions r
	JOIN documents d ON d.vault_id = r.vault_id AND d.id = r.document_id
	JOIN devices dev ON dev.id = r.device_id
	LEFT JOIN blobs b ON b.vault_id = r.vault_id AND b.blob_id = r.content_ref`

func scanRevision(row pgx.Row) (Revision, error) {
	var revision Revision

	err := row.Scan(&revision.ID, &revision.DocumentID, &revision.VaultID, &revision.Seq, &revision.ParentRevID,
		&revision.Kind, &revision.ContentRef, &revision.ContentSize, &revision.Path, &revision.Deleted,
		&revision.DeviceID, &revision.UserID, &revision.CreatedAt, &revision.Anchor)

	return revision, err
}

// Revision returns the revision id in this vault, or ErrNotFound.
func (vault *VaultStore) Revision(ctx context.Context, id uuid.UUID) (Revision, error) {
	return vault.revision(ctx, vault.store.pool, id)
}

func (vault *VaultStore) revision(ctx context.Context, db querier, id uuid.UUID) (Revision, error) {
	revision, err := scanRevision(db.QueryRow(ctx, selectRevisions+`
		WHERE r.vault_id = $1 AND r.id = $2`, vault.vaultID, id))

	return revision, notFound(err, "look up revision")
}

// revisions runs selectRevisions with the condition "r.vault_id = $1 AND
// " + conditions; arguments are $2 onwards.
func (vault *VaultStore) revisions(ctx context.Context, db querier, conditions string, arguments ...any) ([]Revision, error) {
	rows, err := db.Query(ctx, selectRevisions+`
		WHERE r.vault_id = $1 AND `+conditions, append([]any{vault.vaultID}, arguments...)...)
	if err != nil {
		return nil, fmt.Errorf("list revisions: %w", err)
	}

	revisions, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Revision, error) { return scanRevision(row) })
	if err != nil {
		return nil, fmt.Errorf("list revisions: %w", err)
	}

	return revisions, nil
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
