//go:build integration

package server_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// syncFixture serves the full API from two server replicas that share one
// PostgreSQL database and one S3 bucket, each with its own connection pool,
// as in a multi-replica deployment. Neither holds client state, so a client
// may use either for any call.
type syncFixture struct {
	*blobFixture

	replicas []*runningServer
	// hubs are the replicas' realtime hubs, by replica.
	hubs []*realtime.Hub
}

// newSyncFixture starts two server replicas on one database; configure
// adjusts each replica's SyncService.
func newSyncFixture(t *testing.T, limits api.SyncLimits, configure ...func(*api.SyncService)) *syncFixture {
	t.Helper()

	pool := migratedPool(t)

	objects, err := blobstore.New(testinfra.S3Bucket(t))
	require.NoError(t, err)

	issuer := authtest.NewIssuer(t)
	fixture := &authFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), logs: &syncBuffer{}}
	logger := slog.New(slog.NewJSONHandler(fixture.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	syncFix := &syncFixture{}

	for replica := range 2 {
		replicaPool := pool
		if replica > 0 {
			replicaPool, err = pgxpool.NewWithConfig(t.Context(), pool.Config())
			require.NoError(t, err)
			t.Cleanup(replicaPool.Close)
		}

		queries := store.New(replicaPool)
		verifier := auth.NewVerifier(auth.VerifierOptions{IssuerURL: issuer.URL, Audience: authtest.DefaultAudience, Logger: logger})

		authenticator := auth.NewAuthenticator(verifier, queries)
		hub := realtime.NewHub(realtime.Options{
			Authenticator:  authenticator,
			Store:          queries,
			AllowedOrigins: server.AllowedOrigins,
			Logger:         logger,
		})
		syncFix.hubs = append(syncFix.hubs, hub)

		hubCtx, stopHub := context.WithCancel(context.WithoutCancel(t.Context()))
		hubDone := make(chan struct{})

		go func() {
			defer close(hubDone)

			hub.Run(hubCtx)
		}()

		// Registered before the server's cleanup, so it runs after the
		// server (and its drain) stopped.
		t.Cleanup(func() {
			stopHub()
			<-hubDone
		})

		syncService := &api.SyncService{Store: queries, Limits: limits}
		for _, adjust := range configure {
			adjust(syncService)
		}

		syncFix.replicas = append(syncFix.replicas, startServer(t, server.Options{
			MaxRequestBytes: config.DefaultMaxRequestBytes,
			Database:        replicaPool,
			Authenticator:   authenticator,
			Devices:         queries,
			Vaults:          queries,
			Memberships:     queries,
			Membership:      &api.MembershipService{Store: queries},
			UserKeys:        &api.UserKeyService{Store: queries},
			VaultKeys:       &api.VaultKeyService{Keys: api.KeysOf(queries)},
			Sync:            syncService,
			Blobs:           &api.BlobService{Store: queries, Objects: objects, Limits: defaultBlobLimits},
			Realtime:        hub,
			Logger:          logger,
		}))
	}

	fixture.running = syncFix.replicas[0]
	syncFix.blobFixture = &blobFixture{authFixture: fixture, pool: pool, objects: objects, limits: defaultBlobLimits}

	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server logs:\n%s", fixture.logs.String())
		}
	})

	return syncFix
}

// syncClient is one device of one user, working in one vault.
type syncClient struct {
	fixture  *syncFixture
	token    string
	vaultID  string
	deviceID string
}

func (fixture *syncFixture) client(t *testing.T, subject, vaultID string) *syncClient {
	t.Helper()

	token := fixture.token(t, subject)
	device, err := fixture.registerDevice(t, token, &vaultsyncv1.RegisterDeviceRequest{Name: subject + "'s laptop"})
	require.NoError(t, err)

	return &syncClient{fixture: fixture, token: token, vaultID: vaultID, deviceID: device.GetId()}
}

// in returns the client working in another vault.
func (client *syncClient) in(vaultID string) *syncClient {
	moved := *client
	moved.vaultID = vaultID

	return &moved
}

func (client *syncClient) sync(replica int) vaultsyncv1connect.SyncServiceClient {
	return vaultsyncv1connect.NewSyncServiceClient(http.DefaultClient, client.fixture.replicas[replica%len(client.fixture.replicas)].apiURL())
}

// content uploads data as a complete blob and returns its reference.
func (client *syncClient) content(t *testing.T, data string) *vaultsyncv1.ContentRef {
	t.Helper()

	blobID := blobIDOf([]byte(data))
	require.NoError(t, client.fixture.upload(t, client.token, client.vaultID, blobID, []byte(data)))

	return &vaultsyncv1.ContentRef{BlobId: blobID, Size: uint64(len(data))}
}

func newV7(t *testing.T) string {
	t.Helper()

	return uuid.Must(uuid.NewV7()).String()
}

// create returns a request creating a new text document at path.
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

