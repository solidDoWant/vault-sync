package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Vault key errors (SPEC.md §9.3).
var (
	// ErrNotEncrypted is returned for a key operation on a plaintext vault.
	ErrNotEncrypted = errors.New("the vault is not end-to-end encrypted")
	// ErrNextEpochRequired is returned when a member of an E2EE vault is
	// removed without the next epoch.
	ErrNextEpochRequired = errors.New("removing a member of an end-to-end encrypted vault requires the next epoch")
	// ErrUnexpectedNextEpoch is returned when a member of a plaintext vault
	// is removed with a next epoch.
	ErrUnexpectedNextEpoch = errors.New("a plaintext vault takes no next epoch")
	// ErrSelfRemoval is returned when an owner removes themselves from an
	// E2EE vault with RemoveMember: they would create, and so know, the
	// epoch meant to exclude them. LeaveVault leaves the rotation to a
	// remaining owner.
	ErrSelfRemoval = errors.New("an owner cannot remove themselves from an end-to-end encrypted vault with RemoveMember; use LeaveVault")
	// ErrInvalidRecipients is returned when key slots are missing for a
	// recipient the epoch must be wrapped to, or name a recipient that may
	// not have one.
	ErrInvalidRecipients = errors.New("key slot recipients do not match the vault's members")
	// ErrEpochNotFound is returned for a key slot whose epoch the vault
	// does not have.
	ErrEpochNotFound = errors.New("the vault has no such epoch")
	// ErrEpochRecord is returned when a new epoch's signed record, or the
	// escrow entry that comes with it, does not verify against the vault's
	// membership log.
	ErrEpochRecord = errors.New("the epoch record does not verify against the vault's membership log")
)

// RecipientKind is whom a key slot wraps an epoch key to, as stored in
// key_slots.recipient_kind.
type RecipientKind string

// Key slot recipient kinds.
const (
	// RecipientUser: a member's user key; the recipient id is the user id.
	RecipientUser RecipientKind = "user"
	// RecipientEscrow: the deployment's escrow key (SPEC.md §9.4).
	RecipientEscrow RecipientKind = "escrow"
	// RecipientInvitation: a pending invitation's key; the recipient id is
	// the invitation id. Its slots live only while the invitation is stored.
	RecipientInvitation RecipientKind = "invitation"
)

// KeySlot is an epoch key wrapped to one recipient. The wrapped key is
// opaque to the server.
type KeySlot struct {
	Epoch         int32
	RecipientKind RecipientKind
	// RecipientID is the user id (canonical form) for RecipientUser and the
	// invitation id (canonical form) for RecipientInvitation.
	RecipientID string
	WrappedKey  []byte
	// CreatedBy is the user who stored the slot; set by the store.
	CreatedBy uuid.UUID
	CreatedAt time.Time
}

// Epoch is one vault key epoch. Commitment lets a recipient check that the
// key it unwrapped is the epoch's key; it is opaque to the server.
type Epoch struct {
	Epoch      int32
	Commitment []byte
	// Record is the epoch's signed record as received, opaque to the store;
	// nil for an epoch created without one.
	Record    []byte
	CreatedBy uuid.UUID
	CreatedAt time.Time
}

// KeyState is a vault's key state.
type KeyState struct {
	Encryption Encryption
	Escrow     bool
	// CurrentEpoch is the epoch new revisions must use; 0 when the vault
	// has none (always for plaintext vaults).
	CurrentEpoch int32
	// RotationPending asks an owner client to create the next epoch.
	RotationPending bool
}

// NextEpoch is the epoch after ExpectedEpoch: its commitment and its key
// wrapped to every recipient. The slots' Epoch is ignored.
type NextEpoch struct {
	ExpectedEpoch int32
	Commitment    []byte
	Slots         []KeySlot
	// Record is the epoch's signed record, stored with the epoch.
	Record []byte
	// EscrowEntry is a membership log entry to append in the same
	// transaction as the epoch (the escrow on/off entry), or nil.
	EscrowEntry *LogEntry
	// Check, when set, verifies the new epoch against the vault's log under
	// the vault row lock, before anything is written (see EpochCheck).
	Check EpochCheck
}

