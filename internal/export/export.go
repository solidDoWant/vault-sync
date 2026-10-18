// Package export writes a plaintext copy of every vault's live documents to
// a directory tree for the operator's archival tooling (SPEC.md §4). It runs
// as the `vault-sync-server export` subcommand (docs/export.md).
//
// The export only reads the database and the object store. It writes a new
// tree to a staging directory beside the output directory and swaps it into
// place atomically, so the output directory always holds one complete
// export: an interrupted run leaves the previous one untouched.
package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// Source is what an export reads.
type Source interface {
	// Vaults returns up to limit vaults after the id after, in id order.
	Vaults(ctx context.Context, after uuid.UUID, limit int) ([]store.Vault, error)
	// Documents returns up to limit of the vault's live documents as of
	// seq, after the document id after, in id order.
	Documents(ctx context.Context, vaultID uuid.UUID, seq int64, after uuid.UUID, limit int) ([]store.LiveDocument, error)
	// Content streams a blob's content. It returns ErrContentMissing if
	// the object does not exist.
	Content(ctx context.Context, vaultID uuid.UUID, blobID []byte) (io.ReadCloser, error)
}

// ErrContentMissing is returned by Source.Content for a blob whose object
// does not exist.
var ErrContentMissing = errContentMissing

// MarkerName is the file at the root of every export. A non-empty output
// directory without it is never replaced, so a mistyped output path cannot
// destroy unrelated data.
const MarkerName = ".vault-sync-export"

// DefaultPageSize is how many vaults or documents are read per query.
const DefaultPageSize = 1000

// maxListedDocumentErrors bounds the document errors listed in a summary;
// all of them are counted.
const maxListedDocumentErrors = 100

// Options configure Run.
type Options struct {
	// Output is the export directory. Its parent must exist and be on the
	// same filesystem, and it must not be a mount point or a symbolic link.
	Output string
	Source Source
	Logger *slog.Logger
	// PageSize defaults to DefaultPageSize.
	PageSize int
	// Now defaults to time.Now.
	Now func() time.Time
}

// Summary statuses.
const (
	// StatusOK: every live document of every exported vault was written
	// and the new tree is in place.
	StatusOK = "ok"
	// StatusPartial: the new tree is in place, but some documents were
	// left out (see DocumentErrors).
	StatusPartial = "partial"
	// StatusFailed: the export stopped; the previous export, if any, is
	// untouched.
	StatusFailed = "failed"
)

// Summary describes one run. It never contains document paths or content.
type Summary struct {
	Status string `json:"status"`
	// Error is why a failed run stopped.
	Error           string    `json:"error,omitempty"`
	Output          string    `json:"output"`
	StartedAt       time.Time `json:"started_at"`
	DurationSeconds float64   `json:"duration_seconds"`
	// Vaults counts the vaults exported, SkippedVaults those left out
	// (end-to-end encrypted vaults).
	Vaults        int `json:"vaults"`
	SkippedVaults int `json:"skipped_vaults"`
	// Files and Bytes count the files written.
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
	// DocumentErrors counts the documents left out; the first
	// maxListedDocumentErrors are listed under their vault.
	DocumentErrors int            `json:"document_errors"`
	VaultDetails   []VaultSummary `json:"vault_details"`
}

// VaultSummary describes one vault's export.
type VaultSummary struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Encryption string    `json:"encryption"`
	// HeadSeq is the point in the vault's history that was exported.
	HeadSeq int64 `json:"head_seq"`
	// Skipped is why the vault was not exported ("e2ee"), if it was not.
	Skipped        string          `json:"skipped,omitempty"`
	Files          int64           `json:"files"`
	Bytes          int64           `json:"bytes"`
	DocumentErrors []DocumentError `json:"document_errors,omitempty"`
}

// DocumentError is a document left out of the export.
type DocumentError struct {
	DocumentID uuid.UUID `json:"document_id"`
	Reason     string    `json:"reason"`
}

// SkippedE2EE marks an end-to-end encrypted vault, which the export cannot
// decrypt until escrow exists (SPEC.md §9.4).
const SkippedE2EE = "e2ee"

