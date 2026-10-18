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

// ErrBlobUploadLimit is returned when a vault already has the maximum number
// of active upload sessions.
var ErrBlobUploadLimit = errors.New("too many blob uploads in progress")

// ErrBlobUploadConflict is returned when a chunk does not continue the
// session where it currently ends, or the session is no longer active
// (another writer appended first, or it was discarded).
var ErrBlobUploadConflict = errors.New("blob upload changed concurrently")

// Blob states, as stored in blobs.state.
const (
	BlobComplete = "complete"
)

// BlobUpload is an upload session collecting one blob's chunks (SPEC.md
// §6.2). Its chunks are staged objects named by its id.
type BlobUpload struct {
	ID           uuid.UUID
	VaultID      uuid.UUID
	BlobID       []byte
	Size         int64
	ReceivedSize int64
}

// BlobChunk is one accepted chunk of an upload session.
type BlobChunk struct {
	Offset int64
	Length int64
	// Token makes the chunk's staged object key unique to the write that
	// was accepted.
	Token uuid.UUID
}

// BlobUploadStart is the outcome of BeginBlobUpload: either the blob is
// already complete (Complete, with its size), or Upload is the active
// session to continue.
type BlobUploadStart struct {
	Complete     bool
	CompleteSize int64
	Upload       BlobUpload
}

// BlobUploadRef names an upload session for maintenance.
type BlobUploadRef struct {
	VaultID uuid.UUID
	ID      uuid.UUID
}

// Encryption returns the vault's encryption mode.
func (vault *VaultStore) Encryption(ctx context.Context) (Encryption, error) {
	var encryption Encryption

	err := vault.store.pool.QueryRow(ctx, `SELECT encryption FROM vaults WHERE id = $1`, vault.vaultID).Scan(&encryption)

	return encryption, notFound(err, "look up vault encryption")
}

// CompleteBlob returns the blob blobID if it is complete in this vault, or
// ErrNotFound.
func (vault *VaultStore) CompleteBlob(ctx context.Context, blobID []byte) (Blob, error) {
	blob, err := vault.Blob(ctx, blobID)
	if err != nil {
		return Blob{}, err
	}

	if blob.State != BlobComplete {
		return Blob{}, ErrNotFound
	}

	return blob, nil
}

