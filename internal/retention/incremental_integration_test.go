//go:build integration

package retention_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Issue #225 item 2: a blob uploaded and committed (CommitBlob) that no
// revision ever references is collected once the grace period has passed
// since it was stored, and not before. A blob a revision references is
// kept.
func TestBlobNoRevisionReferencesIsCollectedAfterTheGracePeriod(t *testing.T) {
	fixture := newFixture(t)

	uncommitted := fixture.blob(t, "never committed")
	referenced := fixture.blob(t, "committed")
	fixture.revision(t, nil, "a.md", referenced, len("committed"), `now()`)

	job := fixture.job()

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result, "just stored: kept")

	fixture.releasedAgo(t, "59 minutes")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result, "within the grace period: kept")

	row, object := fixture.stored(t, uncommitted)
	assert.True(t, row && object, "within the grace period: kept")

	fixture.releasedAgo(t, "1 hour 1 second")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{BlobsCollected: 1, ObjectsDeleted: 1}, result)

	row, object = fixture.stored(t, uncommitted)
	assert.False(t, row, "the row is deleted")
	assert.False(t, object, "the object is deleted")

	row, object = fixture.stored(t, referenced)
	assert.True(t, row && object, "a blob a revision references is kept")

	// The referenced blob is no longer released: aging releases changes
	// nothing.
	fixture.releasedAgo(t, "2 hours")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)
}

// scannedThrough returns the end of the last complete retention scan.
func (fixture *fixture) scannedThrough(t *testing.T) time.Time {
	t.Helper()

	var through time.Time
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT scanned_through FROM retention_scans`).Scan(&through))

	return through
}

// purgeable commits a document whose revisions at the SQL times first and
// second (the same UTC day, past KeepAll) leave first purgeable once the
// document has a newer head.
func (fixture *fixture) purgeable(t *testing.T, path, first, second string) {
	t.Helper()

	content := fixture.blob(t, path)
	older := fixture.revision(t, nil, path, content, len(path), first)
	newer := fixture.revision(t, &older, path, content, len(path), second)
	fixture.revision(t, &newer, path, content, len(path), `now()`)
}

// Issue #225 item 3: after a complete scan, the job only considers
// documents with revisions that crossed an age of the policy since; a
// different policy scans everything again.
func TestRetentionScansOnlyWhatCrossedAnAgeSinceTheLastCompleteScan(t *testing.T) {
	fixture := newFixture(t)
	job := fixture.job()

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)

	// Backdated past every age at once, which no revision does by
	// aging: the next scan does not consider it.
	fixture.purgeable(t, "stale.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)

	// Revisions that crossed KeepAll just after the last scan started.
	through := `(SELECT scanned_through FROM retention_scans) - interval '90 days'`
	fixture.purgeable(t, "crossed.md", through, through+` + interval '1 microsecond'`)

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result, "only the revision that crossed KeepAll is purged")

	// A revision crossing KeepDaily joins a weekly bucket.
	weekly := `(SELECT scanned_through FROM retention_scans) - interval '365 days'`
	fixture.purgeable(t, "weekly.md", weekly+` - interval '1 microsecond'`, weekly)

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result, "the revision whose bucket partner crossed KeepDaily is purged")

	changed := fixture.job()
	changed.Policy.KeepAll += time.Hour

	result, err = changed.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result, "a different policy scans every document")
}

// A scan that does not purge every candidate fully is not complete: the
// next run considers every document again.
func TestAnIncompleteRetentionScanIsNotRecorded(t *testing.T) {
	fixture := newFixture(t)

	fixture.purgeable(t, "a.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)
	fixture.purgeable(t, "b.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)
	fixture.purgeable(t, "c.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)

	job := fixture.job()
	job.DocumentsPerRun = 2

	// Two candidates found at the limit of two: there may be more.
	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 2}, result)

	// One found under the limit of two, purged fully: complete.
	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result, "the next run is not incremental")

	first := fixture.scannedThrough(t)

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)
	assert.True(t, fixture.scannedThrough(t).After(first), "each complete scan advances the record")
}

// Concurrent server processes record their own complete scans: the record
// never moves back, and a different policy replaces it.
func TestCompleteRetentionScanNeverMovesBack(t *testing.T) {
	fixture := newFixture(t)
	later := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	earlier := later.Add(-time.Minute)

	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), policy, store.RetentionScan{Started: later}))
	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), policy, store.RetentionScan{Started: earlier}))
	assert.True(t, later.Equal(fixture.scannedThrough(t)), "an earlier scan does not move the record back")

	changed := store.RetentionPolicy{KeepAll: policy.KeepAll + time.Hour, KeepDaily: policy.KeepDaily}
	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), changed, store.RetentionScan{Started: earlier}))
	assert.True(t, earlier.Equal(fixture.scannedThrough(t)), "a different policy replaces the record")
}

// Issue #225 item 4: runs are counted in the retention metrics.
func TestRetentionRunsAreCounted(t *testing.T) {
	fixture := newFixture(t)
	metrics := retention.NewMetrics()
	registry := prometheus.NewRegistry()
	registry.MustRegister(metrics.Collectors()...)

	counters := func() map[string]float64 {
		families, err := registry.Gather()
		require.NoError(t, err)

		values := map[string]float64{}
		for _, family := range families {
			values[family.GetName()] = family.GetMetric()[0].GetCounter().GetValue()
		}

		return values
	}

	job := fixture.job()
	job.Metrics = metrics

	fixture.blob(t, "never committed")
	fixture.purgeable(t, "a.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)
	fixture.purgeable(t, "b.md", oldDay+` + interval '1 hour'`, oldDay+` + interval '2 hours'`)

	_, err := job.RunOnce(t.Context())
	require.NoError(t, err)

	fixture.releasedAgo(t, "2 hours")
	fixture.markersPurgedAgo(t, "366 days")

	_, err = job.RunOnce(t.Context())
	require.NoError(t, err)

	expired, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer cancel()

	_, err = job.RunOnce(expired)
	require.Error(t, err)

	// Shutting down is not a failure.
	canceled, stop := context.WithCancel(t.Context())
	stop()

	_, err = job.RunOnce(canceled)
	require.Error(t, err)

	assert.Equal(t, map[string]float64{
		"vault_sync_retention_revisions_purged_total": 2,
		// The blob never committed; the others are still referenced.
		"vault_sync_retention_blobs_collected_total": 1,
		"vault_sync_retention_objects_deleted_total": 1,
		// The purges' markers, once past the horizon.
		"vault_sync_retention_purge_markers_pruned_total": 2,
		"vault_sync_retention_run_failures_total":         1,
		"vault_sync_retention_vaults_purged_total":        0,
	}, counters())
}

// scans counts the recorded complete retention scans.
func (fixture *fixture) scans(t *testing.T) int {
	t.Helper()

	var count int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM retention_scans`).Scan(&count))

	return count
}

