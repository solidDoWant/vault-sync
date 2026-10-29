package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Invitation key slot errors (docs/design/encryption.md, "Invitations").
var (
	// ErrInvitationKeysRequired is returned when an invitation to an E2EE
	// vault is created without its id hash, key slots and invite anchor.
	ErrInvitationKeysRequired = errors.New("an invitation to an end-to-end encrypted vault needs its key slots and invite anchor")
	// ErrUnexpectedInvitationKeys is returned when an invitation to, or a
	// redemption into, a plaintext vault carries key slots.
	ErrUnexpectedInvitationKeys = errors.New("a plaintext vault takes no invitation key slots")
	// ErrInvitationIDTaken is returned when an E2EE invitation's id hash is
	// already used by another invitation.
	ErrInvitationIDTaken = errors.New("the invitation id is already in use")
	// ErrNoUserKey is returned when a user without a user key redeems an
	// invitation to an E2EE vault: their slots could not be checked against
	// anything, and they could not read the vault.
	ErrNoUserKey = errors.New("redeeming an invitation to an end-to-end encrypted vault needs a user key")
)

// InvitationKeys is what an invitation to an E2EE vault carries: its key
// slots, one per existing epoch, and its invite anchor, both opaque.
type InvitationKeys struct {
	Slots  []KeySlot
	Anchor []byte
}

// InvitationSlots is a pending E2EE invitation as its holder reads it
// before redeeming: the invitation, its slots and anchor, and the vault's
// epochs.
type InvitationSlots struct {
	Invitation Invitation
	Anchor     []byte
	Slots      []KeySlot
	Epochs     []Epoch
}

// checkOneSlotPerEpoch returns ErrInvalidRecipients unless slots hold
// exactly one slot for each epoch 1..current, all for recipient (kind, id).
// A slot for an epoch the vault does not have yet is ErrEpochNotFound; a
// missing epoch is missing.
func checkOneSlotPerEpoch(slots []KeySlot, current int32, kind RecipientKind, id string) (missing bool, err error) {
	seen := make(map[int32]bool, len(slots))

	for _, slot := range slots {
		if slot.RecipientKind != kind || slot.RecipientID != id {
			return false, fmt.Errorf("%w: a slot is not for %s %s", ErrInvalidRecipients, kind, id)
		}

		if slot.Epoch < 1 || slot.Epoch > current {
			return false, fmt.Errorf("%w: %d", ErrEpochNotFound, slot.Epoch)
		}

		if seen[slot.Epoch] {
			return false, fmt.Errorf("%w: more than one slot for epoch %d", ErrInvalidRecipients, slot.Epoch)
		}

		seen[slot.Epoch] = true
	}

	return int32(len(seen)) != current, nil //nolint:gosec // bounded by the request size.
}

// deleteOrphanInvitationSlots deletes the vault's invitation key slots
// whose invitation is no longer stored. Every statement that deletes
// invitation rows runs it in the same transaction, so an invitation's
// slots never outlive it.
func deleteOrphanInvitationSlots(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM key_slots s
		WHERE s.vault_id = $1 AND s.recipient_kind = $2
			AND NOT EXISTS (SELECT 1 FROM vault_invitations i WHERE i.vault_id = s.vault_id AND i.id::text = s.recipient_id)`,
		vaultID, RecipientInvitation)
	if err != nil {
		return fmt.Errorf("delete invitation slots: %w", err)
	}

	return nil
}

// GetInvitationSlots returns the pending invitation to an E2EE vault whose
// id hashes to idHash, with its slots, anchor and the vault's epochs. It
// returns ErrInvitationNotFound for an unknown, expired, revoked or used
// invitation, an invitation to a plaintext or deleted vault alike.
func (store *Store) GetInvitationSlots(ctx context.Context, idHash []byte) (InvitationSlots, error) {
	var found InvitationSlots

	err := pgx.BeginTxFunc(ctx, store.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		invitation := &found.Invitation

		err := tx.QueryRow(ctx, `
			SELECT i.id, i.vault_id, i.role, i.created_by, i.created_at, i.expires_at, i.invite_anchor
			FROM vault_invitations i JOIN vaults v ON v.id = i.vault_id
			WHERE i.code_hash = $1 AND i.expires_at > now() AND i.invite_anchor IS NOT NULL
				AND v.deleted_at IS NULL AND v.encryption = $2`, idHash, EncryptionE2EE).
			Scan(&invitation.ID, &invitation.VaultID, &invitation.Role, &invitation.CreatedBy, &invitation.CreatedAt, &invitation.ExpiresAt, &found.Anchor)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvitationNotFound
		}

		if err != nil {
			return fmt.Errorf("look up invitation: %w", err)
		}

		rows, err := tx.Query(ctx, `
			SELECT epoch, recipient_kind, recipient_id, wrapped_key, created_by, created_at FROM key_slots
			WHERE vault_id = $1 AND recipient_kind = $2 AND recipient_id = $3
			ORDER BY epoch`, invitation.VaultID, RecipientInvitation, invitation.ID.String())
		if err != nil {
			return fmt.Errorf("list invitation slots: %w", err)
		}

		found.Slots, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (KeySlot, error) {
			var slot KeySlot

			err := row.Scan(&slot.Epoch, &slot.RecipientKind, &slot.RecipientID, &slot.WrappedKey, &slot.CreatedBy, &slot.CreatedAt)

			return slot, err
		})
		if err != nil {
			return fmt.Errorf("list invitation slots: %w", err)
		}

		rows, err = tx.Query(ctx, `
			SELECT epoch, commitment, record, created_by, created_at FROM vault_key_epochs
			WHERE vault_id = $1 ORDER BY epoch`, invitation.VaultID)
		if err != nil {
			return fmt.Errorf("list epochs: %w", err)
		}

		found.Epochs, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Epoch, error) {
			var epoch Epoch

			err := row.Scan(&epoch.Epoch, &epoch.Commitment, &epoch.Record, &epoch.CreatedBy, &epoch.CreatedAt)

			return epoch, err
		})
		if err != nil {
			return fmt.Errorf("list epochs: %w", err)
		}

		return nil
	})
	if err != nil {
		return InvitationSlots{}, err
	}

	return found, nil
}