// Run exports every vault to options.Output. The returned summary is always
// filled in; the error is non-nil exactly when its status is StatusFailed.
func Run(ctx context.Context, options Options) (Summary, error) {
	if options.PageSize <= 0 {
		options.PageSize = DefaultPageSize
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	run := &run{options: options, summary: Summary{Output: options.Output, StartedAt: options.Now().UTC(), VaultDetails: []VaultSummary{}}}

	err := run.run(ctx)

	run.summary.DurationSeconds = options.Now().Sub(run.summary.StartedAt).Seconds()

	switch {
	case err != nil:
		run.summary.Status = StatusFailed
		run.summary.Error = err.Error()
	case run.summary.DocumentErrors > 0:
		run.summary.Status = StatusPartial
	default:
		run.summary.Status = StatusOK
	}

	return run.summary, err
}

type run struct {
	options Options
	summary Summary
	listed  int
}

func (run *run) run(ctx context.Context) error {
	output, err := filepath.Abs(run.options.Output)
	if err != nil {
		return fmt.Errorf("resolve output directory: %w", err)
	}

	run.summary.Output = output
	parent, base := filepath.Dir(output), filepath.Base(output)

	if output == parent {
		return errors.New("the output directory must not be a filesystem root")
	}

	// The lock serializes runs, so staging directories without a running
	// export are leftovers of interrupted ones.
	lockFile, err := lock(filepath.Join(parent, "."+base+".lock"))
	if err != nil {
		return err
	}

	defer func() { _ = lockFile.Close() }()

	stagingPrefix := "." + base + ".staging-"
	if err := run.removeStale(ctx, parent, stagingPrefix); err != nil {
		return err
	}

	existed, err := checkOutput(output)
	if err != nil {
		return err
	}

	staging, err := os.MkdirTemp(parent, stagingPrefix)
	if err != nil {
		return fmt.Errorf("create staging directory: %w", err)
	}

	swapped := false

	defer func() {
		if !swapped {
			if err := os.RemoveAll(staging); err != nil {
				run.options.Logger.WarnContext(ctx, "cannot remove the staging directory; the next run removes it", "error", err)
			}
		}
	}()

	if err := os.Chmod(staging, dirMode); err != nil {
		return fmt.Errorf("set staging directory permissions: %w", err)
	}

	if err := run.exportVaults(ctx, staging); err != nil {
		return err
	}

	if err := writeMarker(staging, run.summary.StartedAt); err != nil {
		return err
	}

	if err := syncFilesystem(staging); err != nil {
		return err
	}

	if err := ctx.Err(); err != nil {
		return fmt.Errorf("export interrupted: %w", err)
	}

	if existed {
		err = exchange(staging, output)
	} else {
		err = os.Rename(staging, output)
	}

	if err != nil {
		return fmt.Errorf("swap the export into place: %w", err)
	}

	swapped = true

	// After an exchange, staging holds the previous export.
	if existed {
		if err := os.RemoveAll(staging); err != nil {
			run.options.Logger.WarnContext(ctx, "cannot remove the previous export; the next run removes it", "error", err)
		}
	}

	if err := syncDirectory(parent); err != nil {
		return err
	}

	return nil
}

// removeStale removes staging directories left by interrupted runs.
func (run *run) removeStale(ctx context.Context, parent, prefix string) error {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return fmt.Errorf("read the output directory's parent: %w", err)
	}

	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}

		// RemoveAll removes symbolic links, never what they point to.
		if err := os.RemoveAll(filepath.Join(parent, entry.Name())); err != nil {
			return fmt.Errorf("remove a staging directory left by an interrupted export: %w", err)
		}

		run.options.Logger.InfoContext(ctx, "removed a staging directory left by an interrupted export", "name", entry.Name())
	}

	return nil
}

// checkOutput reports whether the output directory exists, and refuses one
// that may not be replaced.
func checkOutput(output string) (bool, error) {
	info, err := os.Lstat(output)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}

	if err != nil {
		return false, fmt.Errorf("inspect the output directory: %w", err)
	}

	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		return false, errors.New("the output directory must not be a symbolic link; use the path it points to")
	case !info.IsDir():
		return false, errors.New("the output path exists and is not a directory")
	}

	entries, err := os.ReadDir(output)
	if err != nil {
		return false, fmt.Errorf("read the output directory: %w", err)
	}

	if len(entries) == 0 {
		return true, nil
	}

	marker, err := os.Lstat(filepath.Join(output, MarkerName))
	if err != nil || !marker.Mode().IsRegular() {
		return false, fmt.Errorf("refusing to replace the output directory: it is not empty and has no %s file, so it is not a previous export", MarkerName)
	}

	return true, nil
}

