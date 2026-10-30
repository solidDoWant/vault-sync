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
// (docs/admin/backup-and-restore.md). It is written to the marker and to
// every manifest's first line, and changes whenever either changes in a way
// a reader must know about. Readers reject a format they do not know and
// ignore fields they do not know.
//
// A manifest, "<vault-id>.manifest.jsonl", is UTF-8 JSON Lines: one JSON
// object per line, each ended by "\n", each with a "type". The first line
// is a ManifestVault, then one ManifestDocument per live document in
// ascending document_id order, and the last line is a ManifestEnd.
//
// An export is intact when, for every manifest, the file at each document's
// location has exactly size bytes whose SHA-256 is sha256, and every file
// under "<vault-id>/" and "<vault-id>.unplaced/" is the location of exactly
// one document line.
const FormatVersion = 2

// File names beside a vault's directory, all outside it so no document
// path can be mistaken for them.
const (
	// ManifestSuffix follows the vault id in the name of its manifest.
	ManifestSuffix = ".manifest.jsonl"
	// UnplacedSuffix follows the vault id in the name of its unplaced
	// tree, which holds the documents that cannot be placed at their path,
	// each in a file named by its document id.
	UnplacedSuffix = ".unplaced"
	// DeletedSuffix follows the vault id in the name of the file marking a
	// vault an owner deleted and the server has not purged yet. It holds
	// the deletion time (RFC 3339).
	DeletedSuffix = ".DELETED"
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

// ManifestVault is a manifest's first line ("type": "vault").
type ManifestVault struct {
	Type string `json:"type"`
	// Format is FormatVersion.
	Format  int       `json:"format"`
	VaultID uuid.UUID `json:"vault_id"`
	// Name is the vault's name at export time.
	Name string `json:"name"`
	// Encryption is "none", or "e2ee" for a decrypted escrowed vault.
	Encryption string `json:"encryption"`
	// HeadSeq is the point in the vault's history that was exported.
	HeadSeq int64 `json:"head_seq"`
	// StartedAt is when the run started (RFC 3339, UTC).
	StartedAt time.Time `json:"started_at"`
}

// ManifestDocument is a manifest line ("type": "document") for one live
// document.
type ManifestDocument struct {
	Type string `json:"type"`
	// DocumentID is the document's id, stable across renames.
	DocumentID uuid.UUID `json:"document_id"`
	// Path is the document's vault-relative path, exactly as stored (in an
	// escrowed vault, decrypted; empty when it does not decrypt). If it is
	// not valid UTF-8, which JSON cannot carry exactly, Path holds an
	// approximation and PathBase64 holds its exact bytes (standard base64).
	Path       string `json:"path"`
	PathBase64 string `json:"path_base64,omitempty"`
	// Kind is "blob", "text" or "yjs".
	Kind string `json:"kind"`
	// RevisionID is the head revision that was exported.
	RevisionID uuid.UUID `json:"revision_id"`
	// Size (in bytes) and SHA256 (lowercase hex) describe the head
	// revision's content, as stored by the server. They are present even
	// when the bytes are missing. In a decrypted escrowed vault they
	// describe the plaintext; a document there whose content cannot be
	// decrypted keeps its stored (encrypted) Size and an empty SHA256.
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	// Status is ManifestPlaced (the bytes are at "<vault-id>/<path>"),
	// ManifestUnplaced (the bytes are at
	// "<vault-id>.unplaced/<document-id>") or ManifestMissing.
	Status string `json:"status"`
	// Location is the file holding the content, slash-separated and
	// relative to the export directory. Absent when Status is missing.
	Location string `json:"location,omitempty"`
	// Reason says why the document is unplaced or missing. Absent when it
	// is placed.
	Reason string `json:"reason,omitempty"`
}

// ManifestEnd is a manifest's last line ("type": "end"), with the counts of
// its document lines. A manifest without it, or whose counts do not match
// its document lines, is incomplete (for example a truncated copy).
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
