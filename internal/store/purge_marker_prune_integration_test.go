//go:build integration

package store_test

import (
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// markerHorizon is the horizon the pruning tests use, the default.
const markerHorizon = 365 * day

// ageMarker sets the purged_at of the vault's marker at seq to expression.
func (fixture *commitFixture) ageMarker(t *testing.T, seq int64, expression string) {
	t.Helper()

	tag, err := fixture.pool.Exec(t.Context(), `UPDATE purged_revisions SET purged_at = `+expression+` WHERE vault_id = $1 AND seq = $2`,
		fixture.vault.VaultID(), seq)
	require.NoError(t, err)
	require.EqualValues(t, 1, tag.RowsAffected(), "the marker at seq %d exists", seq)
}

// markerSeqs returns the seqs of the vault's purge markers, ascending.
func (fixture *commitFixture) markerSeqs(t *testing.T) []int64 {
	t.Helper()

	var seqs []int64

	err := fixture.pool.QueryRow(t.Context(),
		`SELECT COALESCE(array_agg(seq ORDER BY seq), '{}') FROM purged_revisions WHERE vault_id = $1`, fixture.vault.VaultID()).Scan(&seqs)
	require.NoError(t, err)

	return seqs
}

// Issue #514: a purge marker records when it was written, and pruning
// deletes the markers older than the horizon in bounded batches, oldest
// first, and keeps the younger ones. A device whose cursor sat on a pruned
// marker's revision is then told its cursor diverged, so it resyncs; one
// whose cursor sits on a kept marker pulls on.
func TestPruneMarkersRemovesOnlyMarkersPastTheHorizon(t *testing.T) {
	fixture := newCommitFixture(t)

	// Seven revisions of one document in one day of the daily zone, and a
	// head: the six older ones are purged.
	created := make([]string, 7)
	for index := range created {
		created[index] = fmt.Sprintf(dailyDay+` + interval '%d minutes'`, index)
	}

	revisions := fixture.history(t, "a.md", append(created, `now()`))
	require.Equal(t, 6, fixture.purge(t, defaultPolicy))

	purged := revisions[:6]
	require.Equal(t, []int64{purged[0].Seq, purged[1].Seq, purged[2].Seq, purged[3].Seq, purged[4].Seq, purged[5].Seq}, fixture.markerSeqs(t))

	pruned, err := store.New(fixture.pool).PruneMarkers(t.Context(), markerHorizon, 100)
	require.NoError(t, err)
	require.Zero(t, pruned, "markers just written are younger than the horizon")

	// Four markers past the horizon, written at different times; the
	// youngest of them just past it. Two inside it, one just inside.
	fixture.ageMarker(t, purged[0].Seq, `now() - interval '400 days'`)
	fixture.ageMarker(t, purged[1].Seq, `now() - interval '366 days'`)
	fixture.ageMarker(t, purged[2].Seq, `now() - interval '380 days'`)
	fixture.ageMarker(t, purged[3].Seq, `now() - interval '365 days' - interval '1 second'`)
	fixture.ageMarker(t, purged[4].Seq, `now() - interval '365 days' + interval '1 minute'`)

	// Batches of three: three of the four old markers, oldest first, then
	// the last one, then none.
	for index, want := range []struct {
		pruned int
		left   []int64
	}{
		{3, []int64{purged[3].Seq, purged[4].Seq, purged[5].Seq}},
		{1, []int64{purged[4].Seq, purged[5].Seq}},
		{0, []int64{purged[4].Seq, purged[5].Seq}},
	} {
		pruned, err := store.New(fixture.pool).PruneMarkers(t.Context(), markerHorizon, 3)
		require.NoError(t, err)
		assert.Equal(t, want.pruned, pruned, "call %d", index)
		assert.Equal(t, want.left, fixture.markerSeqs(t), "call %d", index)
	}

	tests := []struct {
		name     string
		cursor   store.Revision
		diverged bool
	}{
		{name: "cursor on a pruned marker's revision", cursor: purged[0], diverged: true},
		{name: "cursor on the revision whose marker was just past the horizon", cursor: purged[3], diverged: true},
		{name: "cursor on a marker just inside the horizon", cursor: purged[4]},
		{name: "cursor on a marker written now", cursor: purged[5]},
		{name: "cursor on a live revision", cursor: revisions[6]},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changes, err := fixture.vault.ListChanges(t.Context(), test.cursor.Seq,
				[]store.SeqAnchor{{Seq: test.cursor.Seq, Anchor: test.cursor.Anchor}}, 100)
			require.NoError(t, err)
			assert.Equal(t, test.diverged, changes.Diverged)
		})
	}
}

