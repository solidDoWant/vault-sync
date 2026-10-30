package store

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Converting a plaintext vault to end-to-end encryption in place
// (docs/design/encryption.md, "Converting a plaintext vault in place").

var (
	// ErrVaultEncrypted is returned for a plaintext commit (epoch 0) to an
	// end-to-end encrypted vault, and for converting a vault that already
	// is one.
	ErrVaultEncrypted = errors.New("the vault is end-to-end encrypted")
	// ErrConversionStale is returned when a conversion's path keys do not
	// name exactly the vault's live documents: they changed since the
	// owner's device listed them.
	ErrConversionStale = errors.New("the path keys do not name exactly the vault's live documents")
)

// ConversionBlockedError refuses a conversion the vault is not ready for:
// members who cannot be wrapped to, and pending invitations, which have no
// keys a slot could wrap to.
type ConversionBlockedError struct {
	// MembersWithoutKey are the members without a user key, or with one
	// that has no signing key, sorted.
	MembersWithoutKey []uuid.UUID
	// PendingInvitations are the vault's unexpired invitations, sorted.
	PendingInvitations []uuid.UUID
}

func (err *ConversionBlockedError) Error() string {
	return fmt.Sprintf("the vault cannot be converted: %d members without a user key, %d pending invitations",
		len(err.MembersWithoutKey), len(err.PendingInvitations))
}

// ConversionMember is a member of a vault being converted, with the keys
// the membership log must name for them.
type ConversionMember struct {
	UserID        uuid.UUID
	Role          Role
	PublicKey     []byte
	SignPublicKey []byte
}

// Conversion is a plaintext vault's switch to end-to-end encryption.
type Conversion struct {
	// Genesis and MembersEntry (nil when the creator is the only member)
	// start the vault's membership log.
	Genesis      LogEntry
	MembersEntry *LogEntry
	// CheckMembers, under the vault row lock, refuses a log that does not
	// name exactly members (with their roles and keys); its error is
	// returned as is.
	CheckMembers func(members []ConversionMember) error
	Escrow       bool
	// Epoch is epoch 1 (ExpectedEpoch 0), checked like a rotation's.
	Epoch NextEpoch
	// PathKeys maps every live document to its HMAC path key (raw bytes).
	PathKeys map[uuid.UUID]string
}

// ConvertVault converts the plaintext vault, created by creatorID, to
// end-to-end encryption in one transaction: it appends the log entries,
// switches the vault to EncryptionE2EE with conversion_seq set to its
// head_seq, creates epoch 1 (see RotateEpoch) and replaces the path_key of
// every live document. It returns epoch 1 and the conversion seq.
//
// It returns ErrVaultEncrypted for a vault that already is end-to-end
// encrypted, a *ConversionBlockedError when a member has no complete user
// key or an invitation is pending (expired invitations are deleted),
// CheckMembers' error, ErrConversionStale when PathKeys do not name exactly
// the live documents, ErrPathKeyTaken for two equal path keys, and the
// errors of RotateEpoch for epoch 1.
func (vault *VaultStore) ConvertVault(ctx context.Context, creatorID uuid.UUID, conversion Conversion) (Epoch, int64, error) {
	var (
		created       Epoch
		conversionSeq int64
	)

	err := pgx.BeginFunc(ctx, vault.store.pool, func(tx pgx.Tx) error {
		var encryption Encryption

		err := tx.QueryRow(ctx, `SELECT encryption, head_seq FROM vaults WHERE id = $1 FOR NO KEY UPDATE`, vault.vaultID).
			Scan(&encryption, &conversionSeq)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrVaultNotFound
		}

		if err != nil {
			return fmt.Errorf("lock vault: %w", err)
		}

		if encryption != EncryptionNone {
			return ErrVaultEncrypted
		}

		members, err := conversionReady(ctx, tx, vault.vaultID)
		if err != nil {
			return err
		}

		if err := conversion.CheckMembers(members); err != nil {
			return err
		}

		if err := checkLiveDocuments(ctx, tx, vault.vaultID, conversion.PathKeys); err != nil {
			return err
		}

		if err := insertLogEntry(ctx, tx, vault.vaultID, conversion.Genesis); err != nil {
			return err
		}

		if conversion.MembersEntry != nil {
			if err := insertLogEntry(ctx, tx, vault.vaultID, *conversion.MembersEntry); err != nil {
				return err
			}
		}

		_, err = tx.Exec(ctx, `
			UPDATE vaults SET encryption = $2, escrow = $3, conversion_seq = head_seq, rotation_pending = false
			WHERE id = $1`, vault.vaultID, EncryptionE2EE, conversion.Escrow)
		if err != nil {
			return fmt.Errorf("switch vault to encrypted: %w", err)
		}

		state := KeyState{Encryption: EncryptionE2EE, Escrow: conversion.Escrow}

		created, err = createEpoch(ctx, tx, vault.vaultID, state, creatorID, conversion.Epoch)
		if err != nil {
			return err
		}

		return replacePathKeys(ctx, tx, vault.vaultID, conversion.PathKeys)
	})
	if err != nil {
		return Epoch{}, 0, err
	}

	return created, conversionSeq, nil
}

