// Package retention runs the server's retention job (SPEC.md §11): it purges
// the revisions the retention policy no longer keeps and then garbage-
// collects the blobs no revision references any more, once their grace
// period has passed.
package retention

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Defaults. Each run's work is bounded so that a backlog (for example the
// first run against a long history) is worked off over several runs.
const (
	// DefaultKeepAll keeps every revision for 90 days.
	DefaultKeepAll = 90 * 24 * time.Hour
	// DefaultKeepDaily thins revisions to one a day until they are a year
	// old, and to one a week after that.
	DefaultKeepDaily = 365 * 24 * time.Hour
	// DefaultGrace is how long a blob stays after the purge of the last
	// revision referencing it.
	DefaultGrace = 24 * time.Hour
	// DefaultInterval is how often Run starts a run.
	DefaultInterval = time.Hour
	// DefaultRunTimeout bounds one run started by Run: with the default
	// interval, a stuck run ends when the next one is due.
	DefaultRunTimeout = DefaultInterval
	// DefaultDocumentsPerRun bounds how many documents one run purges.
	DefaultDocumentsPerRun = 1000
	// DefaultRevisionsPerDocument bounds how many revisions one
	// transaction purges from a document.
	DefaultRevisionsPerDocument = 1000
	// DefaultBlobsPerRun bounds how many blobs one run collects, and how
	// many objects it deletes.
	DefaultBlobsPerRun = 1000
	// DefaultMarkerHorizon is how long a purge marker is kept: a device
	// that has not pulled for this long after a purge resyncs once instead
	// of pulling on (SPEC.md §11).
	DefaultMarkerHorizon = 365 * 24 * time.Hour
	// DefaultMarkersPerBatch bounds how many purge markers one statement
	// prunes.
	DefaultMarkersPerBatch = 1000
	// DefaultMarkersPerRun bounds how many purge markers one run prunes,
	// so a backlog is worked off over several runs.
	DefaultMarkersPerRun = 100_000
)

// Job purges revisions and collects blobs.
//
// Every server process runs a Job, at the same time and without
// coordinating except through PostgreSQL: each document is purged, and each
// blob collected and its object deleted, by whichever process locks it
// first (SKIP LOCKED), and every step is idempotent, so concurrent runs
// have the effect of one and never report another's work as a failure.
type Job struct {
	Store *store.Store
	// Objects deletes collected blobs' objects. When nil, the job only
	// purges revisions.
	Objects *blobstore.Objects
	Policy  store.RetentionPolicy
	// Grace is how long a blob no revision references is kept after the
	// purge that released it.
	Grace time.Duration
	// Per-run bounds; zero selects the defaults.
	DocumentsPerRun      int
	RevisionsPerDocument int
	BlobsPerRun          int
	MarkersPerBatch      int
	MarkersPerRun        int
	// MarkerHorizon is how long a purge marker is kept after its purge;
	// zero selects DefaultMarkerHorizon.
	MarkerHorizon time.Duration
	// RunTimeout bounds each run started by Run; zero selects
	// DefaultRunTimeout.
	RunTimeout time.Duration
	// Metrics, if set, count the work and failures of runs started by Run.
	Metrics *Metrics
	Logger  *slog.Logger
}

// Result reports one run's work.
type Result struct {
	// RevisionsPurged counts revisions this run deleted.
	RevisionsPurged int
	// BlobsCollected counts blob rows this run deleted.
	BlobsCollected int
	// ObjectsDeleted counts collected blobs' objects this run deleted.
	ObjectsDeleted int
	// MarkersPruned counts purge markers this run deleted.
	MarkersPruned int
}

// RunOnce performs one bounded pass: purge, then prune purge markers past
// the horizon, then collect, then delete collected objects, and records it in Metrics. A run that fails in part
// counts as a failure unless ctx was canceled (the server is stopping).
// Not safe for concurrent use with itself; separate server processes may
// run it concurrently.
func (job *Job) RunOnce(ctx context.Context) (Result, error) {
	result, err := job.runOnce(ctx)
	job.Metrics.observe(result, err != nil && !errors.Is(ctx.Err(), context.Canceled))

	return result, err
}

