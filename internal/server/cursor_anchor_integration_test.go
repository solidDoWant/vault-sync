//go:build integration

package server_test

import (
	"math"
	"testing"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// anchoredChanges lists the changes after since on a replica, with anchor
// as since_anchor.
func (client *syncClient) anchoredChanges(t *testing.T, replica int, since uint64, anchor []byte) (*vaultsyncv1.ListChangesResponse, error) {
	t.Helper()

	return client.checkedChanges(t, replica, &vaultsyncv1.ListChangesRequest{SinceSeq: since, SinceAnchor: anchor})
}

// checkedChanges lists the changes request asks for, in the client's vault,
// on a replica.
func (client *syncClient) checkedChanges(t *testing.T, replica int, request *vaultsyncv1.ListChangesRequest) (*vaultsyncv1.ListChangesResponse, error) {
	t.Helper()

	request.VaultId = client.vaultID

	response, err := client.sync(replica).ListChanges(t.Context(), authorized(request, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// restoreTo rolls a vault's database state back to what it was when its
// head_seq was seq, as a restore of a PostgreSQL backup taken then would:
// every revision after seq, every purge marker of one, and every document
// created after it, is gone.
// It supports vaults whose documents were not changed after seq, only
// created.
func (fixture *syncFixture) restoreTo(t *testing.T, vaultID string, seq uint64) {
	t.Helper()

	require.NoError(t, pgx.BeginFunc(t.Context(), fixture.pool, func(tx pgx.Tx) error {
		var changed int
		if err := tx.QueryRow(t.Context(), `
			SELECT count(*) FROM revisions r
			WHERE r.vault_id = $1 AND r.seq > $2
				AND EXISTS (SELECT 1 FROM revisions o WHERE o.document_id = r.document_id AND o.seq <= $2)`,
			vaultID, seq).Scan(&changed); err != nil {
			return err
		}

		require.Zero(t, changed, "restoreTo only supports documents created after the restore point")

		rows, err := tx.Query(t.Context(), `DELETE FROM revisions WHERE vault_id = $1 AND seq > $2 RETURNING document_id`, vaultID, seq)
		if err != nil {
			return err
		}

		documents, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}

		if _, err := tx.Exec(t.Context(), `DELETE FROM documents WHERE vault_id = $1 AND id::text = ANY($2)`, vaultID, documents); err != nil {
			return err
		}

		if _, err := tx.Exec(t.Context(), `DELETE FROM purged_revisions WHERE vault_id = $1 AND seq > $2`, vaultID, seq); err != nil {
			return err
		}

		_, err = tx.Exec(t.Context(), `UPDATE vaults SET head_seq = $2 WHERE id = $1`, vaultID, seq)

		return err
	}))
}

// Issue #155: a client's cursor anchor matches while the server's history
// still holds the revision it names, on every replica; after the database is
// restored to before the cursor and new commits (even one re-committing the
// very same revision id) pass the cursor again, the anchor no longer matches
// and the server reports divergence. Without an anchor the old behavior
// stays: nothing is reported, and the revisions are skipped.
func TestCursorAnchorDetectsARestoredHistory(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	content := alice.content(t, "note")
	first := alice.mustCommit(t, alice.create(t, "a.md", content))
	second := alice.mustCommit(t, alice.create(t, "b.md", content))
	thirdRequest := alice.create(t, "c.md", content)
	third := alice.mustCommit(t, thirdRequest)
	require.Equal(t, uint64(3), third.GetSeq())

	anchors := map[string]bool{}

	for _, revision := range alice.allChanges(t, 0, 0) {
		require.Len(t, revision.GetAnchor(), 16, "every revision has a 16-byte anchor")
		anchors[string(revision.GetAnchor())] = true
	}

	assert.Len(t, anchors, 3, "anchors are distinct")
	assert.Equal(t, third.GetAnchor(), alice.allChanges(t, 2, 0)[0].GetAnchor(), "a commit returns the anchor the feed lists")

	// Match, on either replica: the page as without an anchor.
	for replica := range 2 {
		page, err := alice.anchoredChanges(t, replica, first.GetSeq(), first.GetAnchor())
		require.NoError(t, err)
		assert.False(t, page.GetDiverged(), "replica %d", replica)
		assert.Equal(t, []string{second.GetId(), third.GetId()}, revisionIDs(page.GetRevisions()), "replica %d", replica)
		assert.Equal(t, uint64(3), page.GetHeadSeq())

		page, err = alice.anchoredChanges(t, replica, third.GetSeq(), third.GetAnchor())
		require.NoError(t, err)
		assert.False(t, page.GetDiverged(), "at the head, replica %d", replica)
		assert.Empty(t, page.GetRevisions())
	}

	// Another revision's anchor at the cursor does not match.
	page, err := alice.anchoredChanges(t, 0, third.GetSeq(), second.GetAnchor())
	require.NoError(t, err)
	assert.True(t, page.GetDiverged(), "the anchor of another revision")

	// The database is restored to seq 1; seq 2 and 3 are committed anew,
	// seq 3 with the revision id the client applied there before.
	fixture.restoreTo(t, alice.vaultID, 1)

	other := alice.mustCommit(t, alice.create(t, "other.md", content))
	again := alice.mustCommit(t, thirdRequest)
	require.Equal(t, third.GetId(), again.GetId())
	require.Equal(t, third.GetSeq(), again.GetSeq(), "the restored server numbers the same revision id with the same seq")
	require.NotEqual(t, third.GetAnchor(), again.GetAnchor())

	for replica := range 2 {
		page, err := alice.anchoredChanges(t, replica, third.GetSeq(), third.GetAnchor())
		require.NoError(t, err)
		assert.True(t, page.GetDiverged(), "replica %d", replica)
		assert.Empty(t, page.GetRevisions())
		assert.False(t, page.GetHasMore())
		assert.Equal(t, uint64(3), page.GetHeadSeq())
	}

	// The cursor's anchor at seq 1, which the restore kept, still matches.
	page, err = alice.anchoredChanges(t, 0, first.GetSeq(), first.GetAnchor())
	require.NoError(t, err)
	assert.False(t, page.GetDiverged())
	assert.Equal(t, []string{other.GetId(), again.GetId()}, revisionIDs(page.GetRevisions()))

	// Without an anchor (an old client), nothing is reported.
	page, err = alice.changes(t, third.GetSeq(), 0)
	require.NoError(t, err)
	assert.False(t, page.GetDiverged())
	assert.Empty(t, page.GetRevisions())
}

// Issues #155, #488: retention may purge the revision at a client's cursor.
// The purge keeps a marker of its seq and anchor, so the cursor anchor still
// matches on every replica: a purge reports no divergence, and the feed goes
// on after the cursor. Another anchor at the purged seq still diverges. A
// document's head, and so the revision at the vault's head_seq, is never
// purged.
func TestCursorAnchorOfAPurgedRevisionMatchesItsPurgeMarker(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	const oldDay = `date_trunc('day', now() - interval '100 days', 'UTC')`

	first := alice.mustCommit(t, alice.create(t, "Diary.md", alice.content(t, "version 1")))
	second := alice.mustCommit(t, alice.next(t, first, "Diary.md", alice.content(t, "version 2"), false))
	third := alice.mustCommit(t, alice.next(t, second, "Diary.md", alice.content(t, "version 3"), false))
	head := alice.mustCommit(t, alice.next(t, third, "Diary.md", alice.content(t, "version 4"), false))

	fixture.age(t, first, oldDay+` + interval '1 hour'`)
	fixture.age(t, second, oldDay+` + interval '2 hours'`)
	fixture.age(t, third, oldDay+` + interval '3 hours'`)

	page, err := alice.anchoredChanges(t, 0, second.GetSeq(), second.GetAnchor())
	require.NoError(t, err)
	require.False(t, page.GetDiverged(), "before the purge")

	assert.Equal(t, retention.Result{RevisionsPurged: 2}, fixture.applyRetention(t))

	for replica := range 2 {
		for _, purged := range []*vaultsyncv1.Revision{first, second} {
			page, err = alice.anchoredChanges(t, replica, purged.GetSeq(), purged.GetAnchor())
			require.NoError(t, err)
			assert.False(t, page.GetDiverged(), "the cursor's revision at seq %d was purged, replica %d", purged.GetSeq(), replica)
			assert.Equal(t, []string{third.GetId(), head.GetId()}, revisionIDs(page.GetRevisions()), "seq %d, replica %d", purged.GetSeq(), replica)
		}
	}

	page, err = alice.anchoredChanges(t, 0, second.GetSeq(), first.GetAnchor())
	require.NoError(t, err)
	assert.True(t, page.GetDiverged(), "another purged revision's anchor at the purged seq")
	assert.Empty(t, page.GetRevisions())

	// Retained revisions, and the head, still match.
	for _, revision := range []*vaultsyncv1.Revision{third, head} {
		page, err = alice.anchoredChanges(t, 0, revision.GetSeq(), revision.GetAnchor())
		require.NoError(t, err)
		assert.False(t, page.GetDiverged(), "seq %d", revision.GetSeq())
	}
}

// Issue #494: a device's own acknowledged commit can lie above its cursor
// (SPEC.md §6.1, #261). A database restored to between the two keeps the
// revision at the cursor, so only the anchor of the own commit tells the
// restore: while the vault holds that commit, the feed is listed as usual on
// every replica; once the restored server has committed another revision at
// its seq, the response reports divergence, and so it does while the
// restored head is still below it. Purged, the commit still matches.
func TestOwnCommitAnchorDetectsARestoreAboveTheCursor(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	content := alice.content(t, "note")
	cursor := alice.mustCommit(t, alice.create(t, "a.md", content))
	other := alice.mustCommit(t, alice.create(t, "b.md", content))
	own := alice.mustCommit(t, alice.create(t, "c.md", content))
	require.Equal(t, uint64(3), own.GetSeq())

	request := func() *vaultsyncv1.ListChangesRequest {
		return &vaultsyncv1.ListChangesRequest{
			SinceSeq: cursor.GetSeq(), SinceAnchor: cursor.GetAnchor(),
			OwnCommitSeq: own.GetSeq(), OwnCommitAnchor: own.GetAnchor(),
		}
	}

	for replica := range 2 {
		page, err := alice.checkedChanges(t, replica, request())
		require.NoError(t, err)
		assert.False(t, page.GetDiverged(), "replica %d", replica)
		assert.Equal(t, []string{other.GetId(), own.GetId()}, revisionIDs(page.GetRevisions()), "replica %d", replica)
	}

	mismatched := request()
	mismatched.OwnCommitAnchor = other.GetAnchor()
	page, err := alice.checkedChanges(t, 0, mismatched)
	require.NoError(t, err)
	assert.True(t, page.GetDiverged(), "another revision's anchor at the own commit's seq")

	// Restored to seq 2: the own commit is gone, the cursor's revision is not.
	fixture.restoreTo(t, alice.vaultID, other.GetSeq())

	page, err = alice.checkedChanges(t, 0, request())
	require.NoError(t, err)
	assert.True(t, page.GetDiverged(), "the restored head is below the own commit")

	again := alice.mustCommit(t, alice.create(t, "d.md", content))
	require.Equal(t, own.GetSeq(), again.GetSeq())

	for replica := range 2 {
		page, err := alice.checkedChanges(t, replica, request())
		require.NoError(t, err)
		assert.True(t, page.GetDiverged(), "replica %d", replica)
		assert.Empty(t, page.GetRevisions())
		assert.False(t, page.GetHasMore())
		assert.Equal(t, uint64(3), page.GetHeadSeq())
	}

	// The cursor anchor alone cannot tell.
	page, err = alice.anchoredChanges(t, 0, cursor.GetSeq(), cursor.GetAnchor())
	require.NoError(t, err)
	assert.False(t, page.GetDiverged(), "the cursor's revision survived the restore")
}

// since_anchor is bounded: empty or exactly 16 bytes, and only with a
// cursor. A caller who is not a member learns nothing from an anchor, and a
// viewer, who may read the feed, may send one.
func TestCursorAnchorIsValidatedAfterAuthorization(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	first := alice.mustCommit(t, alice.create(t, "a.md", alice.content(t, "note")))
	anchor := first.GetAnchor()

	tests := []struct {
		name    string
		since   uint64
		anchor  []byte
		wantErr require.ErrorAssertionFunc
	}{
		{name: "16 bytes", since: 1, anchor: anchor},
		{name: "empty", since: 1, anchor: nil},
		{name: "empty at seq 0", since: 0, anchor: nil},
		{name: "15 bytes", since: 1, anchor: anchor[:15], wantErr: invalidArgument},
		{name: "17 bytes", since: 1, anchor: append(append([]byte(nil), anchor...), 0), wantErr: invalidArgument},
		{name: "at seq 0", since: 0, anchor: anchor, wantErr: invalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			_, err := alice.anchoredChanges(t, 0, test.since, test.anchor)
			test.wantErr(t, err)
		})
	}

	mallory := fixture.client(t, "mallory", alice.vaultID)
	_, err := mallory.anchoredChanges(t, 0, 1, anchor)
	requireCode(t, connect.CodeNotFound, err, "a non-member")

	_, err = mallory.anchoredChanges(t, 0, 1, anchor[:3])
	requireCode(t, connect.CodeNotFound, err, "a non-member is refused before the anchor is validated")

	_, err = mallory.checkedChanges(t, 0, &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 1, OwnCommitAnchor: anchor})
	requireCode(t, connect.CodeNotFound, err, "a non-member with an own commit anchor")

	_, err = mallory.checkedChanges(t, 0, &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 1, OwnCommitAnchor: anchor[:3]})
	requireCode(t, connect.CodeNotFound, err, "a non-member is refused before the own commit anchor is validated")

	fixture.addMember(t, alice.vaultID, "victor", store.RoleViewer)
	victor := fixture.client(t, "victor", alice.vaultID)
	page, err := victor.anchoredChanges(t, 0, 1, anchor)
	require.NoError(t, err, "a viewer")
	assert.False(t, page.GetDiverged())

	page, err = victor.checkedChanges(t, 0, &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 1, OwnCommitAnchor: anchor})
	require.NoError(t, err, "a viewer with an own commit anchor")
	assert.False(t, page.GetDiverged())
}

