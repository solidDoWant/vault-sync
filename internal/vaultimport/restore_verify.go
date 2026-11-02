package vaultimport

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/export"
)

// maxManifestLine bounds one manifest line (docs/design/restore-from-export.md §3).
const maxManifestLine = 1 << 20

// Fixed reasons a document fails the restore's verification.
const (
	ReasonFileMissing  = "file missing"
	ReasonSizeDiffers  = "size differs"
	ReasonHashDiffers  = "sha256 differs"
	ReasonOverLimit    = "over the file size limit"
	ReasonNotInExport  = "not in the manifest"
	reasonNotARegular  = ReasonFileMissing
	manifestFormatHint = "the export is damaged or from another version; nothing was imported"
)

// ErrExportFormat marks a format failure: the export's format or its
// manifest's shape is wrong, so the restore stops even with -allow-partial.
var ErrExportFormat = errors.New("the export's format is not usable")

func formatError(format string, args ...any) error {
	return fmt.Errorf("%w: %s; %s", ErrExportFormat, fmt.Sprintf(format, args...), manifestFormatHint)
}

// ExportManifest is one vault's manifest from an export.
type ExportManifest struct {
	Vault     export.ManifestVault
	Documents []export.ManifestDocument
	End       export.ManifestEnd
}

// FailedVerification is a document or file that failed the restore's
// verification, with one of the fixed reasons.
type FailedVerification struct {
	// DocumentID is the document's id; empty for a file no manifest line
	// names.
	DocumentID string `json:"document_id,omitempty"`
	// Location is the file, relative to the export directory.
	Location string `json:"location"`
	Reason   string `json:"reason"`
}

// ReadExportManifest reads and checks the export marker and the manifest
// of vaultID in exportDir (docs/design/restore-from-export.md §3, steps 1
// and 2). Every error it returns wraps ErrExportFormat or is an I/O error.
func ReadExportManifest(exportDir string, vaultID uuid.UUID) (ExportManifest, error) {
	var manifest ExportManifest

	marker, err := os.ReadFile(filepath.Join(exportDir, export.MarkerName))
	if err != nil {
		return manifest, formatError("read the export marker %s: %v", export.MarkerName, err)
	}

	var markerFormat struct {
		Format int `json:"format"`
	}

	if err := json.Unmarshal(marker, &markerFormat); err != nil || markerFormat.Format != export.FormatVersion {
		return manifest, formatError("the export marker is not format %d", export.FormatVersion)
	}

	file, err := os.Open(filepath.Join(exportDir, vaultID.String()+export.ManifestSuffix))
	if err != nil {
		return manifest, formatError("open the manifest: %v", err)
	}
	defer func() { _ = file.Close() }()

	reader := bufio.NewReaderSize(file, 64<<10)
	seen := map[uuid.UUID]bool{}
	ended := false

	var counts export.ManifestEnd

	for number := 1; ; number++ {
		line, err := readManifestLine(reader)
		if errors.Is(err, io.EOF) {
			break
		}

		if err != nil {
			return manifest, err
		}

		if ended {
			return manifest, formatError("line %d follows the end line", number)
		}

		var header struct {
			Type string `json:"type"`
		}

		if err := json.Unmarshal(line, &header); err != nil {
			return manifest, formatError("line %d is not JSON", number)
		}

		switch {
		case number == 1:
			if header.Type != export.ManifestTypeVault {
				return manifest, formatError("the first line is not the vault line")
			}

			if err := json.Unmarshal(line, &manifest.Vault); err != nil {
				return manifest, formatError("the vault line does not parse")
			}

			if manifest.Vault.Format != export.FormatVersion {
				return manifest, formatError("the manifest is format %d, not %d", manifest.Vault.Format, export.FormatVersion)
			}

			if manifest.Vault.VaultID != vaultID {
				return manifest, formatError("the manifest is for another vault")
			}
		case header.Type == export.ManifestTypeDocument:
			var document export.ManifestDocument
			if err := json.Unmarshal(line, &document); err != nil {
				return manifest, formatError("line %d does not parse", number)
			}

			if err := checkManifestDocument(vaultID, document); err != nil {
				return manifest, formatError("line %d: %v", number, err)
			}

			if seen[document.DocumentID] {
				return manifest, formatError("line %d repeats a document id", number)
			}

			seen[document.DocumentID] = true
			counts.Documents++

			switch document.Status {
			case export.ManifestPlaced:
				counts.Placed++
			case export.ManifestUnplaced:
				counts.Unplaced++
			case export.ManifestMissing:
				counts.Missing++
			}

			manifest.Documents = append(manifest.Documents, document)
		case header.Type == export.ManifestTypeEnd:
			if err := json.Unmarshal(line, &manifest.End); err != nil {
				return manifest, formatError("the end line does not parse")
			}

			ended = true
		default:
			return manifest, formatError("line %d has an unknown type", number)
		}
	}

	if !ended {
		return manifest, formatError("the manifest has no end line, so it is incomplete")
	}

	counts.Type = export.ManifestTypeEnd
	if manifest.End != counts {
		return manifest, formatError("the end line's counts do not match the document lines")
	}

	return manifest, nil
}

