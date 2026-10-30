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

// LogEntry is one entry of an E2EE vault's membership log
// (docs/design/crypto.md), stored as signed. Its vault is the vault it is
// stored in.
type LogEntry struct {
	Seq        int64
	PrevHash   []byte
	Type       byte
	Payload    []byte
	Signatures [][]byte
	CreatedAt  time.Time
}

func insertLogEntry(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, entry LogEntry) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO vault_log_entries (vault_id, seq, prev_hash, entry_type, payload, signatures)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		vaultID, entry.Seq, entry.PrevHash, int16(entry.Type), entry.Payload, entry.Signatures)
	if err != nil {
		return fmt.Errorf("insert log entry: %w", err)
	}

	return nil
}

// ListLogEntries returns up to limit of the vault's log entries after seq
// after, in ascending seq order.
func (vault *VaultStore) ListLogEntries(ctx context.Context, after int64, limit int) ([]LogEntry, error) {
	return listLogEntries(ctx, vault.store.pool, vault.vaultID, after, limit)
}

// VaultLogEntries returns up to limit of vaultID's log entries after seq
// after, in ascending seq order, whether the vault is live or deleted and
// not purged yet.
func (store *Store) VaultLogEntries(ctx context.Context, vaultID uuid.UUID, after int64, limit int) ([]LogEntry, error) {
	return listLogEntries(ctx, store.pool, vaultID, after, limit)
}

func listLogEntries(ctx context.Context, db querier, vaultID uuid.UUID, after int64, limit int) ([]LogEntry, error) {
	rows, err := db.Query(ctx, `
		SELECT seq, prev_hash, entry_type, payload, signatures, created_at FROM vault_log_entries
		WHERE vault_id = $1 AND seq > $2
		ORDER BY seq LIMIT $3`, vaultID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list log entries: %w", err)
	}

	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (LogEntry, error) {
		var (
			entry     LogEntry
			entryType int16
		)

		err := row.Scan(&entry.Seq, &entry.PrevHash, &entryType, &entry.Payload, &entry.Signatures, &entry.CreatedAt)
		entry.Type = byte(entryType)

		return entry, err
	})
	if err != nil {
		return nil, fmt.Errorf("list log entries: %w", err)
	}

	return entries, nil
}

// Membership log errors.
var (
	// ErrLogEntryRequired is returned when a membership change of an E2EE
	// vault carries no log entry.
	ErrLogEntryRequired = errors.New("a membership change of an E2EE vault needs its log entry")
	// ErrUnexpectedLogEntry is returned when a membership change of a
	// plaintext vault carries a log entry.
	ErrUnexpectedLogEntry = errors.New("a plaintext vault has no membership log")
	// ErrLogConflict is returned when a log entry's seq is not the next one
	// of the stored log: another change appended first, and the client
	// retries on top of it.
	ErrLogConflict = errors.New("log entry is not the next one of the vault's log")
)

// LogAppend is a membership log entry to append with a membership change.
type LogAppend struct {
	Entry LogEntry
	// Verify checks Entry against the vault's stored log, under the vault
	// row lock; an error refuses the change and is returned as is.
	// invitationID is the invitation being redeemed, uuid.Nil otherwise.
	Verify func(vaultID, invitationID uuid.UUID, log []LogEntry) error
}

// appendLog appends a membership change's log entry in tx, which holds the
// vault row lock: an E2EE vault requires one (ErrLogEntryRequired) and a
// plaintext vault takes none (ErrUnexpectedLogEntry). The entry's seq must
// follow the stored log's (ErrLogConflict), then Verify must accept it.
func appendLog(ctx context.Context, tx pgx.Tx, vaultID, invitationID uuid.UUID, entry *LogAppend) error {
	var encryption Encryption

	err := tx.QueryRow(ctx, `SELECT encryption FROM vaults WHERE id = $1`, vaultID).Scan(&encryption)
	if err != nil {
		return fmt.Errorf("read vault encryption: %w", err)
	}

	switch {
	case encryption != EncryptionE2EE && entry != nil:
		return ErrUnexpectedLogEntry
	case encryption != EncryptionE2EE:
		return nil
	case entry == nil:
		return ErrLogEntryRequired
	}

	log, err := readLog(ctx, tx, vaultID)
	if err != nil {
		return err
	}

	var head int64
	if len(log) > 0 {
		head = log[len(log)-1].Seq
	}

	if entry.Entry.Seq != head+1 {
		return ErrLogConflict
	}

	if err := entry.Verify(vaultID, invitationID, log); err != nil {
		return err
	}

	return insertLogEntry(ctx, tx, vaultID, entry.Entry)
}

// readLog returns the vault's whole log in ascending seq order.
func readLog(ctx context.Context, db querier, vaultID uuid.UUID) ([]LogEntry, error) {
	return listLogEntries(ctx, db, vaultID, 0, math.MaxInt32)
}
