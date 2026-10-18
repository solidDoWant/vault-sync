//go:build integration

package main_test

import (
	"context"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/realtime"
)

// dialRealtime opens a realtime WebSocket to server as a browser client
// would: the token travels in the bearer subprotocol.
func dialRealtime(t *testing.T, server *instance, token string) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.apiURL, "http")+realtime.Path, &websocket.DialOptions{
		Subprotocols: []string{realtime.Subprotocol, realtime.BearerSubprotocolPrefix + token},
		HTTPHeader:   http.Header{"Origin": {"app://obsidian.md"}},
	})
	require.NoError(t, err, "dial realtime on %s", server.name)
	t.Cleanup(func() { _ = conn.CloseNow() })

	return conn
}

func readFrame(t *testing.T, conn *websocket.Conn, timeout time.Duration) (*vaultsyncv1.ServerFrame, error) {
	t.Helper()

	ctx, cancel := context.WithTimeout(t.Context(), timeout)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}

	var frame vaultsyncv1.ServerFrame
	require.NoError(t, proto.Unmarshal(data, &frame))

	return &frame, nil
}

func subscribeRealtime(t *testing.T, conn *websocket.Conn, vaultID string) {
	t.Helper()

	data, err := proto.Marshal(&vaultsyncv1.ClientFrame{RequestId: 1, Frame: &vaultsyncv1.ClientFrame_Subscribe{
		Subscribe: &vaultsyncv1.Subscribe{VaultId: vaultID},
	}})
	require.NoError(t, err)
	require.NoError(t, conn.Write(t.Context(), websocket.MessageBinary, data))

	frame, err := readFrame(t, conn, 30*time.Second)
	require.NoError(t, err)
	require.NotNil(t, frame.GetSubscribed(), "expected subscribed, got %v", frame)
}

// commitNote uploads content and commits it as a new note through server.
func commitNote(t *testing.T, server *instance, token, vaultID, deviceID, path string) *vaultsyncv1.Revision {
	t.Helper()

	content, blobID := randomBlob(t, 64)
	client := &blobClient{token: token, vaultID: vaultID, blobID: blobID, content: content}

	_, err := client.begin(t, server)
	require.NoError(t, err)
	client.sendChunks(t, 0, 0, server)
	_, err = client.commit(t, server)
	require.NoError(t, err)

	response, err := vaultsyncv1connect.NewSyncServiceClient(httpClient, server.apiURL).CommitRevision(t.Context(),
		authorized(&vaultsyncv1.CommitRevisionRequest{
			VaultId:    vaultID,
			DocumentId: uuid.Must(uuid.NewV7()).String(),
			RevisionId: uuid.Must(uuid.NewV7()).String(),
			Kind:       vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT,
			ContentRef: &vaultsyncv1.ContentRef{BlobId: blobID, Size: uint64(len(content))},
			Path:       []byte(path),
			DeviceId:   deviceID,
		}, token))
	require.NoError(t, err, "commit on %s", server.name)

	return response.Msg.GetRevision()
}

// A commit on one instance notifies a subscriber connected to another
// within a second (fan-out through PostgreSQL), and SIGTERM closes an
// instance's realtime sockets with 1001 so clients reconnect elsewhere.
func TestRealtimeFansOutAcrossInstancesAndDrainsWithGoingAway(t *testing.T) {
	cluster := newDeployment(t)
	binary := buildServer(t)

	first := cluster.start(t, "first", binary)
	second := cluster.start(t, "second", binary)

	token := cluster.token(t, "alice")
	vault := createVault(t, first, token, "Notes")

	device, err := vaultsyncv1connect.NewDeviceServiceClient(httpClient, first.apiURL).RegisterDevice(t.Context(),
		authorized(&vaultsyncv1.RegisterDeviceRequest{Name: "laptop"}, token))
	require.NoError(t, err)

	conn := dialRealtime(t, second, token)
	subscribeRealtime(t, conn, vault.GetId())

	revision := commitNote(t, first, token, vault.GetId(), device.Msg.GetDevice().GetId(), "note.md")

	frame, err := readFrame(t, conn, time.Second)
	require.NoError(t, err, "vault_changed must arrive within a second")
	require.NotNil(t, frame.GetVaultChanged(), "expected vault_changed, got %v", frame)
	assert.Equal(t, vault.GetId(), frame.GetVaultChanged().GetVaultId())
	assert.Equal(t, revision.GetSeq(), frame.GetVaultChanged().GetSeq())

	require.NoError(t, second.process.Command.Process.Signal(syscall.SIGTERM))

	_, err = readFrame(t, conn, 30*time.Second)
	require.Error(t, err)
	assert.Equal(t, websocket.StatusGoingAway, websocket.CloseStatus(err))

	select {
	case <-second.process.Exited():
		require.NoError(t, second.process.Err(), "a drained instance exits 0")
	case <-time.After(30 * time.Second):
		t.Fatal("the instance did not exit after draining")
	}

	// The client reconnects to the remaining instance and is notified
	// there.
	conn = dialRealtime(t, first, token)
	subscribeRealtime(t, conn, vault.GetId())

	revision = commitNote(t, first, token, vault.GetId(), device.Msg.GetDevice().GetId(), "other.md")

	frame, err = readFrame(t, conn, time.Second)
	require.NoError(t, err)
	require.NotNil(t, frame.GetVaultChanged(), "expected vault_changed, got %v", frame)
	assert.Equal(t, revision.GetSeq(), frame.GetVaultChanged().GetSeq())
}
