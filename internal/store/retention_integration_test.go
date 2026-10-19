//go:build integration

package store_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

const day = 24 * time.Hour

// defaultPolicy is the default retention policy: everything for 90 days,
// then daily until a year, then weekly.
var defaultPolicy = store.RetentionPolicy{KeepAll: 90 * day, KeepDaily: 365 * day}

// history commits one revision of a new document per entry of created, in
// order, and then sets each revision's created_at to the SQL expression in
// created (evaluated by the database, so relative to its clock). Entries
// must be in ascending time order, as commits are. It returns the
// revisions.
func (fixture *commitFixture) history(t *testing.T, path string, created []string) []store.Revision {
	t.Helper()

	var revisions []store.Revision

	for index, expression := range created {
		var revision store.NewRevision
		if index == 0 {
			revision = fixture.create(path, path)
		} else {
			revision = fixture.next(revisions[index-1], path, fixture.content, 7)
		}

		committed := fixture.commit(t, revision)
		fixture.setCreated(t, committed.ID, expression)
		revisions = append(revisions, committed)
	}

	return revisions
}

func (fixture *commitFixture) setCreated(t *testing.T, revisionID uuid.UUID, expression string) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE revisions SET created_at = `+expression+` WHERE id = $1`, revisionID)
	require.NoError(t, err)
}

// purge applies policy until no document has revisions it purges, as the
// retention job does, and returns how many revisions were purged.
func (fixture *commitFixture) purge(t *testing.T, policy store.RetentionPolicy) int {
	t.Helper()

	queries := store.New(fixture.pool)
	total := 0

	for range 10 {
		refs, err := queries.RetentionCandidates(t.Context(), policy, 100)
		require.NoError(t, err)

		if len(refs) == 0 {
			return total
		}

		for _, ref := range refs {
			purged, err := queries.InVault(ref.VaultID).PurgeRevisions(t.Context(), ref.DocumentID, policy, 1000)
			require.NoError(t, err)

			total += purged
		}
	}

	require.Fail(t, "retention did not converge")

	return total
}

// retained returns the ids of documentID's revisions, oldest first, after
// checking that the parent chain from the head visits exactly them: every
// parent_rev_id names a retained revision, the next older one, and the
// oldest has none.
func (fixture *commitFixture) retained(t *testing.T, documentID uuid.UUID) []uuid.UUID {
	t.Helper()

	history, err := fixture.vault.DocumentHistory(t.Context(), documentID, 0, 1000)
	require.NoError(t, err)
	require.NotEmpty(t, history.Revisions)
	assert.Equal(t, history.Document.HeadRevID, history.Revisions[0].ID, "the newest revision is the head")

	ids := make([]uuid.UUID, len(history.Revisions))

	for index, revision := range history.Revisions {
		ids[len(ids)-1-index] = revision.ID

		if index+1 < len(history.Revisions) {
			assert.Equal(t, uuid.NullUUID{UUID: history.Revisions[index+1].ID, Valid: true}, revision.ParentRevID,
				"revision %d's parent is the next older retained revision", revision.Seq)
		} else {
			assert.False(t, revision.ParentRevID.Valid, "the oldest retained revision has no parent")
		}
	}

	return ids
}

func revisionIDsOf(revisions []store.Revision, indexes ...int) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(indexes))
	for _, index := range indexes {
		ids = append(ids, revisions[index].ID)
	}

	return ids
}

// The UTC day 100 days ago: in the daily zone of the default policy.
const dailyDay = `date_trunc('day', now() - interval '100 days', 'UTC')`

// Issue #58: purging a revision that is the parent of another succeeds, the
// head stays the head, and no retained revision's parent_rev_id names a
// revision that no longer exists. The child is re-parented onto the nearest
// retained ancestor, or has no parent if none is left.
func TestPurgeReparentsTheChildOfAPurgedRevision(t *testing.T) {
	tests := []struct {
		name    string
		created []string
		// wantKept indexes created.
		wantKept []int
	}{
		{
			// A (its own day) → B → C (head, B's day): B is purged and C's
			// parent becomes A.
			name:     "the middle of a chain",
			created:  []string{dailyDay + ` - interval '1 hour'`, dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`},
			wantKept: []int{0, 2},
		},
		{
			// A → B → C → D (head, today): A and B are purged, so C has no
			// parent left.
			name:     "the start of a chain",
			created:  []string{dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`, dailyDay + ` + interval '3 hours'`, `now()`},
			wantKept: []int{2, 3},
		},
		{
			// Every other revision of a long chain: each purge re-parents
			// onto a revision purged earlier in the same transaction.
			name: "consecutive revisions",
			created: []string{
				dailyDay + ` - interval '2 days'`, dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`,
				dailyDay + ` + interval '3 hours'`, dailyDay + ` + interval '1 day'`, `now()`,
			},
			wantKept: []int{0, 3, 4, 5},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCommitFixture(t)
			revisions := fixture.history(t, "a.md", test.created)
			head := revisions[len(revisions)-1]

			assert.Equal(t, len(revisions)-len(test.wantKept), fixture.purge(t, defaultPolicy))

			document, err := fixture.vault.Document(t.Context(), head.DocumentID)
			require.NoError(t, err)
			assert.Equal(t, head.ID, document.HeadRevID, "the head is unchanged")

			assert.Equal(t, revisionIDsOf(revisions, test.wantKept...), fixture.retained(t, head.DocumentID))

			for index, revision := range revisions {
				_, err := fixture.vault.Revision(t.Context(), revision.ID)
				if slices.Contains(test.wantKept, index) {
					assert.NoError(t, err, "revision %d is kept", index)
				} else {
					assert.ErrorIs(t, err, store.ErrNotFound, "revision %d is purged", index)
				}
			}
		})
	}
}