// A document the run could purge only in part (more purgeable revisions
// than RevisionsPerDocument) leaves the scan incomplete: the next run
// considers it again and purges the rest.
func TestAPartlyPurgedDocumentLeavesTheScanIncomplete(t *testing.T) {
	fixture := newFixture(t)

	// Three revisions on one UTC day past KeepAll, then a head: the two
	// older ones are purgeable.
	content := fixture.blob(t, "a.md")
	first := fixture.revision(t, nil, "a.md", content, len("a.md"), oldDay+` + interval '1 hour'`)
	second := fixture.revision(t, &first, "a.md", content, len("a.md"), oldDay+` + interval '2 hours'`)
	third := fixture.revision(t, &second, "a.md", content, len("a.md"), oldDay+` + interval '3 hours'`)
	fixture.revision(t, &third, "a.md", content, len("a.md"), `now()`)

	job := fixture.job()
	job.RevisionsPerDocument = 1

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result)
	assert.Zero(t, fixture.scans(t), "a scan that left a document partly purged is not recorded")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result, "the next run purges the rest")

	// That purge reached the limit too, so only a run finding nothing left
	// knows the document is done.
	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)
	assert.Equal(t, 1, fixture.scans(t), "the document is done: the scan is complete")
}

// A document the run skipped because a commit (or another server process)
// held its lock is purged again, waiting for the lock, before the scan
// counts as complete. If that purge reaches RevisionsPerDocument, the scan
// is not recorded either: the next run considers the document again and
// purges the rest.
func TestALockedDocumentIsPurgedBeforeTheScanIsRecorded(t *testing.T) {
	tests := []struct {
		name string
		// purgeable is how many revisions of the locked document, on one
		// UTC day past KeepAll, are purgeable; one more that day is kept.
		purgeable            int
		revisionsPerDocument int
		// waited is what the run that waited for the lock purges.
		waited int
		// recorded is whether that run records the scan.
		recorded bool
		// later is what each following run purges, in order; after the
		// last, the scan is recorded.
		later []int
		// errorAssertion checks the error of the run that waited;
		// defaults to require.NoError.
		errorAssertion require.ErrorAssertionFunc
	}{
		{
			name:      "purged fully",
			purgeable: 1,
			waited:    1,
			recorded:  true,
		},
		{
			name:                 "purged in part",
			purgeable:            2,
			revisionsPerDocument: 1,
			waited:               1,
			// The rest, at the limit again; then a run finding nothing
			// left.
			later: []int{1, 0},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.errorAssertion == nil {
				test.errorAssertion = require.NoError
			}

			fixture := newFixture(t)

			content := fixture.blob(t, "a.md")

			var parent *store.Revision

			for hour := 1; hour <= test.purgeable+1; hour++ {
				revision := fixture.revision(t, parent, "a.md", content, len("a.md"),
					fmt.Sprintf(`%s + interval '%d hours'`, oldDay, hour))
				parent = &revision
			}

			fixture.revision(t, parent, "a.md", content, len("a.md"), `now()`)

			job := fixture.job()
			job.RevisionsPerDocument = test.revisionsPerDocument

			holder, err := fixture.pool.Begin(t.Context())
			require.NoError(t, err)

			defer func() { _ = holder.Rollback(context.WithoutCancel(t.Context())) }()

			var holderPID int32
			require.NoError(t, holder.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&holderPID))

			_, err = holder.Exec(t.Context(), `SELECT 1 FROM documents WHERE id = $1 FOR NO KEY UPDATE`, parent.DocumentID)
			require.NoError(t, err)

			type outcome struct {
				result retention.Result
				err    error
			}

			finished := make(chan outcome, 1)

			go func() {
				result, err := job.RunOnce(t.Context())
				finished <- outcome{result, err}
			}()

			// Wait until the run waits for the lock this test holds; a run
			// that finishes first did not wait for it.
			fixture.awaitBlockedBy(t, holderPID, func() {
				select {
				case run := <-finished:
					require.Failf(t, "the run finished without waiting for the locked document",
						"result %+v, error %v", run.result, run.err)
				default:
				}
			})

			assert.Zero(t, fixture.scans(t), "not recorded while the document is locked")

			require.NoError(t, holder.Commit(t.Context()))

			run := <-finished
			test.errorAssertion(t, run.err)
			assert.Equal(t, retention.Result{RevisionsPurged: test.waited}, run.result, "the locked document is purged once released")

			if test.recorded {
				assert.Equal(t, 1, fixture.scans(t), "the scan is complete")
			} else {
				assert.Zero(t, fixture.scans(t), "a scan that left the locked document partly purged is not recorded")
			}

			for index, purged := range test.later {
				result, err := job.RunOnce(t.Context())
				require.NoError(t, err)
				assert.Equal(t, retention.Result{RevisionsPurged: purged}, result, "run %d after the wait", index+1)
			}

			assert.Equal(t, 1, fixture.scans(t), "the document is done: the scan is complete")
		})
	}
}

// awaitBlockedBy returns once a PostgreSQL backend waits for a lock that
// the backend pid holds, calling check before each poll. Polls back off to
// at most 50ms apart, so waiting does not keep a pool connection busy; the
// delay only spaces the polls, so nothing depends on it.
func (fixture *fixture) awaitBlockedBy(t *testing.T, pid int32, check func()) {
	t.Helper()

	backoff := time.Millisecond

	for {
		check()

		var waiting bool
		require.NoError(t, fixture.pool.QueryRow(t.Context(),
			`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid)))`,
			pid).Scan(&waiting))

		if waiting {
			return
		}

		timer := time.NewTimer(backoff)

		select {
		case <-t.Context().Done():
			timer.Stop()
			require.FailNow(t, "the test ended before a backend waited for the lock")
		case <-timer.C:
		}

		backoff = min(2*backoff, 50*time.Millisecond)
	}
}