// own_commit_seq and own_commit_anchor are bounded: both or neither, a
// 16-byte anchor, and a seq above since_seq and at most MaxInt64.
func TestOwnCommitAnchorIsValidated(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	first := alice.mustCommit(t, alice.create(t, "a.md", alice.content(t, "note")))
	second := alice.mustCommit(t, alice.create(t, "b.md", alice.content(t, "note")))
	anchor := second.GetAnchor()

	tests := []struct {
		name     string
		request  *vaultsyncv1.ListChangesRequest
		diverged bool
		wantErr  require.ErrorAssertionFunc
	}{
		{name: "neither", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1}},
		{name: "from seq 0", request: &vaultsyncv1.ListChangesRequest{OwnCommitSeq: 2, OwnCommitAnchor: anchor}},
		{name: "right above the cursor", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, SinceAnchor: first.GetAnchor(), OwnCommitSeq: 2, OwnCommitAnchor: anchor}},
		{name: "at the highest seq", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitSeq: math.MaxInt64, OwnCommitAnchor: anchor}, diverged: true},
		{name: "above the highest seq", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitSeq: math.MaxInt64 + 1, OwnCommitAnchor: anchor}, wantErr: invalidArgument},
		{name: "at the cursor", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 2, OwnCommitSeq: 2, OwnCommitAnchor: anchor}, wantErr: invalidArgument},
		{name: "below the cursor", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 2, OwnCommitSeq: 1, OwnCommitAnchor: first.GetAnchor()}, wantErr: invalidArgument},
		{name: "seq without anchor", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitSeq: 2}, wantErr: invalidArgument},
		{name: "anchor without seq", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitAnchor: anchor}, wantErr: invalidArgument},
		{name: "15 bytes", request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitSeq: 2, OwnCommitAnchor: anchor[:15]}, wantErr: invalidArgument},
		{
			name:    "17 bytes",
			request: &vaultsyncv1.ListChangesRequest{SinceSeq: 1, OwnCommitSeq: 2, OwnCommitAnchor: append(append([]byte(nil), anchor...), 0)},
			wantErr: invalidArgument,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			page, err := alice.checkedChanges(t, 0, test.request)
			test.wantErr(t, err)

			if err == nil {
				assert.Equal(t, test.diverged, page.GetDiverged())
			}
		})
	}
}

func invalidArgument(t require.TestingT, err error, msgAndArgs ...any) {
	require.Error(t, err, msgAndArgs...)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), msgAndArgs...)
}
