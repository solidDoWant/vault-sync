//go:build linux

package export_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// fakeSource is an in-memory export source. Hooks run before the matching
// call returns and may fail it.
type fakeSource struct {
	vaults    []store.Vault
	documents map[uuid.UUID][]store.LiveDocument
	content   map[string][]byte

	onDocuments func(ctx context.Context, vaultID uuid.UUID, after uuid.UUID) error
	onContent   func(ctx context.Context, blobID []byte) (io.ReadCloser, error)

	// seqs records the seq of every Documents call, by vault.
	seqs map[uuid.UUID][]int64
}

func newFakeSource() *fakeSource {
	return &fakeSource{documents: map[uuid.UUID][]store.LiveDocument{}, content: map[string][]byte{}, seqs: map[uuid.UUID][]int64{}}
}

// addVault adds a vault and returns its id.
func (source *fakeSource) addVault(name string, encryption store.Encryption) uuid.UUID {
	id := uuid.Must(uuid.NewV7())
	source.vaults = append(source.vaults, store.Vault{ID: id, Name: name, Encryption: encryption, HeadSeq: 42})

	return id
}

// addDocument adds a live document with content to the vault and returns
// its id. Documents are listed in the order they are added.
func (source *fakeSource) addDocument(vaultID uuid.UUID, path string, content []byte) uuid.UUID {
	sum := sha256.Sum256(content)
	source.content[hex.EncodeToString(sum[:])] = content

	id := uuid.Must(uuid.NewV7())
	source.documents[vaultID] = append(source.documents[vaultID], store.LiveDocument{
		ID: id, Kind: "text", RevisionID: uuid.Must(uuid.NewV7()), Path: path, ContentRef: sum[:], Size: int64(len(content)),
	})

	return id
}

func (source *fakeSource) Vaults(_ context.Context, after uuid.UUID, limit int) ([]store.Vault, error) {
	var page []store.Vault

	for _, vault := range source.vaults {
		if after != uuid.Nil && bytes.Compare(vault.ID[:], after[:]) <= 0 {
			continue
		}

		if len(page) == limit {
			break
		}

		page = append(page, vault)
	}

	return page, nil
}

func (source *fakeSource) Documents(ctx context.Context, vaultID uuid.UUID, seq int64, after uuid.UUID, limit int) ([]store.LiveDocument, error) {
	source.seqs[vaultID] = append(source.seqs[vaultID], seq)

	if source.onDocuments != nil {
		if err := source.onDocuments(ctx, vaultID, after); err != nil {
			return nil, err
		}
	}

	var page []store.LiveDocument

	for _, document := range source.documents[vaultID] {
		if after != uuid.Nil && bytes.Compare(document.ID[:], after[:]) <= 0 {
			continue
		}

		if len(page) == limit {
			break
		}

		page = append(page, document)
	}

	return page, nil
}

func (source *fakeSource) Content(ctx context.Context, _ uuid.UUID, blobID []byte) (io.ReadCloser, error) {
	if source.onContent != nil {
		content, err := source.onContent(ctx, blobID)
		if content != nil || err != nil {
			return content, err
		}
	}

	content, ok := source.content[hex.EncodeToString(blobID)]
	if !ok {
		return nil, export.ErrContentMissing
	}

	return io.NopCloser(bytes.NewReader(content)), nil
}

// workspace is a directory holding the output directory and its siblings.
type workspace struct {
	root   string
	output string
}

func newWorkspace(t *testing.T) workspace {
	t.Helper()

	root := t.TempDir()

	return workspace{root: root, output: filepath.Join(root, "out")}
}

func (space workspace) run(t *testing.T, ctx context.Context, source export.Source) (export.Summary, error) {
	t.Helper()

	return export.Run(ctx, export.Options{
		Output:   space.output,
		Source:   source,
		Logger:   slog.New(slog.DiscardHandler),
		PageSize: 2,
	})
}

// entry is a file, directory or symbolic link in a snapshot.
type entry struct {
	Mode    fs.FileMode
	Content string
}

