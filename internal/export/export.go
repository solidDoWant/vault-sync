// Package export writes a plaintext copy of every vault's live documents to
// a directory tree for the operator's archival tooling (SPEC.md §4). It runs
// as the `vault-sync-server export` subcommand (docs/export.md).
//
// Every live document whose content can be read is exported: at its path in
// the vault's directory when the filesystem can hold it there, otherwise in
// the vault's unplaced tree by document id. A manifest per vault lists every
// live document and where its bytes are, so the export can be restored
// exactly.
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
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
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
	// Epochs returns up to limit of the vault's key epochs after epoch
	// after, in epoch order.
	Epochs(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.Epoch, error)
	// EscrowSlots returns up to limit of the vault's escrow slots wrapped
	// to the escrow key keyID, for epochs after epoch after, in epoch
	// order.
	EscrowSlots(ctx context.Context, vaultID uuid.UUID, keyID string, after int32, limit int) ([]store.KeySlot, error)
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
	// EscrowIdentities decrypt escrowed vaults (SPEC.md §9.4); more than
	// one during an escrow key rotation. Without any, encrypted vaults are
	// skipped.
	EscrowIdentities []EscrowIdentity
}

// Summary statuses.
const (
	// StatusOK: the bytes of every live document of every exported vault
	// were written, at their path or in the unplaced tree, and the new
	// tree is in place.
	StatusOK = "ok"
	// StatusPartial: the new tree is in place, but the content of some
	// documents is missing, corrupt or cannot be decrypted, so their bytes
	// are not in it (see DocumentErrors), or some encrypted vaults failed
	// (see FailedVaults).
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
	// Vaults counts the vaults exported, SkippedVaults the end-to-end
	// encrypted vaults left out because they cannot be decrypted (no
	// escrow, or no escrow identity), and FailedVaults the encrypted vaults
	// left out because their escrow keys do not verify.
	Vaults        int `json:"vaults"`
	SkippedVaults int `json:"skipped_vaults"`
	FailedVaults  int `json:"failed_vaults"`
	// Files and Bytes count the document files written, in vault trees
	// and unplaced trees.
	Files int64 `json:"files"`
	Bytes int64 `json:"bytes"`
	// DocumentErrors counts the documents whose content is missing or
	// corrupt; the first maxListedDocumentErrors are listed under their
	// vault.
	DocumentErrors int `json:"document_errors"`
	// Unplaced counts the documents written to unplaced trees because
	// their path cannot be placed in their vault's tree.
	Unplaced     int64          `json:"unplaced"`
	VaultDetails []VaultSummary `json:"vault_details"`
}

// VaultSummary describes one vault's export.
type VaultSummary struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Encryption string    `json:"encryption"`
	// HeadSeq is the point in the vault's history that was exported.
	HeadSeq int64 `json:"head_seq"`
	// Skipped is why an encrypted vault was not exported (SkippedNoEscrow
	// or SkippedNoEscrowIdentity), if it was not.
	Skipped string `json:"skipped,omitempty"`
	// Failed is why an encrypted vault's escrow keys do not verify, so it
	// was not exported.
	Failed         string          `json:"failed,omitempty"`
	Files          int64           `json:"files"`
	Bytes          int64           `json:"bytes"`
	Unplaced       int64           `json:"unplaced"`
	DocumentErrors []DocumentError `json:"document_errors,omitempty"`
}

// DocumentError is a document whose content is missing or corrupt, so its
// bytes are not in the export.
type DocumentError struct {
	DocumentID uuid.UUID `json:"document_id"`
	Reason     string    `json:"reason"`
}

// Why an end-to-end encrypted vault is skipped (SPEC.md §9.4).
const (
	// SkippedNoEscrow: the vault has no escrow, so nobody but its members
	// can decrypt it.
	SkippedNoEscrow = "no_escrow"
	// SkippedNoEscrowIdentity: the vault has escrow, but the export was
	// given no escrow identity.
	SkippedNoEscrowIdentity = "no_escrow_identity"
)

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
	case run.summary.DocumentErrors > 0, run.summary.FailedVaults > 0:
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

	staging, err := mkdirStaging(parent, stagingPrefix)
	if err != nil {
		return err
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

	// The new export is in place whatever happens now, so the run must not
	// report that the previous one is untouched.
	if err := syncAfterSwap(parent); err != nil {
		run.options.Logger.WarnContext(ctx, "the new export is in place, but the swap may not survive a power loss", "error", err)
	}

	return nil
}

// maxStagingAttempts bounds the names mkdirStaging tries.
const maxStagingAttempts = 100

