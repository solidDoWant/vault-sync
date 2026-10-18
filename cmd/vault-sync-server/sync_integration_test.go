//go:build integration

package main_test

import (
	"bufio"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/url"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
)

// Helpers for driving revision commits and the change feed (SPEC.md §6)
// against instances, and for observing the shared database underneath them.

func (server *instance) sync() vaultsyncv1connect.SyncServiceClient {
	return vaultsyncv1connect.NewSyncServiceClient(httpClient, server.apiURL)
}

// syncClient is one device of one user, working in one vault. Each request
// goes to whichever instance the test names.
type syncClient struct {
	token    string
	vaultID  string
	deviceID string
}

// newSyncClient registers a device for token's user on server.
func newSyncClient(t *testing.T, server *instance, token, vaultID string) *syncClient {
	t.Helper()

	devices := vaultsyncv1connect.NewDeviceServiceClient(httpClient, server.apiURL)

	response, err := devices.RegisterDevice(t.Context(), authorized(&vaultsyncv1.RegisterDeviceRequest{Name: "laptop"}, token))
	require.NoError(t, err, "register device on %s", server.name)

	return &syncClient{token: token, vaultID: vaultID, deviceID: response.Msg.GetDevice().GetId()}
}

// content uploads data through server as a complete blob and returns its
// reference.
func (client *syncClient) content(t *testing.T, server *instance, data string) *vaultsyncv1.ContentRef {
	t.Helper()

	sum := sha256.Sum256([]byte(data))
	blob := &blobClient{token: client.token, vaultID: client.vaultID, blobID: sum[:], content: []byte(data)}

	_, err := blob.begin(t, server)
	require.NoError(t, err, "begin blob on %s", server.name)
	blob.sendChunks(t, 0, 0, server)

	_, err = blob.commit(t, server)
	require.NoError(t, err, "commit blob on %s", server.name)

	return &vaultsyncv1.ContentRef{BlobId: sum[:], Size: uint64(len(data))}
}

func newV7(t *testing.T) string {
	t.Helper()

	return uuid.Must(uuid.NewV7()).String()
}

// create returns a request creating a new text document.
func (client *syncClient) create(t *testing.T, path string, content *vaultsyncv1.ContentRef) *vaultsyncv1.CommitRevisionRequest {
	t.Helper()

	return &vaultsyncv1.CommitRevisionRequest{
		VaultId:    client.vaultID,
		DocumentId: newV7(t),
		RevisionId: newV7(t),
		Kind:       vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT,
		ContentRef: content,
		Path:       []byte(path),
		DeviceId:   client.deviceID,
	}
}

// next returns a request for a new revision on top of head.
func (client *syncClient) next(t *testing.T, head *vaultsyncv1.Revision, path string, content *vaultsyncv1.ContentRef, deleted bool) *vaultsyncv1.CommitRevisionRequest {
	t.Helper()

	return &vaultsyncv1.CommitRevisionRequest{
		VaultId:    client.vaultID,
		DocumentId: head.GetDocumentId(),
		RevisionId: newV7(t),
		BaseRevId:  head.GetId(),
		Kind:       head.GetKind(),
		ContentRef: content,
		Path:       []byte(path),
		Deleted:    deleted,
		DeviceId:   client.deviceID,
	}
}

