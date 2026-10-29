package store

import (
	"context"
	"fmt"
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
	rows, err := vault.store.pool.Query(ctx, `
		SELECT seq, prev_hash, entry_type, payload, signatures, created_at FROM vault_log_entries
		WHERE vault_id = $1 AND seq > $2
		ORDER BY seq LIMIT $3`, vault.vaultID, after, limit)
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
