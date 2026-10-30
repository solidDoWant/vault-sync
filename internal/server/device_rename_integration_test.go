//go:build integration

package server_test

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func renameDeviceOn(t *testing.T, running *runningServer, token, deviceID, name string) (*vaultsyncv1.Device, error) {
	t.Helper()

	response, err := deviceClient(running).RenameDevice(t.Context(), authorized(&vaultsyncv1.RenameDeviceRequest{DeviceId: deviceID, Name: name}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetDevice(), nil
}

func TestRenamedDeviceKeepsItsIDAndShowsTheNewNameInListAndHistory(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	other := fixture.client(t, "alice", alice.vaultID)

	created := alice.mustCommit(t, alice.create(t, "note.md", alice.content(t, "hello")))

	renamed, err := renameDeviceOn(t, fixture.replicas[1], alice.token, alice.deviceID, "Work laptop")
	require.NoError(t, err)
	assert.Equal(t, alice.deviceID, renamed.GetId())
	assert.Equal(t, "Work laptop", renamed.GetName())

	listed, err := listDevicesOn(t, fixture.replicas[0], alice.token)
	require.NoError(t, err)
	require.Len(t, listed, 2)
	assert.Equal(t, alice.deviceID, listed[0].GetId(), "the device id is unchanged")
	assert.Equal(t, "Work laptop", listed[0].GetName())
	assert.Equal(t, other.deviceID, listed[1].GetId())
	assert.Equal(t, "alice's laptop", listed[1].GetName(), "only the renamed device changes")

	history, err := other.historyPage(t, created.GetDocumentId(), 0, "")
	require.NoError(t, err)
	require.Len(t, history.GetDeviceNames(), 1)
	assert.Equal(t, alice.deviceID, history.GetDeviceNames()[0].GetDeviceId())
	assert.Equal(t, "Work laptop", history.GetDeviceNames()[0].GetName())
	require.Len(t, history.GetUserNames(), 1, "history still names the user next to the device")
	assert.Equal(t, created.GetUserId(), history.GetUserNames()[0].GetUserId())

	// The renamed device still commits.
	alice.mustCommit(t, alice.create(t, "other.md", alice.content(t, "still works")))
}

func TestRenameDeviceNameAndIDRules(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	alice := fixture.token(t, "alice")

	device, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
	require.NoError(t, err)

	tests := []struct {
		name     string
		value    string
		wantCode connect.Code
	}{
		{name: "exactly the limit", value: strings.Repeat("a", api.MaxDeviceNameBytes)},
		{name: "one byte over the limit", value: strings.Repeat("a", api.MaxDeviceNameBytes+1), wantCode: connect.CodeInvalidArgument},
		{name: "multi-byte at the limit", value: strings.Repeat("é", api.MaxDeviceNameBytes/2)},
		{name: "multi-byte over the limit", value: strings.Repeat("é", api.MaxDeviceNameBytes/2) + "a", wantCode: connect.CodeInvalidArgument},
		{name: "empty", value: "", wantCode: connect.CodeInvalidArgument},
		{name: "blank", value: " \t ", wantCode: connect.CodeInvalidArgument},
		{name: "control character", value: "Lap\x00top", wantCode: connect.CodeInvalidArgument},
		{name: "format character", value: "Lap\u200btop", wantCode: connect.CodeInvalidArgument},
		{name: "line separator", value: "Lap\u2028top", wantCode: connect.CodeInvalidArgument},
		{name: "paragraph separator", value: "Lap\u2029top", wantCode: connect.CodeInvalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before, err := listDevicesOn(t, fixture.running, alice)
			require.NoError(t, err)

			renamed, err := renameDeviceOn(t, fixture.running, alice, device.GetId(), test.value)

			listed, listErr := listDevicesOn(t, fixture.running, alice)
			require.NoError(t, listErr)
			require.Len(t, listed, 1)

			if test.wantCode == 0 {
				require.NoError(t, err)
				assert.Equal(t, test.value, renamed.GetName())
				assert.Equal(t, test.value, listed[0].GetName())

				return
			}

			requireCode(t, test.wantCode, err)
			assert.Equal(t, before[0].GetName(), listed[0].GetName(), "a refused name changes nothing")
		})
	}

	for _, deviceID := range []string{"", "not-a-uuid", strings.ToUpper(device.GetId()), "{" + device.GetId() + "}"} {
		_, err := renameDeviceOn(t, fixture.running, alice, deviceID, "Phone")
		requireCode(t, connect.CodeInvalidArgument, err)
	}

	_, err = renameDeviceOn(t, fixture.running, "", device.GetId(), "Phone")
	requireCode(t, connect.CodeUnauthenticated, err)
}

func TestRenameDeviceFindsOnlyTheCallersDevicesThatAreNotRemoved(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")

	laptop, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop"})
	require.NoError(t, err)

	removed, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Old phone"})
	require.NoError(t, err)
	require.NoError(t, removeDeviceOn(t, fixture.running, alice, removed.GetId()))

	// Another user's device: the same answer as for an unknown one.
	_, err = renameDeviceOn(t, fixture.running, bob, laptop.GetId(), "Bob's now")
	requireCode(t, connect.CodeNotFound, err)

	_, err = renameDeviceOn(t, fixture.running, alice, removed.GetId(), "Back")
	requireCode(t, connect.CodeNotFound, err)

	_, err = renameDeviceOn(t, fixture.running, alice, uuid.Must(uuid.NewV7()).String(), "Unknown")
	requireCode(t, connect.CodeNotFound, err)

	listed, err := listDevicesOn(t, fixture.running, alice)
	require.NoError(t, err)
	assert.Equal(t, []string{"Laptop"}, listedNames(listed), "nothing was renamed")

	var removedName string

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT name FROM devices WHERE id = $1`, removed.GetId()).Scan(&removedName))
	assert.Equal(t, "Old phone", removedName, "the removed device keeps its name")
}

func TestRegistrationRetryAfterRenameReturnsTheRenamedDevice(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	alice := fixture.token(t, "alice")
	registrationID := uuid.Must(uuid.NewV7()).String()

	publicKey := make([]byte, api.PublicKeyBytes)
	publicKey[0] = 1

	registered, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "A", PublicKey: publicKey, RegistrationId: registrationID})
	require.NoError(t, err)

	_, err = renameDeviceOn(t, fixture.running, alice, registered.GetId(), "B")
	require.NoError(t, err)

	retried, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "A", PublicKey: publicKey, RegistrationId: registrationID})
	require.NoError(t, err)
	assert.Equal(t, registered.GetId(), retried.GetId(), "the retry returns the same device")
	assert.Equal(t, "B", retried.GetName(), "the retry returns the device's current name")

	listed, err := listDevicesOn(t, fixture.running, alice)
	require.NoError(t, err)
	assert.Equal(t, []string{"B"}, listedNames(listed), "the retry uses no extra place")

	_, err = fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{
		Name: "B", PublicKey: make([]byte, api.PublicKeyBytes), RegistrationId: registrationID,
	})
	requireCode(t, connect.CodeAlreadyExists, err)
}
