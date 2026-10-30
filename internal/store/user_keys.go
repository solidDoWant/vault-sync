package store

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// User key errors (SPEC.md §9.3).
var (
	// ErrUserKeyExists is returned when a user who already has a key
	// creates one.
	ErrUserKeyExists = errors.New("user key already exists")
	// ErrUserKeyNotFound is returned when the user has no key.
	ErrUserKeyNotFound = errors.New("user key not found")
	// ErrWrongAuthKey is returned when the presented auth_key does not match
	// the stored one. The failed attempt has been counted.
	ErrWrongAuthKey = errors.New("wrong auth key")
	// ErrPublicKeyMismatch is returned by ChangePassphrase when the expected
	// public key is not the stored one. Nothing was changed.
	ErrPublicKeyMismatch = errors.New("public key does not match the stored key")
	// ErrSignPublicKeyExists is returned by AddSignPublicKey when another
	// signing public key is stored. Nothing was changed.
	ErrSignPublicKeyExists = errors.New("another signing public key is stored")
)

// AttemptsExhaustedError is returned when the user's failed attempts have
// reached the limit within the current window. The attempt was not checked
// and not counted.
type AttemptsExhaustedError struct {
	// RetryAt is when the window ends and attempts are accepted again.
	RetryAt time.Time
}

func (err *AttemptsExhaustedError) Error() string {
	return "too many failed attempts until " + err.RetryAt.UTC().Format(time.RFC3339)
}

// AttemptLimit bounds failed auth_key attempts per user: at most Max within
// Window, which starts at the first failure counted in it.
type AttemptLimit struct {
	Max    int
	Window time.Duration
}

// PassphraseParams are a wrapping's public parameters.
type PassphraseParams struct {
	Suite       uint32
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint32
	Salt        []byte
}

// UserKey is a user's public key and wrapped private key.
type UserKey struct {
	PublicKey []byte
	// SignPublicKey is the Ed25519 signing public key, or nil for a key
	// stored without one.
	SignPublicKey     []byte
	WrappedPrivateKey []byte
	Params            PassphraseParams
}

// Wrapping is a wrapped private key, its parameters and the SHA-256 of the
// auth_key derived with them. It never holds auth_key itself.
type Wrapping struct {
	WrappedPrivateKey []byte
	Params            PassphraseParams
	AuthKeyHash       []byte
}

// CreateUserKey stores userID's key pair, returning ErrUserKeyExists (and
// changing nothing) if userID already has one.
func (store *Store) CreateUserKey(ctx context.Context, userID uuid.UUID, publicKey, signPublicKey []byte, wrapping Wrapping) error {
	params := wrapping.Params

	tag, err := store.pool.Exec(ctx, `
		INSERT INTO user_keys (user_id, public_key, sign_public_key, wrapped_private_key, suite, argon2_memory_kib,
			argon2_iterations, argon2_parallelism, salt, auth_key_hash)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (user_id) DO NOTHING`,
		userID, publicKey, signPublicKey, wrapping.WrappedPrivateKey, params.Suite, params.MemoryKiB, params.Iterations,
		params.Parallelism, params.Salt, wrapping.AuthKeyHash)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return ErrUserNotFound
		}

		return fmt.Errorf("insert user key: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return ErrUserKeyExists
	}

	return nil
}

// UserKeyParams returns userID's public key and wrapping parameters, with
// WrappedPrivateKey left empty, or ErrUserKeyNotFound.
func (store *Store) UserKeyParams(ctx context.Context, userID uuid.UUID) (UserKey, error) {
	var key UserKey

	err := store.pool.QueryRow(ctx, `
		SELECT public_key, sign_public_key, suite, argon2_memory_kib, argon2_iterations, argon2_parallelism, salt
		FROM user_keys WHERE user_id = $1`, userID).Scan(
		&key.PublicKey, &key.SignPublicKey, &key.Params.Suite, &key.Params.MemoryKiB, &key.Params.Iterations, &key.Params.Parallelism, &key.Params.Salt)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserKey{}, ErrUserKeyNotFound
	}

	if err != nil {
		return UserKey{}, fmt.Errorf("select user key params: %w", err)
	}

	return key, nil
}

// UnlockUserKey returns userID's key when authKeyHash matches the stored
// one. It returns ErrUserKeyNotFound, an *AttemptsExhaustedError, or
// ErrWrongAuthKey after counting the failure.
func (store *Store) UnlockUserKey(ctx context.Context, userID uuid.UUID, authKeyHash []byte, limit AttemptLimit) (UserKey, error) {
	var key UserKey

	err := store.withVerifiedUserKey(ctx, userID, authKeyHash, limit, func(tx pgx.Tx, stored UserKey) error {
		key = stored

		return nil
	})
	if err != nil {
		return UserKey{}, err
	}

	return key, nil
}