// stagingSuffix returns the random number of a staging directory's name;
// tests replace it.
var stagingSuffix = rand.Uint32

// mkdirStaging creates a new directory in parent named prefix followed by a
// random decimal number, the only names removeStale removes. It does not use
// os.MkdirTemp, whose pattern puts the number in place of the last "*" of
// prefix: for an output name containing "*", removeStale would never
// recognize the directory a killed run left behind.
func mkdirStaging(parent, prefix string) (string, error) {
	for range maxStagingAttempts {
		staging := filepath.Join(parent, prefix+strconv.FormatUint(uint64(stagingSuffix()), 10))

		err := os.Mkdir(staging, dirMode)
		if errors.Is(err, fs.ErrExist) {
			continue
		}

		if err != nil {
			return "", fmt.Errorf("create staging directory: %w", err)
		}

		return staging, nil
	}

	return "", errors.New("create staging directory: too many name collisions")
}

// removeStale removes staging directories left by interrupted runs: the
// entries named prefix followed by the decimal number mkdirStaging appends.
// Anything else sharing the prefix, such as the lock file or staging
// directories of an export to a sibling named like "<base>.staging-foo", is
// left alone.
func (run *run) removeStale(ctx context.Context, parent, prefix string) error {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return fmt.Errorf("read the output directory's parent: %w", err)
	}

	for _, entry := range entries {
		suffix, found := strings.CutPrefix(entry.Name(), prefix)
		if !found || !isDecimal(suffix) {
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

// isDecimal reports whether s is a non-empty string of ASCII digits.
func isDecimal(s string) bool {
	if s == "" {
		return false
	}

	for _, char := range s {
		if char < '0' || char > '9' {
			return false
		}
	}

	return true
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
	}{Format: FormatVersion, StartedAt: startedAt})
	if err != nil {
		return fmt.Errorf("encode marker: %w", err)
	}

	if err := os.WriteFile(filepath.Join(staging, MarkerName), append(content, '\n'), fileMode); err != nil {
		return fmt.Errorf("write marker: %w", err)
	}

	return nil
}

// syncAfterSwap makes the swap durable; tests replace it.
var syncAfterSwap = syncDirectory

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

	var keys map[int32]epochKeys

	if vault.Encryption != store.EncryptionNone {
		switch {
		case !vault.Escrow:
			details.Skipped = SkippedNoEscrow
		case len(run.options.EscrowIdentities) == 0:
			details.Skipped = SkippedNoEscrowIdentity
		}

		if details.Skipped != "" {
			run.summary.SkippedVaults++

			return nil
		}

		var (
			failure *vaultFailure
			err     error
		)

		keys, err = run.escrowKeys(ctx, vault.ID)

		switch {
		case errors.As(err, &failure):
			run.options.Logger.WarnContext(ctx, "the vault's escrow keys do not verify; it is not in the export",
				"vault_id", vault.ID, "reason", failure.reason)

			details.Failed = failure.reason
			run.summary.FailedVaults++

			return nil
		case err != nil:
			return err
		}
	}

	directory := filepath.Join(staging, vault.ID.String())
	if err := os.Mkdir(directory, dirMode); err != nil {
		return fmt.Errorf("create vault directory: %w", err)
	}

	if vault.DeletedAt != nil {
		deletedAt := vault.DeletedAt.UTC().Format(time.RFC3339Nano) + "\n"

		err := os.WriteFile(filepath.Join(staging, vault.ID.String()+DeletedSuffix), []byte(deletedAt), fileMode)
		if err != nil {
			return fmt.Errorf("write deleted marker: %w", err)
		}
	}

	tree, err := openVaultTree(directory)
	if err != nil {
		return err
	}

	defer func() { _ = tree.Close() }()

	unplaced := &unplacedTree{directory: filepath.Join(staging, vault.ID.String()+UnplacedSuffix)}

	defer func() { _ = unplaced.Close() }()

	manifest, err := createManifest(filepath.Join(staging, vault.ID.String()+ManifestSuffix), vault, run.summary.StartedAt)
	if err != nil {
		return err
	}

	finished := false

	defer func() {
		if !finished {
			manifest.abandon()
		}
	}()

	out := &vaultOutput{id: vault.ID, tree: tree, unplaced: unplaced, manifest: manifest, details: details}
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

			exported := run.storedDocument(ctx, vault.ID, document)
			if vault.Encryption != store.EncryptionNone {
				exported, err = run.decryptDocument(ctx, vault.ID, keys, document)
				if err != nil {
					return fmt.Errorf("document %s: %w", document.ID, err)
				}
			}

			if err := run.exportDocument(ctx, out, exported); err != nil {
				return fmt.Errorf("document %s: %w", document.ID, err)
			}
		}

		if len(documents) < run.options.PageSize {
			break
		}

		after = documents[len(documents)-1].ID
	}

	finished = true

	if err := manifest.finish(); err != nil {
		return err
	}

	run.summary.Vaults++

	return nil
}

