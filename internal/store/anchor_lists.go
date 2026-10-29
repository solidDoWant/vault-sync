package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrAnchorListVersion is returned by PutAnchorList when the new version is
// not the stored version plus one. Nothing was changed.
var ErrAnchorListVersion = errors.New("anchor list version is not the stored version plus one")

// AnchorList is a user's sealed anchor list and its version. A user without
// a list has version 0 and no bytes.
type AnchorList struct {
	Version    uint64
	SealedList []byte
}

// AnchorList returns userID's sealed anchor list, or version 0 when the
// user has none.
func (store *Store) AnchorList(ctx context.Context, userID uuid.UUID) (AnchorList, error) {
	var (
		version int64
		sealed  []byte
	)

	err := store.pool.QueryRow(ctx, `SELECT version, sealed_list FROM anchor_lists WHERE user_id = $1`, userID).
		Scan(&version, &sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return AnchorList{}, nil
	}

	if err != nil {
		return AnchorList{}, fmt.Errorf("select anchor list: %w", err)
	}

	return AnchorList{Version: uint64(version), SealedList: sealed}, nil //nolint:gosec // the column is checked positive.
}

// PutAnchorList stores sealed as userID's anchor list at version when
// version is the stored version plus one (1 when the user has none), and
// returns ErrAnchorListVersion, changing nothing, otherwise. Each case is a
// single statement, so of concurrent writers of one version exactly one
// succeeds. version must be 1 to math.MaxInt64.
func (store *Store) PutAnchorList(ctx context.Context, userID uuid.UUID, version uint64, sealed []byte) error {
	if version == 0 || version > 1<<63-1 {
		return fmt.Errorf("anchor list version %d out of range", version)
	}

	var (
		tag pgconn.CommandTag
		err error
	)

	if version == 1 {
		tag, err = store.pool.Exec(ctx, `
			INSERT INTO anchor_lists (user_id, version, sealed_list) VALUES ($1, 1, $2)
			ON CONFLICT (user_id) DO NOTHING`, userID, sealed)
	} else {
		tag, err = store.pool.Exec(ctx, `
			UPDATE anchor_lists SET version = $2, sealed_list = $3, updated_at = now()
			WHERE user_id = $1 AND version = $2 - 1`, userID, int64(version), sealed) //nolint:gosec // bounded above.
	}

	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrUserNotFound
		}

		return fmt.Errorf("write anchor list: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return ErrAnchorListVersion
	}

	return nil
}