// snapshot returns every entry under directory by slash-separated relative
// path. Symbolic links are recorded with their target, never followed.
func snapshot(t *testing.T, directory string) map[string]entry {
	t.Helper()

	entries := map[string]entry{}

	err := filepath.WalkDir(directory, func(path string, dirEntry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		relative, err := filepath.Rel(directory, path)
		if err != nil || relative == "." {
			return err
		}

		info, err := dirEntry.Info()
		if err != nil {
			return err
		}

		recorded := entry{Mode: info.Mode()}

		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}

			recorded.Content = target
		case info.Mode().IsRegular():
			content, err := os.ReadFile(path)
			if err != nil {
				return err
			}

			recorded.Content = string(content)
		}

		entries[filepath.ToSlash(relative)] = recorded

		return nil
	})
	require.NoError(t, err)

	return entries
}

// files returns the regular files in the vault directories and unplaced
// trees under directory and their contents, by slash-separated relative
// path. Files directly in directory (the marker and the manifests) are left
// out.
func files(t *testing.T, directory string) map[string]string {
	t.Helper()

	contents := map[string]string{}

	for path, recorded := range snapshot(t, directory) {
		require.Zero(t, recorded.Mode&fs.ModeSymlink, "unexpected symbolic link %s", path)

		if recorded.Mode.IsRegular() && strings.Contains(path, "/") {
			contents[path] = recorded.Content
		}
	}

	return contents
}

// manifestDocument is a document line of a vault manifest, decoded with the
// field names docs/export.md specifies.
type manifestDocument struct {
	Type       string    `json:"type"`
	DocumentID uuid.UUID `json:"document_id"`
	Path       string    `json:"path"`
	PathBase64 string    `json:"path_base64"`
	Kind       string    `json:"kind"`
	RevisionID uuid.UUID `json:"revision_id"`
	Size       int64     `json:"size"`
	SHA256     string    `json:"sha256"`
	Status     string    `json:"status"`
	Location   string    `json:"location"`
	Reason     string    `json:"reason"`
}

// manifest is one vault's decoded manifest.
type manifest struct {
	Vault struct {
		Type       string    `json:"type"`
		Format     int       `json:"format"`
		VaultID    uuid.UUID `json:"vault_id"`
		Name       string    `json:"name"`
		Encryption string    `json:"encryption"`
		HeadSeq    int64     `json:"head_seq"`
	}
	Documents []manifestDocument
	End       struct {
		Type      string `json:"type"`
		Documents int    `json:"documents"`
		Placed    int    `json:"placed"`
		Unplaced  int    `json:"unplaced"`
		Missing   int    `json:"missing"`
	}
}

// byID returns the manifest's documents by id.
func (vault manifest) byID() map[uuid.UUID]manifestDocument {
	documents := map[uuid.UUID]manifestDocument{}
	for _, document := range vault.Documents {
		documents[document.DocumentID] = document
	}

	return documents
}

// verifyManifests checks an export against its manifests the way a restore
// would, and returns them by vault id: every manifest is complete (a vault
// line, document lines, and an end line whose counts match), every exported
// document's file is at its location with its size and SHA-256, a missing
// document has no location, and every file in the export is either the
// marker, a manifest, or some document's location.
func verifyManifests(t *testing.T, output string) map[uuid.UUID]manifest {
	t.Helper()

	manifests := map[uuid.UUID]manifest{}
	locations := map[string]bool{}

	entries, err := os.ReadDir(output)
	require.NoError(t, err)

	for _, dirEntry := range entries {
		name, found := strings.CutSuffix(dirEntry.Name(), ".manifest.jsonl")
		if !found {
			continue
		}

		vault := readManifest(t, filepath.Join(output, dirEntry.Name()))
		require.Equal(t, name, vault.Vault.VaultID.String(), "a manifest is named by its vault id")

		counts := map[string]int{}

		for _, document := range vault.Documents {
			counts[document.Status]++

			if document.Status == "missing" {
				assert.Empty(t, document.Location, "a missing document has no bytes in the export")
				assert.NotEmpty(t, document.Reason)

				continue
			}

			require.Contains(t, []string{"placed", "unplaced"}, document.Status)
			require.False(t, locations[document.Location], "two documents at %s", document.Location)
			locations[document.Location] = true

			content, err := os.ReadFile(filepath.Join(output, filepath.FromSlash(document.Location)))
			require.NoError(t, err, "document %s is at its location", document.DocumentID)

			sum := sha256.Sum256(content)
			assert.Equal(t, document.Size, int64(len(content)), "document %s size", document.DocumentID)
			assert.Equal(t, document.SHA256, hex.EncodeToString(sum[:]), "document %s hash", document.DocumentID)
		}

		assert.Equal(t, len(vault.Documents), vault.End.Documents)
		assert.Equal(t, counts["placed"], vault.End.Placed)
		assert.Equal(t, counts["unplaced"], vault.End.Unplaced)
		assert.Equal(t, counts["missing"], vault.End.Missing)

		manifests[vault.Vault.VaultID] = vault
	}

	for path, recorded := range snapshot(t, output) {
		if !recorded.Mode.IsRegular() || path == export.MarkerName || strings.HasSuffix(path, ".manifest.jsonl") && !strings.Contains(path, "/") {
			continue
		}

		assert.True(t, locations[path], "file %s is listed in a manifest", path)
	}

	return manifests
}

