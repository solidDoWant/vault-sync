//go:build integration

package server_test

import (
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Issue #428: a RegisterDevice retried with the same registration id, after
// a lost response or a crash before the client saved the device, gets the
// device the first call registered and uses no further device slot, even at
// the limit.
func TestRegisterDeviceRetryWithTheSameRegistrationIDUsesNoSecondSlot(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	token := fixture.token(t, "alice")
	registrationID := uuid.Must(uuid.NewV7()).String()
	publicKey := make([]byte, api.PublicKeyBytes)

	// Fill all but one slot, so the registration takes the last one.
	for range api.MaxDevicesPerUser - 1 {
		_, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Device"})
		require.NoError(t, err)
	}

	request := &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: publicKey, RegistrationId: registrationID}

	first, err := fixture.registerDevice(t, token, request)
	require.NoError(t, err)

	retried, err := fixture.registerDevice(t, token, request)
	require.NoError(t, err, "a retry at the limit is not refused")
	assert.Equal(t, first.GetId(), retried.GetId())
	assert.Equal(t, first.GetCreateTime().AsTime(), retried.GetCreateTime().AsTime())

	var rows int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM devices`).Scan(&rows))
	assert.Equal(t, api.MaxDevicesPerUser, rows, "the retry registered no second device")

	// The limit itself still holds for a new registration id.
	_, err = fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Other", RegistrationId: uuid.Must(uuid.NewV7()).String()})
	requireCode(t, connect.CodeResourceExhausted, err)
}

// Concurrent retries of one registration, on any replica, register one
// device: registrations are serialized on the user row in PostgreSQL.
func TestConcurrentRetriesOfOneRegistrationRegisterOneDevice(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	token := fixture.token(t, "alice")
	request := &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", RegistrationId: uuid.Must(uuid.NewV7()).String()}

	const attempts = 8

	ids := make([]string, attempts)

	var group sync.WaitGroup

	for attempt := range attempts {
		group.Go(func() {
			device, err := fixture.registerDevice(t, token, request)
			assert.NoError(t, err)

			ids[attempt] = device.GetId()
		})
	}

	group.Wait()

	for _, id := range ids {
		assert.Equal(t, ids[0], id)
	}

	listed, err := listDevicesOn(t, fixture.running, token)
	require.NoError(t, err)
	assert.Len(t, listed, 1)
}

func TestRegisterDeviceRegistrationIDRules(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")
	registrationID := uuid.Must(uuid.NewV7()).String()

	original, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", RegistrationId: registrationID})
	require.NoError(t, err)

	t.Run("a different name under the same id returns the device as it is", func(t *testing.T) {
		device, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Phone", RegistrationId: registrationID})
		require.NoError(t, err)
		assert.Equal(t, original.GetId(), device.GetId())
		assert.Equal(t, "Laptop", device.GetName(), "the retry's name is ignored")
	})

	t.Run("a different public key under the same id is refused", func(t *testing.T) {
		_, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{
			Name: "Laptop", PublicKey: make([]byte, api.PublicKeyBytes), RegistrationId: registrationID,
		})
		requireCode(t, connect.CodeAlreadyExists, err)
	})

	t.Run("another user's id is their own", func(t *testing.T) {
		device, err := fixture.registerDevice(t, bob, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", RegistrationId: registrationID})
		require.NoError(t, err)
		assert.NotEqual(t, original.GetId(), device.GetId())
	})

	t.Run("an id that is not a canonical lowercase UUID is refused", func(t *testing.T) {
		for _, invalid := range []string{"not-a-uuid", "0192F7E4-8A3B-7C2D-9E1F-0A1B2C3D4E5F", "{" + registrationID + "}"} {
			_, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", RegistrationId: invalid})
			requireCode(t, connect.CodeInvalidArgument, err)
		}
	})

	t.Run("without an id every call registers a new device", func(t *testing.T) {
		first, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Tablet"})
		require.NoError(t, err)

		second, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Tablet"})
		require.NoError(t, err)
		assert.NotEqual(t, first.GetId(), second.GetId())
	})

	t.Run("after removal the id registers a new device", func(t *testing.T) {
		require.NoError(t, removeDeviceOn(t, fixture.running, alice, original.GetId()))

		device, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", RegistrationId: registrationID})
		require.NoError(t, err)
		assert.NotEqual(t, original.GetId(), device.GetId())
	})
}
