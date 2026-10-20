//go:build integration

package retention_test

import (
	"context"
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

	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), policy, later))
	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), policy, earlier))
	assert.True(t, later.Equal(fixture.scannedThrough(t)), "an earlier scan does not move the record back")

	changed := store.RetentionPolicy{KeepAll: policy.KeepAll + time.Hour, KeepDaily: policy.KeepDaily}
	require.NoError(t, fixture.store.CompleteRetentionScan(t.Context(), changed, earlier))
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
		"vault_sync_retention_run_failures_total":    1,
	}, counters())
}