// readManifestLine reads one "\n"-terminated line of at most
// maxManifestLine bytes, without the newline. A last line without its
// newline is refused: the manifest was cut.
func readManifestLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte

	for {
		chunk, err := reader.ReadSlice('\n')
		line = append(line, chunk...)

		if len(line) > maxManifestLine+1 {
			return nil, formatError("a manifest line is longer than %d bytes", maxManifestLine)
		}

		switch {
		case err == nil:
			return bytes.TrimSuffix(line, []byte("\n")), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) == 0:
			return nil, io.EOF
		case errors.Is(err, io.EOF):
			return nil, formatError("the manifest's last line is cut")
		default:
			return nil, fmt.Errorf("read the manifest: %w", err)
		}
	}
}

// checkManifestDocument checks one document line's shape.
func checkManifestDocument(vaultID uuid.UUID, document export.ManifestDocument) error {
	if document.DocumentID == uuid.Nil {
		return errors.New("no document id")
	}

	if document.Kind != string(KindText) && document.Kind != string(KindBlob) {
		return errors.New("the kind is not text or blob")
	}

	var want string

	switch document.Status {
	case export.ManifestPlaced:
		if document.Path == "" || document.PathBase64 != "" {
			return errors.New("a placed document has no exact path")
		}

		want = vaultID.String() + "/" + document.Path
	case export.ManifestUnplaced:
		want = vaultID.String() + export.UnplacedSuffix + "/" + document.DocumentID.String()
	case export.ManifestMissing:
		if document.Location != "" {
			return errors.New("a missing document has a location")
		}

		return nil
	default:
		return errors.New("the status is not placed, unplaced or missing")
	}

	if document.Location != want {
		return errors.New("the location is not the document's own file")
	}

	if decoded, err := hex.DecodeString(document.SHA256); err != nil || len(decoded) != sha256.Size || strings.ToLower(document.SHA256) != document.SHA256 {
		return errors.New("the sha256 is not 64 lowercase hex characters")
	}

	if document.Size < 0 {
		return errors.New("the size is negative")
	}

	return nil
}

// exportTrees opens the vault's directory and unplaced tree in an export.
// A tree that does not exist is nil.
type exportTrees struct {
	vaultID  uuid.UUID
	placed   *os.Root
	unplaced *os.Root
}

func openExportTrees(exportDir string, vaultID uuid.UUID) (*exportTrees, error) {
	trees := &exportTrees{vaultID: vaultID}

	for _, tree := range []struct {
		root   **os.Root
		suffix string
	}{{&trees.placed, ""}, {&trees.unplaced, export.UnplacedSuffix}} {
		root, err := os.OpenRoot(filepath.Join(exportDir, vaultID.String()+tree.suffix))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}

		if err != nil {
			trees.close()

			return nil, fmt.Errorf("open the export: %w", err)
		}

		*tree.root = root
	}

	return trees, nil
}

func (trees *exportTrees) close() {
	for _, root := range []*os.Root{trees.placed, trees.unplaced} {
		if root != nil {
			_ = root.Close()
		}
	}
}

