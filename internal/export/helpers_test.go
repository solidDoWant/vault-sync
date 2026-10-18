//go:build linux

package export_test

import (
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
}

func newFakeSource() *fakeSource {
	return &fakeSource{documents: map[uuid.UUID][]store.LiveDocument{}, content: map[string][]byte{}}
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
		ID: id, RevisionID: uuid.Must(uuid.NewV7()), Path: path, ContentRef: sum[:], Size: int64(len(content)),
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

// files returns the regular files under directory and their contents, by
// slash-separated relative path, leaving out the export marker.
func files(t *testing.T, directory string) map[string]string {
	t.Helper()

	contents := map[string]string{}

	for path, recorded := range snapshot(t, directory) {
		require.Zero(t, recorded.Mode&fs.ModeSymlink, "unexpected symbolic link %s", path)

		if recorded.Mode.IsRegular() && path != export.MarkerName {
			contents[path] = recorded.Content
		}
	}

	return contents
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
	Name  string `json:"name"`
	Path  string `json:"path"`
	Valid bool   `json:"valid"`
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

	return file.Vectors
}
