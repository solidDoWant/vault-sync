package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Membership errors (SPEC.md §9.2).
var (
	// ErrInvitationNotFound is returned for an invite code or invitation id
	// that names no pending invitation: unknown, expired, revoked or used.
	// The cases are deliberately indistinguishable.
	ErrInvitationNotFound = errors.New("invitation not found")
	// ErrInvitationLimit is returned when a vault already has the maximum
	// number of pending invitations.
	ErrInvitationLimit = errors.New("invitation limit reached")
	// ErrMemberLimit is returned when a vault already has the maximum
	// number of members.
	ErrMemberLimit = errors.New("member limit reached")
	// ErrAlreadyMember is returned when a user redeems an invitation to a
	// vault they are already a member of.
	ErrAlreadyMember = errors.New("already a member")
	// ErrMemberNotFound is returned when a user is not a member of the
	// vault.
	ErrMemberNotFound = errors.New("member not found")
	// ErrLastOwner is returned when a change would leave a vault without an
	// owner.
	ErrLastOwner = errors.New("a vault must keep at least one owner")
)

// Invitation is a pending invitation to a vault. Its code is never stored,
// only the code's hash.
type Invitation struct {
	ID        uuid.UUID
	VaultID   uuid.UUID
	Role      Role
	CreatedBy uuid.UUID
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Member is one member of a vault.
type Member struct {
	UserID      uuid.UUID
	DisplayName string
	Role        Role
	JoinedAt    time.Time
	// PublicKey is the member's user public key (SPEC.md §9.3), or nil
	// when they have none.
	PublicKey []byte
}

// lockVault locks the vault row against every other membership change and
// commit of the vault until tx ends (commits take the same lock), so the
// last-owner check and the member limit cannot be raced. It returns
// ErrVaultNotFound when the vault does not exist, and the vault's head_seq.
func lockVault(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) (int64, error) {
	var headSeq int64

	err := tx.QueryRow(ctx, `SELECT head_seq FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vaultID).Scan(&headSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrVaultNotFound
	}

	if err != nil {
		return 0, fmt.Errorf("lock vault: %w", err)
	}

	return headSeq, nil
}

// CreateInvitation stores a pending invitation to the vault with the given
// role, created by creatorID and redeemable for ttl, whose code hashes to
// codeHash. It first deletes the vault's expired invitations, then returns
// ErrInvitationLimit when the vault already has limit pending ones. The
// invitation's id is id, or a new one for uuid.Nil. entry is its membership
// log entry, appended in the same transaction (see appendLog).
func (vault *VaultStore) CreateInvitation(ctx context.Context, creatorID, id uuid.UUID, role Role, codeHash []byte, ttl time.Duration, limit int, entry *LogAppend) (Invitation, error) {
	if id == uuid.Nil {
		generated, err := uuid.NewV7()
		if err != nil {
			return Invitation{}, fmt.Errorf("generate invitation id: %w", err)
		}

		id = generated
	}

	invitation := Invitation{ID: id, VaultID: vault.vaultID, Role: role, CreatedBy: creatorID}

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		if _, err := lockVault(ctx, tx, vault.vaultID); err != nil {
			return err
		}

		if err := appendLog(ctx, tx, vault.vaultID, uuid.Nil, entry); err != nil {
			return err
		}

		_, err := tx.Exec(ctx, `DELETE FROM vault_invitations WHERE vault_id = $1 AND expires_at <= now()`, vault.vaultID)
		if err != nil {
			return fmt.Errorf("prune expired invitations: %w", err)
		}

		var pending int

		err = tx.QueryRow(ctx, `SELECT count(*) FROM vault_invitations WHERE vault_id = $1`, vault.vaultID).Scan(&pending)
		if err != nil {
			return fmt.Errorf("count invitations: %w", err)
		}

		if pending >= limit {
			return ErrInvitationLimit
		}

		err = tx.QueryRow(ctx, `
			INSERT INTO vault_invitations (id, vault_id, code_hash, role, created_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
			RETURNING created_at, expires_at`,
			id, vault.vaultID, codeHash, role, creatorID, ttl.Seconds()).Scan(&invitation.CreatedAt, &invitation.ExpiresAt)
		if err != nil {
			return fmt.Errorf("insert invitation: %w", err)
		}

		return nil
	})
	if err != nil {
		return Invitation{}, err
	}

	return invitation, nil
}

// ListInvitations returns the vault's pending invitations, oldest first.
func (vault *VaultStore) ListInvitations(ctx context.Context) ([]Invitation, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT id, vault_id, role, created_by, created_at, expires_at
		FROM vault_invitations
		WHERE vault_id = $1 AND expires_at > now()
		ORDER BY created_at, id`, vault.vaultID)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	invitations, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Invitation, error) {
		var invitation Invitation

		err := row.Scan(&invitation.ID, &invitation.VaultID, &invitation.Role, &invitation.CreatedBy, &invitation.CreatedAt, &invitation.ExpiresAt)

		return invitation, err
	})
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	return invitations, nil
}