// conversionReady deletes the vault's expired invitations and returns its
// members, or a *ConversionBlockedError naming the members without a
// complete user key and the pending invitations.
func conversionReady(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID) ([]ConversionMember, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM vault_invitations WHERE vault_id = $1 AND expires_at <= now()`, vaultID); err != nil {
		return nil, fmt.Errorf("prune expired invitations: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT m.user_id, m.role, k.public_key, k.sign_public_key
		FROM vault_members m LEFT JOIN user_keys k ON k.user_id = m.user_id
		WHERE m.vault_id = $1 ORDER BY m.user_id`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}

	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ConversionMember, error) {
		var member ConversionMember

		return member, row.Scan(&member.UserID, &member.Role, &member.PublicKey, &member.SignPublicKey)
	})
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}

	blocked := &ConversionBlockedError{}

	for _, member := range members {
		if member.PublicKey == nil || member.SignPublicKey == nil {
			blocked.MembersWithoutKey = append(blocked.MembersWithoutKey, member.UserID)
		}
	}

	rows, err = tx.Query(ctx, `SELECT id FROM vault_invitations WHERE vault_id = $1 ORDER BY id`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	blocked.PendingInvitations, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}

	if len(blocked.MembersWithoutKey) > 0 || len(blocked.PendingInvitations) > 0 {
		return nil, blocked
	}

	return members, nil
}

// checkLiveDocuments returns ErrConversionStale unless pathKeys names
// exactly the vault's live documents.
func checkLiveDocuments(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, pathKeys map[uuid.UUID]string) error {
	rows, err := tx.Query(ctx, `SELECT id FROM documents WHERE vault_id = $1 AND NOT deleted`, vaultID)
	if err != nil {
		return fmt.Errorf("list live documents: %w", err)
	}

	live, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return fmt.Errorf("list live documents: %w", err)
	}

	if len(live) != len(pathKeys) {
		return ErrConversionStale
	}

	for _, id := range live {
		if _, ok := pathKeys[id]; !ok {
			return ErrConversionStale
		}
	}

	return nil
}

// replacePathKeys sets the path_key of each live document to its encrypted
// path key. The live keys first move to temporary keys unique per document
// (a "/" never occurs in an encrypted key), so that a new key equal to
// another document's old plaintext key cannot trip the unique live
// path_key index midway.
func replacePathKeys(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, pathKeys map[uuid.UUID]string) error {
	if len(pathKeys) == 0 {
		return nil
	}

	_, err := tx.Exec(ctx, `UPDATE documents SET path_key = 'converting/' || id::text WHERE vault_id = $1 AND NOT deleted`, vaultID)
	if err != nil {
		return fmt.Errorf("clear path keys: %w", err)
	}

	ids := make([]uuid.UUID, 0, len(pathKeys))
	for id := range pathKeys {
		ids = append(ids, id)
	}

	slices.SortFunc(ids, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })

	keys := make([]string, len(ids))
	for index, id := range ids {
		keys[index] = storedText(1, pathKeys[id])
	}

	_, err = tx.Exec(ctx, `
		UPDATE documents d SET path_key = k.path_key
		FROM unnest($2::uuid[], $3::text[]) AS k (id, path_key)
		WHERE d.vault_id = $1 AND d.id = k.id`, vaultID, ids, keys)
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok && pgErr.Code == uniqueViolation && pgErr.ConstraintName == livePathKeyIndex {
		return ErrPathKeyTaken
	}

	if err != nil {
		return fmt.Errorf("set path keys: %w", err)
	}

	return nil
}
