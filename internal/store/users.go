package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrDeviceLimit is returned when a user already has the maximum number of
// devices that have not been removed.
var ErrDeviceLimit = errors.New("device limit reached")

// ErrUserNotFound is returned when an operation names a user that does not
// exist.
var ErrUserNotFound = errors.New("user not found")

// Store runs the server's queries against PostgreSQL.
type Store struct {
	pool *pgxpool.Pool
}

// New returns a Store using pool.
func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// UpsertUser returns the id of the user with the OIDC identity (issuer,
// subject), creating the user on first sight (SPEC.md §5). Concurrent calls
// for the same new identity create exactly one user and all return its id.
func (store *Store) UpsertUser(ctx context.Context, issuer, subject string) (uuid.UUID, error) {
	const selectUser = `SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`

	var id uuid.UUID

	err := store.pool.QueryRow(ctx, selectUser, issuer, subject).Scan(&id)
	if err == nil {
		return id, nil
	}

	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("look up user: %w", err)
	}

	newID, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, fmt.Errorf("generate user id: %w", err)
	}

	// DO NOTHING returns no row when a concurrent request inserted the user
	// first. That insert has committed by then, so a fresh statement sees it.
	err = store.pool.QueryRow(ctx, `
		INSERT INTO users (id, oidc_issuer, oidc_subject) VALUES ($1, $2, $3)
		ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING
		RETURNING id`, newID, issuer, subject).Scan(&id)
	if err == nil {
		return id, nil
	}

	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("create user: %w", err)
	}

	if err := store.pool.QueryRow(ctx, selectUser, issuer, subject).Scan(&id); err != nil {
		return uuid.Nil, fmt.Errorf("look up concurrently created user: %w", err)
	}

	return id, nil
}

// Device is a registered plugin installation.
type Device struct {
	ID     uuid.UUID
	UserID uuid.UUID
	Name   string
	// PublicKey is the X25519 public key, or nil.
	PublicKey []byte
	CreatedAt time.Time
	// LastSeen is when the device last committed a revision, to within
	// deviceLastSeenGranularity, or nil if it never has.
	LastSeen *time.Time
}

// deviceLastSeenGranularity is how stale devices.last_seen may get before a
// commit refreshes it, so that a burst of commits rewrites the row once.
const deviceLastSeenGranularity = "1 minute"

// RegisterDevice registers a device for userID. publicKey is nil or a 32
// byte X25519 public key. It returns ErrDeviceLimit when the user already
// has limit devices that have not been removed, and ErrUserNotFound when the
// user does not exist.
func (store *Store) RegisterDevice(ctx context.Context, userID uuid.UUID, name string, publicKey []byte, limit int) (Device, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Device{}, fmt.Errorf("generate device id: %w", err)
	}

	if len(publicKey) == 0 {
		publicKey = nil
	}

	device := Device{ID: id, UserID: userID, Name: name, PublicKey: publicKey}

	err = pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		// Locking the user row serializes concurrent registrations, so the
		// limit cannot be overshot. The count must be a separate statement:
		// under READ COMMITTED it then takes a snapshot after the lock was
		// granted and sees the devices of registrations that held it before.
		// The lock must stay the transaction's first statement: holding no
		// other lock while waiting for it, the transaction cannot be part of
		// a deadlock cycle, even with transactions whose FK checks hold the
		// user row FOR KEY SHARE (which FOR UPDATE conflicts with).
		var locked uuid.UUID

		err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&locked)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}

		if err != nil {
			return fmt.Errorf("lock user: %w", err)
		}

		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM devices WHERE user_id = $1 AND removed_at IS NULL`, userID).Scan(&count); err != nil {
			return fmt.Errorf("count devices: %w", err)
		}

		if count >= limit {
			return ErrDeviceLimit
		}

		err = tx.QueryRow(ctx, `
			INSERT INTO devices (id, user_id, name, public_key) VALUES ($1, $2, $3, $4)
			RETURNING created_at`, id, userID, name, publicKey).Scan(&device.CreatedAt)
		if err != nil {
			return fmt.Errorf("insert device: %w", err)
		}

		return nil
	})
	if err != nil {
		return Device{}, err
	}

	return device, nil
}

// ListDevices returns userID's devices that have not been removed, oldest
// first. There are at most as many as the device limit RegisterDevice
// enforces.
func (store *Store) ListDevices(ctx context.Context, userID uuid.UUID) ([]Device, error) {
	rows, err := store.pool.Query(ctx, `
		SELECT id, user_id, name, public_key, created_at, last_seen FROM devices
		WHERE user_id = $1 AND removed_at IS NULL ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}

	devices, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Device, error) {
		var device Device

		err := row.Scan(&device.ID, &device.UserID, &device.Name, &device.PublicKey, &device.CreatedAt, &device.LastSeen)

		return device, err
	})
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}

	return devices, nil
}

// RemoveDevice marks userID's device deviceID removed. The row is kept, since
// its revisions reference it. A removed device no longer counts toward the
// device limit, is not listed, and can no longer commit. It returns
// ErrDeviceNotFound when userID has no such device that is not removed yet,
// including when the device belongs to another user.
//
// The update waits for the row lock every commit by the device holds until
// it ends (CommitRevision), so once RemoveDevice returns, no commit by the
// device is in flight and every later one, through any server process, sees
// the removal.
func (store *Store) RemoveDevice(ctx context.Context, userID, deviceID uuid.UUID) error {
	tag, err := store.pool.Exec(ctx, `
		UPDATE devices SET removed_at = now()
		WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`, deviceID, userID)
	if err != nil {
		return fmt.Errorf("remove device: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return ErrDeviceNotFound
	}

	return nil
}