// locate returns the tree and the tree-relative name of a manifest
// location that checkManifestDocument accepted.
func (trees *exportTrees) locate(location string) (*os.Root, string) {
	unplacedPrefix := trees.vaultID.String() + export.UnplacedSuffix + "/"
	if rest, ok := strings.CutPrefix(location, unplacedPrefix); ok {
		return trees.unplaced, rest
	}

	return trees.placed, strings.TrimPrefix(location, trees.vaultID.String()+"/")
}

// errNotRegular is a location that is not a regular file reached without a
// symbolic link.
var errNotRegular = errors.New("not a regular file")

// open opens the regular file at a manifest location, refusing any
// symbolic link on the way.
func (trees *exportTrees) open(location string) (*os.File, error) {
	root, name := trees.locate(location)
	if root == nil {
		return nil, fs.ErrNotExist
	}

	parts := strings.Split(name, "/")
	for index := range parts {
		info, err := root.Lstat(path.Join(parts[:index+1]...))
		if err != nil {
			return nil, err
		}

		last := index == len(parts)-1
		if (last && !info.Mode().IsRegular()) || (!last && !info.IsDir()) {
			return nil, errNotRegular
		}
	}

	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}

	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
		_ = file.Close()

		return nil, errNotRegular
	}

	return file, nil
}

// readVerified reads the document's file, at most limit bytes, and checks
// its size and SHA-256 against the manifest. It returns the bytes and an
// empty reason, or a fixed reason the document fails.
func (trees *exportTrees) readVerified(document export.ManifestDocument, limit int64) ([]byte, string, error) {
	file, err := trees.open(document.Location)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errNotRegular) {
		return nil, reasonNotARegular, nil
	}

	if err != nil {
		return nil, "", fmt.Errorf("open document %s: %w", document.DocumentID, withoutPath(err))
	}
	defer func() { _ = file.Close() }()

	if document.Size > limit {
		return nil, ReasonOverLimit, nil
	}

	content, err := io.ReadAll(io.LimitReader(file, document.Size+1))
	if err != nil {
		return nil, "", fmt.Errorf("read document %s: %w", document.DocumentID, withoutPath(err))
	}

	if int64(len(content)) != document.Size {
		return nil, ReasonSizeDiffers, nil
	}

	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != document.SHA256 {
		return nil, ReasonHashDiffers, nil
	}

	return content, "", nil
}

// withoutPath drops the file name from a *fs.PathError, so an error never
// carries a document's path.
func withoutPath(err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return fmt.Errorf("%s: %w", pathErr.Op, pathErr.Err)
	}

	return err
}

// VerifyExport checks every document of manifest that has bytes in the
// export, and looks for files no line names (docs/design/restore-from-export.md
// §3, steps 3 and 4). It returns every failure; an error means the export
// could not be read at all.
func VerifyExport(exportDir string, manifest ExportManifest, limit int64) ([]FailedVerification, error) {
	trees, err := openExportTrees(exportDir, manifest.Vault.VaultID)
	if err != nil {
		return nil, err
	}
	defer trees.close()

	failed := []FailedVerification{}
	named := map[string]bool{}

	for _, document := range manifest.Documents {
		if document.Status == export.ManifestMissing {
			continue
		}

		named[document.Location] = true

		_, reason, err := trees.readVerified(document, limit)
		if err != nil {
			return nil, err
		}

		if reason != "" {
			failed = append(failed, FailedVerification{DocumentID: document.DocumentID.String(), Location: document.Location, Reason: reason})
		}
	}

	for _, tree := range []struct {
		root   *os.Root
		prefix string
	}{
		{trees.placed, manifest.Vault.VaultID.String() + "/"},
		{trees.unplaced, manifest.Vault.VaultID.String() + export.UnplacedSuffix + "/"},
	} {
		if tree.root == nil {
			continue
		}

		err := fs.WalkDir(tree.root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
			if err != nil {
				return withoutPath(err)
			}

			if entry.IsDir() {
				return nil
			}

			if location := tree.prefix + name; !named[location] {
				failed = append(failed, FailedVerification{Location: location, Reason: ReasonNotInExport})
			}

			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("list the export: %w", err)
		}
	}

	return failed, nil
}
