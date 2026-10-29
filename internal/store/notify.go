package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// VaultChangedChannel is the PostgreSQL notification channel on which every
// committed revision is announced (SPEC.md §6.4, §12). Its payload is
// "<vault id>:<seq>".
const VaultChangedChannel = "vault_changed"

// VaultChange announces that a vault's head_seq advanced to Seq.
type VaultChange struct {
	VaultID uuid.UUID
	Seq     int64
}

func (change VaultChange) payload() string {
	return change.VaultID.String() + ":" + strconv.FormatInt(change.Seq, 10)
}

func parseVaultChange(payload string) (VaultChange, bool) {
	rawID, rawSeq, found := strings.Cut(payload, ":")
	if !found {
		return VaultChange{}, false
	}

	id, err := uuid.Parse(rawID)
	if err != nil {
		return VaultChange{}, false
	}

	seq, err := strconv.ParseInt(rawSeq, 10, 64)
	if err != nil || seq < 0 {
		return VaultChange{}, false
	}

	return VaultChange{VaultID: id, Seq: seq}, true
}

// notifyVaultChanged queues a VaultChangedChannel notification in tx.
// PostgreSQL delivers it to every listener when, and only if, tx commits.
func notifyVaultChanged(ctx context.Context, tx pgx.Tx, change VaultChange) error {
	_, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`, VaultChangedChannel, change.payload())
	if err != nil {
		return fmt.Errorf("notify vault change: %w", err)
	}

	return nil
}

// DefaultListenHealthInterval is how long ListenVaultChanges waits for a
// notification before it checks that its connection is still alive.
const DefaultListenHealthInterval = 30 * time.Second

// listenPingTimeout bounds the liveness check of an idle listening connection.
const listenPingTimeout = 10 * time.Second

// ListenOptions configures ListenVaultChanges.
type ListenOptions struct {
	// HealthInterval is how long the listener waits for a notification
	// before pinging its connection, so a silently dead connection is
	// noticed. Defaults to DefaultListenHealthInterval.
	HealthInterval time.Duration
	// Ready is called once the listener is subscribed: every commit from
	// then on is delivered to Handle. It may query the database.
	Ready func(ctx context.Context)
	// Handle receives every vault change, in the order the commits were
	// made. It must not block for long.
	Handle func(VaultChange)
}

// ListenVaultChanges listens on VaultChangedChannel on a dedicated connection
// and passes every vault change to options.Handle, until ctx ends (it then
// returns nil) or the connection fails (it returns the error; the caller
// reconnects). Notifications sent while no listener was connected are lost,
// so after reconnecting a caller compares head_seqs (HeadSeqs).
func (store *Store) ListenVaultChanges(ctx context.Context, options ListenOptions) error {
	if options.HealthInterval <= 0 {
		options.HealthInterval = DefaultListenHealthInterval
	}

	pooled, err := store.pool.Acquire(ctx)
	if err != nil {
		return ignoreCanceled(ctx, fmt.Errorf("acquire listening connection: %w", err))
	}

	// The connection now belongs to the listener; the pool replaces it.
	conn := pooled.Hijack()

	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), listenPingTimeout)
		defer cancel()

		_ = conn.Close(closeCtx)
	}()

	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{VaultChangedChannel}.Sanitize()); err != nil {
		return ignoreCanceled(ctx, fmt.Errorf("listen for vault changes: %w", err))
	}

	if options.Ready != nil {
		options.Ready(ctx)
	}

	for {
		waitCtx, cancel := context.WithTimeout(ctx, options.HealthInterval)
		notification, err := conn.WaitForNotification(waitCtx)

		cancel()

		switch {
		case ctx.Err() != nil:
			return nil
		case err != nil && pgconn.Timeout(err):
			// Idle: check the connection is still alive.
			pingCtx, cancelPing := context.WithTimeout(ctx, listenPingTimeout)
			err = conn.Ping(pingCtx)

			cancelPing()

			if err != nil {
				return ignoreCanceled(ctx, fmt.Errorf("check listening connection: %w", err))
			}
		case err != nil:
			return fmt.Errorf("wait for vault changes: %w", err)
		default:
			if change, ok := parseVaultChange(notification.Payload); ok && notification.Channel == VaultChangedChannel {
				options.Handle(change)
			}
		}
	}
}

func ignoreCanceled(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return nil
	}

	return err
}

// MemberHeadSeq returns userID's role in vaultID and the vault's head_seq in
// one query. Like VaultRole, it returns ErrVaultNotFound both when the vault
// does not exist and when the user is not a member, through the same path,
// and ErrVaultDeleted to a member of a deleted vault.
func (store *Store) MemberHeadSeq(ctx context.Context, vaultID, userID uuid.UUID) (Role, int64, error) {
	var (
		role    Role
		headSeq int64
		deleted bool
	)

	err := store.pool.QueryRow(ctx, `
		SELECT m.role, v.head_seq, v.deleted_at IS NOT NULL FROM vault_members m JOIN vaults v ON v.id = m.vault_id
		WHERE m.vault_id = $1 AND m.user_id = $2`, vaultID, userID).Scan(&role, &headSeq, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, ErrVaultNotFound
	}

	if err != nil {
		return "", 0, fmt.Errorf("look up vault membership: %w", err)
	}

	if deleted {
		return "", 0, ErrVaultDeleted
	}

	return role, headSeq, nil
}

// VaultMembers returns which of userIDs are members of vaultID, in one
// query. A vault that does not exist has no members. For a deleted vault it
// returns the members together with ErrVaultDeleted, so the caller can tell
// its members that it was deleted. Callers bound the length of userIDs.
func (store *Store) VaultMembers(ctx context.Context, vaultID uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT m.user_id, v.deleted_at IS NOT NULL FROM vault_members m JOIN vaults v ON v.id = m.vault_id
		WHERE m.vault_id = $1 AND m.user_id = ANY($2)`, vaultID, userIDs)
	if err != nil {
		return nil, fmt.Errorf("look up vault members: %w", err)
	}

	members := make(map[uuid.UUID]bool, len(userIDs))

	var (
		userID  uuid.UUID
		deleted bool
	)

	_, err = pgx.ForEachRow(rows, []any{&userID, &deleted}, func() error {
		members[userID] = true

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("look up vault members: %w", err)
	}

	if deleted {
		return members, ErrVaultDeleted
	}

	return members, nil
}

// HeadSeqs returns the head_seq of each existing vault in vaultIDs.
func (store *Store) HeadSeqs(ctx context.Context, vaultIDs []uuid.UUID) (map[uuid.UUID]int64, error) {
	rows, err := store.pool.Query(ctx, `SELECT id, head_seq FROM vaults WHERE id = ANY($1)`, vaultIDs)
	if err != nil {
		return nil, fmt.Errorf("look up head_seqs: %w", err)
	}

	heads := make(map[uuid.UUID]int64, len(vaultIDs))

	var (
		id      uuid.UUID
		headSeq int64
	)

	_, err = pgx.ForEachRow(rows, []any{&id, &headSeq}, func() error {
		heads[id] = headSeq

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("look up head_seqs: %w", err)
	}

	return heads, nil
}
