package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Re-encryption and retirement errors (docs/design/encryption.md,
// "Re-encrypting history").
var (
	// ErrFirstEpochKept is returned for retiring epoch 1, whose key derives
	// every path_key for the vault's whole life.
	ErrFirstEpochKept = errors.New("epoch 1 is never retired: its key derives every path_key")
	// ErrEpochInUse is returned for retiring the vault's current epoch or an
	// epoch a stored revision still uses.
	ErrEpochInUse = errors.New("the epoch is still in use: it is the current epoch or a revision uses it")
	// ErrCiphertextShape is returned when a rewrite gives content for a
	// revision without content, or none for a revision with content.
	ErrCiphertextShape = errors.New("content_ref must be given exactly when the revision has content")
)

// RevisionCiphertext is a stored revision's ciphertext re-sealed under a
// newer epoch by an owner's re-key job.
type RevisionCiphertext struct {
	RevisionID uuid.UUID
	// FromEpoch is the epoch the revision must still be at, and ToEpoch the
	// epoch the new ciphertext is sealed under, which must be current.
	FromEpoch int32
	ToEpoch   int32
	// Path is the sealed path. ContentRef and ContentSize are the sealed
	// content's blob; ContentRef is nil exactly when the revision has no
	// content.
	Path        string
	ContentRef  []byte
	ContentSize int64
}

// ReplaceRevisionCiphertext replaces a stored revision's path and content
// with ciphertext under ToEpoch, and reports whether it did. It is
// conditional, under the vault row lock that commits and epoch changes take:
// a rewrite whose revision is no longer at FromEpoch, or whose ToEpoch is no
// longer the current epoch, is skipped (false, nil). Nothing else changes:
// not the revision's seq, document or tombstone flag, not the document's
// path_key, and not which revision is the document's head. The replaced
// content is released for the blob garbage collector, which deletes it once
// no revision references it.
//
// It returns ErrNotEncrypted for a plaintext vault, ErrNotFound for a
// revision the vault does not have, ErrCiphertextShape when content is given
// for a revision without content or missing for one with content,
// ErrBlobNotComplete when the content is not a complete blob in the vault,
// and ErrBlobSizeMismatch when its size differs from the stored blob's.
func (vault *VaultStore) ReplaceRevisionCiphertext(ctx context.Context, replacement RevisionCiphertext) (bool, error) {
	replaced := false

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		state, err := lockKeyState(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		if state.Encryption != EncryptionE2EE {
			return ErrNotEncrypted
		}

		var epoch int32

		var oldContent []byte

		// NO KEY UPDATE, as a commit locks a document: it orders the
		// rewrite against a retention purge deleting the revision.
		err = tx.QueryRow(ctx, `
			SELECT epoch, content_ref FROM revisions WHERE vault_id = $1 AND id = $2 FOR NO KEY UPDATE`,
			vault.vaultID, replacement.RevisionID).Scan(&epoch, &oldContent)
		if err != nil {
			return notFound(err, "lock revision")
		}

		if (oldContent == nil) != (replacement.ContentRef == nil) {
			return ErrCiphertextShape
		}

		if epoch != replacement.FromEpoch || state.CurrentEpoch != replacement.ToEpoch {
			return nil
		}

		if replacement.ContentRef != nil {
			if err := checkCompleteBlob(ctx, tx, vault.vaultID, replacement.ContentRef, replacement.ContentSize); err != nil {
				return err
			}
		}

		_, err = tx.Exec(ctx, `UPDATE revisions SET path = $3, content_ref = $4, epoch = $5 WHERE vault_id = $1 AND id = $2`,
			vault.vaultID, replacement.RevisionID, storedText(replacement.ToEpoch, replacement.Path), replacement.ContentRef, replacement.ToEpoch)
		if err != nil {
			return fmt.Errorf("replace revision ciphertext: %w", err)
		}

		if oldContent != nil {
			if err := vault.releaseBlobs(ctx, tx, [][]byte{oldContent}); err != nil {
				return err
			}
		}

		replaced = true

		return nil
	})
	if err != nil {
		return false, err
	}

	return replaced, nil
}