// The batch bound is exact: a limit of N deletes N of N+1 old markers, and
// a limit of N+1 deletes them all.
func TestPruneMarkersBatchBound(t *testing.T) {
	fixture := newCommitFixture(t)

	_, err := fixture.pool.Exec(t.Context(), `
		INSERT INTO purged_revisions (vault_id, seq, anchor, purged_at)
		SELECT $1, seq, gen_random_uuid(), now() - interval '400 days' - (6 - seq) * interval '1 minute'
		FROM generate_series(1, 5) AS seq`, fixture.vault.VaultID())
	require.NoError(t, err)

	queries := store.New(fixture.pool)

	pruned, err := queries.PruneMarkers(t.Context(), markerHorizon, 4)
	require.NoError(t, err)
	assert.Equal(t, 4, pruned)
	assert.Equal(t, []int64{5}, fixture.markerSeqs(t), "the oldest first: the youngest is left")

	_, err = fixture.pool.Exec(t.Context(), `
		INSERT INTO purged_revisions (vault_id, seq, anchor, purged_at)
		SELECT $1, seq, gen_random_uuid(), now() - interval '400 days' FROM generate_series(6, 9) AS seq`, fixture.vault.VaultID())
	require.NoError(t, err)

	pruned, err = queries.PruneMarkers(t.Context(), markerHorizon, 5)
	require.NoError(t, err)
	assert.Equal(t, 5, pruned)
	assert.Empty(t, fixture.markerSeqs(t))
}

// HA (SPEC.md §12): every replica prunes at the same time. Concurrent
// pruning never fails, never waits on another replica's batch, and removes
// exactly what one run removes: each old marker once, no young one.
func TestConcurrentPruneMarkersActsAsOne(t *testing.T) {
	fixture := newCommitFixture(t)

	const old, young = 200, 20

	_, err := fixture.pool.Exec(t.Context(), `
		INSERT INTO purged_revisions (vault_id, seq, anchor, purged_at)
		SELECT $1, seq, gen_random_uuid(),
			CASE WHEN seq <= $2 THEN now() - interval '400 days' - seq * interval '1 minute' ELSE now() END
		FROM generate_series(1, $3::bigint) AS seq`, fixture.vault.VaultID(), old, old+young)
	require.NoError(t, err)

	const replicas = 4

	var (
		mutex sync.Mutex
		total int
		group sync.WaitGroup
	)

	for range replicas {
		// Each replica has its own pool, as separate server processes do.
		pool, err := pgxpool.NewWithConfig(t.Context(), fixture.pool.Config())
		require.NoError(t, err)
		t.Cleanup(pool.Close)

		queries := store.New(pool)

		group.Go(func() {
			for {
				pruned, err := queries.PruneMarkers(t.Context(), markerHorizon, 7)
				if !assert.NoError(t, err, "a replica never fails because another pruned first") {
					return
				}

				mutex.Lock()
				total += pruned
				mutex.Unlock()

				if pruned == 0 {
					return
				}
			}
		})
	}

	group.Wait()

	assert.Equal(t, old, total, "each old marker is pruned exactly once")

	want := make([]int64, 0, young)
	for seq := int64(old + 1); seq <= old+young; seq++ {
		want = append(want, seq)
	}

	assert.Equal(t, want, fixture.markerSeqs(t), "every young marker is kept")
}

// HA (SPEC.md §11, §12): pruning never waits on markers another
// transaction holds locked, such as another replica's batch. It skips them
// and fills its batch with the other old markers, and the skipped ones are
// pruned once released. The pruning pool's lock_timeout turns a call that
// waits into an error instead of a hang, so the test does not depend on how
// fast the call returns.
func TestPruneMarkersSkipsLockedMarkers(t *testing.T) {
	fixture := newCommitFixture(t)

	// Seqs 1 to 5 past the horizon, oldest first; 6 and 7 young.
	_, err := fixture.pool.Exec(t.Context(), `
		INSERT INTO purged_revisions (vault_id, seq, anchor, purged_at)
		SELECT $1, seq, gen_random_uuid(),
			CASE WHEN seq <= 5 THEN now() - interval '400 days' + seq * interval '1 minute' ELSE now() END
		FROM generate_series(1, 7) AS seq`, fixture.vault.VaultID())
	require.NoError(t, err)

	config := fixture.pool.Config()
	config.ConnConfig.RuntimeParams["lock_timeout"] = "5s"

	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	queries := store.New(pool)

	// Another transaction holds the two oldest markers.
	holder, err := fixture.pool.Begin(t.Context())
	require.NoError(t, err)

	defer func() { _ = holder.Rollback(t.Context()) }()

	var locked []int64

	err = holder.QueryRow(t.Context(), `
		SELECT array_agg(seq ORDER BY seq) FROM (
			SELECT seq FROM purged_revisions WHERE vault_id = $1 AND seq IN (1, 2) FOR UPDATE
		) AS held`, fixture.vault.VaultID()).Scan(&locked)
	require.NoError(t, err)
	require.Equal(t, []int64{1, 2}, locked)

	pruned, err := queries.PruneMarkers(t.Context(), markerHorizon, 3)
	require.NoError(t, err, "pruning never waits on a locked marker")
	assert.Equal(t, 3, pruned, "the batch is filled with the old markers nobody holds")
	assert.Equal(t, []int64{1, 2, 6, 7}, fixture.markerSeqs(t), "the locked and the young markers are kept")

	pruned, err = queries.PruneMarkers(t.Context(), markerHorizon, 3)
	require.NoError(t, err)
	assert.Zero(t, pruned, "only locked markers are left past the horizon")

	require.NoError(t, holder.Rollback(t.Context()))

	pruned, err = queries.PruneMarkers(t.Context(), markerHorizon, 3)
	require.NoError(t, err)
	assert.Equal(t, 2, pruned, "released markers are pruned")
	assert.Equal(t, []int64{6, 7}, fixture.markerSeqs(t))
}