// EpochCheck verifies a new epoch of an E2EE vault. log is the vault's
// membership log in seq order, followed by the NextEpoch's EscrowEntry if
// it has one; prevCommitment is the current epoch's commitment (nil before
// the first epoch). It returns whether escrow is on at the head of log, and
// an error wrapping ErrEpochRecord when the epoch does not verify.
type EpochCheck func(log []LogEntry, prevCommitment []byte) (escrow bool, err error)

// MissingSlot is a member's missing key slot for an epoch, with the
// member's public key to wrap the epoch key to.
type MissingSlot struct {
	Epoch     int32
	UserID    uuid.UUID
	PublicKey []byte
}

// lockKeyState locks the vault row like lockVault and returns its key state.
func lockKeyState(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) (KeyState, error) {
	return keyState(ctx, tx, vaultID, "FOR NO KEY UPDATE")
}

func keyState(ctx context.Context, db querier, vaultID uuid.UUID, lock string) (KeyState, error) {
	var state KeyState

	err := db.QueryRow(ctx, `SELECT encryption, escrow, current_epoch, rotation_pending FROM vaults WHERE id = $1 `+lock, vaultID).
		Scan(&state.Encryption, &state.Escrow, &state.CurrentEpoch, &state.RotationPending)
	if errors.Is(err, pgx.ErrNoRows) {
		return KeyState{}, ErrVaultNotFound
	}

	if err != nil {
		return KeyState{}, fmt.Errorf("read key state: %w", err)
	}

	return state, nil
}

// KeyState returns the vault's key state.
func (vault *VaultStore) KeyState(ctx context.Context) (KeyState, error) {
	return keyState(ctx, vault.store.pool, vault.vaultID, "")
}

// RotateEpoch creates the epoch after next.ExpectedEpoch, created by
// creatorID, and clears the vault's pending rotation, in one transaction.
// It is a compare-and-set on the current epoch: ErrEpochNotCurrent when
// next.ExpectedEpoch is not the vault's current epoch (another rotation won),
// ErrInvalidRecipients when the slots are not exactly one per member with a
// user key (plus at most one escrow slot in an escrow vault), and
// ErrNotEncrypted for a plaintext vault.
func (vault *VaultStore) RotateEpoch(ctx context.Context, creatorID uuid.UUID, next NextEpoch) (Epoch, error) {
	var created Epoch

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		state, err := lockKeyState(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		created, err = createEpoch(ctx, tx, vault.vaultID, state, creatorID, next)

		return err
	})
	if err != nil {
		return Epoch{}, err
	}

	return created, nil
}

// createEpoch creates the epoch after next.ExpectedEpoch under the vault row
// lock (see RotateEpoch), for the vault's members as they are in tx.
func createEpoch(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, state KeyState, creatorID uuid.UUID, next NextEpoch) (Epoch, error) {
	if state.Encryption != EncryptionE2EE {
		return Epoch{}, ErrNotEncrypted
	}

	if next.ExpectedEpoch != state.CurrentEpoch {
		return Epoch{}, ErrEpochNotCurrent
	}

	if state.CurrentEpoch == math.MaxInt32 {
		return Epoch{}, errors.New("epoch counter exhausted")
	}

	if next.Check != nil {
		escrow, err := checkSignedEpoch(ctx, tx, vaultID, state, next)
		if err != nil {
			return Epoch{}, err
		}

		state.Escrow = escrow
	}

	kept, err := checkEpochRecipients(ctx, tx, vaultID, state, next.Slots)
	if err != nil {
		return Epoch{}, err
	}

	if next.EscrowEntry != nil {
		if err := insertLogEntry(ctx, tx, vaultID, *next.EscrowEntry); err != nil {
			return Epoch{}, err
		}

		if _, err := tx.Exec(ctx, `UPDATE vaults SET escrow = $2 WHERE id = $1`, vaultID, state.Escrow); err != nil {
			return Epoch{}, fmt.Errorf("set escrow: %w", err)
		}
	}

	created := Epoch{Epoch: state.CurrentEpoch + 1, Commitment: next.Commitment, Record: next.Record, CreatedBy: creatorID}

	err = tx.QueryRow(ctx, `
		INSERT INTO vault_key_epochs (vault_id, epoch, commitment, record, created_by) VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`, vaultID, created.Epoch, created.Commitment, created.Record, creatorID).Scan(&created.CreatedAt)
	if err != nil {
		return Epoch{}, fmt.Errorf("insert epoch: %w", err)
	}

	slots := make([]KeySlot, len(kept))
	for index, slot := range kept {
		slot.Epoch = created.Epoch
		slots[index] = slot
	}

	if _, err := insertKeySlots(ctx, tx, vaultID, creatorID, slots); err != nil {
		return Epoch{}, err
	}

	_, err = tx.Exec(ctx, `UPDATE vaults SET current_epoch = $2, rotation_pending = false WHERE id = $1`, vaultID, created.Epoch)
	if err != nil {
		return Epoch{}, fmt.Errorf("advance epoch: %w", err)
	}

	return created, nil
}