// RevokeInvitation deletes a pending invitation of the vault. It returns
// ErrInvitationNotFound when the vault has no such pending invitation.
//
// In an E2EE vault entry is the revoke entry, appended in the same
// transaction (see appendLog), and its verification decides whether the
// invitation is pending: owner devices revoke in the log the invitations
// they see have expired, whose rows may already be gone.
func (vault *VaultStore) RevokeInvitation(ctx context.Context, invitationID uuid.UUID, entry *LogAppend) error {
	return pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		if _, err := lockVault(ctx, tx, vault.vaultID); err != nil {
			return err
		}

		if err := appendLog(ctx, tx, vault.vaultID, uuid.Nil, entry); err != nil {
			return err
		}

		// appendLog accepted an entry only for an E2EE vault.
		logged := entry != nil

		tag, err := tx.Exec(ctx, `DELETE FROM vault_invitations WHERE vault_id = $1 AND id = $2 AND ($3 OR expires_at > now())`,
			vault.vaultID, invitationID, logged)
		if err != nil {
			return fmt.Errorf("revoke invitation: %w", err)
		}

		if tag.RowsAffected() == 0 && !logged {
			return ErrInvitationNotFound
		}

		return nil
	})
}

// RedeemInvitation makes userID a member of the vault of the pending
// invitation whose code hashes to codeHash, with its role, and deletes the
// invitation, in one transaction. It returns ErrInvitationNotFound for a
// code that names no pending invitation or an invitation to a deleted
// vault, ErrAlreadyMember when the user is already a member (the invitation
// is kept), and ErrMemberLimit when the vault already has memberLimit
// members (the invitation is kept). entry is the redeem entry, appended in
// the same transaction (see appendLog).
func (store *Store) RedeemInvitation(ctx context.Context, userID uuid.UUID, codeHash []byte, memberLimit int, entry *LogAppend) (Vault, error) {
	var joined Vault

	err := pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		var invitationID uuid.UUID

		// Lock the vault before the invitation, the order CreateInvitation
		// (which prunes the vault's expired invitations under the vault
		// lock) and every other vault-wide change use, so the two cannot
		// deadlock. The first lookup only finds the vault to lock.
		err := tx.QueryRow(ctx, `SELECT vault_id FROM vault_invitations WHERE code_hash = $1 AND expires_at > now()`,
			codeHash).Scan(&joined.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvitationNotFound
		}

		if err != nil {
			return fmt.Errorf("look up invitation: %w", err)
		}

		if _, err := lockVault(ctx, tx, joined.ID); err != nil {
			if errors.Is(err, ErrVaultNotFound) {
				return ErrInvitationNotFound
			}

			return err
		}

		// A deleted vault is invisible to everyone, so its invitations
		// name nothing.
		var deleted bool

		err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM vaults WHERE id = $1`, joined.ID).Scan(&deleted)
		if err != nil {
			return fmt.Errorf("read vault: %w", err)
		}

		if deleted {
			return ErrInvitationNotFound
		}

		// Re-read the invitation under the vault lock: it may have been
		// redeemed, revoked or pruned meanwhile. The row lock keeps a
		// concurrent revocation out until this transaction ends.
		err = tx.QueryRow(ctx, `
			SELECT id, role FROM vault_invitations
			WHERE code_hash = $1 AND vault_id = $2 AND expires_at > now()
			FOR UPDATE`, codeHash, joined.ID).Scan(&invitationID, &joined.Role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvitationNotFound
		}

		if err != nil {
			return fmt.Errorf("lock invitation: %w", err)
		}

		var members int

		var already bool

		err = tx.QueryRow(ctx, `SELECT count(*), coalesce(bool_or(user_id = $2), false) FROM vault_members WHERE vault_id = $1`,
			joined.ID, userID).Scan(&members, &already)
		if err != nil {
			return fmt.Errorf("count members: %w", err)
		}

		if already {
			return ErrAlreadyMember
		}

		if members >= memberLimit {
			return ErrMemberLimit
		}

		if err := appendLog(ctx, tx, joined.ID, invitationID, entry); err != nil {
			return err
		}

		_, err = tx.Exec(ctx, `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, $3)`, joined.ID, userID, joined.Role)
		if err != nil {
			return fmt.Errorf("insert membership: %w", err)
		}

		_, err = tx.Exec(ctx, `DELETE FROM vault_invitations WHERE id = $1`, invitationID)
		if err != nil {
			return fmt.Errorf("delete invitation: %w", err)
		}

		err = tx.QueryRow(ctx, `SELECT name, encryption, escrow, head_seq, created_at FROM vaults WHERE id = $1`, joined.ID).
			Scan(&joined.Name, &joined.Encryption, &joined.Escrow, &joined.HeadSeq, &joined.CreatedAt)
		if err != nil {
			return fmt.Errorf("read vault: %w", err)
		}

		return nil
	})
	if err != nil {
		return Vault{}, err
	}

	return joined, nil
}

// ListMembers returns the vault's members, oldest membership first.
func (vault *VaultStore) ListMembers(ctx context.Context) ([]Member, error) {
	rows, err := vault.store.pool.Query(ctx, `
		SELECT m.user_id, u.display_name, m.role, m.created_at, k.public_key
		FROM vault_members m JOIN users u ON u.id = m.user_id
		LEFT JOIN user_keys k ON k.user_id = m.user_id
		WHERE m.vault_id = $1
		ORDER BY m.created_at, m.user_id`, vault.vaultID)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}

	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) {
		var member Member

		err := row.Scan(&member.UserID, &member.DisplayName, &member.Role, &member.JoinedAt, &member.PublicKey)

		return member, err
	})
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}

	return members, nil
}

// deleteInvitationsBy deletes the vault's invitations created by userID, in
// tx. It runs whenever userID stops being an owner (removed, left or
// demoted): only owners can invite, so a former owner's pending codes would
// otherwise let them back in with the invitation's role.
func deleteInvitationsBy(ctx context.Context, tx pgx.Tx, vaultID, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `DELETE FROM vault_invitations WHERE vault_id = $1 AND created_by = $2`, vaultID, userID)
	if err != nil {
		return fmt.Errorf("delete member's invitations: %w", err)
	}

	return nil
}

// lockMember returns userID's role in the vault, under lockVault. It returns
// ErrMemberNotFound when the user is not a member, and the other owners'
// count in otherOwners.
func lockMember(ctx context.Context, tx pgx.Tx, vaultID, userID uuid.UUID) (role Role, otherOwners int, headSeq int64, err error) {
	headSeq, err = lockVault(ctx, tx, vaultID)
	if err != nil {
		return "", 0, 0, err
	}

	var current *Role

	err = tx.QueryRow(ctx, `
		SELECT (SELECT role FROM vault_members WHERE vault_id = $1 AND user_id = $2),
		       (SELECT count(*) FROM vault_members WHERE vault_id = $1 AND user_id <> $2 AND role = $3)`,
		vaultID, userID, RoleOwner).Scan(&current, &otherOwners)
	if err != nil {
		return "", 0, 0, fmt.Errorf("look up member: %w", err)
	}

	if current == nil {
		return "", 0, 0, ErrMemberNotFound
	}

	return *current, otherOwners, headSeq, nil
}

// UpdateMemberRole sets userID's role in the vault; demoting an owner also
// deletes the invitations they created. It returns
// ErrMemberNotFound when the user is not a member and ErrLastOwner when it
// would demote the vault's last owner. entry is the set-role entry, appended
// in the same transaction (see appendLog).
func (vault *VaultStore) UpdateMemberRole(ctx context.Context, userID uuid.UUID, role Role, entry *LogAppend) (Member, error) {
	member := Member{UserID: userID, Role: role}

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		current, otherOwners, _, err := lockMember(ctx, tx, vault.vaultID, userID)
		if err != nil {
			return err
		}

		if current == RoleOwner && role != RoleOwner && otherOwners == 0 {
			return ErrLastOwner
		}

		if err := appendLog(ctx, tx, vault.vaultID, uuid.Nil, entry); err != nil {
			return err
		}

		err = tx.QueryRow(ctx, `
			UPDATE vault_members m SET role = $3 FROM users u
			WHERE m.vault_id = $1 AND m.user_id = $2 AND u.id = m.user_id
			RETURNING u.display_name, m.created_at`, vault.vaultID, userID, role).Scan(&member.DisplayName, &member.JoinedAt)
		if err != nil {
			return fmt.Errorf("update role: %w", err)
		}

		if role != RoleOwner {
			return deleteInvitationsBy(ctx, tx, vault.vaultID, userID)
		}

		return nil
	})
	if err != nil {
		return Member{}, err
	}

	return member, nil
}

// RemoveMember removes userID from the vault on behalf of removedBy (an
// owner). In an E2EE vault, next is the epoch that replaces the current one,
// wrapped for every remaining member with a user key: the removal and the
// new epoch commit together (see RotateEpoch for its errors), so no revision
// is accepted under an epoch the removed member holds once the removal is
// visible. A plaintext vault takes no next epoch (ErrUnexpectedNextEpoch); an E2EE
// vault requires one (ErrNextEpochRequired). An E2EE vault refuses
// removedBy removing themselves (ErrSelfRemoval): they would know the next
// epoch, so they leave with LeaveVault instead.
//
// It returns ErrMemberNotFound when the user is not a member and
// ErrLastOwner when they are the vault's last owner. The removal is
// announced on VaultChangedChannel at the vault's current head_seq, so every
// replica re-checks the vault's realtime subscribers at once and ends the
// removed member's subscriptions (SPEC.md §6.4). entry is the remove-member
// entry, appended in the same transaction (see appendLog).
func (vault *VaultStore) RemoveMember(ctx context.Context, removedBy, userID uuid.UUID, next *NextEpoch, entry *LogAppend) error {
	return vault.removeMember(ctx, userID, entry, func(ctx context.Context, tx pgx.Tx, state KeyState) error {
		switch {
		case state.Encryption == EncryptionE2EE && removedBy == userID:
			return ErrSelfRemoval
		case state.Encryption != EncryptionE2EE && next != nil:
			return ErrUnexpectedNextEpoch
		case state.Encryption != EncryptionE2EE:
			return nil
		case next == nil:
			return ErrNextEpochRequired
		}

		_, err := createEpoch(ctx, tx, vault.vaultID, state, removedBy, *next)

		return err
	})
}

// LeaveVault removes userID from the vault at their own request, like
// RemoveMember. No owner client takes part, so in an E2EE vault it marks a
// rotation pending instead of creating the next epoch: revisions are still
// accepted under the current epoch until an owner rotates (SPEC.md §9.3).
// entry is the leave entry, appended in the same transaction (see appendLog).
func (vault *VaultStore) LeaveVault(ctx context.Context, userID uuid.UUID, entry *LogAppend) error {
	return vault.removeMember(ctx, userID, entry, func(ctx context.Context, tx pgx.Tx, state KeyState) error {
		if state.Encryption != EncryptionE2EE {
			return nil
		}

		_, err := tx.Exec(ctx, `UPDATE vaults SET rotation_pending = true WHERE id = $1`, vault.vaultID)
		if err != nil {
			return fmt.Errorf("mark rotation pending: %w", err)
		}

		return nil
	})
}

// removeMember removes userID and the invitations they created, runs rekey
// and then appends entry, in one transaction under the vault row lock.
func (vault *VaultStore) removeMember(ctx context.Context, userID uuid.UUID, entry *LogAppend, rekey func(context.Context, pgx.Tx, KeyState) error) error {
	return pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		current, otherOwners, headSeq, err := lockMember(ctx, tx, vault.vaultID, userID)
		if err != nil {
			return err
		}

		if current == RoleOwner && otherOwners == 0 {
			return ErrLastOwner
		}

		_, err = tx.Exec(ctx, `DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2`, vault.vaultID, userID)
		if err != nil {
			return fmt.Errorf("remove member: %w", err)
		}

		if err := deleteInvitationsBy(ctx, tx, vault.vaultID, userID); err != nil {
			return err
		}

		// The vault row is already locked; this reads its key state.
		state, err := keyState(ctx, tx, vault.vaultID, "")
		if err != nil {
			return err
		}

		if err := rekey(ctx, tx, state); err != nil {
			return err
		}

		if err := appendLog(ctx, tx, vault.vaultID, uuid.Nil, entry); err != nil {
			return err
		}

		return notifyVaultChanged(ctx, tx, VaultChange{VaultID: vault.vaultID, Seq: headSeq})
	})
}