func (client *syncClient) commit(t *testing.T, server *instance, request *vaultsyncv1.CommitRevisionRequest) (*vaultsyncv1.Revision, error) {
	t.Helper()

	response, err := server.sync().CommitRevision(t.Context(), authorized(request, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetRevision(), nil
}

func (client *syncClient) mustCommit(t *testing.T, server *instance, request *vaultsyncv1.CommitRevisionRequest) *vaultsyncv1.Revision {
	t.Helper()

	revision, err := client.commit(t, server, request)
	require.NoError(t, err, "commit revision on %s", server.name)

	return revision
}

// changes pages through the whole change feed, pageSize revisions at a time
// (zero: the server default), sending page n to servers[n % len(servers)].
// It returns the revisions and the head_seq of the last page.
func (client *syncClient) changes(t *testing.T, pageSize uint32, servers ...*instance) ([]*vaultsyncv1.Revision, uint64) {
	t.Helper()

	var (
		revisions []*vaultsyncv1.Revision
		since     uint64
	)

	for page := 0; ; page++ {
		server := servers[page%len(servers)]

		response, err := server.sync().ListChanges(t.Context(), authorized(&vaultsyncv1.ListChangesRequest{
			VaultId: client.vaultID, SinceSeq: since, PageSize: pageSize,
		}, client.token))
		require.NoError(t, err, "list changes since %d on %s", since, server.name)

		revisions = append(revisions, response.Msg.GetRevisions()...)

		if !response.Msg.GetHasMore() {
			return revisions, response.Msg.GetHeadSeq()
		}

		require.NotEmpty(t, response.Msg.GetRevisions(), "has_more without revisions on %s", server.name)

		since = revisions[len(revisions)-1].GetSeq()
	}
}

// history pages through a document's history, newest first, sending page n
// to servers[n % len(servers)].
func (client *syncClient) history(t *testing.T, documentID string, pageSize uint32, servers ...*instance) []*vaultsyncv1.Revision {
	t.Helper()

	var (
		revisions []*vaultsyncv1.Revision
		token     string
	)

	for page := 0; ; page++ {
		server := servers[page%len(servers)]

		response, err := server.sync().GetDocumentHistory(t.Context(), authorized(&vaultsyncv1.GetDocumentHistoryRequest{
			VaultId: client.vaultID, DocumentId: documentID, PageSize: pageSize, PageToken: token,
		}, client.token))
		require.NoError(t, err, "document history on %s", server.name)
		require.Equal(t, documentID, response.Msg.GetDocument().GetId())

		revisions = append(revisions, response.Msg.GetRevisions()...)

		token = response.Msg.GetNextPageToken()
		if token == "" {
			return revisions
		}
	}
}

func (client *syncClient) revision(t *testing.T, server *instance, revisionID string) *vaultsyncv1.Revision {
	t.Helper()

	response, err := server.sync().GetRevision(t.Context(), authorized(&vaultsyncv1.GetRevisionRequest{
		VaultId: client.vaultID, RevisionId: revisionID,
	}, client.token))
	require.NoError(t, err, "get revision on %s", server.name)

	return response.Msg.GetRevision()
}

// headSeq returns the vault's head_seq as server's ListVaults reports it.
func (client *syncClient) headSeq(t *testing.T, server *instance) uint64 {
	t.Helper()

	response, err := server.vaults().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, client.token))
	require.NoError(t, err, "list vaults on %s", server.name)

	for _, vault := range response.Msg.GetVaults() {
		if vault.GetId() == client.vaultID {
			return vault.GetHeadSeq()
		}
	}

	require.Failf(t, "vault not listed", "%s does not list vault %s", server.name, client.vaultID)

	return 0
}

// requireSameRevisions checks that got equals want, revision by revision.
func requireSameRevisions(t *testing.T, want, got []*vaultsyncv1.Revision, format string, arguments ...any) {
	t.Helper()

	what := fmt.Sprintf(format, arguments...)

	require.Equal(t, revisionIDs(want), revisionIDs(got), "%s: revision ids", what)

	for index := range want {
		require.Truef(t, proto.Equal(want[index], got[index]), "%s: revision %d differs:\nwant %v\ngot  %v",
			what, index, want[index], got[index])
	}
}

func revisionIDs(revisions []*vaultsyncv1.Revision) []string {
	ids := make([]string, 0, len(revisions))
	for _, revision := range revisions {
		ids = append(ids, revision.GetId())
	}

	return ids
}

// requireGapless checks that changes, the whole change feed, has seqs
// 1, 2, ... and that headSeq is the last of them.
func requireGapless(t *testing.T, changes []*vaultsyncv1.Revision, headSeq uint64) {
	t.Helper()

	seqs := make([]uint64, 0, len(changes))
	want := make([]uint64, 0, len(changes))

	for index, revision := range changes {
		seqs = append(seqs, revision.GetSeq())
		want = append(want, uint64(index+1))
	}

	require.Equal(t, want, seqs, "seqs are gapless")
	require.Equal(t, uint64(len(changes)), headSeq, "head_seq is the last seq")
}

