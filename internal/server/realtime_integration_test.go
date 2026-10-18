//go:build integration

package server_test

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// realtimeReadTimeout bounds waiting for a frame that must arrive.
const realtimeReadTimeout = 10 * time.Second

// realtimeClient is one device's realtime WebSocket to one replica.
type realtimeClient struct {
	t    *testing.T
	conn *websocket.Conn
}

func (fixture *syncFixture) realtime(t *testing.T, replica int, token string) *realtimeClient {
	t.Helper()

	ctx, cancel := context.WithTimeout(t.Context(), realtimeReadTimeout)
	defer cancel()

	url := "ws" + strings.TrimPrefix(fixture.replicas[replica].apiURL(), "http") + realtime.Path

	conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		Subprotocols: []string{realtime.Subprotocol, realtime.BearerSubprotocolPrefix + token},
		HTTPHeader:   http.Header{"Origin": {"app://obsidian.md"}},
	})
	require.NoError(t, err)
	require.Equal(t, http.StatusSwitchingProtocols, response.StatusCode)
	t.Cleanup(func() { _ = conn.CloseNow() })

	return &realtimeClient{t: t, conn: conn}
}

func (client *realtimeClient) read() *vaultsyncv1.ServerFrame {
	client.t.Helper()

	return client.readWithin(realtimeReadTimeout)
}

func (client *realtimeClient) readWithin(timeout time.Duration) *vaultsyncv1.ServerFrame {
	client.t.Helper()

	ctx, cancel := context.WithTimeout(client.t.Context(), timeout)
	defer cancel()

	_, data, err := client.conn.Read(ctx)
	require.NoError(client.t, err)

	var frame vaultsyncv1.ServerFrame
	require.NoError(client.t, proto.Unmarshal(data, &frame))

	return &frame
}

func (client *realtimeClient) send(requestID uint64, vaultID string) *vaultsyncv1.ServerFrame {
	client.t.Helper()

	data, err := proto.Marshal(&vaultsyncv1.ClientFrame{RequestId: requestID, Frame: &vaultsyncv1.ClientFrame_Subscribe{
		Subscribe: &vaultsyncv1.Subscribe{VaultId: vaultID},
	}})
	require.NoError(client.t, err)

	ctx, cancel := context.WithTimeout(client.t.Context(), realtimeReadTimeout)
	defer cancel()

	require.NoError(client.t, client.conn.Write(ctx, websocket.MessageBinary, data))

	frame := client.read()
	require.Equal(client.t, requestID, frame.GetRequestId())

	return frame
}

func (client *realtimeClient) subscribe(requestID uint64, vaultID string) uint64 {
	client.t.Helper()

	frame := client.send(requestID, vaultID)
	require.NotNil(client.t, frame.GetSubscribed(), "expected subscribed, got %v", frame)

	return frame.GetSubscribed().GetHeadSeq()
}

func requireVaultChanged(t *testing.T, frame *vaultsyncv1.ServerFrame, vaultID string, seq uint64) {
	t.Helper()

	require.NotNil(t, frame.GetVaultChanged(), "expected vault_changed, got %v", frame)
	assert.Equal(t, vaultID, frame.GetVaultChanged().GetVaultId())
	assert.Equal(t, seq, frame.GetVaultChanged().GetSeq())
}

// Criteria 1 and 6: a commit made through one replica reaches subscribers
// connected to every replica, within a second.
func TestRealtimeNotifiesSubscribersOnEveryReplicaAfterACommit(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")

	onFirst := fixture.realtime(t, 0, alice.token)
	onSecond := fixture.realtime(t, 1, fixture.token(t, "alice"))

	assert.Equal(t, uint64(0), onFirst.subscribe(1, alice.vaultID))
	assert.Equal(t, uint64(0), onSecond.subscribe(1, alice.vaultID))

	for replica := range 2 {
		revision, err := alice.commitOn(t, replica, alice.create(t, "note-"+strconv.Itoa(replica)+".md", content))
		require.NoError(t, err)

		committed := time.Now()

		requireVaultChanged(t, onSecond.readWithin(time.Second), alice.vaultID, revision.GetSeq())
		requireVaultChanged(t, onFirst.readWithin(time.Second-time.Since(committed)), alice.vaultID, revision.GetSeq())
	}

	// A late subscriber learns the head_seq when it subscribes.
	late := fixture.realtime(t, 1, alice.token)
	assert.Equal(t, fixture.headSeq(t, alice.vaultID), late.subscribe(9, alice.vaultID))

	// An idempotent retry moves no head and notifies nothing; the next
	// frame is the following commit's.
	request := alice.create(t, "other.md", content)
	first, err := alice.commitOn(t, 0, request)
	require.NoError(t, err)
	requireVaultChanged(t, onSecond.read(), alice.vaultID, first.GetSeq())

	_, err = alice.commitOn(t, 1, request)
	require.NoError(t, err)

	next, err := alice.commitOn(t, 0, alice.create(t, "third.md", content))
	require.NoError(t, err)
	requireVaultChanged(t, onSecond.read(), alice.vaultID, next.GetSeq())
}

