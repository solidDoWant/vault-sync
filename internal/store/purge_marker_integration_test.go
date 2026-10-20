//go:build integration

package store_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// markers returns the vault's purge markers, by seq.
func (fixture *commitFixture) markers(t *testing.T) map[int64]uuid.UUID {
	t.Helper()

	rows, err := fixture.pool.Query(t.Context(), `SELECT seq, anchor FROM purged_revisions WHERE vault_id = $1`, fixture.vault.VaultID())
	require.NoError(t, err)

	type marker struct {
		Seq    int64
		Anchor uuid.UUID
	}

	collected, err := pgx.CollectRows(rows, pgx.RowToStructByPos[marker])
	require.NoError(t, err)

	markers := map[int64]uuid.UUID{}
	for _, row := range collected {
		markers[row.Seq] = row.Anchor
	}

	return markers
}

// Issues #488, #494: purging a revision keeps its seq and anchor as a purge
// marker, so ListChanges still accepts an anchor of the purged revision (at
// the cursor, or as the client's own commit) and reports no divergence. An
// anchor the vault holds neither as a revision nor as a marker at its seq
// still diverges, whichever of the two checks it is.
func TestPurgeKeepsAMarkerTheAnchorCheckAccepts(t *testing.T) {
	fixture := newCommitFixture(t)

	// A → B → C (head): A and B are in one day of the daily zone, so A is
	// purged; B is kept as the day's newest. D is another document.
	revisions := fixture.history(t, "a.md", []string{
		dailyDay + ` + interval '1 hour'`, dailyDay + ` + interval '2 hours'`, `now()`,
	})
	other := fixture.commit(t, fixture.create("b.md", "b.md"))
	purged, kept, head := revisions[0], revisions[1], revisions[2]

	require.Empty(t, fixture.markers(t), "no purge yet")
	require.Equal(t, 1, fixture.purge(t, defaultPolicy))

	_, err := fixture.vault.Revision(t.Context(), purged.ID)
	require.ErrorIs(t, err, store.ErrNotFound, "the revision is purged")
	assert.Equal(t, map[int64]uuid.UUID{purged.Seq: purged.Anchor}, fixture.markers(t), "exactly the purged revision's seq and anchor are kept")

	stranger := uuid.New()

	tests := []struct {
		name     string
		since    int64
		anchors  []store.SeqAnchor
		diverged bool
	}{
		{name: "no anchor", since: purged.Seq},
		{name: "cursor at a purged revision", since: purged.Seq, anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: purged.Anchor}}},
		{name: "cursor at a live revision", since: kept.Seq, anchors: []store.SeqAnchor{{Seq: kept.Seq, Anchor: kept.Anchor}}},
		{
			name: "own commit purged above the cursor", since: 0,
			anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: purged.Anchor}},
		},
		{
			name: "own commit live above the cursor", since: purged.Seq,
			anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: purged.Anchor}, {Seq: other.Seq, Anchor: other.Anchor}},
		},
		{name: "another anchor at a purged seq", since: purged.Seq, anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: stranger}}, diverged: true},
		{name: "another anchor at a live seq", since: kept.Seq, anchors: []store.SeqAnchor{{Seq: kept.Seq, Anchor: head.Anchor}}, diverged: true},
		{
			name: "the purged revision's anchor at another seq", since: kept.Seq,
			anchors: []store.SeqAnchor{{Seq: kept.Seq, Anchor: purged.Anchor}}, diverged: true,
		},
		{
			name: "own commit not held while the cursor is", since: purged.Seq,
			anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: purged.Anchor}, {Seq: other.Seq, Anchor: stranger}}, diverged: true,
		},
		{
			name: "own commit above the head", since: purged.Seq,
			anchors: []store.SeqAnchor{{Seq: purged.Seq, Anchor: purged.Anchor}, {Seq: other.Seq + 1, Anchor: other.Anchor}}, diverged: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changes, err := fixture.vault.ListChanges(t.Context(), test.since, test.anchors, 100)
			require.NoError(t, err)
			assert.Equal(t, test.diverged, changes.Diverged)
			assert.Equal(t, other.Seq, changes.HeadSeq)

			if test.diverged {
				assert.Empty(t, changes.Revisions)
				assert.False(t, changes.HasMore)

				return
			}

			var seqs []int64
			for _, revision := range changes.Revisions {
				seqs = append(seqs, revision.Seq)
			}

			var want []int64

			for _, revision := range []store.Revision{kept, head, other} {
				if revision.Seq > test.since {
					want = append(want, revision.Seq)
				}
			}

			assert.Equal(t, want, seqs)
		})
	}
}