// checkCompleteBlob returns ErrBlobNotComplete unless blobID is a complete
// blob of the vault, and ErrBlobSizeMismatch unless it has size. Like a
// commit's content check it holds a KEY SHARE lock on the blob row until tx
// ends, so the garbage collector cannot delete it meanwhile.
func checkCompleteBlob(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, blobID []byte, size int64) error {
	var stored int64

	err := tx.QueryRow(ctx, `
		SELECT size FROM blobs WHERE vault_id = $1 AND blob_id = $2 AND state = $3 FOR KEY SHARE`,
		vaultID, blobID, BlobComplete).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBlobNotComplete
	}

	if err != nil {
		return fmt.Errorf("look up blob: %w", err)
	}

	if stored != size {
		return ErrBlobSizeMismatch
	}

	return nil
}

// RetireEpoch retires epoch, which no stored revision may use: it deletes
// the epoch's key slots for every recipient and marks the epoch retired,
// under the vault row lock that commits and rewrites take, so no revision
// can move onto it meanwhile. The epoch's row, commitment and signed record
// stay. Retiring a retired epoch changes nothing.
//
// It returns ErrNotEncrypted for a plaintext vault, ErrEpochNotFound for an
// epoch the vault does not have, ErrFirstEpochKept for epoch 1, and
// ErrEpochInUse for the current epoch or one a revision uses.
func (vault *VaultStore) RetireEpoch(ctx context.Context, epoch int32) error {
	return pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		state, err := lockKeyState(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		if state.Encryption != EncryptionE2EE {
			return ErrNotEncrypted
		}

		var retired bool

		err = tx.QueryRow(ctx, `SELECT retired_at IS NOT NULL FROM vault_key_epochs WHERE vault_id = $1 AND epoch = $2`,
			vault.vaultID, epoch).Scan(&retired)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: %d", ErrEpochNotFound, epoch)
		}

		if err != nil {
			return fmt.Errorf("look up epoch: %w", err)
		}

		switch {
		case epoch == 1:
			return ErrFirstEpochKept
		case epoch == state.CurrentEpoch:
			return ErrEpochInUse
		case retired:
			return nil
		}

		var used bool

		err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revisions WHERE vault_id = $1 AND epoch = $2)`,
			vault.vaultID, epoch).Scan(&used)
		if err != nil {
			return fmt.Errorf("check epoch use: %w", err)
		}

		if used {
			return ErrEpochInUse
		}

		if _, err := tx.Exec(ctx, `DELETE FROM key_slots WHERE vault_id = $1 AND epoch = $2`, vault.vaultID, epoch); err != nil {
			return fmt.Errorf("delete retired slots: %w", err)
		}

		_, err = tx.Exec(ctx, `UPDATE vault_key_epochs SET retired_at = now() WHERE vault_id = $1 AND epoch = $2`, vault.vaultID, epoch)
		if err != nil {
			return fmt.Errorf("retire epoch: %w", err)
		}

		return nil
	})
}

// retiredEpochs returns the vault's retired epochs, which take no key
// slots, read in tx.
func retiredEpochs(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) (map[int32]bool, error) {
	rows, err := tx.Query(ctx, `SELECT epoch FROM vault_key_epochs WHERE vault_id = $1 AND retired_at IS NOT NULL`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list retired epochs: %w", err)
	}

	epochs, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return nil, fmt.Errorf("list retired epochs: %w", err)
	}

	retired := make(map[int32]bool, len(epochs))
	for _, epoch := range epochs {
		retired[epoch] = true
	}

	return retired, nil
}

// withoutRetired returns slots without those for a retired epoch, which are
// accepted but not stored.
func withoutRetired(slots []KeySlot, retired map[int32]bool) []KeySlot {
	if len(retired) == 0 {
		return slots
	}

	kept := make([]KeySlot, 0, len(slots))

	for _, slot := range slots {
		if !retired[slot.Epoch] {
			kept = append(kept, slot)
		}
	}

	return kept
}
