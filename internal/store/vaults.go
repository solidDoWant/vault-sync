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

// ErrVaultNotFound is returned when a vault does not exist or the user is not
// one of its members. The two cases are deliberately indistinguishable.
var ErrVaultNotFound = errors.New("vault not found")

// ErrVaultDeleted is returned to a member of a vault that an owner deleted
// (DeleteVault). Non-members of a deleted vault get ErrVaultNotFound, as for
// any other vault.
var ErrVaultDeleted = errors.New("vault deleted")

// ErrVaultExists is returned when a vault is created with the id of an
// existing vault.
var ErrVaultExists = errors.New("vault id already exists")

// ErrVaultLimit is returned when a user already owns the maximum number of
// vaults.
var ErrVaultLimit = errors.New("vault limit reached")

// Role is a member's role in a vault (SPEC.md §9.2).
type Role string

// Vault roles, as stored in vault_members.role.
const (
	RoleOwner  Role = "owner"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

// Encryption is a vault's encryption mode, as stored in vaults.encryption.
type Encryption string

// Vault encryption modes.
const (
	EncryptionNone Encryption = "none"
	EncryptionE2EE Encryption = "e2ee"
)

// NewVault describes a vault to create.
type NewVault struct {
	// ID is the vault's id, chosen by the creator's device for an E2EE
	// vault (it signs it into Genesis); uuid.Nil has the store choose one.
	ID         uuid.UUID
	Name       string
	Encryption Encryption
	Escrow     bool
	// Genesis is the first entry of an E2EE vault's membership log, which
	// the caller has verified; nil for a plaintext vault.
	Genesis *LogEntry
}

// Vault is a vault as seen by one of its members.
type Vault struct {
	ID         uuid.UUID
	Name       string
	Encryption Encryption
	Escrow     bool
	HeadSeq    int64
	// Role is the member's role in the vault.
	Role      Role
	CreatedAt time.Time
	// DeletedAt is when an owner deleted the vault; set only by AllVaults,
	// nil for a vault that is not deleted.
	DeletedAt *time.Time
}

// CreateVault creates a vault with ownerID as its owner, in one transaction.
// It returns ErrVaultLimit when the user already owns limit vaults that are
// not deleted, and
// ErrUserNotFound when the user does not exist. With vault.ID set it returns
// ErrVaultExists when a vault with that id exists. With vault.Genesis set it
// stores it as the vault's first log entry, in the same transaction.
func (store *Store) CreateVault(ctx context.Context, ownerID uuid.UUID, vault NewVault, limit int) (Vault, error) {
	id := vault.ID
	if id == uuid.Nil {
		generated, err := uuid.NewV7()
		if err != nil {
			return Vault{}, fmt.Errorf("generate vault id: %w", err)
		}

		id = generated
	}

	created := Vault{ID: id, Name: vault.Name, Encryption: vault.Encryption, Escrow: vault.Escrow, Role: RoleOwner}

	err := pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		// Locking the user row serializes concurrent creations by the same
		// user, so the limit cannot be overshot (see RegisterDevice).
		var locked uuid.UUID

		err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, ownerID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}

		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}

		var owned int

		// A deleted vault does not count (docs/design/sharing.md), so an
		// owner can delete a vault to make room for a new one.
		err = tx.QueryRow(ctx, `
			SELECT count(*) FROM vault_members m JOIN vaults v ON v.id = m.vault_id
			WHERE m.user_id = $1 AND m.role = $2 AND v.deleted_at IS NULL`,
			ownerID, RoleOwner).Scan(&owned)
		if err != nil {
			return fmt.Errorf("count owned vaults: %w", err)
		}

		if owned >= limit {
			return ErrVaultLimit
		}

		err = tx.QueryRow(ctx, `
			INSERT INTO vaults (id, name, encryption, escrow, rotation_pending) VALUES ($1, $2, $3, $4, $5)
			RETURNING head_seq, created_at`, id, vault.Name, vault.Encryption, vault.Escrow,
			// An E2EE vault has no epoch yet: an owner client creates
			// epoch 1 with RotateEpoch (SPEC.md §9.3).
			vault.Encryption == EncryptionE2EE).
			Scan(&created.HeadSeq, &created.CreatedAt)
		if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok && pgErr.Code == uniqueViolation && pgErr.ConstraintName == "vaults_pkey" {
			return ErrVaultExists
		}

		if err != nil {
			return fmt.Errorf("insert vault: %w", err)
		}

		_, err = tx.Exec(ctx, `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, $3)`,
			id, ownerID, RoleOwner)
		if err != nil {
			return fmt.Errorf("insert owner membership: %w", err)
		}

		if vault.Genesis != nil {
			if err := insertLogEntry(ctx, tx, id, *vault.Genesis); err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return Vault{}, err
	}

	return created, nil
}

// ListVaults returns up to limit of the vaults userID is a member of that are
// not deleted, in
// ascending id order, starting after the vault id after (uuid.Nil for the
// first page).
func (store *Store) ListVaults(ctx context.Context, userID, after uuid.UUID, limit int) ([]Vault, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT v.id, v.name, v.encryption, v.escrow, v.head_seq, m.role, v.created_at
		FROM vault_members m JOIN vaults v ON v.id = m.vault_id
		WHERE m.user_id = $1 AND v.id > $2 AND v.deleted_at IS NULL
		ORDER BY v.id
		LIMIT $3`, userID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}

	vaults, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Vault, error) {
		var vault Vault

		err := row.Scan(&vault.ID, &vault.Name, &vault.Encryption, &vault.Escrow, &vault.HeadSeq, &vault.Role, &vault.CreatedAt)

		return vault, err
	})
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}

	return vaults, nil
}

// VaultRole returns userID's role in vaultID. It returns ErrVaultNotFound
// both when the vault does not exist and when the user is not a member: one
// query answers both, so the two cases take the same path. A member of a
// deleted vault gets ErrVaultDeleted.
func (store *Store) VaultRole(ctx context.Context, vaultID, userID uuid.UUID) (Role, error) {
	var (
		role    Role
		deleted bool
	)

	err := store.pool.QueryRow(ctx, `
		SELECT m.role, v.deleted_at IS NOT NULL FROM vault_members m JOIN vaults v ON v.id = m.vault_id
		WHERE m.vault_id = $1 AND m.user_id = $2`, vaultID, userID).Scan(&role, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrVaultNotFound
	}

	if err != nil {
		return "", fmt.Errorf("look up vault membership: %w", err)
	}

	if deleted {
		return "", ErrVaultDeleted
	}

	return role, nil
}

// DeleteVault marks vaultID deleted (docs/design/sharing.md). The caller
// has authorized an owner. It notifies the vault's realtime subscribers, so
// their subscriptions end. It returns ErrVaultDeleted when the vault is
// already deleted and ErrVaultNotFound when it does not exist.
func (store *Store) DeleteVault(ctx context.Context, vaultID uuid.UUID) error {
	return pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		headSeq, err := lockVault(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		tag, err := tx.Exec(ctx, `UPDATE vaults SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, vaultID)
		if err != nil {
			return fmt.Errorf("delete vault: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return ErrVaultDeleted
		}

		return notifyVaultChanged(ctx, tx, VaultChange{VaultID: vaultID, Seq: headSeq})
	})
}
