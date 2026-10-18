package export

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// FormatVersion is the version of the export layout and manifest format
// (docs/export.md). It is written to the marker and to every manifest, and
// changes whenever either changes in a way a reader must know about.
const FormatVersion = 2

// File names beside a vault's directory, both outside it so no document
// path can be mistaken for them.
const (
	// ManifestSuffix follows the vault id in the name of its manifest.
	ManifestSuffix = ".manifest.jsonl"
	// UnplacedSuffix follows the vault id in the name of its unplaced
	// tree, which holds the documents that cannot be placed at their path,
	// each in a file named by its document id.
	UnplacedSuffix = ".unplaced"
)

// Manifest line types.
const (
	ManifestTypeVault    = "vault"
	ManifestTypeDocument = "document"
	ManifestTypeEnd      = "end"
)

// Statuses of a manifest document.
const (
	// ManifestPlaced: the document's bytes are at its path in the vault
	// directory.
	ManifestPlaced = "placed"
	// ManifestUnplaced: the document's bytes are in the unplaced tree.
	ManifestUnplaced = "unplaced"
	// ManifestMissing: the document's content is missing or corrupt in
	// the object store, so its bytes are not in the export.
	ManifestMissing = "missing"
)

// ManifestVault is a manifest's first line.
type ManifestVault struct {
	Type       string    `json:"type"`
	Format     int       `json:"format"`
	VaultID    uuid.UUID `json:"vault_id"`
	Name       string    `json:"name"`
	Encryption string    `json:"encryption"`
	HeadSeq    int64     `json:"head_seq"`
	StartedAt  time.Time `json:"started_at"`
}

// ManifestDocument is a manifest line for one live document.
type ManifestDocument struct {
	Type       string    `json:"type"`
	DocumentID uuid.UUID `json:"document_id"`
	// Path is the document's path. If it is not valid UTF-8, which JSON
	// cannot carry exactly, PathBase64 holds its exact bytes.
	Path       string    `json:"path"`
	PathBase64 string    `json:"path_base64,omitempty"`
	Kind       string    `json:"kind"`
	RevisionID uuid.UUID `json:"revision_id"`
	// Size and SHA256 (hex) describe the head revision's content, as
	// stored by the server, whether or not it is in the export.
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Status string `json:"status"`
	// Location is the file holding the content, slash-separated and
	// relative to the export directory. Empty when Status is missing.
	Location string `json:"location,omitempty"`
	// Reason says why the document is unplaced or missing.
	Reason string `json:"reason,omitempty"`
}

// ManifestEnd is a manifest's last line. A manifest without it is
// incomplete.
type ManifestEnd struct {
	Type      string `json:"type"`
	Documents int64  `json:"documents"`
	Placed    int64  `json:"placed"`
	Unplaced  int64  `json:"unplaced"`
	Missing   int64  `json:"missing"`
}

// manifestWriter streams one vault's manifest, one JSON line at a time, so
// a vault of any size needs memory only for one document.
type manifestWriter struct {
	file    *os.File
	buffer  *bufio.Writer
	encoder *json.Encoder
	end     ManifestEnd
}

func createManifest(path string, vault store.Vault, startedAt time.Time) (*manifestWriter, error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		return nil, fmt.Errorf("create manifest: %w", err)
	}

	buffer := bufio.NewWriter(file)
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)

	manifest := &manifestWriter{file: file, buffer: buffer, encoder: encoder, end: ManifestEnd{Type: ManifestTypeEnd}}

	err = manifest.write(ManifestVault{
		Type: ManifestTypeVault, Format: FormatVersion, VaultID: vault.ID, Name: vault.Name,
		Encryption: string(vault.Encryption), HeadSeq: vault.HeadSeq, StartedAt: startedAt,
	})
	if err != nil {
		_ = file.Close()

		return nil, err
	}

	return manifest, nil
}

// newManifestDocument describes document, without its status.
func newManifestDocument(document store.LiveDocument) ManifestDocument {
	record := ManifestDocument{
		Type: ManifestTypeDocument, DocumentID: document.ID, Path: document.Path, Kind: document.Kind,
		RevisionID: document.RevisionID, Size: document.Size, SHA256: hex.EncodeToString(document.ContentRef),
	}

	if !utf8.ValidString(document.Path) {
		record.PathBase64 = base64.StdEncoding.EncodeToString([]byte(document.Path))
	}

	return record
}

func (manifest *manifestWriter) document(record ManifestDocument) error {
	manifest.end.Documents++

	switch record.Status {
	case ManifestPlaced:
		manifest.end.Placed++
	case ManifestUnplaced:
		manifest.end.Unplaced++
	case ManifestMissing:
		manifest.end.Missing++
	}

	return manifest.write(record)
}

func (manifest *manifestWriter) write(record any) error {
	if err := manifest.encoder.Encode(record); err != nil {
		return fmt.Errorf("write manifest: %w", withoutPath(err))
	}

	return nil
}

// finish writes the end line and closes the manifest.
func (manifest *manifestWriter) finish() error {
	err := manifest.write(manifest.end)
	if err == nil {
		err = manifest.buffer.Flush()
	}

	if closeErr := manifest.file.Close(); err == nil && closeErr != nil {
		err = closeErr
	}

	if err != nil {
		return fmt.Errorf("write manifest: %w", withoutPath(err))
	}

	return nil
}

// abandon closes the manifest after a failure; the staging tree holding it
// is removed.
func (manifest *manifestWriter) abandon() {
	_ = manifest.file.Close()
}