// BeginBlobUpload reports whether blobID is already complete in this vault
// and otherwise returns its active upload session, creating one for size
// bytes when there is none. Resuming a session counts as activity. It
// returns ErrBlobUploadLimit instead of creating a session when the vault
// already has limit active sessions. The caller checks that an existing
// session's size matches.
func (vault *VaultStore) BeginBlobUpload(ctx context.Context, blobID []byte, size int64, limit int) (BlobUploadStart, error) {
	var start BlobUploadStart

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		// Locking the vault row serializes session creation in the vault,
		// so the limit cannot be overshot and two concurrent callers cannot
		// both create a session for the same blob. NO KEY UPDATE, not
		// UPDATE: inserts referencing the vault (chunks, blobs) take KEY
		// SHARE locks on it, and a chunk append holds its session row while
		// inserting, so FOR UPDATE here would deadlock with it.
		var locked uuid.UUID

		err := tx.QueryRow(ctx, `SELECT id FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vault.vaultID).Scan(&locked)
		if err != nil {
			return notFound(err, "lock vault")
		}

		var state string

		err = tx.QueryRow(ctx, `SELECT size, state FROM blobs WHERE vault_id = $1 AND blob_id = $2`,
			vault.vaultID, blobID).Scan(&start.CompleteSize, &state)

		switch {
		case err == nil && state == BlobComplete:
			start.Complete = true

			return nil
		case err != nil && !errors.Is(err, pgx.ErrNoRows):
			return fmt.Errorf("look up blob: %w", err)
		}

		start.CompleteSize = 0

		upload := BlobUpload{VaultID: vault.vaultID, BlobID: blobID}

		err = tx.QueryRow(ctx, `
			UPDATE blob_uploads SET updated_at = now()
			WHERE vault_id = $1 AND blob_id = $2 AND state = 'uploading'
			RETURNING id, size, received_size`, vault.vaultID, blobID).
			Scan(&upload.ID, &upload.Size, &upload.ReceivedSize)
		if err == nil {
			start.Upload = upload

			return nil
		}

		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("resume blob upload: %w", err)
		}

		var active int

		err = tx.QueryRow(ctx, `SELECT count(*) FROM blob_uploads WHERE vault_id = $1 AND state = 'uploading'`,
			vault.vaultID).Scan(&active)
		if err != nil {
			return fmt.Errorf("count blob uploads: %w", err)
		}

		if active >= limit {
			return ErrBlobUploadLimit
		}

		upload.ID, err = uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generate upload id: %w", err)
		}

		upload.Size = size

		_, err = tx.Exec(ctx, `INSERT INTO blob_uploads (id, vault_id, blob_id, size) VALUES ($1, $2, $3, $4)`,
			upload.ID, vault.vaultID, blobID, size)
		if err != nil {
			return fmt.Errorf("insert blob upload: %w", err)
		}

		start.Upload = upload

		return nil
	})
	if err != nil {
		return BlobUploadStart{}, err
	}

	return start, nil
}

// ActiveBlobUpload returns the active upload session of blobID in this
// vault, or ErrNotFound, and records activity on it. Every chunk write and
// commit starts here, so the cleanup routine, which only claims sessions
// idle for longer than the upload TTL, cannot remove a session while a
// request that read it is still writing its staged objects.
func (vault *VaultStore) ActiveBlobUpload(ctx context.Context, blobID []byte) (BlobUpload, error) {
	upload := BlobUpload{VaultID: vault.vaultID, BlobID: blobID}

	err := vault.store.pool.QueryRow(ctx, `
		UPDATE blob_uploads SET updated_at = now()
		WHERE vault_id = $1 AND blob_id = $2 AND state = 'uploading'
		RETURNING id, size, received_size`, vault.vaultID, blobID).
		Scan(&upload.ID, &upload.Size, &upload.ReceivedSize)

	return upload, notFound(err, "look up blob upload")
}

// AppendBlobChunk records chunk as accepted by the active session uploadID
// and returns the new received size. The chunk must start exactly where the
// session currently ends and fit within its size; otherwise, or if the
// session is no longer active, it returns ErrBlobUploadConflict and records
// nothing. Concurrent appends at the same offset therefore accept exactly
// one.
func (vault *VaultStore) AppendBlobChunk(ctx context.Context, uploadID uuid.UUID, chunk BlobChunk) (int64, error) {
	var received int64

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			UPDATE blob_uploads SET received_size = received_size + $3, updated_at = now()
			WHERE vault_id = $1 AND id = $2 AND state = 'uploading'
				AND received_size = $4 AND received_size + $3 <= size
			RETURNING received_size`, vault.vaultID, uploadID, chunk.Length, chunk.Offset).Scan(&received)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrBlobUploadConflict
		}

		if err != nil {
			return fmt.Errorf("advance blob upload: %w", err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO blob_upload_chunks (upload_id, vault_id, "offset", length, token)
			VALUES ($1, $2, $3, $4, $5)`, uploadID, vault.vaultID, chunk.Offset, chunk.Length, chunk.Token)
		if err != nil {
			return fmt.Errorf("insert blob chunk: %w", err)
		}

		return nil
	})
	if err != nil {
		return 0, err
	}

	return received, nil
}

// BlobUploadChunks returns the accepted chunks of session uploadID in offset
// order.
func (vault *VaultStore) BlobUploadChunks(ctx context.Context, uploadID uuid.UUID) ([]BlobChunk, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT "offset", length, token FROM blob_upload_chunks
		WHERE vault_id = $1 AND upload_id = $2
		ORDER BY "offset"`, vault.vaultID, uploadID)
	if err != nil {
		return nil, fmt.Errorf("list blob chunks: %w", err)
	}

	chunks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (BlobChunk, error) {
		var chunk BlobChunk

		err := row.Scan(&chunk.Offset, &chunk.Length, &chunk.Token)

		return chunk, err
	})
	if err != nil {
		return nil, fmt.Errorf("list blob chunks: %w", err)
	}

	return chunks, nil
}