func (job *Job) runOnce(ctx context.Context) (Result, error) {
	var (
		result   Result
		problems []error
	)

	documents := orDefault(job.DocumentsPerRun, DefaultDocumentsPerRun)

	scan, err := job.Store.RetentionCandidates(ctx, job.Policy, documents)
	// The scan is complete if it found every candidate and every one was
	// purged fully; later scans then only consider what changed since.
	complete := err == nil && len(scan.Documents) < documents

	if err != nil {
		problems = append(problems, err)
	}

	revisions := orDefault(job.RevisionsPerDocument, DefaultRevisionsPerDocument)

	var skipped []store.DocumentRef

	for _, ref := range scan.Documents {
		purged, done, err := job.Store.InVault(ref.VaultID).PurgeRevisions(ctx, ref.DocumentID, job.Policy, revisions)
		result.RevisionsPurged += purged

		switch {
		case err != nil:
			complete = false

			problems = append(problems, err)
		case !done && purged == 0:
			// Locked by a commit or by another server process's purge.
			skipped = append(skipped, ref)
		case !done:
			complete = false
		}
	}

	// Only worth waiting for if the scan can complete: another server
	// process purging the same documents (every replica runs the job at
	// about the same time) leaves them done, and a commit holds the lock
	// briefly.
	for _, ref := range skipped {
		if !complete {
			break
		}

		purged, done, err := job.Store.InVault(ref.VaultID).PurgeRevisionsWaiting(ctx, ref.DocumentID, job.Policy, revisions)
		result.RevisionsPurged += purged
		complete = done && err == nil

		if err != nil {
			problems = append(problems, err)
		}
	}

	if complete {
		if err := job.Store.CompleteRetentionScan(ctx, job.Policy, scan); err != nil {
			problems = append(problems, err)
		}
	}

	pruned, err := job.pruneMarkers(ctx)
	result.MarkersPruned = pruned

	if err != nil {
		problems = append(problems, err)
	}

	if job.Objects == nil {
		return result, errors.Join(problems...)
	}

	blobs := orDefault(job.BlobsPerRun, DefaultBlobsPerRun)

	released, err := job.Store.ReleasedBlobs(ctx, job.Grace, blobs)
	if err != nil {
		problems = append(problems, err)
	}

	for _, ref := range released {
		collected, err := job.Store.InVault(ref.VaultID).CollectBlob(ctx, ref.BlobID, job.Grace)
		if err != nil {
			problems = append(problems, err)

			continue
		}

		if collected {
			result.BlobsCollected++
		}
	}

	pending, err := job.Store.PendingBlobDeletions(ctx, blobs)
	if err != nil {
		problems = append(problems, err)
	}

	for _, ref := range pending {
		key := blobstore.BlobKey(ref.VaultID, ref.BlobID)

		deleted, err := job.Store.InVault(ref.VaultID).DeleteBlobObject(ctx, ref.BlobID,
			func(ctx context.Context) error { return job.Objects.Delete(ctx, key) })
		if err != nil {
			problems = append(problems, err)

			continue
		}

		if deleted {
			result.ObjectsDeleted++
		}
	}

	return result, errors.Join(problems...)
}

// Run calls RunOnce every interval, starting at once, until ctx is
// canceled, logging failures. Each run is cut short after RunTimeout;
// cutting a run short is safe, since every step is its own transaction and
// idempotent.
func (job *Job) Run(ctx context.Context, interval time.Duration) {
	logger := job.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	runTimeout := job.RunTimeout
	if runTimeout <= 0 {
		runTimeout = DefaultRunTimeout
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		runCtx, cancel := context.WithTimeout(ctx, runTimeout)
		result, err := job.RunOnce(runCtx)

		cancel()

		if err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "retention run failed; retrying next run", "error", err)
		}

		if result != (Result{}) {
			logger.InfoContext(ctx, "applied the retention policy",
				"revisions", result.RevisionsPurged, "purge_markers", result.MarkersPruned, "blobs", result.BlobsCollected, "objects", result.ObjectsDeleted)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pruneMarkers deletes purge markers older than the horizon in batches,
// until a batch finds fewer than it may delete or the run's bound is
// reached.
func (job *Job) pruneMarkers(ctx context.Context) (int, error) {
	horizon := job.MarkerHorizon
	if horizon <= 0 {
		horizon = DefaultMarkerHorizon
	}

	batch := orDefault(job.MarkersPerBatch, DefaultMarkersPerBatch)
	remaining := orDefault(job.MarkersPerRun, DefaultMarkersPerRun)
	pruned := 0

	for remaining > 0 {
		limit := min(batch, remaining)

		deleted, err := job.Store.PruneMarkers(ctx, horizon, limit)
		pruned += deleted
		remaining -= limit

		if err != nil {
			return pruned, err
		}

		if deleted < limit {
			break
		}
	}

	return pruned, nil
}

func orDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}

	return value
}