// checkSignedEpoch runs next.Check on the vault's log (with next's escrow
// entry appended) and the current epoch's commitment, under the vault row
// lock held by tx, and returns whether escrow is on afterwards.
func checkSignedEpoch(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, state KeyState, next NextEpoch) (bool, error) {
	log, err := listLogEntries(ctx, tx, vaultID, 0, math.MaxInt32)
	if err != nil {
		return false, err
	}

	if next.EscrowEntry != nil {
		log = append(log, *next.EscrowEntry)
	}

	var prevCommitment []byte

	if state.CurrentEpoch > 0 {
		err := tx.QueryRow(ctx, `SELECT commitment FROM vault_key_epochs WHERE vault_id = $1 AND epoch = $2`,
			vaultID, state.CurrentEpoch).Scan(&prevCommitment)
		if err != nil {
			return false, fmt.Errorf("read current epoch: %w", err)
		}
	}

	return next.Check(log, prevCommitment)
}

// keyedMembers returns the ids (canonical form) of the vault's members who
// have a user key: the recipients every epoch must be wrapped to. A member
// without one cannot be wrapped to; they appear in ListMissingSlots once
// they create a key.
func keyedMembers(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.user_id FROM vault_members m JOIN user_keys k ON k.user_id = m.user_id
		WHERE m.vault_id = $1`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list keyed members: %w", err)
	}

	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, fmt.Errorf("list keyed members: %w", err)
	}

	members := make(map[string]bool, len(ids))
	for _, id := range ids {
		members[id.String()] = true
	}

	return members, nil
}

// storedInvitations returns the ids (canonical form) of the vault's stored
// invitations, expired ones included: they stay pending in the membership
// log until an owner revokes them, so a new epoch is wrapped to them too.
func storedInvitations(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM vault_invitations WHERE vault_id = $1`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	invitations := make(map[string]bool, len(ids))
	for _, id := range ids {
		invitations[id.String()] = true
	}

	return invitations, nil
}

// checkEpochRecipients returns ErrInvalidRecipients unless slots hold
// exactly one slot per member with a user key, one per stored invitation
// and, in an escrow vault, at most one escrow slot. It returns the slots to
// store: an invitation slot naming an invitation that is no longer stored
// (pending in the log, but expired and pruned) is accepted and dropped, as
// nobody can redeem it.
func checkEpochRecipients(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, state KeyState, slots []KeySlot) ([]KeySlot, error) {
	required, err := keyedMembers(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}

	invitations, err := storedInvitations(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool, len(slots))
	seenInvitations := make(map[string]bool, len(invitations))
	kept := make([]KeySlot, 0, len(slots))
	escrow := 0

	for _, slot := range slots {
		switch slot.RecipientKind {
		case RecipientInvitation:
			if seenInvitations[slot.RecipientID] {
				return nil, fmt.Errorf("%w: invitation %s has more than one slot", ErrInvalidRecipients, slot.RecipientID)
			}

			seenInvitations[slot.RecipientID] = true

			if !invitations[slot.RecipientID] {
				continue
			}
		case RecipientUser:
			if !required[slot.RecipientID] {
				return nil, fmt.Errorf("%w: user %s is not a member with a user key", ErrInvalidRecipients, slot.RecipientID)
			}

			if seen[slot.RecipientID] {
				return nil, fmt.Errorf("%w: user %s has more than one slot", ErrInvalidRecipients, slot.RecipientID)
			}

			seen[slot.RecipientID] = true
		case RecipientEscrow:
			escrow++
			if !state.Escrow || escrow > 1 {
				return nil, fmt.Errorf("%w: only an escrow vault takes one escrow slot", ErrInvalidRecipients)
			}
		default:
			return nil, fmt.Errorf("%w: unknown recipient kind", ErrInvalidRecipients)
		}

		kept = append(kept, slot)
	}

	for member := range required {
		if !seen[member] {
			return nil, fmt.Errorf("%w: no slot for member %s", ErrInvalidRecipients, member)
		}
	}

	for invitation := range invitations {
		if !seenInvitations[invitation] {
			return nil, fmt.Errorf("%w: no slot for pending invitation %s", ErrInvalidRecipients, invitation)
		}
	}

	return kept, nil
}