func (client *syncClient) commitOn(t *testing.T, replica int, request *vaultsyncv1.CommitRevisionRequest) (*vaultsyncv1.Revision, error) {
	t.Helper()

	response, err := client.sync(replica).CommitRevision(t.Context(), authorized(request, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetRevision(), nil
}

func (client *syncClient) commit(t *testing.T, request *vaultsyncv1.CommitRevisionRequest) (*vaultsyncv1.Revision, error) {
	t.Helper()

	return client.commitOn(t, 0, request)
}

func (client *syncClient) mustCommit(t *testing.T, request *vaultsyncv1.CommitRevisionRequest) *vaultsyncv1.Revision {
	t.Helper()

	revision, err := client.commit(t, request)
	require.NoError(t, err)

	return revision
}

func (client *syncClient) changes(t *testing.T, since uint64, pageSize uint32) (*vaultsyncv1.ListChangesResponse, error) {
	t.Helper()

	response, err := client.sync(0).ListChanges(t.Context(), authorized(&vaultsyncv1.ListChangesRequest{
		VaultId: client.vaultID, SinceSeq: since, PageSize: pageSize,
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// allChanges pages through the change feed after since.
func (client *syncClient) allChanges(t *testing.T, since uint64, pageSize uint32) []*vaultsyncv1.Revision {
	t.Helper()

	var revisions []*vaultsyncv1.Revision

	for {
		page, err := client.changes(t, since, pageSize)
		require.NoError(t, err)

		revisions = append(revisions, page.GetRevisions()...)

		if !page.GetHasMore() {
			return revisions
		}

		require.NotEmpty(t, page.GetRevisions(), "has_more without revisions")
		since = page.GetRevisions()[len(page.GetRevisions())-1].GetSeq()
	}
}

func (client *syncClient) revision(t *testing.T, revisionID string) (*vaultsyncv1.Revision, error) {
	t.Helper()

	response, err := client.sync(0).GetRevision(t.Context(), authorized(&vaultsyncv1.GetRevisionRequest{
		VaultId: client.vaultID, RevisionId: revisionID,
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetRevision(), nil
}

func (client *syncClient) historyPage(t *testing.T, documentID string, pageSize uint32, pageToken string) (*vaultsyncv1.GetDocumentHistoryResponse, error) {
	t.Helper()

	response, err := client.sync(0).GetDocumentHistory(t.Context(), authorized(&vaultsyncv1.GetDocumentHistoryRequest{
		VaultId: client.vaultID, DocumentId: documentID, PageSize: pageSize, PageToken: pageToken,
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// history returns every revision of a document, newest first.
func (client *syncClient) history(t *testing.T, documentID string) []*vaultsyncv1.Revision {
	t.Helper()

	var revisions []*vaultsyncv1.Revision

	pageToken := ""

	for {
		page, err := client.historyPage(t, documentID, 0, pageToken)
		require.NoError(t, err)

		revisions = append(revisions, page.GetRevisions()...)

		pageToken = page.GetNextPageToken()
		if pageToken == "" {
			return revisions
		}
	}
}

func revisionIDs(revisions []*vaultsyncv1.Revision) []string {
	ids := make([]string, 0, len(revisions))
	for _, revision := range revisions {
		ids = append(ids, revision.GetId())
	}

	return ids
}

func (fixture *syncFixture) headSeq(t *testing.T, vaultID string) uint64 {
	t.Helper()

	var headSeq uint64

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT head_seq FROM vaults WHERE id = $1`, vaultID).Scan(&headSeq))

	return headSeq
}

func (fixture *syncFixture) count(t *testing.T, table, vaultID string) int {
	t.Helper()

	var count int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table+` WHERE vault_id = $1`, vaultID).Scan(&count))

	return count
}

// requireDocumentMirrorsHead checks that the documents row of documentID
// matches its head revision: head_rev_id is its latest revision, and
// path_key and deleted are derived from that revision.
func (fixture *syncFixture) requireDocumentMirrorsHead(t *testing.T, documentID string, wantHead *vaultsyncv1.Revision) {
	t.Helper()

	var (
		headRevID, latestRevID   string
		pathKey, headPath        string
		deleted, headDeleted     bool
		documentVault, headVault string
	)

	err := fixture.pool.QueryRow(t.Context(), `
		SELECT d.head_rev_id, d.path_key, d.deleted, d.vault_id, r.path, r.deleted, r.vault_id,
			(SELECT id FROM revisions WHERE document_id = d.id ORDER BY seq DESC LIMIT 1)
		FROM documents d JOIN revisions r ON r.id = d.head_rev_id
		WHERE d.id = $1`, documentID).
		Scan(&headRevID, &pathKey, &deleted, &documentVault, &headPath, &headDeleted, &headVault, &latestRevID)
	require.NoError(t, err)

	assert.Equal(t, wantHead.GetId(), headRevID, "head_rev_id")
	assert.Equal(t, latestRevID, headRevID, "the head is the document's latest revision")
	assert.Equal(t, headDeleted, deleted, "documents.deleted mirrors the head revision")
	assert.Equal(t, pathkey.Key(headPath), pathKey, "documents.path_key is derived from the head revision's path")
	assert.Equal(t, string(wantHead.GetPath()), headPath)
	assert.Equal(t, headVault, documentVault)
}

// headMovedTo returns the head_rev_id in a FAILED_PRECONDITION error's
// Document detail.
func headMovedTo(t *testing.T, err error) string {
	t.Helper()

	requireCode(t, connect.CodeFailedPrecondition, err)

	var connectErr *connect.Error
	require.True(t, errors.As(err, &connectErr))

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

// Criterion 1: of concurrent commits on the same base, on different
// replicas, exactly one succeeds; the others get FAILED_PRECONDITION
// carrying the winner as the current head.
func TestConcurrentCommitsOnTheSameBase(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")

	first := alice.mustCommit(t, alice.create(t, "note.md", content))

	const writers = 8

	type outcome struct {
		revision *vaultsyncv1.Revision
		err      error
	}

	outcomes := make([]outcome, writers)
	requests := make([]*vaultsyncv1.CommitRevisionRequest, writers)

	for writer := range writers {
		requests[writer] = alice.next(t, first, fmt.Sprintf("renamed-%d.md", writer), content, false)
	}

	var (
		wait  sync.WaitGroup
		start = make(chan struct{})
	)

	for writer := range writers {
		wait.Go(func() {
			<-start

			revision, err := alice.commitOn(t, writer, requests[writer])
			outcomes[writer] = outcome{revision: revision, err: err}
		})
	}

	close(start)
	wait.Wait()

	var winner *vaultsyncv1.Revision

	for _, outcome := range outcomes {
		if outcome.err == nil {
			require.Nil(t, winner, "more than one concurrent commit on the same base succeeded")
			winner = outcome.revision
		}
	}

	require.NotNil(t, winner, "one commit succeeds")

	for _, outcome := range outcomes {
		if outcome.err != nil {
			assert.Equal(t, winner.GetId(), headMovedTo(t, outcome.err), "the error names the current head")
		}
	}

	assert.Equal(t, []string{winner.GetId(), first.GetId()}, revisionIDs(alice.history(t, first.GetDocumentId())))
	assert.Equal(t, uint64(2), fixture.headSeq(t, alice.vaultID))
	fixture.requireDocumentMirrorsHead(t, first.GetDocumentId(), winner)

	// A commit based on the old head now also fails, and one based on an
	// empty base (as if the document were new) too.
	_, err := alice.commit(t, alice.next(t, first, "late.md", content, false))
	assert.Equal(t, winner.GetId(), headMovedTo(t, err))

	stale := alice.next(t, first, "late.md", content, false)
	stale.BaseRevId = ""
	_, err = alice.commit(t, stale)
	assert.Equal(t, winner.GetId(), headMovedTo(t, err))

	// Basing on the current head succeeds.
	alice.mustCommit(t, alice.next(t, winner, "late.md", content, false))
}

// Criterion 2: seqs are strictly increasing and gapless per vault, also
// under concurrent commits on several replicas, and ListChanges returns
// exactly the revisions after a cursor, in order.
func TestSeqIsGaplessAndListChangesPagesInOrder(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{MaxChangesPageSize: 10})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	other := alice.in(fixture.createVault(t, alice.token, "Other").GetId())
	content := alice.content(t, "shared")
	otherContent := other.content(t, "shared")

	const commits = 36

	committed := make([]*vaultsyncv1.Revision, commits)

	var wait sync.WaitGroup

	for index := range commits {
		wait.Go(func() {
			// Interleave commits to another vault, whose seqs are
			// independent.
			if index%4 == 0 {
				_, err := other.commitOn(t, index, other.create(t, fmt.Sprintf("other-%d.md", index), otherContent))
				assert.NoError(t, err)
			}

			revision, err := alice.commitOn(t, index, alice.create(t, fmt.Sprintf("note-%d.md", index), content))
			if assert.NoError(t, err) {
				committed[index] = revision
			}
		})
	}

	wait.Wait()
	require.False(t, t.Failed())

	seqs := make([]uint64, 0, commits)
	for _, revision := range committed {
		seqs = append(seqs, revision.GetSeq())
	}

	slices.Sort(seqs)

	for index, seq := range seqs {
		require.Equal(t, uint64(index+1), seq, "seqs are 1..n without gaps or duplicates")
	}

	assert.Equal(t, uint64(commits), fixture.headSeq(t, alice.vaultID))

	slices.SortFunc(committed, func(a, b *vaultsyncv1.Revision) int { return int(a.GetSeq()) - int(b.GetSeq()) })

	for _, pageSize := range []uint32{0, 1, 7, 10, 1000} {
		t.Run(fmt.Sprintf("page size %d", pageSize), func(t *testing.T) {
			for _, since := range []uint64{0, 1, 13, commits - 1, commits, commits + 5} {
				want := []string{}
				if since < commits {
					want = revisionIDs(committed[since:])
				}

				got := alice.allChanges(t, since, pageSize)
				assert.Equal(t, want, append([]string{}, revisionIDs(got)...), "since %d", since)

				for index := 1; index < len(got); index++ {
					assert.Greater(t, got[index].GetSeq(), got[index-1].GetSeq())
				}
			}
		})
	}

	// Pages are capped by the server; zero selects the default (above the
	// cap here), and the head_seq comes with every page.
	for _, pageSize := range []uint32{0, 10, 11, 1000, ^uint32(0)} {
		page, err := alice.changes(t, 0, pageSize)
		require.NoError(t, err)
		assert.Len(t, page.GetRevisions(), 10, "page size %d", pageSize)
		assert.True(t, page.GetHasMore())
		assert.Equal(t, uint64(commits), page.GetHeadSeq())
	}

	page, err := alice.changes(t, 0, 3)
	require.NoError(t, err)
	assert.Len(t, page.GetRevisions(), 3)

	page, err = alice.changes(t, commits-1, 0)
	require.NoError(t, err)
	assert.Len(t, page.GetRevisions(), 1)
	assert.False(t, page.GetHasMore())

	// Revisions in the feed are complete.
	feedRevision := alice.allChanges(t, 0, 0)[0]
	assert.Equal(t, alice.vaultID, feedRevision.GetVaultId())
	assert.Equal(t, alice.deviceID, feedRevision.GetDeviceId())
	assert.Equal(t, content.GetBlobId(), feedRevision.GetContentRef().GetBlobId())
	assert.Equal(t, content.GetSize(), feedRevision.GetContentRef().GetSize())
	assert.Equal(t, vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT, feedRevision.GetKind())
	assert.NotEmpty(t, feedRevision.GetUserId())
	assert.NotNil(t, feedRevision.GetCreateTime())

	// The other vault's feed is its own.
	otherFeed := other.allChanges(t, 0, 0)
	assert.Len(t, otherFeed, commits/4)
	assert.Equal(t, uint64(1), otherFeed[0].GetSeq())
}

// Criterion 3: a new document whose normalized path equals a live
// document's fails with ALREADY_EXISTS.
func TestPathKeyCollisions(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	tests := []struct {
		name            string
		existing, other string
		collide         bool
	}{
		{name: "NFD and NFC", existing: "Café.md", other: "café.md", collide: true},
		{name: "NFC and NFD", existing: "café.md", other: "CAFÉ.md", collide: true},
		{name: "identical", existing: "note.md", other: "note.md", collide: true},
		{name: "ASCII case", existing: "Notes/Todo.md", other: "notes/TODO.MD", collide: true},
		{name: "German sharp s", existing: "Straße.md", other: "STRASSE.md", collide: true},
		{name: "Turkish dotted capital I", existing: "İstanbul.md", other: "i̇stanbul.md", collide: true},
		{name: "Turkish dotless i takes the key of I (NTFS upcase)", existing: "ıx.md", other: "Ix.md", collide: true},
		{name: "Turkish dotless i takes the key of i", existing: "ıy.md", other: "iy.md", collide: true},
		{name: "full-width letters fold among themselves", existing: "Ｎｏｔｅ.md", other: "ｎｏｔｅ.md", collide: true},
		{name: "full-width letters are distinct from ASCII", existing: "Ｎｏｔｅ.md", other: "Note.md", collide: false},
		{name: "different names", existing: "a.md", other: "b.md", collide: false},
		{name: "whitespace is significant", existing: "a b.md", other: "a  b.md", collide: false},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := fmt.Sprintf("case-%d/", index)
			alice.mustCommit(t, alice.create(t, directory+test.existing, content))

			before := fixture.headSeq(t, alice.vaultID)
			_, err := alice.commit(t, alice.create(t, directory+test.other, content))

			if !test.collide {
				require.NoError(t, err)

				return
			}

			requireCode(t, connect.CodeAlreadyExists, err)
			assert.Equal(t, before, fixture.headSeq(t, alice.vaultID), "nothing is committed")
		})
	}

	// Renaming onto a live document's path collides too, but changing only
	// the case of one's own path does not.
	taken := alice.mustCommit(t, alice.create(t, "taken.md", content))
	mover := alice.mustCommit(t, alice.create(t, "mover.md", content))

	_, err := alice.commit(t, alice.next(t, mover, "TAKEN.md", content, false))
	requireCode(t, connect.CodeAlreadyExists, err)
	fixture.requireDocumentMirrorsHead(t, mover.GetDocumentId(), mover)

	recased := alice.mustCommit(t, alice.next(t, taken, "Taken.md", content, false))
	fixture.requireDocumentMirrorsHead(t, taken.GetDocumentId(), recased)
}

// Criterion 4: a delete is a tombstone revision; earlier content stays
// retrievable through history, and the path becomes free.
func TestDeleteIsATombstone(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	v1, v2, v3 := alice.content(t, "version 1"), alice.content(t, "version 2"), alice.content(t, "version 3")

	created := alice.mustCommit(t, alice.create(t, "Diary.md", v1))
	edited := alice.mustCommit(t, alice.next(t, created, "Diary.md", v2, false))
	deleted := alice.mustCommit(t, alice.next(t, edited, "Diary.md", v2, true))

	assert.True(t, deleted.GetDeleted())
	assert.Equal(t, created.GetDocumentId(), deleted.GetDocumentId())
	assert.Equal(t, edited.GetId(), deleted.GetParentRevId())
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), deleted)

	// Nothing is erased: every revision, with its content, is in history.
	history := alice.history(t, created.GetDocumentId())
	assert.Equal(t, []string{deleted.GetId(), edited.GetId(), created.GetId()}, revisionIDs(history))

	for _, revision := range []*vaultsyncv1.Revision{created, edited} {
		got, err := alice.revision(t, revision.GetId())
		require.NoError(t, err)
		assert.False(t, got.GetDeleted())
		assert.Equal(t, revision.GetContentRef().GetBlobId(), got.GetContentRef().GetBlobId())
	}

	assert.Equal(t, v1.GetBlobId(), history[2].GetContentRef().GetBlobId())
	assert.Contains(t, revisionIDs(alice.allChanges(t, 0, 0)), deleted.GetId(), "the tombstone is in the change feed")

	// The path is free for a new document.
	replacement := alice.mustCommit(t, alice.create(t, "diary.md", v3))
	assert.NotEqual(t, created.GetDocumentId(), replacement.GetDocumentId())

	// So the deleted document cannot be restored at its old path while the
	// new one lives there, but it can be under another name.
	_, err := alice.commit(t, alice.next(t, deleted, "Diary.md", v2, false))
	requireCode(t, connect.CodeAlreadyExists, err)
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), deleted)

	restored := alice.mustCommit(t, alice.next(t, deleted, "Diary (restored).md", v2, false))
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), restored)

	// Deleting a deleted document's replacement frees the path again.
	gone := alice.mustCommit(t, alice.next(t, replacement, "diary.md", v3, true))
	fixture.requireDocumentMirrorsHead(t, replacement.GetDocumentId(), gone)
	alice.mustCommit(t, alice.create(t, "DIARY.md", v1))
}

// Criterion 5: a rename keeps the document id and changes only the path.
func TestRenameKeepsTheDocumentID(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	created := alice.mustCommit(t, alice.create(t, "inbox/idea.md", content))
	renamed := alice.mustCommit(t, alice.next(t, created, "projects/Idea.md", content, false))

	assert.Equal(t, created.GetDocumentId(), renamed.GetDocumentId())
	assert.Equal(t, "projects/Idea.md", string(renamed.GetPath()))
	assert.Equal(t, created.GetContentRef().GetBlobId(), renamed.GetContentRef().GetBlobId())
	assert.Equal(t, created.GetKind(), renamed.GetKind())
	assert.False(t, renamed.GetDeleted())
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), renamed)

	history, err := alice.historyPage(t, created.GetDocumentId(), 0, "")
	require.NoError(t, err)
	assert.Equal(t, created.GetDocumentId(), history.GetDocument().GetId())
	assert.Equal(t, renamed.GetId(), history.GetDocument().GetHeadRevId())
	assert.Equal(t, []string{renamed.GetId(), created.GetId()}, revisionIDs(history.GetRevisions()))
	assert.Equal(t, "inbox/idea.md", string(history.GetRevisions()[1].GetPath()))

	// The old path is free.
	alice.mustCommit(t, alice.create(t, "Inbox/Idea.md", content))
}

// Criterion 6: a commit must reference a blob that is complete in the same
// vault, with its stored size.
func TestCommitRequiresACompleteBlobInTheSameVault(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	other := alice.in(fixture.createVault(t, alice.token, "Other").GetId())

	otherVaultContent := other.content(t, "only in the other vault")

	uploading := []byte("upload in progress")
	_, err := fixture.begin(t, alice.token, alice.vaultID, blobIDOf(uploading), len(uploading))
	require.NoError(t, err)

	complete := alice.content(t, "complete")

	tests := []struct {
		name    string
		content *vaultsyncv1.ContentRef
		code    connect.Code
	}{
		{name: "never uploaded", content: &vaultsyncv1.ContentRef{BlobId: blobIDOf([]byte("nothing")), Size: 7}, code: connect.CodeFailedPrecondition},
		{name: "upload in progress", content: &vaultsyncv1.ContentRef{BlobId: blobIDOf(uploading), Size: uint64(len(uploading))}, code: connect.CodeFailedPrecondition},
		{name: "complete in another vault", content: otherVaultContent, code: connect.CodeFailedPrecondition},
		{name: "size claim too large", content: &vaultsyncv1.ContentRef{BlobId: complete.GetBlobId(), Size: complete.GetSize() + 1}, code: connect.CodeInvalidArgument},
		{name: "size claim too small", content: &vaultsyncv1.ContentRef{BlobId: complete.GetBlobId(), Size: 0}, code: connect.CodeInvalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := alice.commit(t, alice.create(t, "note.md", test.content))
			requireCode(t, test.code, err)

			assert.Zero(t, fixture.headSeq(t, alice.vaultID))
			assert.Zero(t, fixture.count(t, "documents", alice.vaultID))
			assert.Zero(t, fixture.count(t, "revisions", alice.vaultID))
		})
	}

	// The same applies to later revisions, including tombstones.
	created := alice.mustCommit(t, alice.create(t, "note.md", complete))
	assert.Equal(t, complete.GetSize(), created.GetContentRef().GetSize(), "the stored size is returned")

	for _, deleted := range []bool{false, true} {
		_, err := alice.commit(t, alice.next(t, created, "note.md", otherVaultContent, deleted))
		requireCode(t, connect.CodeFailedPrecondition, err)
	}

	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), created)
}

// Criterion 7: a commit retried with the same revision id returns the
// committed revision instead of a duplicate, even after the head moved.
func TestCommitIsIdempotentByRevisionID(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	bob := fixture.client(t, "bob", alice.vaultID)
	fixture.addMember(t, alice.vaultID, "bob", store.RoleEditor)
	v1, v2, v3 := alice.content(t, "one"), alice.content(t, "two"), alice.content(t, "three")

	createRequest := alice.create(t, "note.md", v1)
	created := alice.mustCommit(t, createRequest)

	retried, err := alice.commitOn(t, 1, createRequest)
	require.NoError(t, err)
	assert.Equal(t, created.GetId(), retried.GetId())
	assert.Equal(t, created.GetSeq(), retried.GetSeq())
	assert.Equal(t, uint64(1), fixture.headSeq(t, alice.vaultID), "a retry commits nothing")

	// The response to alice's edit is lost; bob then commits on top of it;
	// alice's retry, whose base is no longer the head, still gets her
	// revision back rather than FAILED_PRECONDITION.
	lostRequest := alice.next(t, created, "note.md", v2, false)
	lost := alice.mustCommit(t, lostRequest)

	bobs, err := bob.commitOn(t, 1, bob.next(t, lost, "note.md", v3, false))
	require.NoError(t, err)

	retried, err = alice.commit(t, lostRequest)
	require.NoError(t, err, "a retry after the head moved is not a conflict")
	assert.Equal(t, lost.GetId(), retried.GetId())
	assert.Equal(t, lost.GetSeq(), retried.GetSeq())
	assert.Equal(t, created.GetId(), retried.GetParentRevId())

	assert.Equal(t, []string{bobs.GetId(), lost.GetId(), created.GetId()}, revisionIDs(alice.history(t, created.GetDocumentId())))
	assert.Equal(t, uint64(3), fixture.headSeq(t, alice.vaultID))
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), bobs)

	// Reusing a revision id with different fields is an error, not a retry.
	changes := map[string]func(request *vaultsyncv1.CommitRevisionRequest){
		"path":    func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("other.md") },
		"content": func(request *vaultsyncv1.CommitRevisionRequest) { request.ContentRef = v3 },
		"deleted": func(request *vaultsyncv1.CommitRevisionRequest) { request.Deleted = true },
		"base":    func(request *vaultsyncv1.CommitRevisionRequest) { request.BaseRevId = bobs.GetId() },
		"kind": func(request *vaultsyncv1.CommitRevisionRequest) {
			request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		},
		"document": func(request *vaultsyncv1.CommitRevisionRequest) {
			request.DocumentId = newV7(t)
			request.BaseRevId = ""
		},
		"device": func(request *vaultsyncv1.CommitRevisionRequest) {
			request.DeviceId = fixture.client(t, "alice", alice.vaultID).deviceID
		},
	}

	for name, change := range changes {
		t.Run("different "+name, func(t *testing.T) {
			request := alice.next(t, created, "note.md", v2, false)
			request.RevisionId = lost.GetId()
			change(request)

			_, err := alice.commit(t, request)
			requireCode(t, connect.CodeInvalidArgument, err)
		})
	}

	// Another member replaying alice's request with bob's own device is
	// different fields too.
	replayed := alice.next(t, created, "note.md", v2, false)
	replayed.RevisionId = lost.GetId()
	replayed.DeviceId = bob.deviceID
	_, err = bob.commit(t, replayed)
	requireCode(t, connect.CodeInvalidArgument, err)

	// Concurrent identical submissions commit once.
	concurrentRequest := alice.next(t, bobs, "note.md", v1, false)

	const attempts = 6

	results := make([]*vaultsyncv1.Revision, attempts)

	var wait sync.WaitGroup

	for attempt := range attempts {
		wait.Go(func() {
			revision, err := alice.commitOn(t, attempt, concurrentRequest)
			if assert.NoError(t, err) {
				results[attempt] = revision
			}
		})
	}

	wait.Wait()
	require.False(t, t.Failed())

	for _, result := range results {
		assert.Equal(t, results[0].GetId(), result.GetId())
		assert.Equal(t, results[0].GetSeq(), result.GetSeq())
	}

	assert.Equal(t, uint64(4), fixture.headSeq(t, alice.vaultID))
	assert.Len(t, alice.history(t, created.GetDocumentId()), 4)
}

// Ids from another vault are not found even by a member of both vaults, and
// commits naming them never touch the other vault (#10, criterion 5).
func TestIDsFromAnotherVaultAreRejected(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	other := alice.in(fixture.createVault(t, alice.token, "Other").GetId())
	content := alice.content(t, "content")
	otherContent := other.content(t, "content")

	alice.mustCommit(t, alice.create(t, "mine.md", content))
	foreign := other.mustCommit(t, other.create(t, "theirs.md", otherContent))
	otherHeadSeq := fixture.headSeq(t, other.vaultID)

	_, err := alice.revision(t, foreign.GetId())
	requireCode(t, connect.CodeNotFound, err)
	assert.NotContains(t, err.Error(), "vault not found", "the vault was authorized; the revision is not in it")

	_, err = alice.historyPage(t, foreign.GetDocumentId(), 0, "")
	requireCode(t, connect.CodeNotFound, err)

	// Appending to the other vault's document through this vault: the
	// document does not exist here.
	_, err = alice.commit(t, alice.next(t, foreign, "theirs.md", content, false))
	requireCode(t, connect.CodeFailedPrecondition, err)

	// Creating a document with the other vault's document id, or a
	// revision with its revision id.
	takenDocument := alice.create(t, "new.md", content)
	takenDocument.DocumentId = foreign.GetDocumentId()
	_, err = alice.commit(t, takenDocument)
	requireCode(t, connect.CodeInvalidArgument, err)

	takenRevision := alice.create(t, "new.md", content)
	takenRevision.RevisionId = foreign.GetId()
	_, err = alice.commit(t, takenRevision)
	requireCode(t, connect.CodeInvalidArgument, err)

	assert.NotContains(t, revisionIDs(alice.allChanges(t, 0, 0)), foreign.GetId())

	// The other vault is untouched.
	assert.Equal(t, otherHeadSeq, fixture.headSeq(t, other.vaultID))
	assert.Equal(t, []string{foreign.GetId()}, revisionIDs(other.history(t, foreign.GetDocumentId())))
	fixture.requireDocumentMirrorsHead(t, foreign.GetDocumentId(), foreign)
	assert.Equal(t, 1, fixture.count(t, "documents", alice.vaultID))
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "rejections are not internal errors")
}

// Viewers and non-members cannot commit; viewers can read.
func TestCommitRevisionRoles(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")
	created := alice.mustCommit(t, alice.create(t, "note.md", content))

	bob := fixture.client(t, "bob", alice.vaultID)
	carol := fixture.client(t, "carol", alice.vaultID)
	mallory := fixture.client(t, "mallory", alice.vaultID)

	fixture.addMember(t, alice.vaultID, "bob", store.RoleEditor)
	fixture.addMember(t, alice.vaultID, "carol", store.RoleViewer)

	bobs := bob.mustCommit(t, bob.next(t, created, "note.md", content, false))
	assert.Equal(t, bob.deviceID, bobs.GetDeviceId())
	assert.NotEqual(t, created.GetUserId(), bobs.GetUserId())

	for _, test := range []struct {
		client *syncClient
		code   connect.Code
	}{
		{client: carol, code: connect.CodePermissionDenied},
		{client: mallory, code: connect.CodeNotFound},
	} {
		for _, request := range []*vaultsyncv1.CommitRevisionRequest{
			test.client.create(t, "intruder.md", content),
			test.client.next(t, bobs, "note.md", content, true),
		} {
			_, err := test.client.commit(t, request)
			requireCode(t, test.code, err)
		}
	}

	assert.Equal(t, uint64(2), fixture.headSeq(t, alice.vaultID), "nothing was written")
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), bobs)

	// Carol reads; Mallory cannot.
	assert.Len(t, carol.allChanges(t, 0, 0), 2)
	_, err := carol.revision(t, bobs.GetId())
	require.NoError(t, err)
	assert.Len(t, carol.history(t, created.GetDocumentId()), 2)

	_, err = mallory.changes(t, 0, 0)
	requireCode(t, connect.CodeNotFound, err)
	_, err = mallory.revision(t, bobs.GetId())
	requireCode(t, connect.CodeNotFound, err)
	_, err = mallory.historyPage(t, created.GetDocumentId(), 0, "")
	requireCode(t, connect.CodeNotFound, err)

	// An editor cannot commit with another user's device.
	borrowed := bob.next(t, bobs, "note.md", content, false)
	borrowed.DeviceId = alice.deviceID
	_, err = bob.commit(t, borrowed)
	requireCode(t, connect.CodeNotFound, err)
}

func TestDocumentHistoryPages(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{MaxHistoryPageSize: 3})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	head := alice.mustCommit(t, alice.create(t, "note-0.md", content))
	want := []string{head.GetId()}

	for index := 1; index < 8; index++ {
		head = alice.mustCommit(t, alice.next(t, head, fmt.Sprintf("note-%d.md", index), content, false))
		want = append([]string{head.GetId()}, want...)

		// Another document's revisions interleave in seq.
		alice.mustCommit(t, alice.create(t, fmt.Sprintf("other-%d.md", index), content))
	}

	for _, pageSize := range []uint32{0, 1, 2, 3, 100} {
		var got []string

		pageToken := ""

		for {
			page, err := alice.historyPage(t, head.GetDocumentId(), pageSize, pageToken)
			require.NoError(t, err)
			assert.LessOrEqual(t, len(page.GetRevisions()), 3, "page size is capped")
			assert.Equal(t, head.GetId(), page.GetDocument().GetHeadRevId())
			assert.Equal(t, vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT, page.GetDocument().GetKind())

			got = append(got, revisionIDs(page.GetRevisions())...)

			pageToken = page.GetNextPageToken()
			if pageToken == "" {
				break
			}
		}

		assert.Equal(t, want, got, "page size %d", pageSize)
	}
}

// Issue #420: history names the devices that made its revisions, for every
// member (a viewer included), and only them; a non-member learns nothing.
func TestDocumentHistoryNamesDevices(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")
	created := alice.mustCommit(t, alice.create(t, "note.md", content))

	bob := fixture.client(t, "bob", alice.vaultID)
	carol := fixture.client(t, "carol", alice.vaultID)
	mallory := fixture.client(t, "mallory", alice.vaultID)

	fixture.addMember(t, alice.vaultID, "bob", store.RoleEditor)
	fixture.addMember(t, alice.vaultID, "carol", store.RoleViewer)

	edited := bob.mustCommit(t, bob.next(t, created, "note.md", content, false))
	head := alice.mustCommit(t, alice.next(t, edited, "note.md", content, false))

	// Bob's other device, which made no revision of the note, is not named.
	other := fixture.client(t, "bob", alice.vaultID)
	other.mustCommit(t, other.create(t, "other.md", content))

	names := func(page *vaultsyncv1.GetDocumentHistoryResponse) map[string]string {
		named := make(map[string]string)
		for _, device := range page.GetDeviceNames() {
			_, duplicate := named[device.GetDeviceId()]
			assert.False(t, duplicate, "device %s named twice", device.GetDeviceId())

			named[device.GetDeviceId()] = device.GetName()
		}

		return named
	}

	want := map[string]string{alice.deviceID: "alice's laptop", bob.deviceID: "bob's laptop"}

	for _, member := range []*syncClient{alice, bob, carol} {
		page, err := member.historyPage(t, created.GetDocumentId(), 0, "")
		require.NoError(t, err)
		assert.Equal(t, []string{head.GetId(), edited.GetId(), created.GetId()}, revisionIDs(page.GetRevisions()))
		assert.Equal(t, want, names(page))
	}

	// A page names only the devices of its own revisions.
	first, err := alice.historyPage(t, created.GetDocumentId(), 2, "")
	require.NoError(t, err)
	assert.Equal(t, want, names(first))

	second, err := alice.historyPage(t, created.GetDocumentId(), 1, first.GetNextPageToken())
	require.NoError(t, err)
	assert.Equal(t, []string{created.GetId()}, revisionIDs(second.GetRevisions()))
	assert.Equal(t, map[string]string{alice.deviceID: "alice's laptop"}, names(second))

	// A non-member is refused and learns no device name.
	refused, err := mallory.historyPage(t, created.GetDocumentId(), 0, "")
	requireCode(t, connect.CodeNotFound, err)
	assert.Empty(t, refused.GetDeviceNames())

	// Nor does a vault of their own name devices of another vault's
	// revisions.
	mallory.vaultID = fixture.createVault(t, mallory.token, "Mine").GetId()
	theirs := mallory.mustCommit(t, mallory.create(t, "mine.md", mallory.content(t, "mine")))
	page, err := mallory.historyPage(t, theirs.GetDocumentId(), 0, "")
	require.NoError(t, err)
	assert.Equal(t, map[string]string{mallory.deviceID: "mallory's laptop"}, names(page))
}

// TestDeviceNamedBeforeTheFormatRuleKeepsWorking: RegisterDevice now refuses
// format characters in names (#548), but a device registered before that
// keeps its name and keeps committing; nothing is migrated.
func TestDeviceNamedBeforeTheFormatRuleKeepsWorking(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	legacy := "laptop\u202e\u2066 this device\u2069\u200b”"
	_, err := fixture.registerDevice(t, alice.token, &vaultsyncv1.RegisterDeviceRequest{Name: legacy})
	requireCode(t, connect.CodeInvalidArgument, err)

	_, err = fixture.pool.Exec(t.Context(), `UPDATE devices SET name = $1 WHERE id = $2`, legacy, alice.deviceID)
	require.NoError(t, err)

	created := alice.mustCommit(t, alice.create(t, "note.md", alice.content(t, "content")))
	edited := alice.mustCommit(t, alice.next(t, created, "note.md", alice.content(t, "edited"), false))

	page, err := alice.historyPage(t, created.GetDocumentId(), 0, "")
	require.NoError(t, err)
	assert.Equal(t, []string{edited.GetId(), created.GetId()}, revisionIDs(page.GetRevisions()))
	require.Len(t, page.GetDeviceNames(), 1)
	assert.Equal(t, alice.deviceID, page.GetDeviceNames()[0].GetDeviceId())
	assert.Equal(t, legacy, page.GetDeviceNames()[0].GetName())
}

func TestSyncRequestsAreValidated(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")
	existing := alice.mustCommit(t, alice.create(t, "existing.md", content))

	v4 := uuid.New().String()

	commitTests := []struct {
		name   string
		change func(request *vaultsyncv1.CommitRevisionRequest)
		code   connect.Code
	}{
		{name: "malformed document_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.DocumentId = "nope" }},
		{name: "upper-case document_id", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.DocumentId = strings.ToUpper(request.GetDocumentId())
		}},
		{name: "non-v7 document_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.DocumentId = v4 }},
		{name: "empty revision_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.RevisionId = "" }},
		{name: "non-v7 revision_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.RevisionId = v4 }},
		{name: "malformed base_rev_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.BaseRevId = "{" + existing.GetId() + "}" }},
		{name: "malformed device_id", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.DeviceId = "" }},
		{name: "unknown device", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.DeviceId = newV7(t) }, code: connect.CodeNotFound},
		{name: "unspecified kind", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_UNSPECIFIED
		}},
		{name: "yjs kind", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_YJS
		}},
		{name: "unknown kind", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Kind = 99 }},
		{name: "no content_ref", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.ContentRef = nil }},
		{name: "short blob_id", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.ContentRef = &vaultsyncv1.ContentRef{BlobId: content.GetBlobId()[:31], Size: content.GetSize()}
		}},
		{name: "path_key in a plaintext vault", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.PathKey = make([]byte, 32) }},
		{name: "empty path", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = nil }},
		{name: "absolute path", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("/etc/passwd") }},
		{name: "trailing slash", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("notes/") }},
		{name: "empty segment", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("notes//a.md") }},
		{name: "dot segment", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("notes/./a.md") }},
		{name: "dot-dot segment", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("notes/../../a.md") }},
		{name: "NUL in path", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("a\x00.md") }},
		{name: "newline in path", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("a\n.md") }},
		{name: "invalid UTF-8 path", change: func(request *vaultsyncv1.CommitRevisionRequest) { request.Path = []byte("a\xff.md") }},
		{name: "over-long path", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.Path = []byte(strings.Repeat("a", api.MaxPathBytes-2) + ".md")
		}},
		{name: "path over-long once normalized", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			// U+1D160 (4 bytes) is a composition exclusion that NFC
			// decomposes into 3 code points (12 bytes).
			request.Path = []byte(strings.Repeat("\U0001D160", api.MaxPathBytes/4))
		}},
		{name: "kind change", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.DocumentId = existing.GetDocumentId()
			request.BaseRevId = existing.GetId()
			request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_BLOB
		}},
		{name: "base for a document that does not exist", change: func(request *vaultsyncv1.CommitRevisionRequest) {
			request.BaseRevId = existing.GetId()
		}, code: connect.CodeFailedPrecondition},
	}

	for _, test := range commitTests {
		t.Run(test.name, func(t *testing.T) {
			request := alice.create(t, "new.md", content)
			test.change(request)

			code := test.code
			if code == 0 {
				code = connect.CodeInvalidArgument
			}

			_, err := alice.commit(t, request)
			requireCode(t, code, err)
		})
	}

	// The longest new path is accepted: 1024 bytes in names of 255.
	alice.mustCommit(t, alice.create(t, strings.Repeat(strings.Repeat("a", 254)+"/", 4)+"a.md", content))

	assert.Equal(t, 2, fixture.count(t, "revisions", alice.vaultID))

	_, err := alice.changes(t, uint64(1)<<63, 0)
	requireCode(t, connect.CodeInvalidArgument, err)

	_, err = alice.revision(t, "not-an-id")
	requireCode(t, connect.CodeInvalidArgument, err)

	_, err = alice.revision(t, newV7(t))
	requireCode(t, connect.CodeNotFound, err)

	for _, pageToken := range []string{"x", "AAAAAAAAAAA", "////////////", strings.Repeat("A", 64)} {
		_, err = alice.historyPage(t, existing.GetDocumentId(), 0, pageToken)
		requireCode(t, connect.CodeInvalidArgument, err, "page token %q", pageToken)
	}

	_, err = alice.historyPage(t, "", 0, "")
	requireCode(t, connect.CodeInvalidArgument, err)

	_, err = alice.historyPage(t, newV7(t), 0, "")
	requireCode(t, connect.CodeNotFound, err)

	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad input is not an internal error")
}
