//go:build integration

package server_test

import (
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

	response, err := client.sync(replica).ListChanges(t.Context(), authorized(&vaultsyncv1.ListChangesRequest{
		VaultId: client.vaultID, SinceSeq: since, SinceAnchor: anchor,
	}, client.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// restoreTo rolls a vault's database state back to what it was when its
// head_seq was seq, as a restore of a PostgreSQL backup taken then would:
// every revision after seq, and every document created after it, is gone.
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

// Issue #155: retention may purge the revision at a client's cursor. The
// server cannot tell that from a restore, so it reports divergence: a
// false-positive resync, never a skipped revision. A document's head, and so
// the revision at the vault's head_seq, is never purged.
func TestCursorAnchorOfAPurgedRevisionReportsDivergence(t *testing.T) {
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

	page, err = alice.anchoredChanges(t, 0, second.GetSeq(), second.GetAnchor())
	require.NoError(t, err)
	assert.True(t, page.GetDiverged(), "the cursor's revision was purged")
	assert.Empty(t, page.GetRevisions())

	// Retained revisions, and the head, still match.
	for _, revision := range []*vaultsyncv1.Revision{third, head} {
		page, err = alice.anchoredChanges(t, 0, revision.GetSeq(), revision.GetAnchor())
		require.NoError(t, err)
		assert.False(t, page.GetDiverged(), "seq %d", revision.GetSeq())
	}
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

	fixture.addMember(t, alice.vaultID, "victor", store.RoleViewer)
	victor := fixture.client(t, "victor", alice.vaultID)
	page, err := victor.anchoredChanges(t, 0, 1, anchor)
	require.NoError(t, err, "a viewer")
	assert.False(t, page.GetDiverged())
}

func invalidArgument(t require.TestingT, err error, msgAndArgs ...any) {
	require.Error(t, err, msgAndArgs...)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), msgAndArgs...)
}