// Criterion 3, against PostgreSQL: a non-member is refused exactly like a
// subscription to a vault that does not exist, and never notified.
func TestRealtimeRefusesNonMembersAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")

	mallory := fixture.client(t, "mallory", "")
	mallory.vaultID = fixture.createVault(t, mallory.token, "Mine").GetId()
	malloryContent := mallory.content(t, "m1")
	socket := fixture.realtime(t, 1, mallory.token)

	notMember := socket.send(1, alice.vaultID)
	missing := socket.send(1, newV7(t))

	for _, frame := range []*vaultsyncv1.ServerFrame{notMember, missing} {
		require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
		assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
	}

	assert.Equal(t, notMember.GetError().GetMessage(), missing.GetError().GetMessage())

	socket.subscribe(2, mallory.vaultID)

	alice.mustCommit(t, alice.create(t, "secret.md", content))
	own := mallory.mustCommit(t, mallory.create(t, "mine.md", malloryContent))

	// Commits are delivered in order, so alice's would come first.
	requireVaultChanged(t, socket.read(), mallory.vaultID, own.GetSeq())
}

// Criterion 4: a member removed from a vault stops receiving its
// notifications.
func TestRealtimeStopsNotifyingARemovedMember(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")
	fixture.addMember(t, alice.vaultID, "bob", store.RoleViewer)

	bob := fixture.realtime(t, 1, fixture.token(t, "bob"))
	bob.subscribe(1, alice.vaultID)

	first := alice.mustCommit(t, alice.create(t, "a.md", content))
	requireVaultChanged(t, bob.read(), alice.vaultID, first.GetSeq())

	_, err := fixture.pool.Exec(t.Context(), `DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		alice.vaultID, userID(t, fixture.pool, fixture.issuer.URL, "bob"))
	require.NoError(t, err)

	alice.mustCommit(t, alice.create(t, "b.md", content))

	frame := bob.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
	assert.Equal(t, alice.vaultID, frame.GetError().GetVaultId())

	// Nothing more for that vault: a later frame is the server's answer to
	// a new subscribe, which is refused.
	alice.mustCommit(t, alice.create(t, "c.md", content))

	refused := bob.send(2, alice.vaultID)
	require.NotNil(t, refused.GetError(), "expected an error frame, got %v", refused)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, refused.GetError().GetCode())
}

// Criterion 6: when a replica's LISTEN connection is lost, it reconnects
// and still delivers commits, including one made while it was gone.
func TestRealtimeSurvivesLosingTheListeningConnection(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")

	socket := fixture.realtime(t, 1, alice.token)
	socket.subscribe(1, alice.vaultID)

	var terminated int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `
		SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'listen%'`).Scan(&terminated))
	require.Equal(t, 2, terminated, "each replica holds one listening connection")

	// Made while the listeners may be down; delivered by the reconnect's
	// resync if its NOTIFY was missed.
	missed := alice.mustCommit(t, alice.create(t, "a.md", content))

	frame := socket.read()
	requireVaultChanged(t, frame, alice.vaultID, missed.GetSeq())

	// The resync may repeat the head_seq; skip duplicates.
	later := alice.mustCommit(t, alice.create(t, "b.md", content))

	for {
		frame = socket.read()
		require.NotNil(t, frame.GetVaultChanged(), "expected vault_changed, got %v", frame)

		if frame.GetVaultChanged().GetSeq() == later.GetSeq() {
			break
		}

		require.Equal(t, missed.GetSeq(), frame.GetVaultChanged().GetSeq())
	}
}
