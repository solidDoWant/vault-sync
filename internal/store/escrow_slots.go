package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// EscrowSlotReplacement names an escrow key slot to replace and its
// replacement (docs/design/encryption.md, "Re-wrapping replaces an escrow
// slot").
type EscrowSlotReplacement struct {
	VaultID        uuid.UUID
	Epoch          int32
	OldRecipientID string
	NewRecipientID string
	WrappedKey     []byte
}

// ReplaceEscrowSlot deletes the escrow slot of replacement's vault and epoch
// wrapped to OldRecipientID and inserts the slot wrapped to NewRecipientID,
// in one statement and only if the old slot is still there, so the epoch
// keeps exactly one escrow slot. The new slot keeps the old one's creator.
// It also applies to deleted vaults that are not purged yet. Without the old
// slot it changes nothing and fails with ErrNotFound.
func (store *Store) ReplaceEscrowSlot(ctx context.Context, replacement EscrowSlotReplacement) error {
	tag, err := store.pool.Exec(ctx, `
		WITH old AS (
			DELETE FROM key_slots
			WHERE vault_id = $1 AND epoch = $2 AND recipient_kind = 'escrow' AND recipient_id = $3
			RETURNING vault_id, epoch, created_by
		)
		INSERT INTO key_slots (vault_id, epoch, recipient_kind, recipient_id, wrapped_key, created_by)
		SELECT vault_id, epoch, 'escrow', $4, $5, created_by FROM old`,
		replacement.VaultID, replacement.Epoch, replacement.OldRecipientID, replacement.NewRecipientID, replacement.WrappedKey)
	if err != nil {
		return fmt.Errorf("replace escrow slot: %w", err)
	}

	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}

	return nil
}
