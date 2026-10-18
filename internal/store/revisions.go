package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// CommitRevision errors. Each names a reason the commit was refused; nothing
// was written.
var (
	// ErrRevisionConflict: the revision id was already committed in this
	// vault with different fields.
	ErrRevisionConflict = errors.New("revision_id was already committed with different fields")
	// ErrIDInUse: the document or revision id is taken outside this vault.
	ErrIDInUse = errors.New("id is already in use")
	// ErrDeviceNotFound: the device does not belong to the committing user.
	ErrDeviceNotFound = errors.New("device not found")
	// ErrDocumentNotFound: a base revision was given for a document that
	// does not exist in this vault.
	ErrDocumentNotFound = errors.New("document not found")
	// ErrKindMismatch: the kind differs from the existing document's.
	ErrKindMismatch = errors.New("kind differs from the document's kind")
	// ErrBlobNotComplete: the content is not a complete blob in this vault.
	ErrBlobNotComplete = errors.New("content is not a complete blob in this vault")
	// ErrBlobSizeMismatch: the claimed content size differs from the
	// stored blob's size.
	ErrBlobSizeMismatch = errors.New("content size differs from the stored blob's size")
	// ErrPathKeyTaken: another live document in the vault has the path key.
	ErrPathKeyTaken = errors.New("path_key is taken by another live document")
)

// HeadMovedError is returned when a commit's base is not the document's
// current head (optimistic concurrency, SPEC.md §6.2). Document is the
// document as it is now.
type HeadMovedError struct {
	Document Document
}

func (err *HeadMovedError) Error() string {
	return "base revision is not the document's head"
}

// NewRevision is a revision to commit. Ids are client-generated.
type NewRevision struct {
	ID         uuid.UUID
	DocumentID uuid.UUID
	// BaseRevID is the document's head the revision is based on; invalid
	// (null) for a new document.
	BaseRevID uuid.NullUUID
	Kind      string
	// ContentRef is the content's blob id and ContentSize its size as
	// claimed by the client, which must equal the stored blob's size.
	ContentRef  []byte
	ContentSize int64
	Path        string
	PathKey     string
	Deleted     bool
	DeviceID    uuid.UUID
	// UserID is the committing user; DeviceID must belong to them.
	UserID uuid.UUID
}

// livePathKeyIndex enforces path_key uniqueness among live documents.
const livePathKeyIndex = "documents_live_path_key_idx"

// idConstraints are the unique constraints on client-generated ids.
var idConstraints = map[string]bool{
	"documents_pkey":               true,
	"documents_id_vault_id_key":    true,
	"revisions_pkey":               true,
	"revisions_id_document_id_key": true,
}

// CommitRevision appends revision to its document with optimistic
// concurrency (SPEC.md §6.2) and returns the committed revision with its
// seq. It is idempotent by revision id: if the id was already committed in
// this vault with the same fields, that revision is returned (whatever the
// document's head is now); with different fields, ErrRevisionConflict.
//
// Otherwise the commit is accepted only if BaseRevID is the document's head
// (*HeadMovedError if not), or the document does not exist in this vault and
// BaseRevID is null (ErrDocumentNotFound if a base was given). The content
// must be a complete blob in this vault of the claimed size. The revision is
// assigned the vault's next seq, and the document's head, path key and
// tombstone flag are updated, all in one transaction.
//
// Every commit to a vault locks the vault row first and holds it until it
// commits, so commits to one vault are serialized by PostgreSQL across all
// server processes: seqs are gapless, and a revision becomes visible only
// after every revision with a lower seq.
func (vault *VaultStore) CommitRevision(ctx context.Context, revision NewRevision) (Revision, error) {
	var committed Revision

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var err error

		committed, err = vault.commitRevision(ctx, tx, revision)

		return err
	})
	if err != nil {
		return Revision{}, commitError(err)
	}

	return committed, nil
}

