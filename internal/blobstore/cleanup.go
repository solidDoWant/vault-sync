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
// uploads (left by an interrupted commit) that are older than TTL: they are
// invisible and would otherwise leak storage.
type Cleaner struct {
	Store   *store.Store
	Objects *Objects
	// TTL is how long an upload session may be idle before it is removed.
	// It must comfortably exceed the time a commit takes.
	TTL time.Duration
	// Per-run bounds; zero selects the defaults.
	SessionsPerRun       int
	ObjectsPerRun        int
	MultipartPagesPerRun int
	Logger               *slog.Logger

	multipart multipartCursor
}

// CleanupResult reports one run's work.
type CleanupResult struct {
	// SessionsRemoved counts sessions whose objects and row are gone.
	SessionsRemoved int
	// ObjectsDeleted counts staged objects deleted.
	ObjectsDeleted int
	// MultipartAborted counts aborted multipart uploads.
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

	aborted, cursor, err := cleaner.Objects.abortStaleMultipartUploads(ctx, "vaults/", time.Now().Add(-cleaner.TTL),
		cleaner.multipart, orDefault(cleaner.MultipartPagesPerRun, DefaultMultipartPagesPerRun))
	result.MultipartAborted = aborted
	cleaner.multipart = cursor

	if err != nil {
		problems = append(problems, err)
	}

	return result, errors.Join(problems...)
}

// Run calls RunOnce every interval until ctx is canceled, logging failures.
func (cleaner *Cleaner) Run(ctx context.Context, interval time.Duration) {
	logger := cleaner.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		result, err := cleaner.RunOnce(ctx)
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
// many objects it deleted and whether the session is gone.
func RemoveFinishedUpload(ctx context.Context, vault *store.VaultStore, objects *Objects, uploadID uuid.UUID, budget int) (int, bool, error) {
	deleted, empty, err := objects.DeletePrefix(ctx, UploadPrefix(vault.VaultID(), uploadID), budget)
	if err != nil {
		return deleted, false, fmt.Errorf("delete staged chunks: %w", err)
	}

	if !empty {
		return deleted, false, nil
	}

	if err := vault.DeleteBlobUpload(ctx, uploadID); err != nil {
		return deleted, false, err
	}

	return deleted, true, nil
}

func orDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}

	return value
}
