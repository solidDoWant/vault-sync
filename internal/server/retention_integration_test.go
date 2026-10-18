//go:build integration

package server_test

import (
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// age sets a revision's created_at to the SQL expression created.
func (fixture *syncFixture) age(t *testing.T, revision *vaultsyncv1.Revision, created string) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE revisions SET created_at = `+created+` WHERE id = $1`, revision.GetId())
	require.NoError(t, err)
}

func (fixture *syncFixture) applyRetention(t *testing.T) retention.Result {
	t.Helper()

	job := &retention.Job{
		Store:   store.New(fixture.pool),
		Objects: fixture.objects,
		Policy:  store.RetentionPolicy{KeepAll: retention.DefaultKeepAll, KeepDaily: retention.DefaultKeepDaily},
		Grace:   time.Hour,
	}

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)

	return result
}

// Issue #26 (server half of criteria 1 and 2): after retention, a
// document's history lists its retained revisions with time and device, any
// of them can be read and restored as a new head, a deleted document can be
// found by its tombstone and restored, and purged revisions are gone from
// every read.
func TestHistoryAndRestoreAfterRetention(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	const oldDay = `date_trunc('day', now() - interval '100 days', 'UTC')`

	v1, v2, v3, v4 := alice.content(t, "version 1"), alice.content(t, "version 2"), alice.content(t, "version 3"), alice.content(t, "version 4")

	// Three revisions on one old day, so only the newest of them is kept,
	// and a recent head.
	first := alice.mustCommit(t, alice.create(t, "Diary.md", v1))
	second := alice.mustCommit(t, alice.next(t, first, "Diary.md", v2, false))
	third := alice.mustCommit(t, alice.next(t, second, "Diary.md", v3, false))
	head := alice.mustCommit(t, alice.next(t, third, "Diary.md", v4, false))

	fixture.age(t, first, oldDay+` + interval '1 hour'`)
	fixture.age(t, second, oldDay+` + interval '2 hours'`)
	fixture.age(t, third, oldDay+` + interval '3 hours'`)

	// A document deleted on that day: its tombstone is the head.
	draft := alice.mustCommit(t, alice.create(t, "Draft.md", v1))
	tombstone := alice.mustCommit(t, alice.next(t, draft, "Draft.md", v2, true))

	fixture.age(t, draft, oldDay+` + interval '1 hour'`)
	fixture.age(t, tombstone, oldDay+` + interval '2 hours'`)

	assert.Equal(t, retention.Result{RevisionsPurged: 3}, fixture.applyRetention(t))

	// History: the retained revisions, newest first, with time and device;
	// the oldest retained revision's parent was purged, so it has none.
	history := alice.history(t, head.GetDocumentId())
	require.Equal(t, []string{head.GetId(), third.GetId()}, revisionIDs(history))

	for _, revision := range history {
		assert.Equal(t, alice.deviceID, revision.GetDeviceId())
		assert.NotNil(t, revision.GetCreateTime())
	}

	assert.Less(t, history[1].GetCreateTime().AsTime(), time.Now().Add(-99*24*time.Hour))
	assert.Equal(t, third.GetId(), history[0].GetParentRevId())
	assert.Empty(t, history[1].GetParentRevId())

	// Purged revisions are gone from every read.
	for _, purged := range []*vaultsyncv1.Revision{first, second, draft} {
		_, err := alice.revision(t, purged.GetId())
		requireCode(t, connect.CodeNotFound, err)
		assert.NotContains(t, revisionIDs(alice.allChanges(t, 0, 0)), purged.GetId())
	}

	// Preview a retained revision and restore it as a new head.
	assert.Equal(t, []byte("version 3"), fixture.downloadAll(t, alice.token, alice.vaultID, history[1].GetContentRef().GetBlobId()))

	restored := alice.mustCommit(t, alice.next(t, head, "Diary.md", history[1].GetContentRef(), false))
	assert.Equal(t, v3.GetBlobId(), restored.GetContentRef().GetBlobId())
	assert.Equal(t, head.GetId(), restored.GetParentRevId())
	fixture.requireDocumentMirrorsHead(t, head.GetDocumentId(), restored)

	// The deleted document is found by its tombstone, which is kept, and
	// restored with the content it had when it was deleted.
	assert.Contains(t, revisionIDs(alice.allChanges(t, 0, 0)), tombstone.GetId())
	assert.Equal(t, []string{tombstone.GetId()}, revisionIDs(alice.history(t, tombstone.GetDocumentId())))

	undeleted := alice.mustCommit(t, alice.next(t, tombstone, "Draft.md", tombstone.GetContentRef(), false))
	assert.False(t, undeleted.GetDeleted())
	fixture.requireDocumentMirrorsHead(t, tombstone.GetDocumentId(), undeleted)

	// The purged revisions' first version is referenced by nothing now;
	// after the grace period it is collected, and committing it needs a
	// new upload, which works as for any new content.
	_, err := fixture.pool.Exec(t.Context(), `UPDATE blobs SET released_at = now() - interval '2 hours' WHERE released_at IS NOT NULL`)
	require.NoError(t, err)

	assert.Equal(t, retention.Result{BlobsCollected: 1, ObjectsDeleted: 1}, fixture.applyRetention(t), "version 1 is collected")

	_, err = alice.commit(t, alice.next(t, restored, "Diary.md", v1, false))
	requireCode(t, connect.CodeFailedPrecondition, err, "the collected content must be uploaded again")

	again := alice.content(t, "version 1")
	alice.mustCommit(t, alice.next(t, restored, "Diary.md", again, false))
	assert.Equal(t, []byte("version 1"), fixture.downloadAll(t, alice.token, alice.vaultID, v1.GetBlobId()))
}

// CommitBlob waits for a deletion of the blob's previous object in progress
// (garbage collection, SPEC.md §11) before it writes the new object, so the
// deletion cannot remove the content just uploaded.
func TestCommitBlobWaitsForADeletionOfItsObject(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	content := []byte("collected once, uploaded again")
	blobID := blobIDOf(content)

	_, err := fixture.begin(t, alice.token, alice.vaultID, blobID, len(content))
	require.NoError(t, err)
	require.NoError(t, fixture.sendFrom(t, alice.token, alice.vaultID, blobID, content, 0, 0))

	// A collector deleting the previous object holds the deletion record.
	_, err = fixture.pool.Exec(t.Context(), `INSERT INTO blob_deletions (vault_id, blob_id) VALUES ($1, $2)`, alice.vaultID, blobID)
	require.NoError(t, err)

	tx, err := fixture.pool.Begin(t.Context())
	require.NoError(t, err)

	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })

	_, err = tx.Exec(t.Context(), `SELECT 1 FROM blob_deletions WHERE vault_id = $1 AND blob_id = $2 FOR UPDATE`, alice.vaultID, blobID)
	require.NoError(t, err)

	committed := make(chan error, 1)

	go func() {
		_, err := fixture.commit(t, alice.token, alice.vaultID, blobID)
		committed <- err
	}()

	assert.Never(t, func() bool { return len(committed) > 0 }, 300*time.Millisecond, 10*time.Millisecond,
		"the commit waits for the deletion")

	// The deletion finishes (here: gives up) and the commit goes ahead.
	require.NoError(t, tx.Rollback(t.Context()))
	require.NoError(t, <-committed)
	assert.Equal(t, content, fixture.downloadAll(t, alice.token, alice.vaultID, blobID))
}