// insertKeySlots stores slots, keeping any slot already stored for the same
// epoch and recipient, and returns how many it added.
func insertKeySlots(ctx context.Context, tx pgx.Tx, vaultID, creatorID uuid.UUID, slots []KeySlot) (int, error) {
	epochs := make([]int32, len(slots))
	kinds := make([]string, len(slots))
	ids := make([]string, len(slots))
	keys := make([][]byte, len(slots))

	for index, slot := range slots {
		epochs[index] = slot.Epoch
		kinds[index] = string(slot.RecipientKind)
		ids[index] = slot.RecipientID
		keys[index] = slot.WrappedKey
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO key_slots (vault_id, epoch, recipient_kind, recipient_id, wrapped_key, created_by)
		SELECT $1, slot.epoch, slot.kind, slot.id, slot.key, $2
		FROM unnest($3::integer[], $4::text[], $5::text[], $6::bytea[]) AS slot (epoch, kind, id, key)
		ON CONFLICT DO NOTHING`, vaultID, creatorID, epochs, kinds, ids, keys)
	if err != nil {
		return 0, fmt.Errorf("insert key slots: %w", err)
	}

	return int(tag.RowsAffected()), nil
}

// AddKeySlots stores slots for existing epochs of the vault, created by
// creatorID, and returns how many it added. A slot already stored for the
// same epoch and recipient is kept, never replaced. It returns
// ErrNotEncrypted for a plaintext vault, ErrEpochNotFound for an epoch the
// vault does not have, and ErrInvalidRecipients for a user slot whose
// recipient is not a member with a user key, or an escrow slot in a vault
// without escrow. Nothing is stored unless every slot is valid.
func (vault *VaultStore) AddKeySlots(ctx context.Context, creatorID uuid.UUID, slots []KeySlot) (int, error) {
	var added int

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		// The vault row lock orders this against membership changes, so a
		// slot is never granted to a member a concurrent removal removed.
		state, err := lockKeyState(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		if state.Encryption != EncryptionE2EE {
			return ErrNotEncrypted
		}

		members, err := keyedMembers(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		for _, slot := range slots {
			if slot.Epoch < 1 || slot.Epoch > state.CurrentEpoch {
				return fmt.Errorf("%w: %d", ErrEpochNotFound, slot.Epoch)
			}

			switch slot.RecipientKind {
			case RecipientUser:
				if !members[slot.RecipientID] {
					return fmt.Errorf("%w: user %s is not a member with a user key", ErrInvalidRecipients, slot.RecipientID)
				}
			case RecipientEscrow:
				if !state.Escrow {
					return fmt.Errorf("%w: the vault has no escrow", ErrInvalidRecipients)
				}
			default:
				return fmt.Errorf("%w: unknown recipient kind", ErrInvalidRecipients)
			}
		}

		added, err = insertKeySlots(ctx, tx, vault.vaultID, creatorID, slots)

		return err
	})
	if err != nil {
		return 0, err
	}

	return added, nil
}

// ListEpochs returns up to limit of the vault's epochs after epoch after,
// in ascending order.
func (vault *VaultStore) ListEpochs(ctx context.Context, after int32, limit int) ([]Epoch, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT epoch, commitment, record, created_by, created_at FROM vault_key_epochs
		WHERE vault_id = $1 AND epoch > $2
		ORDER BY epoch LIMIT $3`, vault.vaultID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list epochs: %w", err)
	}

	epochs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Epoch, error) {
		var epoch Epoch

		err := row.Scan(&epoch.Epoch, &epoch.Commitment, &epoch.Record, &epoch.CreatedBy, &epoch.CreatedAt)

		return epoch, err
	})
	if err != nil {
		return nil, fmt.Errorf("list epochs: %w", err)
	}

	return epochs, nil
}