// ChangePassphrase replaces userID's wrapping with replacement when
// authKeyHash matches the stored one and expectedPublicKey is the stored
// public key. Beyond UnlockUserKey's errors, it returns
// ErrPublicKeyMismatch, changing nothing.
func (store *Store) ChangePassphrase(ctx context.Context, userID uuid.UUID, authKeyHash, expectedPublicKey []byte, replacement Wrapping, limit AttemptLimit) error {
	return store.withVerifiedUserKey(ctx, userID, authKeyHash, limit, func(tx pgx.Tx, stored UserKey) error {
		if subtle.ConstantTimeCompare(stored.PublicKey, expectedPublicKey) != 1 {
			return ErrPublicKeyMismatch
		}

		params := replacement.Params

		_, err := tx.Exec(ctx, `
			UPDATE user_keys SET wrapped_private_key = $2, suite = $3, argon2_memory_kib = $4, argon2_iterations = $5,
				argon2_parallelism = $6, salt = $7, auth_key_hash = $8, updated_at = now()
			WHERE user_id = $1`,
			userID, replacement.WrappedPrivateKey, params.Suite, params.MemoryKiB, params.Iterations,
			params.Parallelism, params.Salt, replacement.AuthKeyHash)
		if err != nil {
			return fmt.Errorf("update user key: %w", err)
		}

		return nil
	})
}

// AddSignPublicKey stores signPublicKey as userID's signing public key when
// authKeyHash matches the stored one and the key has none. Presenting the
// stored signing public key succeeds without a change. Beyond
// UnlockUserKey's errors, it returns ErrSignPublicKeyExists when another one
// is stored, changing nothing.
func (store *Store) AddSignPublicKey(ctx context.Context, userID uuid.UUID, authKeyHash, signPublicKey []byte, limit AttemptLimit) error {
	return store.withVerifiedUserKey(ctx, userID, authKeyHash, limit, func(tx pgx.Tx, stored UserKey) error {
		if stored.SignPublicKey != nil {
			if !bytes.Equal(stored.SignPublicKey, signPublicKey) {
				return ErrSignPublicKeyExists
			}

			return nil
		}

		_, err := tx.Exec(ctx, `UPDATE user_keys SET sign_public_key = $2, updated_at = now() WHERE user_id = $1`,
			userID, signPublicKey)
		if err != nil {
			return fmt.Errorf("add sign public key: %w", err)
		}

		return nil
	})
}

// withVerifiedUserKey locks userID's key row, enforces limit and checks
// authKeyHash in one transaction, then runs action on success. A wrong
// auth_key is counted and committed before ErrWrongAuthKey is returned. The
// row lock serializes attempts across replicas, and the window is measured
// with the database clock, so the count and the window are the same on
// every replica.
func (store *Store) withVerifiedUserKey(ctx context.Context, userID uuid.UUID, authKeyHash []byte, limit AttemptLimit,
	action func(tx pgx.Tx, stored UserKey) error,
) error {
	// outcome is an error that must not roll back the transaction: the
	// failed attempt has to be counted.
	var outcome error

	err := pgx.BeginFunc(ctx, store.pool, func(tx pgx.Tx) error {
		var (
			stored      UserKey
			storedHash  []byte
			failed      int
			windowStart *time.Time
			now         time.Time
		)

		err := tx.QueryRow(ctx, `
			SELECT public_key, sign_public_key, wrapped_private_key, suite, argon2_memory_kib, argon2_iterations, argon2_parallelism, salt,
				auth_key_hash, failed_attempts, attempt_window_start, now()
			FROM user_keys WHERE user_id = $1 FOR UPDATE`, userID).Scan(
			&stored.PublicKey, &stored.SignPublicKey, &stored.WrappedPrivateKey, &stored.Params.Suite, &stored.Params.MemoryKiB,
			&stored.Params.Iterations, &stored.Params.Parallelism, &stored.Params.Salt,
			&storedHash, &failed, &windowStart, &now)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserKeyNotFound
		}

		if err != nil {
			return fmt.Errorf("lock user key: %w", err)
		}

		// A window that has ended no longer counts.
		if windowStart != nil && !now.Before(windowStart.Add(limit.Window)) {
			failed, windowStart = 0, nil
		}

		if failed >= limit.Max && windowStart != nil {
			outcome = &AttemptsExhaustedError{RetryAt: windowStart.Add(limit.Window)}

			return nil
		}

		if subtle.ConstantTimeCompare(storedHash, authKeyHash) != 1 {
			if windowStart == nil {
				windowStart = &now
			}

			_, err := tx.Exec(ctx, `UPDATE user_keys SET failed_attempts = $2, attempt_window_start = $3 WHERE user_id = $1`,
				userID, failed+1, *windowStart)
			if err != nil {
				return fmt.Errorf("count failed attempt: %w", err)
			}

			outcome = ErrWrongAuthKey

			return nil
		}

		return action(tx, stored)
	})
	if err != nil {
		return err
	}

	return outcome
}
