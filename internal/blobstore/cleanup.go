package blobstore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// Cleanup defaults. Each run's work is bounded so that a backlog is worked
// off over several runs instead of in one long burst.
const (
	DefaultCleanupInterval = 5 * time.Minute
	// DefaultRunTimeout bounds one run started by Run: with the default
	// interval, a stuck run ends when the next one is due.
	DefaultRunTimeout = DefaultCleanupInterval
	// DefaultSessionsPerRun bounds how many upload sessions one run removes.
	DefaultSessionsPerRun = 100
	// DefaultObjectsPerRun bounds how many staged objects one run deletes.
	DefaultObjectsPerRun = 10000
	// DefaultMultipartPagesPerRun bounds how many pages (of up to 1,000) of
	// multipart uploads one run lists.
	DefaultMultipartPagesPerRun = 5
)

// Cleaner removes abandoned upload sessions: sessions idle for longer than
// TTL, and finished sessions whose staged objects could not be removed right
// away. It deletes a session's staged objects first and its row last, so a
// failure part-way is retried by the next run. It also aborts S3 multipart
// uploads (left by an interrupted commit) that are older than TTL and whose
// blob has no session active within TTL: they are invisible and would
// otherwise leak storage.
//
// Every server process runs a Cleaner, at the same time: every step is
// idempotent and a session is claimed atomically, so concurrent cleaners
// (and a commit's own cleanup) do not get in each other's way.
type Cleaner struct {
	Store   *store.Store
	Objects *Objects
	// TTL is how long an upload session may be idle before it is removed.
	// A commit in progress records activity after every part it composes,
	// so it is never idle for longer than one part takes.
	TTL time.Duration
	// Per-run bounds; zero selects the defaults.
	SessionsPerRun       int
	ObjectsPerRun        int
	MultipartPagesPerRun int
	// RunTimeout bounds each run started by Run; zero selects
	// DefaultRunTimeout.
	RunTimeout time.Duration
	Logger     *slog.Logger

	multipart multipartCursor
	// now, if set (by tests only), replaces time.Now for the multipart
	// sweep, which compares it with the object store's timestamps.
	now func() time.Time
}

// CleanupResult reports one run's work.
type CleanupResult struct {
	// SessionsRemoved counts sessions this run removed (objects and row).
	SessionsRemoved int
	// ObjectsDeleted counts staged objects deleted.
	ObjectsDeleted int
	// MultipartAborted counts multipart uploads whose abort the object store
	// acknowledged. When several server processes abort the same upload at
	// the same moment, the store may acknowledge more than one of them
	// (aborting is idempotent), so the counts of concurrent processes can
	// add up to more than the number of uploads.
	MultipartAborted int
}

// RunOnce performs one bounded cleanup pass. Not safe for concurrent use
// with itself; separate server processes may run it concurrently.
func (cleaner *Cleaner) RunOnce(ctx context.Context) (CleanupResult, error) {
	var result CleanupResult

	sessions := orDefault(cleaner.SessionsPerRun, DefaultSessionsPerRun)
	budget := orDefault(cleaner.ObjectsPerRun, DefaultObjectsPerRun)

	refs, err := cleaner.Store.ReapableBlobUploads(ctx, cleaner.TTL, sessions)
	if err != nil {
		return result, err
	}

	var problems []error

	for _, ref := range refs {
		if budget-result.ObjectsDeleted <= 0 {
			break
		}

		vault := cleaner.Store.InVault(ref.VaultID)

		claimed, err := vault.ClaimBlobUploadForRemoval(ctx, ref.ID, cleaner.TTL)
		if err != nil {
			problems = append(problems, err)

			continue
		}

		if !claimed {
			// Became active again since it was listed.
			continue
		}

		deleted, done, err := RemoveFinishedUpload(ctx, vault, cleaner.Objects, ref.ID, budget-result.ObjectsDeleted)
		result.ObjectsDeleted += deleted

		if err != nil {
			problems = append(problems, err)

			continue
		}

		if done {
			result.SessionsRemoved++
		}
	}

	aborted, cursor, err := cleaner.Objects.abortStaleMultipartUploads(ctx, "vaults/", cleaner.clock().Add(-cleaner.TTL),
		cleaner.multipart, orDefault(cleaner.MultipartPagesPerRun, DefaultMultipartPagesPerRun), cleaner.commitInProgress)
	result.MultipartAborted = aborted
	cleaner.multipart = cursor

	if err != nil {
		problems = append(problems, err)
	}

	return result, errors.Join(problems...)
}

// Run calls RunOnce every interval until ctx is canceled, logging failures.
// Each run is cut short after RunTimeout, so a run that is stuck (for
// example behind an object store that stopped answering) fails and is
// logged instead of holding up every later run; with the defaults, it ends
// when the next run is due. Cutting a run short is safe: every step is
// idempotent and a session claimed for removal stays reapable.
func (cleaner *Cleaner) Run(ctx context.Context, interval time.Duration) {
	logger := cleaner.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	runTimeout := cleaner.RunTimeout
	if runTimeout <= 0 {
		runTimeout = DefaultRunTimeout
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		runCtx, cancel := context.WithTimeout(ctx, runTimeout)
		result, err := cleaner.RunOnce(runCtx)

		cancel()

		if err != nil && ctx.Err() == nil {
			logger.WarnContext(ctx, "blob upload cleanup failed; retrying next run", "error", err)
		}

		if result != (CleanupResult{}) {
			logger.InfoContext(ctx, "removed abandoned blob uploads",
				"sessions", result.SessionsRemoved, "objects", result.ObjectsDeleted, "multipart_uploads", result.MultipartAborted)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RemoveFinishedUpload deletes up to budget staged objects of the finished
// session uploadID and, once none remain, the session itself. It reports how
// many objects it deleted and whether this call removed the session: when
// several server processes remove the same session at once, every step is
// idempotent and exactly one of them reports removing it.
func RemoveFinishedUpload(ctx context.Context, vault *store.VaultStore, objects *Objects, uploadID uuid.UUID, budget int) (int, bool, error) {
	deleted, empty, err := objects.DeletePrefix(ctx, UploadPrefix(vault.VaultID(), uploadID), budget)
	if err != nil {
		return deleted, false, fmt.Errorf("delete staged chunks: %w", err)
	}

	if !empty {
		return deleted, false, nil
	}

	removed, err := vault.DeleteBlobUpload(ctx, uploadID)
	if err != nil {
		return deleted, false, err
	}

	return deleted, removed, nil
}

func orDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}

	return value
}

// commitInProgress reports whether the multipart upload at key may belong to
// a commit still in progress, in this or another server process: its blob
// has an upload session that was active within the TTL. A commit records
// activity after every part, so its multipart upload is never aborted
// however long the commit takes. This uses the database clock, as session
// activity does, so it does not depend on the server's clock agreeing with
// the object store's.
func (cleaner *Cleaner) commitInProgress(ctx context.Context, key string) (bool, error) {
	vaultID, blobID, ok := parseBlobKey(key)
	if !ok {
		// Not a blob object; no commit writes it.
		return false, nil
	}

	active, err := cleaner.Store.InVault(vaultID).BlobUploadActiveWithin(ctx, blobID, cleaner.TTL)
	if err != nil {
		return false, err
	}

	return active, nil
}

func (cleaner *Cleaner) clock() time.Time {
	if cleaner.now != nil {
		return cleaner.now()
	}

	return time.Now()
}
