//go:build integration

package server_test

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func deviceClient(running *runningServer) vaultsyncv1connect.DeviceServiceClient {
	return vaultsyncv1connect.NewDeviceServiceClient(http.DefaultClient, running.apiURL())
}

func listDevicesOn(t *testing.T, running *runningServer, token string) ([]*vaultsyncv1.Device, error) {
	t.Helper()

	response, err := deviceClient(running).ListDevices(t.Context(), authorized(&vaultsyncv1.ListDevicesRequest{}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetDevices(), nil
}

func removeDeviceOn(t *testing.T, running *runningServer, token, deviceID string) error {
	t.Helper()

	_, err := deviceClient(running).RemoveDevice(t.Context(), authorized(&vaultsyncv1.RemoveDeviceRequest{DeviceId: deviceID}, token))

	return err
}

func listedNames(devices []*vaultsyncv1.Device) []string {
	names := make([]string, 0, len(devices))
	for _, device := range devices {
		names = append(names, device.GetName())
	}

	return names
}

func TestListDevicesShowsTheCallersDevicesAndNothingSecret(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")

	publicKey := make([]byte, api.PublicKeyBytes)
	for index := range publicKey {
		publicKey[index] = byte(0xA0 + index)
	}

	before := time.Now().Add(-time.Second)

	laptop, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Laptop", PublicKey: publicKey})
	require.NoError(t, err)

	phone, err := fixture.registerDevice(t, alice, &vaultsyncv1.RegisterDeviceRequest{Name: "Phone"})
	require.NoError(t, err)

	_, err = fixture.registerDevice(t, bob, &vaultsyncv1.RegisterDeviceRequest{Name: "Desktop"})
	require.NoError(t, err)

	listed, err := listDevicesOn(t, fixture.running, alice)
	require.NoError(t, err)
	require.Len(t, listed, 2)

	assert.Equal(t, []string{laptop.GetId(), phone.GetId()}, []string{listed[0].GetId(), listed[1].GetId()})
	assert.Equal(t, []string{"Laptop", "Phone"}, listedNames(listed))

	for _, device := range listed {
		assert.WithinRange(t, device.GetCreateTime().AsTime(), before, time.Now().Add(time.Second))
		assert.Nil(t, device.GetLastActivityTime(), "a device that never committed has no last activity")

		encoded, err := proto.Marshal(device)
		require.NoError(t, err)
		assert.NotContains(t, string(encoded), string(publicKey), "the public key is not listed")
	}

	bobs, err := listDevicesOn(t, fixture.running, bob)
	require.NoError(t, err)
	assert.Equal(t, []string{"Desktop"}, listedNames(bobs), "a user sees only their own devices")

	_, err = listDevicesOn(t, fixture.running, "")
	requireCode(t, connect.CodeUnauthenticated, err)
}

func TestListDevicesShowsLastActivity(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	idle, err := fixture.registerDevice(t, alice.token, &vaultsyncv1.RegisterDeviceRequest{Name: "Idle"})
	require.NoError(t, err)

	content := alice.content(t, "hello")
	before := time.Now().Add(-time.Second)

	alice.mustCommit(t, alice.create(t, "note.md", content))

	after := time.Now().Add(time.Second)

	listed, err := listDevicesOn(t, fixture.replicas[1], alice.token)
	require.NoError(t, err)
	require.Len(t, listed, 2)

	assert.Equal(t, alice.deviceID, listed[0].GetId())
	require.NotNil(t, listed[0].GetLastActivityTime(), "a committing device has a last activity")
	assert.WithinRange(t, listed[0].GetLastActivityTime().AsTime(), before, after)

	assert.Equal(t, idle.GetId(), listed[1].GetId())
	assert.Nil(t, listed[1].GetLastActivityTime())
}

func TestRemovedDeviceCannotCommitAndKeepsItsHistory(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	other := fixture.client(t, "alice", alice.vaultID)

	content := alice.content(t, "hello")
	created := alice.mustCommit(t, alice.create(t, "note.md", content))

	// Removed through one replica; the other refuses the device at once.
	require.NoError(t, removeDeviceOn(t, fixture.replicas[1], alice.token, alice.deviceID))

	for replica := range fixture.replicas {
		_, err := alice.commitOn(t, replica, alice.next(t, created, "note.md", content, false))
		requireCode(t, connect.CodeNotFound, err)

		_, err = alice.commitOn(t, replica, alice.create(t, "new.md", content))
		requireCode(t, connect.CodeNotFound, err)
	}

	assert.Equal(t, uint64(1), fixture.headSeq(t, alice.vaultID), "nothing was committed")

	listed, err := listDevicesOn(t, fixture.replicas[0], alice.token)
	require.NoError(t, err)
	assert.Equal(t, []string{other.deviceID}, []string{listed[0].GetId()}, "a removed device is not listed")
	assert.Len(t, listed, 1)

	// The removed device's revision keeps its history and attribution.
	changes, err := other.changes(t, 0, 0)
	require.NoError(t, err)
	require.Len(t, changes.GetRevisions(), 1)
	assert.True(t, proto.Equal(created, changes.GetRevisions()[0]), "the revision is unchanged")
	assert.Equal(t, alice.deviceID, changes.GetRevisions()[0].GetDeviceId())

	history, err := other.historyPage(t, created.GetDocumentId(), 0, "")
	require.NoError(t, err)
	assert.Equal(t, []string{created.GetId()}, revisionIDs(history.GetRevisions()))
	require.Len(t, history.GetDeviceNames(), 1)
	assert.Equal(t, alice.deviceID, history.GetDeviceNames()[0].GetDeviceId())
	assert.Equal(t, "alice's laptop", history.GetDeviceNames()[0].GetName(), "the removed device is still named")

	// Another device of the user still commits on top of it.
	other.mustCommit(t, other.next(t, created, "note.md", content, true))

	// Removing it again finds nothing to remove.
	requireCode(t, connect.CodeNotFound, removeDeviceOn(t, fixture.replicas[0], alice.token, alice.deviceID))
}

func TestRemovingADeviceAtTheLimitLetsANewInstallationRegister(t *testing.T) {
	pool := migratedPool(t)
	fixture := newAuthFixture(t, store.New(pool), pool)
	token := fixture.token(t, "alice")

	var first *vaultsyncv1.Device

	for index := range api.MaxDevicesPerUser {
		device, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Device"})
		require.NoError(t, err)

		if index == 0 {
			first = device
		}
	}

	_, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "One too many"})
	requireCode(t, connect.CodeResourceExhausted, err)

	require.NoError(t, removeDeviceOn(t, fixture.running, token, first.GetId()))

	replacement, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "Reinstalled"})
	require.NoError(t, err)

	// The removal freed exactly one place.
	_, err = fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: "One too many"})
	requireCode(t, connect.CodeResourceExhausted, err)

	listed, err := listDevicesOn(t, fixture.running, token)
	require.NoError(t, err)
	assert.Len(t, listed, api.MaxDevicesPerUser)
	assert.Equal(t, replacement.GetId(), listed[len(listed)-1].GetId())

	// The removed row is kept, so revisions referencing it stay valid.
	var rows int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM devices`).Scan(&rows))
	assert.Equal(t, api.MaxDevicesPerUser+1, rows)
}

func TestAUserCannotListOrRemoveAnotherUsersDevices(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	bob := fixture.token(t, "bob")
	bobDevice, err := fixture.registerDevice(t, bob, &vaultsyncv1.RegisterDeviceRequest{Name: "Bob's phone"})
	require.NoError(t, err)

	bobs, err := listDevicesOn(t, fixture.replicas[0], bob)
	require.NoError(t, err)
	assert.Equal(t, []string{bobDevice.GetId()}, []string{bobs[0].GetId()})
	assert.Len(t, bobs, 1, "bob does not see alice's device")

	// Bob cannot remove alice's device: the same answer as for a device
	// that does not exist.
	requireCode(t, connect.CodeNotFound, removeDeviceOn(t, fixture.replicas[0], bob, alice.deviceID))
	requireCode(t, connect.CodeNotFound, removeDeviceOn(t, fixture.replicas[0], bob, newV7(t)))

	listed, err := listDevicesOn(t, fixture.replicas[0], alice.token)
	require.NoError(t, err)
	assert.Equal(t, []string{alice.deviceID}, []string{listed[0].GetId()})

	alice.mustCommit(t, alice.create(t, "note.md", alice.content(t, "still works")))

	// Requests are bounded and authenticated before anything is touched.
	for _, deviceID := range []string{"", "not-a-uuid", "0198F9C2-7A6B-7C3D-8E4F-123456789ABC"} {
		requireCode(t, connect.CodeInvalidArgument, removeDeviceOn(t, fixture.replicas[0], alice.token, deviceID))
	}

	requireCode(t, connect.CodeUnauthenticated, removeDeviceOn(t, fixture.replicas[0], "", alice.deviceID))

	listed, err = listDevicesOn(t, fixture.replicas[1], alice.token)
	require.NoError(t, err)
	assert.Len(t, listed, 1, "alice's device is still there")
}

// A removal racing the device's commits on another replica: once
// RemoveDevice returns, no commit by the device lands any more, so every
// accepted commit is at or below the head read right after the removal.
func TestNoCommitLandsAfterRemoveDeviceReturns(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})

	for round := range 10 {
		alice := fixture.client(t, "alice", "")
		alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
		content := alice.content(t, "hello")
		alice.mustCommit(t, alice.create(t, "warm-up.md", content))

		var (
			waitGroup sync.WaitGroup
			mutex     sync.Mutex
			accepted  []uint64
		)

		start := make(chan struct{})

		for range 4 {
			waitGroup.Go(func() {
				<-start

				for range 25 {
					response, err := alice.sync(0).CommitRevision(t.Context(), authorized(alice.create(t, "note-"+newV7(t)+".md", content), alice.token))
					if err != nil {
						assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "round %d: %v", round, err)

						return
					}

					mutex.Lock()

					accepted = append(accepted, response.Msg.GetRevision().GetSeq())
					mutex.Unlock()
				}
			})
		}

		close(start)
		time.Sleep(time.Duration(round) * time.Millisecond)
		require.NoError(t, removeDeviceOn(t, fixture.replicas[1], alice.token, alice.deviceID))
		headAtRemoval := fixture.headSeq(t, alice.vaultID)

		waitGroup.Wait()

		for _, seq := range accepted {
			assert.LessOrEqual(t, seq, headAtRemoval, "round %d: a commit landed after the removal returned", round)
		}

		assert.Equal(t, headAtRemoval, fixture.headSeq(t, alice.vaultID), "round %d", round)
	}
}