func readManifest(t *testing.T, path string) manifest {
	t.Helper()

	file, err := os.Open(path)
	require.NoError(t, err)

	defer func() { _ = file.Close() }()

	var vault manifest

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)

	line := 0
	ended := false

	for scanner.Scan() {
		require.False(t, ended, "nothing follows the end line")

		var record struct {
			Type string `json:"type"`
		}

		require.NoError(t, json.Unmarshal(scanner.Bytes(), &record))

		switch {
		case line == 0:
			require.Equal(t, "vault", record.Type, "the first line describes the vault")
			require.NoError(t, json.Unmarshal(scanner.Bytes(), &vault.Vault))
			require.Equal(t, 2, vault.Vault.Format)
		case record.Type == "document":
			var document manifestDocument
			require.NoError(t, json.Unmarshal(scanner.Bytes(), &document))
			vault.Documents = append(vault.Documents, document)
		case record.Type == "end":
			require.NoError(t, json.Unmarshal(scanner.Bytes(), &vault.End))

			ended = true
		default:
			t.Fatalf("unexpected manifest line %q", scanner.Text())
		}

		line++
	}

	require.NoError(t, scanner.Err())
	require.True(t, ended, "the manifest ends with an end line")

	return vault
}

// siblings returns the names in the workspace root.
func (space workspace) siblings(t *testing.T) []string {
	t.Helper()

	entries, err := os.ReadDir(space.root)
	require.NoError(t, err)

	names := make([]string, 0, len(entries))
	for _, dirEntry := range entries {
		names = append(names, dirEntry.Name())
	}

	slices.Sort(names)

	return names
}

// stagingDirectories returns the staging directories in the workspace root.
func (space workspace) stagingDirectories(t *testing.T) []string {
	t.Helper()

	var staging []string

	for _, name := range space.siblings(t) {
		if strings.HasPrefix(name, ".out.staging-") {
			staging = append(staging, filepath.Join(space.root, name))
		}
	}

	return staging
}

// emptyDirectories returns the empty directories under directory, by
// slash-separated relative path.
func emptyDirectories(t *testing.T, directory string) []string {
	t.Helper()

	var empty []string

	for path, recorded := range snapshot(t, directory) {
		if !recorded.Mode.IsDir() {
			continue
		}

		entries, err := os.ReadDir(filepath.Join(directory, filepath.FromSlash(path)))
		require.NoError(t, err)

		if len(entries) == 0 {
			empty = append(empty, path)
		}
	}

	slices.Sort(empty)

	return empty
}

// documentErrors returns the reasons listed in a summary, by document id.
func documentErrors(summary export.Summary) map[uuid.UUID]string {
	reasons := map[uuid.UUID]string{}

	for _, vault := range summary.VaultDetails {
		for _, documentError := range vault.DocumentErrors {
			reasons[documentError.DocumentID] = documentError.Reason
		}
	}

	return reasons
}

type pathVector struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Repeat int    `json:"repeat"`
	Suffix string `json:"suffix"`
	Valid  bool   `json:"valid"`
}

// loadPathVectors reads the shared path validity vectors (SPEC.md §6.2).
func loadPathVectors(t *testing.T) []pathVector {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "validity.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []pathVector `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	// A vector's path is "path" repeated "repeat" times, then "suffix".
	for index := range file.Vectors {
		vector := &file.Vectors[index]
		vector.Path = strings.Repeat(vector.Path, max(vector.Repeat, 1)) + vector.Suffix
	}

	return file.Vectors
}