// vaultOutput is where one vault's documents go.
type vaultOutput struct {
	id       uuid.UUID
	tree     *vaultTree
	unplaced *unplacedTree
	manifest *manifestWriter
	details  *VaultSummary
}

// exportedDocument is a document as the export writes it: in an encrypted
// vault, its decrypted path and content.
type exportedDocument struct {
	// document is what the manifest describes.
	document store.LiveDocument
	// open opens the content to write.
	open func() (io.ReadCloser, error)
	// pathProblem, when set, puts the document in the unplaced tree.
	pathProblem error
	// contentProblem, when set, leaves the document's bytes out.
	contentProblem error
}

// storedDocument exports document's stored path and content as they are.
func (run *run) storedDocument(ctx context.Context, vaultID uuid.UUID, document store.LiveDocument) exportedDocument {
	return exportedDocument{document: document, open: func() (io.ReadCloser, error) {
		content, err := run.options.Source.Content(ctx, vaultID, document.ContentRef)
		if errors.Is(err, ErrContentMissing) {
			return nil, refuse(errContentMissing)
		}

		return content, err
	}}
}

// exportDocument writes the document's bytes at its path in the vault tree
// or, when the path cannot be placed there, in the unplaced tree, and lists
// it in the manifest. Only missing, corrupt or undecryptable content leaves
// its bytes out.
func (run *run) exportDocument(ctx context.Context, out *vaultOutput, exported exportedDocument) error {
	document := exported.document
	record := newManifestDocument(document)

	if exported.contentProblem != nil {
		run.missing(ctx, out, document.ID, exported.contentProblem)

		record.Status = ManifestMissing
		record.Reason = exported.contentProblem.Error()

		return out.manifest.document(record)
	}

	var (
		refused *documentError
		remove  func() error
		file    *os.File
		err     error
	)

	if exported.pathProblem != nil {
		err = refuse(exported.pathProblem)
	} else {
		file, err = out.tree.create(document.Path)
	}

	switch {
	case errors.As(err, &refused):
		file, err = out.unplaced.create(document.ID)
		if err != nil {
			return err
		}

		record.Status = ManifestUnplaced
		record.Location = out.id.String() + UnplacedSuffix + "/" + document.ID.String()
		record.Reason = refused.reason.Error()
		remove = func() error { return out.unplaced.remove(document.ID) }
	case err != nil:
		return err
	default:
		record.Status = ManifestPlaced
		record.Location = out.id.String() + "/" + document.Path
		remove = func() error { return out.tree.remove(document.Path) }
	}

	err = writeContent(file, exported.open, document.Size, document.ContentRef)

	switch {
	case errors.As(err, &refused):
		if err := remove(); err != nil {
			return err
		}

		run.missing(ctx, out, document.ID, refused.reason)

		record.Status = ManifestMissing
		record.Location = ""
		record.Reason = refused.reason.Error()
	case err != nil:
		return err
	case record.Status == ManifestUnplaced:
		// The path is user data: log the document id only.
		run.options.Logger.InfoContext(ctx, "document exported to the unplaced tree",
			"vault_id", out.id, "document_id", document.ID, "reason", record.Reason)

		out.details.Unplaced++
		run.summary.Unplaced++
	}

	if record.Status != ManifestMissing {
		out.details.Files++
		out.details.Bytes += document.Size
		run.summary.Files++
		run.summary.Bytes += document.Size
	}

	return out.manifest.document(record)
}

// missing reports a document whose content is missing or corrupt.
func (run *run) missing(ctx context.Context, out *vaultOutput, documentID uuid.UUID, reason error) {
	// The path is user data: log and report the document id only.
	run.options.Logger.WarnContext(ctx, "document content is missing, corrupt or cannot be decrypted; its bytes are not in the export",
		"vault_id", out.id, "document_id", documentID, "reason", reason.Error())

	run.summary.DocumentErrors++

	if run.listed < maxListedDocumentErrors {
		run.listed++

		out.details.DocumentErrors = append(out.details.DocumentErrors, DocumentError{DocumentID: documentID, Reason: reason.Error()})
	}
}
