//go:build integration

package store_test

import (
	"bytes"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

const testIssuer = "https://auth.example/application/o/vault-sync/"

func TestUpsertUserIsKeyedByIssuerAndSubject(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	alice, err := queries.UpsertUser(t.Context(), testIssuer, "alice", "")
	require.NoError(t, err)

	again, err := queries.UpsertUser(t.Context(), testIssuer, "alice", "")
	require.NoError(t, err)

	otherIssuer, err := queries.UpsertUser(t.Context(), "https://other.example/", "alice", "")
	require.NoError(t, err)

	bob, err := queries.UpsertUser(t.Context(), testIssuer, "bob", "")
	require.NoError(t, err)

	assert.Equal(t, alice, again)
	assert.NotEqual(t, alice, otherIssuer)
	assert.NotEqual(t, alice, bob)
	assert.Equal(t, uuid.Version(7), alice.Version())

	var stored uuid.UUID

	require.NoError(t, pool.QueryRow(t.Context(),
		`SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`, testIssuer, "alice").Scan(&stored))
	assert.Equal(t, alice, stored)
}

// TestUpsertUserConcurrentFirstRequests races many first requests of the same
// new identity: exactly one user is created and every request gets its id.
func TestUpsertUserConcurrentFirstRequests(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	const (
		identities = 20
		racers     = 8
	)

	for identity := range identities {
		subject := uuid.NewString()
		ids := make([]uuid.UUID, racers)
		errs := make([]error, racers)
		start := make(chan struct{})

		var group sync.WaitGroup

		for racer := range racers {
			group.Go(func() {
				<-start

				ids[racer], errs[racer] = queries.UpsertUser(t.Context(), testIssuer, subject, "")
			})
		}

		close(start)
		group.Wait()

		for racer := range racers {
			require.NoError(t, errs[racer], "identity %d racer %d", identity, racer)
			assert.Equal(t, ids[0], ids[racer], "identity %d racer %d", identity, racer)
		}

		var count int

		require.NoError(t, pool.QueryRow(t.Context(),
			`SELECT count(*) FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`, testIssuer, subject).Scan(&count))
		assert.Equal(t, 1, count)
	}
}

func TestDevicesAreListedForTheirUserOnly(t *testing.T) {
	queries := store.New(migratedPool(t))

	alice, err := queries.UpsertUser(t.Context(), testIssuer, "alice", "")
	require.NoError(t, err)

	bob, err := queries.UpsertUser(t.Context(), testIssuer, "bob", "")
	require.NoError(t, err)

	publicKey := bytes.Repeat([]byte{7}, 32)

	laptop, err := queries.RegisterDevice(t.Context(), alice, "Laptop", publicKey, 10)
	require.NoError(t, err)

	phone, err := queries.RegisterDevice(t.Context(), alice, "Phone", nil, 10)
	require.NoError(t, err)

	desktop, err := queries.RegisterDevice(t.Context(), bob, "Desktop", nil, 10)
	require.NoError(t, err)

	aliceDevices, err := queries.ListDevices(t.Context(), alice)
	require.NoError(t, err)

	bobDevices, err := queries.ListDevices(t.Context(), bob)
	require.NoError(t, err)

	assert.Equal(t, []uuid.UUID{laptop.ID, phone.ID}, deviceIDs(aliceDevices))
	assert.Equal(t, []uuid.UUID{desktop.ID}, deviceIDs(bobDevices))

	assert.Equal(t, "Laptop", aliceDevices[0].Name)
	assert.Equal(t, publicKey, aliceDevices[0].PublicKey)
	assert.Equal(t, alice, aliceDevices[0].UserID)
	assert.Nil(t, aliceDevices[1].PublicKey)

	nobody, err := queries.ListDevices(t.Context(), uuid.New())
	require.NoError(t, err)
	assert.Empty(t, nobody)
}

func deviceIDs(devices []store.Device) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
	}

	return ids
}

func TestRegisterDeviceEnforcesTheLimitUnderConcurrency(t *testing.T) {
	queries := store.New(migratedPool(t))

	user, err := queries.UpsertUser(t.Context(), testIssuer, "alice", "")
	require.NoError(t, err)

	const (
		limit    = 3
		attempts = 12
	)

	errs := make([]error, attempts)

	var group sync.WaitGroup

	for attempt := range attempts {
		group.Go(func() {
			_, errs[attempt] = queries.RegisterDevice(t.Context(), user, "Device", nil, limit)
		})
	}

	group.Wait()

	succeeded := 0

	for _, err := range errs {
		if err == nil {
			succeeded++

			continue
		}

		require.ErrorIs(t, err, store.ErrDeviceLimit)
	}

	assert.Equal(t, limit, succeeded)

	devices, err := queries.ListDevices(t.Context(), user)
	require.NoError(t, err)
	assert.Len(t, devices, limit)
}

func TestRegisterDeviceRequiresAnExistingUser(t *testing.T) {
	queries := store.New(migratedPool(t))

	_, err := queries.RegisterDevice(t.Context(), uuid.New(), "Laptop", nil, 10)
	require.ErrorIs(t, err, store.ErrUserNotFound)
}