func writeMarker(staging string, startedAt time.Time) error {
	content, err := json.Marshal(struct {
		Format    int       `json:"format"`
		StartedAt time.Time `json:"started_at"`
	}{Format: 1, StartedAt: startedAt})
	if err != nil {
		return fmt.Errorf("encode marker: %w", err)
	}

	if err := os.WriteFile(filepath.Join(staging, MarkerName), append(content, '\n'), fileMode); err != nil {
		return fmt.Errorf("write marker: %w", err)
	}

	return nil
}

// syncDirectory makes a rename within directory durable.
func syncDirectory(directory string) error {
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open %s: %w", directory, err)
	}

	defer func() { _ = dir.Close() }()

	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", directory, err)
	}

	return nil
}

func (run *run) exportVaults(ctx context.Context, staging string) error {
	after := uuid.Nil

	for {
		vaults, err := run.options.Source.Vaults(ctx, after, run.options.PageSize)
		if err != nil {
			return fmt.Errorf("list vaults: %w", err)
		}

		for _, vault := range vaults {
			if err := run.exportVault(ctx, staging, vault); err != nil {
				return fmt.Errorf("export vault %s: %w", vault.ID, err)
			}
		}

		if len(vaults) < run.options.PageSize {
			return nil
		}

		after = vaults[len(vaults)-1].ID
	}
}

func (run *run) exportVault(ctx context.Context, staging string, vault store.Vault) error {
	run.summary.VaultDetails = append(run.summary.VaultDetails, VaultSummary{
		ID: vault.ID, Name: vault.Name, Encryption: string(vault.Encryption), HeadSeq: vault.HeadSeq,
	})
	details := &run.summary.VaultDetails[len(run.summary.VaultDetails)-1]

	if vault.Encryption != store.EncryptionNone {
		details.Skipped = SkippedE2EE
		run.summary.SkippedVaults++

		return nil
	}

	directory := filepath.Join(staging, vault.ID.String())
	if err := os.Mkdir(directory, dirMode); err != nil {
		return fmt.Errorf("create vault directory: %w", err)
	}

	tree, err := openVaultTree(directory)
	if err != nil {
		return err
	}

	defer func() { _ = tree.Close() }()

	after := uuid.Nil

	for {
		documents, err := run.options.Source.Documents(ctx, vault.ID, vault.HeadSeq, after, run.options.PageSize)
		if err != nil {
			return fmt.Errorf("list documents: %w", err)
		}

		for _, document := range documents {
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("export interrupted: %w", err)
			}

			if err := run.exportDocument(ctx, tree, vault.ID, document, details); err != nil {
				return fmt.Errorf("document %s: %w", document.ID, err)
			}
		}

		if len(documents) < run.options.PageSize {
			break
		}

		after = documents[len(documents)-1].ID
	}

	run.summary.Vaults++

	return nil
}

func (run *run) exportDocument(ctx context.Context, tree *vaultTree, vaultID uuid.UUID, document store.LiveDocument, details *VaultSummary) error {
	open := func() (io.ReadCloser, error) {
		content, err := run.options.Source.Content(ctx, vaultID, document.ContentRef)
		if errors.Is(err, ErrContentMissing) {
			return nil, refuse(errContentMissing)
		}

		return content, err
	}

	err := tree.write(document.Path, open, document.Size, document.ContentRef)

	var refused *documentError

	switch {
	case errors.As(err, &refused):
		// The path is user data: log and report the document id only.
		run.options.Logger.WarnContext(ctx, "document left out of the export",
			"vault_id", vaultID, "document_id", document.ID, "reason", refused.reason.Error())

		run.summary.DocumentErrors++

		if run.listed < maxListedDocumentErrors {
			run.listed++

			details.DocumentErrors = append(details.DocumentErrors, DocumentError{DocumentID: document.ID, Reason: refused.reason.Error()})
		}

		return nil
	case err != nil:
		return err
	}

	details.Files++
	details.Bytes += document.Size
	run.summary.Files++
	run.summary.Bytes += document.Size

	return nil
}