// CompleteBlobUpload marks blobID complete with size bytes and finishes
// session uploadID, in one transaction. Call it only once the blob's object
// is in place. Completing an already-complete blob changes nothing.
func (vault *VaultStore) CompleteBlobUpload(ctx context.Context, uploadID uuid.UUID, blobID []byte, size int64) error {
	return pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')
			ON CONFLICT (vault_id, blob_id) DO UPDATE SET state = 'complete', size = EXCLUDED.size
				WHERE blobs.state <> 'complete'`, vault.vaultID, blobID, size)
		if err != nil {
			return fmt.Errorf("complete blob: %w", err)
		}

		return vault.finishBlobUpload(ctx, tx, uploadID)
	})
}

// FinishBlobUpload ends session uploadID without completing its blob (for
// example after a hash mismatch). The session stops accepting chunks and a
// new upload of the same blob starts a new session; the finished session
// remains until its staged objects are removed (see DeleteBlobUpload).
func (vault *VaultStore) FinishBlobUpload(ctx context.Context, uploadID uuid.UUID) error {
	return vault.finishBlobUpload(ctx, vault.store.pool, uploadID)
}

// execer is a pool or a transaction.
type execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

func (vault *VaultStore) finishBlobUpload(ctx context.Context, db execer, uploadID uuid.UUID) error {
	_, err := db.Exec(ctx, `UPDATE blob_uploads SET state = 'finished', updated_at = now() WHERE vault_id = $1 AND id = $2`,
		vault.vaultID, uploadID)
	if err != nil {
		return fmt.Errorf("finish blob upload: %w", err)
	}

	return nil
}

// ClaimBlobUploadForRemoval finishes session uploadID if it is already
// finished or has been idle for longer than ttl, and reports whether it did.
// A session that saw activity within ttl is left alone.
func (vault *VaultStore) ClaimBlobUploadForRemoval(ctx context.Context, uploadID uuid.UUID, ttl time.Duration) (bool, error) {
	tag, err := vault.store.pool.Exec(ctx, `
		UPDATE blob_uploads SET state = 'finished'
		WHERE vault_id = $1 AND id = $2
			AND (state = 'finished' OR updated_at < now() - $3 * interval '1 microsecond')`,
		vault.vaultID, uploadID, ttl.Microseconds())
	if err != nil {
		return false, fmt.Errorf("claim blob upload: %w", err)
	}

	return tag.RowsAffected() == 1, nil
}

// DeleteBlobUpload deletes the finished session uploadID and its chunk
// records. Call it only after its staged objects are gone.
func (vault *VaultStore) DeleteBlobUpload(ctx context.Context, uploadID uuid.UUID) error {
	_, err := vault.store.pool.Exec(ctx, `DELETE FROM blob_uploads WHERE vault_id = $1 AND id = $2 AND state = 'finished'`,
		vault.vaultID, uploadID)
	if err != nil {
		return fmt.Errorf("delete blob upload: %w", err)
	}

	return nil
}

// ReapableBlobUploads returns up to limit upload sessions, across all
// vaults, that are finished or have been idle for longer than ttl, least
// recently active first.
//
// It is the one blob query not scoped to a vault: it serves the background
// cleanup routine, never a request, and only names sessions; the cleanup
// acts on each through InVault.
func (store *Store) ReapableBlobUploads(ctx context.Context, ttl time.Duration, limit int) ([]BlobUploadRef, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT vault_id, id FROM blob_uploads
		WHERE state = 'finished' OR updated_at < now() - $1 * interval '1 microsecond'
		ORDER BY updated_at
		LIMIT $2`, ttl.Microseconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("list reapable blob uploads: %w", err)
	}

	refs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (BlobUploadRef, error) {
		var ref BlobUploadRef

		err := row.Scan(&ref.VaultID, &ref.ID)

		return ref, err
	})
	if err != nil {
		return nil, fmt.Errorf("list reapable blob uploads: %w", err)
	}

	return refs, nil
}