// ListKeySlots returns up to limit of the slots of one recipient in the
// vault for epochs after epoch after, in ascending epoch order.
func (vault *VaultStore) ListKeySlots(ctx context.Context, kind RecipientKind, recipientID string, after int32, limit int) ([]KeySlot, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT epoch, recipient_kind, recipient_id, wrapped_key, created_by, created_at FROM key_slots
		WHERE vault_id = $1 AND recipient_kind = $2 AND recipient_id = $3 AND epoch > $4
		ORDER BY epoch LIMIT $5`, vault.vaultID, kind, recipientID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list key slots: %w", err)
	}

	slots, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (KeySlot, error) {
		var slot KeySlot

		err := row.Scan(&slot.Epoch, &slot.RecipientKind, &slot.RecipientID, &slot.WrappedKey, &slot.CreatedBy, &slot.CreatedAt)

		return slot, err
	})
	if err != nil {
		return nil, fmt.Errorf("list key slots: %w", err)
	}

	return slots, nil
}

// ListEscrowSlots returns up to limit of the vault's escrow slots for
// epochs after epoch after, in ascending epoch order. An escrow vault has
// one escrow slot per epoch, whichever escrow key it is wrapped to.
func (vault *VaultStore) ListEscrowSlots(ctx context.Context, after int32, limit int) ([]KeySlot, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT epoch, recipient_kind, recipient_id, wrapped_key, created_by, created_at FROM key_slots
		WHERE vault_id = $1 AND recipient_kind = $2 AND epoch > $3
		ORDER BY epoch, recipient_id LIMIT $4`, vault.vaultID, RecipientEscrow, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list escrow slots: %w", err)
	}

	slots, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (KeySlot, error) {
		var slot KeySlot

		err := row.Scan(&slot.Epoch, &slot.RecipientKind, &slot.RecipientID, &slot.WrappedKey, &slot.CreatedBy, &slot.CreatedAt)

		return slot, err
	})
	if err != nil {
		return nil, fmt.Errorf("list escrow slots: %w", err)
	}

	return slots, nil
}

// ListMissingSlots returns up to limit of the slots the vault's members
// with a user key lack, one per (epoch, member), ordered by epoch and then
// user id, after (afterEpoch, afterUser).
func (vault *VaultStore) ListMissingSlots(ctx context.Context, afterEpoch int32, afterUser uuid.UUID, limit int) ([]MissingSlot, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT e.epoch, m.user_id, k.public_key
		FROM vault_key_epochs e
		JOIN vault_members m ON m.vault_id = e.vault_id
		JOIN user_keys k ON k.user_id = m.user_id
		WHERE e.vault_id = $1 AND (e.epoch, m.user_id) > ($2, $3)
			AND NOT EXISTS (
				SELECT 1 FROM key_slots s
				WHERE s.vault_id = e.vault_id AND s.epoch = e.epoch
					AND s.recipient_kind = $4 AND s.recipient_id = m.user_id::text)
		ORDER BY e.epoch, m.user_id LIMIT $5`, vault.vaultID, afterEpoch, afterUser, RecipientUser, limit)
	if err != nil {
		return nil, fmt.Errorf("list missing slots: %w", err)
	}

	missing, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (MissingSlot, error) {
		var slot MissingSlot

		err := row.Scan(&slot.Epoch, &slot.UserID, &slot.PublicKey)

		return slot, err
	})
	if err != nil {
		return nil, fmt.Errorf("list missing slots: %w", err)
	}

	return missing, nil
}
