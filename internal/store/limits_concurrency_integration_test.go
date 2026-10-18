//go:build integration

package store_test

import (
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// SQLSTATE codes for the failures this test guards against.
const (
	sqlStateDeadlockDetected     = "40P01"
	sqlStateSerializationFailure = "40001"
)

func requireNoLockConflict(t *testing.T, err error, msgAndArgs ...any) {
	t.Helper()

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		require.NotEqual(t, sqlStateDeadlockDetected, pgErr.Code, msgAndArgs...)
		require.NotEqual(t, sqlStateSerializationFailure, pgErr.Code, msgAndArgs...)
	}
}

// TestPerUserLimitsUnderConcurrentWritesReferencingTheUser races, for one
// user, RegisterDevice and CreateVault calls against each other and against
// transactions that insert rows referencing the same user row (editor
// memberships in another user's vaults). The FK checks of those inserts lock
// the user row FOR KEY SHARE, which conflicts with the limit lock. No call may
// fail with a deadlock or serialization failure, and the limits must hold
// exactly.
func TestPerUserLimitsUnderConcurrentWritesReferencingTheUser(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	const (
		rounds        = 25
		racers        = 6
		childWriters  = 4
		deviceLimit   = 3
		vaultLimit    = 3
		unboundedHost = 1 << 20
	)

	host, err := queries.UpsertUser(t.Context(), testIssuer, "host")
	require.NoError(t, err)

	for round := range rounds {
		user, err := queries.UpsertUser(t.Context(), testIssuer, uuid.NewString())
		require.NoError(t, err)

		// Vaults owned by another user that the child writers add user to.
		hostVaults := make([]uuid.UUID, childWriters)

		for writer := range childWriters {
			vault, err := queries.CreateVault(t.Context(), host, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, unboundedHost)
			require.NoError(t, err)

			hostVaults[writer] = vault.ID
		}

		deviceErrs := make([]error, racers)
		vaultErrs := make([]error, racers)
		childErrs := make([]error, childWriters)
		start := make(chan struct{})

		var group sync.WaitGroup

		for racer := range racers {
			group.Go(func() {
				<-start

				_, deviceErrs[racer] = queries.RegisterDevice(t.Context(), user, "Device", nil, deviceLimit)
			})

			group.Go(func() {
				<-start

				_, vaultErrs[racer] = queries.CreateVault(t.Context(), user, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, vaultLimit)
			})
		}

		for writer := range childWriters {
			group.Go(func() {
				<-start

				childErrs[writer] = pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
					// The FK check locks user's row FOR KEY SHARE; holding it
					// for a moment widens the window for a lock conflict.
					_, err := tx.Exec(t.Context(),
						`INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`,
						hostVaults[writer], user)
					if err != nil {
						return err
					}

					_, err = tx.Exec(t.Context(), `SELECT pg_sleep(0.005)`)

					return err
				})
			})
		}

		close(start)
		group.Wait()

		var registered, created int

		for racer := range racers {
			requireNoLockConflict(t, deviceErrs[racer], "round %d device racer %d", round, racer)
			requireNoLockConflict(t, vaultErrs[racer], "round %d vault racer %d", round, racer)

			if deviceErrs[racer] == nil {
				registered++
			} else {
				require.ErrorIs(t, deviceErrs[racer], store.ErrDeviceLimit, "round %d device racer %d", round, racer)
			}

			if vaultErrs[racer] == nil {
				created++
			} else {
				require.ErrorIs(t, vaultErrs[racer], store.ErrVaultLimit, "round %d vault racer %d", round, racer)
			}
		}

		for writer := range childWriters {
			requireNoLockConflict(t, childErrs[writer], "round %d child writer %d", round, writer)
			require.NoError(t, childErrs[writer], "round %d child writer %d", round, writer)
		}

		assert.Equal(t, deviceLimit, registered, "round %d", round)
		assert.Equal(t, vaultLimit, created, "round %d", round)

		devices, err := queries.ListDevices(t.Context(), user)
		require.NoError(t, err)
		assert.Len(t, devices, deviceLimit, "round %d", round)

		vaults, err := queries.ListVaults(t.Context(), user, uuid.Nil, 100)
		require.NoError(t, err)

		owned := 0

		for _, vault := range vaults {
			if vault.Role == store.RoleOwner {
				owned++
			}
		}

		assert.Equal(t, vaultLimit, owned, "round %d", round)
		assert.Len(t, vaults, vaultLimit+childWriters, "round %d", round)
	}
}