func (vault *VaultStore) commitRevision(ctx context.Context, tx pgx.Tx, revision NewRevision) (Revision, error) {
	// NO KEY UPDATE, like BeginBlobUpload: inserts referencing the vault
	// take KEY SHARE locks on it and must not be blocked.
	var headSeq int64

	err := tx.QueryRow(ctx, `SELECT head_seq FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vault.vaultID).Scan(&headSeq)
	if err != nil {
		return Revision{}, notFound(err, "lock vault")
	}

	var owned bool

	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND user_id = $2)`,
		revision.DeviceID, revision.UserID).Scan(&owned)
	if err != nil {
		return Revision{}, fmt.Errorf("look up device: %w", err)
	}

	if !owned {
		return Revision{}, ErrDeviceNotFound
	}

	// Idempotency comes before the head comparison: a retry whose first
	// attempt was applied (and whose response was lost) must get that
	// revision back even if other commits moved the head since.
	existing, err := vault.revision(ctx, tx, revision.ID)
	switch {
	case err == nil:
		if !sameRevision(existing, revision) {
			return Revision{}, ErrRevisionConflict
		}

		return existing, nil
	case !errors.Is(err, ErrNotFound):
		return Revision{}, err
	}

	document, err := vault.document(ctx, tx, revision.DocumentID, "FOR NO KEY UPDATE")

	isNew := errors.Is(err, ErrNotFound)
	switch {
	case isNew && revision.BaseRevID.Valid:
		return Revision{}, ErrDocumentNotFound
	case isNew:
	case err != nil:
		return Revision{}, err
	case !skipBaseRevisionCheck && (!revision.BaseRevID.Valid || revision.BaseRevID.UUID != document.HeadRevID):
		return Revision{}, &HeadMovedError{Document: document}
	case document.Kind != revision.Kind:
		return Revision{}, ErrKindMismatch
	}

	var size int64

	err = tx.QueryRow(ctx, `
		SELECT size FROM blobs WHERE vault_id = $1 AND blob_id = $2 AND state = $3 FOR KEY SHARE`,
		vault.vaultID, revision.ContentRef, BlobComplete).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrBlobNotComplete
	}

	if err != nil {
		return Revision{}, fmt.Errorf("look up blob: %w", err)
	}

	if size != revision.ContentSize {
		return Revision{}, ErrBlobSizeMismatch
	}

	var seq int64

	err = tx.QueryRow(ctx, `UPDATE vaults SET head_seq = head_seq + 1 WHERE id = $1 RETURNING head_seq`, vault.vaultID).Scan(&seq)
	if err != nil {
		return Revision{}, fmt.Errorf("advance head_seq: %w", err)
	}

	// documents mirrors the head revision (head_rev_id, path_key, deleted)
	// and is written in the same transaction as the revision: the live
	// path_key index relies on deleted being accurate.
	if isNew {
		_, err = tx.Exec(ctx, `
			INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			revision.DocumentID, vault.vaultID, revision.Kind, revision.ID, revision.PathKey, revision.Deleted)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE documents SET head_rev_id = $3, path_key = $4, deleted = $5
			WHERE vault_id = $1 AND id = $2`,
			vault.vaultID, revision.DocumentID, revision.ID, revision.PathKey, revision.Deleted)
	}

	if err != nil {
		return Revision{}, fmt.Errorf("write document: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO revisions (id, document_id, vault_id, seq, parent_rev_id, content_ref, path, deleted, device_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		revision.ID, revision.DocumentID, vault.vaultID, seq, revision.BaseRevID, revision.ContentRef,
		revision.Path, revision.Deleted, revision.DeviceID)
	if err != nil {
		return Revision{}, fmt.Errorf("insert revision: %w", err)
	}

	return vault.revision(ctx, tx, revision.ID)
}

// sameRevision reports whether a retried commit matches the revision its
// first attempt committed.
func sameRevision(existing Revision, revision NewRevision) bool {
	return existing.DocumentID == revision.DocumentID &&
		existing.ParentRevID == revision.BaseRevID &&
		existing.Kind == revision.Kind &&
		bytes.Equal(existing.ContentRef, revision.ContentRef) &&
		existing.ContentSize == revision.ContentSize &&
		existing.Path == revision.Path &&
		existing.Deleted == revision.Deleted &&
		existing.DeviceID == revision.DeviceID
}

// commitError maps constraint violations to CommitRevision errors.
func commitError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != uniqueViolation {
		return err
	}

	switch {
	case pgErr.ConstraintName == livePathKeyIndex:
		return ErrPathKeyTaken
	case idConstraints[pgErr.ConstraintName]:
		// A client-generated id that exists in another vault: lookups
		// in this vault did not find it, but ids are globally unique.
		return ErrIDInUse
	default:
		return err
	}
}

// uniqueViolation is PostgreSQL's unique_violation SQLSTATE.
const uniqueViolation = "23505"

// Changes is one page of a vault's change feed.
type Changes struct {
	// Revisions have seq > the requested cursor, in ascending seq order.
	Revisions []Revision
	// HasMore reports whether revisions after the last one returned exist.
	HasMore bool
	// HeadSeq is the vault's head_seq in the same snapshot.
	HeadSeq int64
}

// ListChanges returns up to limit revisions with seq > since in ascending
// seq order (SPEC.md §6.1), and the vault's head_seq, read from one
// snapshot.
func (vault *VaultStore) ListChanges(ctx context.Context, since int64, limit int) (Changes, error) {
	var changes Changes

	err := pgx.BeginTxFunc(ctx, vault.store.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT head_seq FROM vaults WHERE id = $1`, vault.vaultID).Scan(&changes.HeadSeq)
		if err != nil {
			return notFound(err, "look up head_seq")
		}

		// One extra row tells whether another page exists.
		revisions, err := vault.revisions(ctx, tx, `r.seq > $2 ORDER BY r.seq LIMIT $3`, since, limit+1)
		if err != nil {
			return err
		}

		changes.HasMore = len(revisions) > limit
		changes.Revisions = revisions[:min(len(revisions), limit)]

		return nil
	})
	if err != nil {
		return Changes{}, err
	}

	return changes, nil
}

// History is one page of a document's history.
type History struct {
	Document Document
	// Revisions are newest (highest seq) first.
	Revisions []Revision
	// HasMore reports whether older revisions exist.
	HasMore bool
}

// DocumentHistory returns the document documentID and up to limit of its
// revisions with seq < before (all of them if before is zero), newest first,
// read from one snapshot. It returns ErrNotFound if the document does not
// exist in this vault.
func (vault *VaultStore) DocumentHistory(ctx context.Context, documentID uuid.UUID, before int64, limit int) (History, error) {
	var history History

	err := pgx.BeginTxFunc(ctx, vault.store.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error

		history.Document, err = vault.document(ctx, tx, documentID, "")
		if err != nil {
			return err
		}

		if before == 0 {
			before = math.MaxInt64
		}

		revisions, err := vault.revisions(ctx, tx, `r.document_id = $2 AND r.seq < $3 ORDER BY r.seq DESC LIMIT $4`,
			documentID, before, limit+1)
		if err != nil {
			return err
		}

		history.HasMore = len(revisions) > limit
		history.Revisions = revisions[:min(len(revisions), limit)]

		return nil
	})
	if err != nil {
		return History{}, err
	}

	return history, nil
}
