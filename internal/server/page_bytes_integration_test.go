//go:build integration

package server_test

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// longPath returns a valid path of exactly api.MaxPathBytes bytes, unique
// per name.
func longPath(name string) string {
	suffix := "/" + name + ".md"

	return strings.Repeat("a", api.MaxPathBytes-len(suffix)) + suffix
}

// pageCodecs are the ways a client may encode its calls. Without gzip, the
// server's send limit applies to the uncompressed response.
var pageCodecs = map[string][]connect.ClientOption{
	"binary":           {connect.WithAcceptCompression("gzip", nil, nil)},
	"JSON":             {connect.WithProtoJSON(), connect.WithAcceptCompression("gzip", nil, nil)},
	"binary with gzip": nil,
}

// longPathVault is a vault whose revisions all have maximum-length paths:
// one document with historyLength revisions and documents more documents,
// so that a maximum-size page of either feed encodes to more than the
// default send limit (1 MiB).
type longPathVault struct {
	client *syncClient
	// changes are every revision of the vault, in seq order.
	changes []string
	// document is the document with a long history; history its
	// revisions, newest first.
	document string
	history  []string
}

func newLongPathVault(t *testing.T, fixture *syncFixture, historyLength, documents int) *longPathVault {
	t.Helper()

	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Long paths").GetId()
	content := alice.content(t, "content")
	vault := &longPathVault{client: alice}

	head := alice.mustCommit(t, alice.create(t, longPath("history-0"), content))
	vault.document = head.GetDocumentId()
	vault.history = []string{head.GetId()}

	for index := 1; index < historyLength; index++ {
		head = alice.mustCommit(t, alice.next(t, head, longPath(fmt.Sprintf("history-%d", index)), content, false))
		vault.history = append([]string{head.GetId()}, vault.history...)
	}

	// Commit the other documents a few at a time, alternating replicas.
	const workers = 4

	var wait sync.WaitGroup

	for worker := range workers {
		wait.Go(func() {
			for index := worker; index < documents; index += workers {
				_, err := alice.commitOn(t, index, alice.create(t, longPath(fmt.Sprintf("document-%d", index)), content))
				assert.NoError(t, err)
			}
		})
	}

	wait.Wait()
	require.False(t, t.Failed())

	vault.changes = revisionIDs(alice.allChanges(t, 0, 1))
	require.Len(t, vault.changes, historyLength+documents)

	return vault
}

func (vault *longPathVault) syncClient(options []connect.ClientOption) vaultsyncv1connect.SyncServiceClient {
	return vaultsyncv1connect.NewSyncServiceClient(http.DefaultClient, vault.client.fixture.replicas[0].apiURL(), options...)
}

// pageChanges pages through the change feed from the start and returns
// every revision id and the length of each page.
func (vault *longPathVault) pageChanges(t *testing.T, client vaultsyncv1connect.SyncServiceClient, pageSize uint32) ([]string, []int) {
	t.Helper()

	var (
		got     []string
		lengths []int
		since   uint64
	)

	for range len(vault.changes) + 1 {
		response, err := client.ListChanges(t.Context(), authorized(&vaultsyncv1.ListChangesRequest{
			VaultId: vault.client.vaultID, SinceSeq: since, PageSize: pageSize,
		}, vault.client.token))
		require.NoError(t, err, "page after seq %d", since)

		page := response.Msg
		require.NotEmpty(t, page.GetRevisions(), "page after seq %d makes no progress", since)

		got = append(got, revisionIDs(page.GetRevisions())...)
		lengths = append(lengths, len(page.GetRevisions()))

		if !page.GetHasMore() {
			return got, lengths
		}

		since = page.GetRevisions()[len(page.GetRevisions())-1].GetSeq()
	}

	require.FailNow(t, "the change feed did not end")

	return nil, nil
}

// pageHistory pages through the document's history and returns every
// revision id and the length of each page.
func (vault *longPathVault) pageHistory(t *testing.T, client vaultsyncv1connect.SyncServiceClient, pageSize uint32) ([]string, []int) {
	t.Helper()

	var (
		got       []string
		lengths   []int
		pageToken string
	)

	for range len(vault.history) + 1 {
		response, err := client.GetDocumentHistory(t.Context(), authorized(&vaultsyncv1.GetDocumentHistoryRequest{
			VaultId: vault.client.vaultID, DocumentId: vault.document, PageSize: pageSize, PageToken: pageToken,
		}, vault.client.token))
		require.NoError(t, err, "page after token %q", pageToken)

		page := response.Msg
		require.NotEmpty(t, page.GetRevisions(), "page after token %q makes no progress", pageToken)

		got = append(got, revisionIDs(page.GetRevisions())...)
		lengths = append(lengths, len(page.GetRevisions()))

		if page.GetNextPageToken() == "" {
			return got, lengths
		}

		pageToken = page.GetNextPageToken()
	}

	require.FailNow(t, "the document history did not end")

	return nil, nil
}

// Criteria 1 and 2: when a full page of maximum-length paths would encode
// to more than the send limit (the default 1 MiB here), ListChanges and
// GetDocumentHistory return shorter pages, and paging reaches the end with
// every revision exactly once and no error, in every encoding.
func TestPagesOfLongPathsFitTheSendLimit(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})

	// A revision with a 4096-byte path encodes to over 4 KiB, so 300
	// revisions take more than 1 MiB.
	const historyLength, documents = 300, 300

	vault := newLongPathVault(t, fixture, historyLength, documents)

	for name, options := range pageCodecs {
		client := vault.syncClient(options)

		t.Run(name, func(t *testing.T) {
			for _, pageSize := range []uint32{0, api.MaxChangesPageSize, ^uint32(0)} {
				got, lengths := vault.pageChanges(t, client, pageSize)
				assert.Equal(t, vault.changes, got, "ListChanges page size %d", pageSize)
				assert.Greater(t, len(lengths), 1, "ListChanges page size %d: pages %v", pageSize, lengths)
			}

			for _, pageSize := range []uint32{0, historyLength, api.MaxHistoryPageSize, ^uint32(0)} {
				got, lengths := vault.pageHistory(t, client, pageSize)
				assert.Equal(t, vault.history, got, "GetDocumentHistory page size %d", pageSize)

				if pageSize >= historyLength {
					assert.Greater(t, len(lengths), 1, "GetDocumentHistory page size %d: pages %v", pageSize, lengths)
				}
			}
		})
	}
}

// Criterion 3: a page holds at least one revision when one exists, even
// when that revision alone exceeds the server's response budget, so a
// client always makes progress.
func TestPagesAlwaysMakeProgress(t *testing.T) {
	// A one-byte budget fits no revision at all.
	fixture := newSyncFixture(t, api.SyncLimits{MaxResponseBytes: 1})

	const historyLength, documents = 3, 4

	vault := newLongPathVault(t, fixture, historyLength, documents)

	for name, options := range pageCodecs {
		client := vault.syncClient(options)

		t.Run(name, func(t *testing.T) {
			got, lengths := vault.pageChanges(t, client, api.MaxChangesPageSize)
			assert.Equal(t, vault.changes, got)
			assert.Equal(t, []int{1, 1, 1, 1, 1, 1, 1}, lengths)

			got, lengths = vault.pageHistory(t, client, api.MaxHistoryPageSize)
			assert.Equal(t, vault.history, got)
			assert.Equal(t, []int{1, 1, 1}, lengths)
		})
	}
}