// Issue #26 criterion 3 (decision on #52): a document's head revision is
// never purged, however old, whether it is live or a tombstone; deleted
// documents keep their tombstone indefinitely. Older non-head revisions and
// tombstones are purged by the policy.
func TestRetentionNeverPurgesHeads(t *testing.T) {
	fixture := newCommitFixture(t)

	const ancient = `now() - interval '1000 days'`

	// A document whose only revision is ancient.
	lone := fixture.history(t, "lone.md", []string{ancient})

	// A live head in the same week as older revisions of its document,
	// including a tombstone that was later undone.
	resurrected := fixture.history(t, "resurrected.md", []string{ancient, ancient, ancient})
	tombstone := fixture.next(resurrected[2], "resurrected.md", nil, 0)
	deletedOnce := fixture.commit(t, tombstone)
	fixture.setCreated(t, deletedOnce.ID, ancient)
	live := fixture.commit(t, fixture.next(deletedOnce, "resurrected.md", fixture.content, 7))
	fixture.setCreated(t, live.ID, ancient)

	// A tombstone head, alone in its document and after older revisions in
	// its bucket.
	gone := fixture.history(t, "gone.md", []string{ancient})
	goneHead := fixture.commit(t, fixture.next(gone[0], "gone.md", nil, 0))
	fixture.setCreated(t, goneHead.ID, ancient)

	deleted := fixture.history(t, "deleted.md", []string{dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`})
	deletedHead := fixture.commit(t, fixture.next(deleted[1], "deleted.md", nil, 0))
	fixture.setCreated(t, deletedHead.ID, dailyDay+` + interval '3 hours'`)

	assert.Equal(t, 7, fixture.purge(t, defaultPolicy))

	for _, head := range []store.Revision{lone[0], live, goneHead, deletedHead} {
		document, err := fixture.vault.Document(t.Context(), head.DocumentID)
		require.NoError(t, err)
		assert.Equal(t, head.ID, document.HeadRevID)
		assert.Equal(t, head.Deleted, document.Deleted)
		assert.Equal(t, []uuid.UUID{head.ID}, fixture.retained(t, head.DocumentID), "only the head is left of %s", head.Path)
	}

	_, err := fixture.vault.Revision(t.Context(), deletedOnce.ID)
	require.ErrorIs(t, err, store.ErrNotFound, "a tombstone that is not the head is purged")

	// Nothing is left to purge, however often retention runs.
	refs, err := store.New(fixture.pool).RetentionCandidates(t.Context(), defaultPolicy, 100)
	require.NoError(t, err)
	assert.Empty(t, refs)

	for _, head := range []store.Revision{lone[0], live, goneHead, deletedHead} {
		purged, err := fixture.vault.PurgeRevisions(t.Context(), head.DocumentID, defaultPolicy, 1000)
		require.NoError(t, err)
		assert.Zero(t, purged)
	}
}

// The policy at its boundaries (SPEC.md §11): every revision younger than
// KeepAll is kept; older ones are thinned to the newest of each UTC day
// while younger than KeepDaily, and to the newest of each ISO week (from
// Monday, UTC) after that. A revision is in one zone or the other, never
// both, so a day and the week starting on it are separate buckets.
func TestRetentionPolicyBoundaries(t *testing.T) {
	t.Run("keep everything", func(t *testing.T) {
		fixture := newCommitFixture(t)

		// The two oldest are in the same UTC day, just older than
		// KeepAll; the next two are just younger.
		const justOlder = `now() - interval '90 days 1 second'`

		revisions := fixture.history(t, "a.md", []string{
			`GREATEST(date_trunc('day', ` + justOlder + `, 'UTC'), now() - interval '90 days 2 seconds')`,
			justOlder,
			`now() - interval '90 days' + interval '1 minute'`,
			`now() - interval '90 days' + interval '2 minutes'`,
			`now()`,
		})

		assert.Equal(t, 1, fixture.purge(t, defaultPolicy))
		assert.Equal(t, revisionIDsOf(revisions, 1, 2, 3, 4), fixture.retained(t, revisions[0].DocumentID))
	})

	t.Run("days and weeks", func(t *testing.T) {
		fixture := newCommitFixture(t)

		// KeepDaily ends at noon on a Monday 30 days ago.
		var keepDaily time.Duration

		require.NoError(t, fixture.pool.QueryRow(t.Context(), `
			SELECT (extract(epoch FROM now() - (date_trunc('week', now() - interval '30 days', 'UTC') + interval '12 hours')) * 1000000)::bigint`).
			Scan((*int64)(&keepDaily)))
		keepDaily *= time.Microsecond

		policy := store.RetentionPolicy{KeepAll: day, KeepDaily: keepDaily}

		const monday = `date_trunc('week', now() - interval '30 days', 'UTC')`

		at := func(offset string) string { return monday + ` + interval '` + offset + `'` }

		revisions := fixture.history(t, "a.md", []string{
			at("-1 day -2 hours"), // 0: the previous week (a Saturday): purged
			at("-1 hour"),         // 1: the newest of the previous week (a Sunday): kept
			at("6 hours"),         // 2: weekly zone, this week: purged
			at("11 hours 59 min"), // 3: the newest of this week's weekly zone: kept
			at("12 hours 1 min"),  // 4: daily zone, Monday: purged
			at("18 hours"),        // 5: the newest of Monday: kept
			at("1 day 6 hours"),   // 6: Tuesday: purged
			at("1 day 7 hours"),   // 7: the newest of Tuesday: kept
			at("6 days 10 hours"), // 8: Sunday, the same ISO week: purged
			at("6 days 11 hours"), // 9: the newest of Sunday: kept
			`now()`,               // 10: the head
		})

		assert.Equal(t, 5, fixture.purge(t, policy))
		assert.Equal(t, revisionIDsOf(revisions, 1, 3, 5, 7, 9, 10), fixture.retained(t, revisions[0].DocumentID))
	})
}

// Issue #58: a commit whose response was lost, retried after retention
// purged its base, is still recognised as the commit already applied, even
// though the revision has been re-parented since.
func TestCommitRetryAfterItsBaseWasPurged(t *testing.T) {
	fixture := newCommitFixture(t)

	revisions := fixture.history(t, "a.md", []string{dailyDay + ` - interval '1 hour'`, dailyDay + ` + interval '1 hour'`})

	retry := fixture.next(revisions[1], "a.md", fixture.content, 7)
	applied := fixture.commit(t, retry)
	fixture.setCreated(t, applied.ID, dailyDay+` + interval '2 hours'`)

	require.Equal(t, 1, fixture.purge(t, defaultPolicy), "the base is purged")

	got, err := fixture.vault.CommitRevision(t.Context(), retry)
	require.NoError(t, err)
	assert.Equal(t, applied.ID, got.ID)
	assert.Equal(t, uuid.NullUUID{UUID: revisions[0].ID, Valid: true}, got.ParentRevID, "re-parented onto the retained ancestor")

	// The retry must still match in every other field.
	changed := retry
	changed.Path = "b.md"
	changed.PathKey = "b.md"

	_, err = fixture.vault.CommitRevision(t.Context(), changed)
	require.ErrorIs(t, err, store.ErrRevisionConflict)

	// And a base that exists but is not the parent is a conflict.
	other := retry
	other.BaseRevID = uuid.NullUUID{UUID: fixture.commit(t, fixture.create("c.md", "c.md")).ID, Valid: true}

	_, err = fixture.vault.CommitRevision(t.Context(), other)
	require.ErrorIs(t, err, store.ErrRevisionConflict)
}

// HA (SPEC.md §12): a purge never waits for a commit to the same document
// or another server process's purge of it: it skips the locked document,
// and a later run picks it up.
func TestPurgeSkipsALockedDocument(t *testing.T) {
	fixture := newCommitFixture(t)

	revisions := fixture.history(t, "a.md", []string{dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`})
	documentID := revisions[0].DocumentID

	tx, err := fixture.pool.Begin(t.Context())
	require.NoError(t, err)

	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })

	_, err = tx.Exec(t.Context(), `SELECT 1 FROM documents WHERE id = $1 FOR NO KEY UPDATE`, documentID)
	require.NoError(t, err)

	purged, err := fixture.vault.PurgeRevisions(t.Context(), documentID, defaultPolicy, 1000)
	require.NoError(t, err)
	assert.Zero(t, purged, "the locked document is skipped")

	require.NoError(t, tx.Rollback(t.Context()))

	purged, err = fixture.vault.PurgeRevisions(t.Context(), documentID, defaultPolicy, 1000)
	require.NoError(t, err)
	assert.Equal(t, 1, purged)
}

