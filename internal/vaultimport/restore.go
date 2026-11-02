package vaultimport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
)

// RestoreTarget creates the restored documents with ids the restore
// chooses, so a retried call ends in one state.
type RestoreTarget interface {
	// CreateWithIDs creates one document. It returns a *SkipError with
	// PathTaken when another document already has the path.
	CreateWithIDs(ctx context.Context, documentID, revisionID uuid.UUID, entry Entry) error
}

// FallbackDocument is a document restored under the restored-files folder
// instead of its own path.
type FallbackDocument struct {
	DocumentID string `json:"document_id"`
	// Path is the original path; PathBase64 its exact bytes when they are
	// not UTF-8.
	Path       string `json:"path"`
	PathBase64 string `json:"path_base64,omitempty"`
	// RestoredPath is where the document is in the new vault.
	RestoredPath string `json:"restored_path"`
}

// MissingDocument is a document whose bytes the export does not have.
type MissingDocument struct {
	DocumentID string `json:"document_id"`
	Path       string `json:"path"`
	PathBase64 string `json:"path_base64,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// RestoreResult is what a restore did, on top of the import's Result.
type RestoreResult struct {
	Result
	Fallback           []FallbackDocument   `json:"fallback"`
	Missing            []MissingDocument    `json:"missing"`
	FailedVerification []FailedVerification `json:"failed_verification"`
}

func newRestoreResult() RestoreResult {
	return RestoreResult{
		Result:             Result{Skipped: []Skip{}},
		Fallback:           []FallbackDocument{},
		Missing:            []MissingDocument{},
		FailedVerification: []FailedVerification{},
	}
}

// partial reports whether anything of the manifest is not at its own path.
func (result RestoreResult) partial() bool {
	return len(result.Fallback) > 0 || len(result.Missing) > 0 || len(result.FailedVerification) > 0
}

// RestoreOptions configure Restore.
type RestoreOptions struct {
	// ExportDir is the export's output directory.
	ExportDir string
	// Manifest is the vault's manifest, from ReadExportManifest.
	Manifest ExportManifest
	// MaxFileBytes is the server's file size limit.
	MaxFileBytes int64
	// AllowPartial imports the documents that verify when others do not.
	AllowPartial bool
	// Target returns where the documents are created. It is called once
	// the export verified, so a damaged export asks for no key.
	Target func(context.Context) (RestoreTarget, error)
	Logger *slog.Logger
}

// ErrVerificationFailed is returned when the export does not verify and
// AllowPartial is not set; nothing was created.
var ErrVerificationFailed = errors.New("the export does not verify; nothing was imported (see failed_verification, or give -allow-partial to import the documents that verify)")

// maxTransientRetries bounds how often one document's creation is retried
// after a transient failure.
const maxTransientRetries = 5

// retryDelay is the wait before the first retry; it doubles each time.
var retryDelay = 500 * time.Millisecond

// Restore verifies the export, plans every document's path and creates the
// documents (docs/design/restore-from-export.md §3 to §5). It returns an
// error when the restore stopped; the result then lists what was created.
func Restore(ctx context.Context, options RestoreOptions) (RestoreResult, error) {
	result := newRestoreResult()
	logger := options.Logger

	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	failed, err := VerifyExport(options.ExportDir, options.Manifest, options.MaxFileBytes)
	if err != nil {
		return result, err
	}

	result.FailedVerification = failed

	for _, failure := range failed {
		logger.WarnContext(ctx, "a file does not verify", "document_id", failure.DocumentID, "reason", failure.Reason)
	}

	if len(failed) > 0 && !options.AllowPartial {
		return result, ErrVerificationFailed
	}

	leftOut := map[string]bool{}
	for _, failure := range failed {
		leftOut[failure.DocumentID] = true
	}

	var restorable []export.ManifestDocument

	for _, document := range options.Manifest.Documents {
		switch {
		case document.Status == export.ManifestMissing:
			result.Missing = append(result.Missing, MissingDocument{
				DocumentID: document.DocumentID.String(), Path: document.Path, PathBase64: document.PathBase64, Reason: document.Reason,
			})
		case !leftOut[document.DocumentID.String()]:
			restorable = append(restorable, document)
		}
	}

	plan := Plan(restorable)

	target, err := options.Target(ctx)
	if err != nil {
		return result, err
	}

	trees, err := openExportTrees(options.ExportDir, options.Manifest.Vault.VaultID)
	if err != nil {
		return result, err
	}
	defer trees.close()

	creator := &restoreCreator{target: target, options: options, result: &result, trees: trees, logger: logger, taken: newPathSet(), folders: map[string]bool{}}

	for _, planned := range plan {
		if planned.Document != nil {
			creator.taken.add(planned.Path)
		}
	}

	for _, planned := range plan {
		if err := ctx.Err(); err != nil {
			return result, err
		}

		if err := creator.create(ctx, planned); err != nil {
			logger.ErrorContext(ctx, "restore stopped", "document_id", documentLabel(planned), "error", err)

			return result, err
		}
	}

	return result, nil
}

type restoreCreator struct {
	target  RestoreTarget
	options RestoreOptions
	result  *RestoreResult
	trees   *exportTrees
	logger  *slog.Logger
	// taken holds every planned path, so a fallback found during the
	// import collides with none of them.
	taken *pathSet
	// folders holds the keys of the folders created so far.
	folders map[string]bool
}

func (creator *restoreCreator) create(ctx context.Context, planned PlannedDocument) error {
	if planned.Document == nil {
		if err := creator.createFolder(ctx, planned.Path); err != nil {
			return err
		}

		return nil
	}

	document := *planned.Document

	content, reason, err := creator.trees.readVerified(document, creator.options.MaxFileBytes)
	if err != nil {
		return err
	}

	if reason != "" {
		return fmt.Errorf("document %s changed after it was verified (%s); restore from a copy of the export", document.DocumentID, reason)
	}

	documentID, revisionID, err := newIDs()
	if err != nil {
		return err
	}

	entry := Entry{Path: planned.Path, Kind: planned.Kind, Content: content}

	err = creator.createWithRetry(ctx, documentID, revisionID, entry)

	var skipped *SkipError
	if errors.As(err, &skipped) && skipped.PathTaken && !planned.Fallback {
		// Something else took the path during the restore: move the
		// document to the restored-files folder.
		creator.logger.WarnContext(ctx, "a document's path was taken during the restore; it goes to the restored-files folder", "document_id", document.DocumentID)

		planned.Fallback = true
		if entry.Path, err = creator.fallbackPath(ctx, document); err != nil {
			return err
		}

		planned.Path = entry.Path
		err = creator.createWithRetry(ctx, documentID, revisionID, entry)
	}

	if err != nil {
		return fmt.Errorf("create document %s: %w", document.DocumentID, err)
	}

	if planned.Fallback {
		creator.result.Fallback = append(creator.result.Fallback, FallbackDocument{
			DocumentID: document.DocumentID.String(), Path: document.Path, PathBase64: document.PathBase64, RestoredPath: planned.Path,
		})
	}

	if planned.Kind == KindText {
		creator.result.Imported.Text++
	} else {
		creator.result.Imported.Blob++
	}

	creator.result.Bytes += int64(len(content))

	return nil
}

func (creator *restoreCreator) createFolder(ctx context.Context, folder string) error {
	key := pathkey.Key(folder)
	if creator.folders[key] {
		return nil
	}

	documentID, revisionID, err := newIDs()
	if err != nil {
		return err
	}

	if err := creator.createWithRetry(ctx, documentID, revisionID, Entry{Path: folder, Kind: KindFolder}); err != nil {
		return fmt.Errorf("create a folder: %w", err)
	}

	creator.folders[key] = true
	creator.result.Imported.Folder++

	return nil
}

// fallbackPath finds a restored-files path for document that no planned
// path uses, and creates its folder.
func (creator *restoreCreator) fallbackPath(ctx context.Context, document export.ManifestDocument) (string, error) {
	for number := 1; ; number++ {
		folder := RestoredFilesFolder
		if number > 1 {
			folder += " " + strconv.Itoa(number)
		}

		if creator.taken.files[pathkey.Key(folder)] {
			continue
		}

		target := FallbackPath(folder, document)
		if !creator.taken.free(target) {
			continue
		}

		creator.taken.add(target)

		return target, creator.createFolder(ctx, folder)
	}
}

// createWithRetry creates one document, retrying a transient failure with
// the same ids.
func (creator *restoreCreator) createWithRetry(ctx context.Context, documentID, revisionID uuid.UUID, entry Entry) error {
	delay := retryDelay

	for attempt := 0; ; attempt++ {
		err := creator.target.CreateWithIDs(ctx, documentID, revisionID, entry)
		if err == nil || attempt >= maxTransientRetries || !transient(err) {
			return err
		}

		creator.logger.WarnContext(ctx, "retrying after a transient failure", "document_id", documentID, "attempt", attempt+1, "error", err)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}

		delay *= 2
	}
}

// transient reports whether err is a failure a retry with the same ids may
// get past: the server is unavailable, the deadline passed, or the reply
// was lost.
func transient(err error) bool {
	var skipped *SkipError
	if errors.As(err, &skipped) || errors.Is(err, context.Canceled) {
		return false
	}

	switch connect.CodeOf(err) {
	case connect.CodeUnavailable, connect.CodeDeadlineExceeded:
		return true
	case connect.CodeUnknown:
		// A transport failure, such as a lost reply, is a connect error
		// without a code from the server.
		var connectErr *connect.Error

		return errors.As(err, &connectErr)
	default:
		return false
	}
}

func newIDs() (documentID, revisionID uuid.UUID, err error) {
	if documentID, err = uuid.NewV7(); err != nil {
		return documentID, revisionID, err
	}

	revisionID, err = uuid.NewV7()

	return documentID, revisionID, err
}