// headMovedTo returns the head_rev_id in a FAILED_PRECONDITION error's
// Document detail.
func headMovedTo(t *testing.T, err error) string {
	t.Helper()

	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	require.Equal(t, connect.CodeFailedPrecondition, connectErr.Code(), "%v", err)

	for _, detail := range connectErr.Details() {
		value, err := detail.Value()
		require.NoError(t, err)

		if document, ok := value.(*vaultsyncv1.Document); ok {
			return document.GetHeadRevId()
		}
	}

	require.Fail(t, "no Document detail", "%v", err)

	return ""
}

// sendCommit sends request to server as a Connect unary call on a raw
// connection and returns without reading the response, so the test decides
// when, or whether, the client sees one.
func sendCommit(t *testing.T, server *instance, token string, request *vaultsyncv1.CommitRevisionRequest) net.Conn {
	t.Helper()

	body, err := proto.Marshal(request)
	require.NoError(t, err)

	address, err := url.Parse(server.apiURL)
	require.NoError(t, err)

	conn, err := net.Dial("tcp", address.Host)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	_, err = fmt.Fprintf(conn, "POST /%s/CommitRevision HTTP/1.1\r\nHost: vault-sync\r\n"+
		"Authorization: Bearer %s\r\nContent-Type: application/proto\r\nConnect-Protocol-Version: 1\r\nContent-Length: %d\r\n\r\n",
		vaultsyncv1connect.SyncServiceName, token, len(body))
	require.NoError(t, err)

	_, err = conn.Write(body)
	require.NoError(t, err)

	return conn
}

// requireNoAnswer checks that the server end of conn closed without sending
// anything.
func requireNoAnswer(t *testing.T, conn net.Conn) {
	t.Helper()

	require.NoError(t, conn.SetReadDeadline(time.Now().Add(30*time.Second)))

	_, err := bufio.NewReader(conn).ReadByte()
	require.Error(t, err, "the killed instance never answers")

	var timeout net.Error
	require.False(t, errors.As(err, &timeout) && timeout.Timeout(), "the connection must be closed, not idle: %v", err)
}

// connectDatabase opens a session of the test's own on the deployment's
// database.
func (cluster *deployment) connectDatabase(t *testing.T) *pgx.Conn {
	t.Helper()

	conn, err := pgx.Connect(t.Context(), cluster.database.DSN)
	require.NoError(t, err)

	t.Cleanup(func() { _ = conn.Close(t.Context()) })

	return conn
}

func backendPID(t *testing.T, conn *pgx.Conn) uint32 {
	t.Helper()

	var pid uint32

	require.NoError(t, conn.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&pid))

	return pid
}

// blockedBackend waits until exactly one PostgreSQL backend is waiting for a
// lock that the session with pid blocker holds, and returns that backend's
// pid.
func blockedBackend(t *testing.T, database *pgx.Conn, blocker uint32) uint32 {
	t.Helper()

	deadline := time.Now().Add(time.Minute)

	for {
		rows, err := database.Query(t.Context(), `
			SELECT pid FROM pg_stat_activity WHERE $1::integer = ANY (pg_blocking_pids(pid))`, blocker)
		require.NoError(t, err)

		blocked, err := pgx.CollectRows(rows, pgx.RowTo[uint32])
		require.NoError(t, err)
		require.LessOrEqual(t, len(blocked), 1, "only the commit under test may wait for the lock")

		if len(blocked) == 1 {
			return blocked[0]
		}

		require.True(t, time.Now().Before(deadline), "the commit must reach the lock the test holds")
		time.Sleep(pollInterval)
	}
}

// pollInterval is how often the tests poll PostgreSQL's view of sessions.
const pollInterval = 5 * time.Millisecond

// waitBackendGone waits until the PostgreSQL backend pid has ended, so the
// transaction it ran is finished one way or the other.
func waitBackendGone(t *testing.T, database *pgx.Conn, pid uint32) {
	t.Helper()

	deadline := time.Now().Add(time.Minute)

	for {
		var exists bool

		err := database.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::integer)`, pid).Scan(&exists)
		require.NoError(t, err)

		if !exists {
			return
		}

		require.True(t, time.Now().Before(deadline), "the killed instance's database session must end")
		time.Sleep(pollInterval)
	}
}