// A purge is bounded per transaction; the rest is purged by later calls.
func TestPurgeIsBounded(t *testing.T) {
	fixture := newCommitFixture(t)

	created := make([]string, 6)
	for index := range created {
		created[index] = fmt.Sprintf(dailyDay+` + interval '%d minutes'`, index)
	}

	revisions := fixture.history(t, "a.md", created)

	for _, want := range []int{2, 2, 1, 0} {
		purged, err := fixture.vault.PurgeRevisions(t.Context(), revisions[0].DocumentID, defaultPolicy, 2)
		require.NoError(t, err)
		assert.Equal(t, want, purged)
	}

	assert.Equal(t, revisionIDsOf(revisions, 5), fixture.retained(t, revisions[0].DocumentID))
}

// Purges release the content of the revisions they delete; a blob found
// referenced again is no longer released.
func TestCollectBlobOnlyTakesUnreferencedBlobsPastTheirGrace(t *testing.T) {
	fixture := newCommitFixture(t)
	old := fixture.addBlob(t, "old content")

	first := fixture.create("a.md", "a.md")
	first.ContentRef, first.ContentSize = old, int64(len("old content"))
	revisions := []store.Revision{fixture.commit(t, first)}
	fixture.setCreated(t, revisions[0].ID, dailyDay+` + interval '1 hour'`)

	second := fixture.commit(t, fixture.next(revisions[0], "a.md", fixture.content, 7))
	fixture.setCreated(t, second.ID, dailyDay+` + interval '2 hours'`)

	require.Equal(t, 1, fixture.purge(t, defaultPolicy))

	releasedAt := func() *time.Time {
		var at *time.Time
		require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT released_at FROM blobs WHERE vault_id = $1 AND blob_id = $2`,
			fixture.vault.VaultID(), old).Scan(&at))

		return at
	}
	require.NotNil(t, releasedAt(), "the purge released the old content")

	collected, err := fixture.vault.CollectBlob(t.Context(), old, time.Hour)
	require.NoError(t, err)
	assert.False(t, collected, "within the grace period")

	_, err = fixture.pool.Exec(t.Context(), `UPDATE blobs SET released_at = now() - interval '2 hours' WHERE blob_id = $1`, old)
	require.NoError(t, err)

	// A commit holding the blob (as every commit referencing it does,
	// until it commits) makes the collector skip it.
	tx, err := fixture.pool.Begin(t.Context())
	require.NoError(t, err)

	t.Cleanup(func() { _ = tx.Rollback(t.Context()) })

	_, err = tx.Exec(t.Context(), `SELECT 1 FROM blobs WHERE vault_id = $1 AND blob_id = $2 FOR KEY SHARE`, fixture.vault.VaultID(), old)
	require.NoError(t, err)

	// Bounded, so a collector that waits for the commit fails instead of
	// hanging: one that skips returns at once.
	skipCtx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	collected, err = fixture.vault.CollectBlob(skipCtx, old, time.Hour)
	require.NoError(t, err, "the collector must not wait for the commit")
	assert.False(t, collected, "a blob a commit holds is skipped")
	require.NoError(t, tx.Rollback(t.Context()))

	// Referenced again by a new revision: not collected, and no longer
	// released.
	fixture.commit(t, fixture.next(second, "a.md", old, int64(len("old content"))))

	collected, err = fixture.vault.CollectBlob(t.Context(), old, time.Hour)
	require.NoError(t, err)
	assert.False(t, collected, "a referenced blob is never collected")
	assert.Nil(t, releasedAt())
}
