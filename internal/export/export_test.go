//go:build linux

package export_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestExportMirrorsEveryVaultsLiveDocuments(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()

	binary := make([]byte, 70<<10)
	for index := range binary {
		binary[index] = byte(index * 7)
	}

	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("# A\n"))
	source.addDocument(notes, "daily/2026/10-18.md", []byte("today"))
	source.addDocument(notes, "daily/2026/10-19.md", []byte("tomorrow"))
	source.addDocument(notes, "attachments/image.png", binary)
	source.addDocument(notes, "empty.md", []byte{})
	source.addDocument(notes, `back\slash.md`, []byte("a name, not a directory"))
	source.addDocument(notes, ".obsidian/app.json", []byte("{}"))

	work := source.addVault("Notes", store.EncryptionNone) // names may collide
	source.addDocument(work, "a.md", []byte("work A"))

	empty := source.addVault("Empty", store.EncryptionNone)
	secret := source.addVault("Secret", store.EncryptionE2EE)
	source.addDocument(secret, "ciphertext", []byte("never exported"))

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, map[string]string{
		notes.String() + "/a.md":                  "# A\n",
		notes.String() + "/daily/2026/10-18.md":   "today",
		notes.String() + "/daily/2026/10-19.md":   "tomorrow",
		notes.String() + "/attachments/image.png": string(binary),
		notes.String() + "/empty.md":              "",
		notes.String() + `/back\slash.md`:         "a name, not a directory",
		notes.String() + "/.obsidian/app.json":    "{}",
		work.String() + "/a.md":                   "work A",
	}, files(t, space.output))

	info, err := os.Stat(filepath.Join(space.output, empty.String()))
	require.NoError(t, err, "an empty vault still gets its directory")
	assert.True(t, info.IsDir())

	_, err = os.Lstat(filepath.Join(space.output, secret.String()))
	require.ErrorIs(t, err, fs.ErrNotExist, "an end-to-end encrypted vault is not exported")

	_, err = os.Lstat(filepath.Join(space.output, secret.String()+".manifest.jsonl"))
	require.ErrorIs(t, err, fs.ErrNotExist, "nor gets a manifest")

	manifests := verifyManifests(t, space.output)
	require.Len(t, manifests, 3, "every exported vault has a manifest, even an empty one")
	assert.Len(t, manifests[notes].Documents, 7)
	assert.Len(t, manifests[work].Documents, 1)
	assert.Empty(t, manifests[empty].Documents)

	_, err = os.Lstat(filepath.Join(space.output, notes.String()+".unplaced"))
	require.ErrorIs(t, err, fs.ErrNotExist, "there is no unplaced tree when every document is placed")

	marker, err := os.ReadFile(filepath.Join(space.output, export.MarkerName))
	require.NoError(t, err)
	assert.Contains(t, string(marker), `"format":2`, "the marker names the export format")

	assert.Equal(t, export.StatusOK, summary.Status)
	assert.Empty(t, summary.Error)
	assert.Equal(t, space.output, summary.Output)
	assert.Equal(t, 3, summary.Vaults)
	assert.Equal(t, 1, summary.SkippedVaults)
	assert.EqualValues(t, 8, summary.Files)
	assert.EqualValues(t, 4+5+8+len(binary)+0+23+2+6, summary.Bytes)
	assert.Zero(t, summary.DocumentErrors)
	assert.GreaterOrEqual(t, summary.DurationSeconds, 0.0)
	assert.False(t, summary.StartedAt.IsZero())

	assert.Equal(t, []export.VaultSummary{
		{ID: notes, Name: "Notes", Encryption: "none", HeadSeq: 42, Files: 7, Bytes: int64(4 + 5 + 8 + len(binary) + 0 + 23 + 2)},
		{ID: work, Name: "Notes", Encryption: "none", HeadSeq: 42, Files: 1, Bytes: 6},
		{ID: empty, Name: "Empty", Encryption: "none", HeadSeq: 42},
		{ID: secret, Name: "Secret", Encryption: "e2ee", HeadSeq: 42, Skipped: export.SkippedNoEscrow},
	}, summary.VaultDetails)

	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "no staging directory is left behind")
}

func TestExportReplacesThePreviousExport(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()

	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "kept.md", []byte("kept"))
	source.addDocument(notes, "deleted.md", []byte("deleted"))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	source.documents[notes] = nil
	source.addDocument(notes, "kept.md", []byte("kept, edited"))
	source.addDocument(notes, "new/file.md", []byte("new"))

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)
	assert.Equal(t, export.StatusOK, summary.Status)

	assert.Equal(t, map[string]string{
		notes.String() + "/kept.md":     "kept, edited",
		notes.String() + "/new/file.md": "new",
	}, files(t, space.output))
	assert.Len(t, verifyManifests(t, space.output)[notes].Documents, 2, "the manifest is replaced too")

	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "the previous export is removed")
}

func TestExportWritesOnlyInsideTheVaultDirectory(t *testing.T) {
	// Every shared validity vector (SPEC.md §6.2) plus traversal attempts
	// a database row could carry if it bypassed CommitRevision. Each path
	// gets its own vault, so valid paths cannot conflict with each other.
	// A name longer than 255 bytes is valid but no filesystem here can
	// hold it, so such vectors are left out: this test is about containment.
	paths := slices.DeleteFunc(loadPathVectors(t), func(vector pathVector) bool {
		return slices.ContainsFunc(strings.Split(vector.Path, "/"), func(name string) bool { return len(name) > 255 })
	})
	for _, attempt := range []string{
		"..", "../escape.md", "../../escape.md", "a/../../escape.md", "a/./b.md",
		"/etc/escape.md", "/tmp/escape.md",
		`..\escape.md`, `a\..\..\escape.md`, `\escape.md`,
		`C:\escape.md`, `C:escape.md`, `c:/escape.md`,
		`\\server\share\escape.md`, `\\?\C:\escape.md`, `\\.\pipe\escape`,
		"//server/share/escape.md", "a//b.md", "a/", "", ". ", ".. /escape.md",
	} {
		paths = append(paths, pathVector{Name: attempt, Path: attempt, Valid: false})
	}

	space := newWorkspace(t)
	source := newFakeSource()

	wantFiles := map[string]string{}
	unplaced := map[uuid.UUID]string{}

	for _, vector := range paths {
		vault := source.addVault(vector.Name, store.EncryptionNone)
		document := source.addDocument(vault, vector.Path, []byte(vector.Name))

		if vector.Valid {
			wantFiles[vault.String()+"/"+vector.Path] = vector.Name
		} else {
			// Kept by document id, outside the vault directory.
			wantFiles[vault.String()+".unplaced/"+document.String()] = vector.Name
			unplaced[document] = vector.Path
		}
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, wantFiles, files(t, space.output), "valid paths are written verbatim; invalid ones by document id")
	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "nothing is written beside the export")

	assert.Equal(t, export.StatusOK, summary.Status, "every document is in the export")
	assert.Zero(t, summary.DocumentErrors)
	assert.EqualValues(t, len(unplaced), summary.Unplaced)
	assert.EqualValues(t, len(paths), summary.Files)

	manifests := verifyManifests(t, space.output)
	require.Len(t, manifests, len(paths))

	for _, vault := range manifests {
		require.Len(t, vault.Documents, 1)
		document := vault.Documents[0]

		if path, ok := unplaced[document.DocumentID]; ok {
			assert.Equal(t, "unplaced", document.Status)
			assert.Equal(t, path, document.Path, "the manifest keeps the original path")
			assert.Equal(t, "path is not vault-relative", document.Reason)
		} else {
			assert.Equal(t, "placed", document.Status)
		}
	}
}

func TestExportNeverFollowsASymbolicLink(t *testing.T) {
	space := newWorkspace(t)
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "target.md")
	require.NoError(t, os.WriteFile(outsideFile, []byte("outside"), 0o600))

	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)

	// A previous export whose tree contains links out of it.
	previous := filepath.Join(space.output, notes.String())
	require.NoError(t, os.MkdirAll(previous, 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(space.output, export.MarkerName), nil, 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(previous, "linked")))
	require.NoError(t, os.Symlink(outsideFile, filepath.Join(previous, "target.md")))

	// Links planted in the new tree while the export runs (by anything
	// else with write access to the output's parent).
	source.addDocument(notes, "plant.md", []byte("plants links"))
	throughDirectory := source.addDocument(notes, "planted/escape.md", []byte("through a directory link"))
	ontoFile := source.addDocument(notes, "planted-file.md", []byte("onto a file link"))
	source.addDocument(notes, "linked/escape.md", []byte("where the old tree had a link"))
	source.addDocument(notes, "target.md", []byte("where the old tree had a link"))

	plantBlob := source.documents[notes][0].ContentRef
	source.onContent = func(_ context.Context, blobID []byte) (io.ReadCloser, error) {
		if !bytes.Equal(blobID, plantBlob) {
			return nil, nil
		}

		staging := space.stagingDirectories(t)
		require.Len(t, staging, 1)

		vaultDir := filepath.Join(staging[0], notes.String())
		require.NoError(t, os.Symlink(outside, filepath.Join(vaultDir, "planted")))
		require.NoError(t, os.Symlink(outsideFile, filepath.Join(vaultDir, "planted-file.md")))

		return nil, nil
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, map[string]entry{"target.md": {Mode: 0o600, Content: "outside"}}, snapshot(t, outside), "nothing is written through a link")
	assert.Equal(t, export.StatusOK, summary.Status)
	assert.Zero(t, summary.DocumentErrors)

	// The planted links stay in the tree; the documents they block are
	// kept in the unplaced tree instead.
	unplacedDir := filepath.Join(space.output, notes.String()+".unplaced")
	exportedUnplaced := snapshot(t, unplacedDir)
	assert.Equal(t, "through a directory link", exportedUnplaced[throughDirectory.String()].Content)
	assert.Equal(t, "onto a file link", exportedUnplaced[ontoFile.String()].Content)

	documents := verifyManifests(t, space.output)[notes].byID()
	assert.Equal(t, "path crosses a symbolic link", documents[throughDirectory].Reason)
	assert.Equal(t, "path conflicts with another document's file or directory", documents[ontoFile].Reason)

	exported := snapshot(t, filepath.Join(space.output, notes.String()))
	assert.Equal(t, "plants links", exported["plant.md"].Content)
	assert.True(t, exported["linked"].Mode.IsDir(), "the new tree has a real directory where the old one had a link")
	assert.Equal(t, "where the old tree had a link", exported["linked/escape.md"].Content)
	assert.True(t, exported["target.md"].Mode.IsRegular())
	assert.Equal(t, "where the old tree had a link", exported["target.md"].Content)
}

// placement is where a test expects a document's bytes.
type placement struct {
	path    string
	content string
	// unplaced is the reason the document cannot be placed in the main
	// tree, or empty if it is placed at path.
	unplaced string
}

func TestExportKeepsEveryDocumentItCannotPlace(t *testing.T) {
	const (
		conflict   = "path conflicts with another document's file or directory"
		unwritable = "path cannot be created on this filesystem"
	)

	segment255 := strings.Repeat("x", 252) + ".md"
	segment256 := strings.Repeat("y", 253) + ".md"

	tests := []struct {
		name      string
		documents []placement
	}{
		{
			name: "a file, then a document under it",
			documents: []placement{
				{path: "a", content: "a file"},
				{path: "a/b.md", content: "a file under a file", unplaced: conflict},
			},
		},
		{
			name: "a document, then a file where its folder is",
			documents: []placement{
				{path: "a/b.md", content: "makes a a folder"},
				{path: "a", content: "a file where a folder is", unplaced: conflict},
			},
		},
		{
			name: "deeper collisions",
			documents: []placement{
				{path: "x/y", content: "a file"},
				{path: "x/y/z/deep.md", content: "under the file", unplaced: conflict},
				{path: "x/y/other.md", content: "also under it", unplaced: conflict},
				{path: "x/sibling.md", content: "beside it"},
			},
		},
		{
			name: "a name of exactly 255 bytes is placed",
			documents: []placement{
				{path: segment255, content: "255 bytes"},
				{path: "folder/" + segment255, content: "255 bytes in a folder"},
			},
		},
		{
			name: "a name over 255 bytes is not",
			documents: []placement{
				{path: segment256, content: "256 bytes", unplaced: unwritable},
				{path: segment256 + "/note.md", content: "a folder of 256 bytes", unplaced: unwritable},
				{path: "folder/" + segment256, content: "256 bytes in a folder", unplaced: unwritable},
			},
		},
		{
			name: "a name that is not UTF-8",
			documents: []placement{
				{path: "caf\xe9.md", content: "Latin-1", unplaced: "path is not valid UTF-8"},
				{path: "folder/caf\xe9/note.md", content: "in a Latin-1 folder", unplaced: "path is not valid UTF-8"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)

			wantFiles := map[string]string{}
			ids := make([]uuid.UUID, len(test.documents))

			for index, document := range test.documents {
				ids[index] = source.addDocument(notes, document.path, []byte(document.content))

				if document.unplaced == "" {
					wantFiles[notes.String()+"/"+document.path] = document.content
				} else {
					wantFiles[notes.String()+".unplaced/"+ids[index].String()] = document.content
				}
			}

			summary, err := space.run(t, t.Context(), source)
			require.NoError(t, err)

			assert.Equal(t, export.StatusOK, summary.Status, "every document's bytes are in the export")
			assert.Zero(t, summary.DocumentErrors)
			assert.Equal(t, wantFiles, files(t, space.output))
			assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t))

			documents := verifyManifests(t, space.output)[notes].byID()
			require.Len(t, documents, len(test.documents))

			wantUnplaced := 0

			for index, document := range test.documents {
				recorded := documents[ids[index]]

				if utf8.ValidString(document.path) {
					assert.Equal(t, document.path, recorded.Path, "the manifest records the original path")
					assert.Empty(t, recorded.PathBase64)
				} else {
					assert.Equal(t, base64.StdEncoding.EncodeToString([]byte(document.path)), recorded.PathBase64,
						"a path that is not UTF-8 is recorded exactly")
				}

				assert.Equal(t, document.unplaced, recorded.Reason)

				if document.unplaced == "" {
					assert.Equal(t, "placed", recorded.Status)
				} else {
					wantUnplaced++

					assert.Equal(t, "unplaced", recorded.Status)
					assert.Equal(t, notes.String()+".unplaced/"+ids[index].String(), recorded.Location)
				}
			}

			assert.EqualValues(t, wantUnplaced, summary.Unplaced)
			require.Len(t, summary.VaultDetails, 1)
			assert.EqualValues(t, wantUnplaced, summary.VaultDetails[0].Unplaced)
			assert.EqualValues(t, len(test.documents), summary.Files)
		})
	}
}

func TestExportKeepsUserFilesNamedLikeItsOwnFiles(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)

	// A document that goes to the unplaced tree, so that tree exists.
	tooLong := source.addDocument(notes, strings.Repeat("z", 300), []byte("unplaced"))

	userFiles := map[string]string{
		notes.String() + ".unplaced/" + tooLong.String(): "looks like the unplaced copy",
		notes.String() + ".manifest.jsonl":               `{"type":"vault","format":2}`,
		".vault-sync-export":                             `{"format":2}`,
		"x.unplaced/" + uuid.NewString():                 "another vault's unplaced tree",
		"x.manifest.jsonl":                               "another vault's manifest",
	}

	ids := map[string]uuid.UUID{}
	for path, content := range userFiles {
		ids[path] = source.addDocument(notes, path, []byte(content))
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)
	assert.Equal(t, export.StatusOK, summary.Status)

	wantFiles := map[string]string{notes.String() + ".unplaced/" + tooLong.String(): "unplaced"}
	for path, content := range userFiles {
		wantFiles[notes.String()+"/"+path] = content
	}

	assert.Equal(t, wantFiles, files(t, space.output), "user files are exported unchanged in the vault directory")

	documents := verifyManifests(t, space.output)[notes].byID()
	for path, id := range ids {
		assert.Equal(t, "placed", documents[id].Status, path)
		assert.Equal(t, notes.String()+"/"+path, documents[id].Location, path)
	}

	assert.Equal(t, notes.String()+".unplaced/"+tooLong.String(), documents[tooLong].Location)
}

func TestExportReportsDocumentsWhoseContentIsMissingOrCorrupt(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)

	source.addDocument(notes, "kept.md", []byte("kept"))
	shortContent := source.addDocument(notes, "short.md", []byte("short"))
	longContent := source.addDocument(notes, "long.md", []byte("long"))
	corrupt := source.addDocument(notes, "folder/corrupt.md", []byte("original"))
	missing := source.addDocument(notes, "missing.md", []byte("missing"))
	source.addDocument(notes, "a", []byte("a file"))
	missingUnplaced := source.addDocument(notes, "a/missing.md", []byte("missing and unplaced"))

	byID := func(id uuid.UUID) store.LiveDocument {
		for _, document := range source.documents[notes] {
			if document.ID == id {
				return document
			}
		}

		t.Fatalf("no document %s", id)

		return store.LiveDocument{}
	}

	source.content[hex.EncodeToString(byID(shortContent).ContentRef)] = []byte("shor")
	source.content[hex.EncodeToString(byID(longContent).ContentRef)] = []byte("longer")
	source.content[hex.EncodeToString(byID(corrupt).ContentRef)] = []byte("ORIGINAL")
	delete(source.content, hex.EncodeToString(byID(missing).ContentRef))
	delete(source.content, hex.EncodeToString(byID(missingUnplaced).ContentRef))

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	want := map[uuid.UUID]string{
		shortContent:    "stored content does not have the blob's size",
		longContent:     "stored content does not have the blob's size",
		corrupt:         "stored content does not match its blob id",
		missing:         "stored content is missing",
		missingUnplaced: "stored content is missing",
	}

	assert.Equal(t, want, documentErrors(summary))
	assert.Equal(t, export.StatusPartial, summary.Status)
	assert.Equal(t, 5, summary.DocumentErrors)

	assert.Equal(t, map[string]string{
		notes.String() + "/kept.md": "kept",
		notes.String() + "/a":       "a file",
	}, files(t, space.output), "no file is left behind for a missing document")
	assert.EqualValues(t, 2, summary.Files)
	assert.EqualValues(t, 4+6, summary.Bytes)
	assert.Zero(t, summary.Unplaced, "a document without content is not counted as unplaced")

	documents := verifyManifests(t, space.output)[notes].byID()
	require.Len(t, documents, 7, "every live document is listed")

	for id, reason := range want {
		document := byID(id)
		recorded := documents[id]

		assert.Equal(t, "missing", recorded.Status)
		assert.Equal(t, reason, recorded.Reason)
		assert.Equal(t, document.Path, recorded.Path)
		assert.Empty(t, recorded.Location)
		assert.Equal(t, document.Size, recorded.Size, "the size the content should have")
		assert.Equal(t, hex.EncodeToString(document.ContentRef), recorded.SHA256, "the hash the content should have")
	}
}

func TestExportManifestDescribesEveryDocument(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes & <Work>", store.EncryptionNone)

	note := source.addDocument(notes, "daily/note.md", []byte("hello"))
	image := source.addDocument(notes, "image.png", []byte{0x89, 'P', 'N', 'G'})
	source.documents[notes][1].Kind = "blob"

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)
	assert.Equal(t, export.StatusOK, summary.Status)

	manifests := verifyManifests(t, space.output)
	require.Len(t, manifests, 1)

	vault := manifests[notes]
	assert.Equal(t, "vault", vault.Vault.Type)
	assert.Equal(t, notes, vault.Vault.VaultID)
	assert.Equal(t, "Notes & <Work>", vault.Vault.Name)
	assert.Equal(t, "none", vault.Vault.Encryption)
	assert.EqualValues(t, 42, vault.Vault.HeadSeq)

	helloSum := "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	pngSum := sha256.Sum256([]byte{0x89, 'P', 'N', 'G'})

	assert.Equal(t, []manifestDocument{
		{
			Type: "document", DocumentID: note, Path: "daily/note.md", Kind: "text",
			RevisionID: source.documents[notes][0].RevisionID, Size: 5, SHA256: helloSum,
			Status: "placed", Location: notes.String() + "/daily/note.md",
		},
		{
			Type: "document", DocumentID: image, Path: "image.png", Kind: "blob",
			RevisionID: source.documents[notes][1].RevisionID, Size: 4, SHA256: hex.EncodeToString(pngSum[:]),
			Status: "placed", Location: notes.String() + "/image.png",
		},
	}, vault.Documents, "documents are listed in id order")

	assert.Equal(t, 2, vault.End.Documents)
	assert.Equal(t, 2, vault.End.Placed)

	info, err := os.Lstat(filepath.Join(space.output, notes.String()+".manifest.jsonl"))
	require.NoError(t, err)
	assert.Zero(t, info.Mode()&0o007, "the manifest holds paths: never readable by others")
}

func TestExportListsAtMostOneHundredDocumentErrors(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()

	addMissing := func(vault uuid.UUID, index int) {
		id := source.addDocument(vault, fmt.Sprintf("missing-%d.md", index), fmt.Appendf(nil, "%s %d", vault, index))
		for _, document := range source.documents[vault] {
			if document.ID == id {
				delete(source.content, hex.EncodeToString(document.ContentRef))
			}
		}
	}

	first := source.addVault("First", store.EncryptionNone)
	for index := range 60 {
		addMissing(first, index)
	}

	second := source.addVault("Second", store.EncryptionNone)
	for index := range 41 {
		addMissing(second, index)
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, 101, summary.DocumentErrors)
	require.Len(t, summary.VaultDetails, 2)
	assert.Len(t, summary.VaultDetails[0].DocumentErrors, 60)
	assert.Len(t, summary.VaultDetails[1].DocumentErrors, 40)

	manifests := verifyManifests(t, space.output)
	assert.Equal(t, 41, manifests[second].End.Missing, "the manifest lists every missing document")
}

func TestExportFailsRatherThanDropADocumentItCannotStore(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a", []byte("a file"))
	source.addDocument(notes, "a/b.md", []byte("under a file"))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	before := snapshot(t, space.output)

	// The unplaced tree cannot be created: something else took its name
	// in the staging directory while the export ran.
	source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
		source.onContent = nil

		staging := space.stagingDirectories(t)
		require.Len(t, staging, 1)
		require.NoError(t, os.WriteFile(filepath.Join(staging[0], notes.String()+".unplaced"), nil, 0o600))

		return nil, nil
	}

	summary, err := space.run(t, t.Context(), source)
	require.ErrorIs(t, err, fs.ErrExist)

	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.Equal(t, before, snapshot(t, space.output), "the previous export is untouched")
	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "the staging directory is removed")
}

func TestInterruptedExportLeavesThePreviousExportUntouched(t *testing.T) {
	errS3 := errors.New("S3 is unavailable")

	tests := []struct {
		name string
		// interrupt makes the second run fail partway through.
		interrupt func(source *fakeSource, cancel context.CancelFunc)
	}{
		{
			name: "content cannot be read",
			interrupt: func(source *fakeSource, _ context.CancelFunc) {
				reads := 0
				source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
					reads++
					if reads == 3 {
						return nil, errS3
					}

					return nil, nil
				}
			},
		},
		{
			name: "content fails mid-stream",
			interrupt: func(source *fakeSource, _ context.CancelFunc) {
				source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
					return io.NopCloser(io.MultiReader(strings.NewReader("par"), errorReader{errS3})), nil
				}
			},
		},
		{
			name: "documents cannot be listed",
			interrupt: func(source *fakeSource, _ context.CancelFunc) {
				source.onDocuments = func(_ context.Context, _ uuid.UUID, after uuid.UUID) error {
					if after != uuid.Nil {
						return errS3
					}

					return nil
				}
			},
		},
		{
			name: "the export is canceled (SIGTERM)",
			interrupt: func(source *fakeSource, cancel context.CancelFunc) {
				reads := 0
				source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
					reads++
					if reads == 2 {
						cancel()
					}

					return nil, nil
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)

			for index := range 5 {
				source.addDocument(notes, "note-"+string(rune('a'+index))+".md", []byte("version 1"))
			}

			_, err := space.run(t, t.Context(), source)
			require.NoError(t, err)

			before := snapshot(t, space.output)

			source.documents[notes] = nil
			for index := range 5 {
				source.addDocument(notes, "note-"+string(rune('a'+index))+".md", []byte("version 2"))
			}

			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()

			test.interrupt(source, cancel)

			summary, err := space.run(t, ctx, source)
			require.Error(t, err)

			assert.Equal(t, export.StatusFailed, summary.Status)
			assert.NotEmpty(t, summary.Error)
			assert.Equal(t, before, snapshot(t, space.output), "the previous export is untouched")
			assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "the staging directory is removed")
		})
	}
}

type errorReader struct {
	err error
}

func (reader errorReader) Read([]byte) (int, error) { return 0, reader.err }

func TestExportRemovesStagingDirectoriesOfKilledRuns(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("a"))

	// A run killed mid-export, and one killed after its swap.
	killed := filepath.Join(space.root, ".out.staging-123")
	require.NoError(t, os.MkdirAll(filepath.Join(killed, "vault", "dir"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(killed, "vault", "dir", "partial.md"), []byte("partial"), 0o600))
	require.NoError(t, os.Mkdir(filepath.Join(space.root, ".out.staging-456"), 0o700))

	// A link among them is removed, not followed.
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "keep.md"), []byte("keep"), 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(killed, "link")))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t))
	assert.Equal(t, map[string]entry{"keep.md": {Mode: 0o600, Content: "keep"}}, snapshot(t, outside))
}

func TestExportRefusesAnOutputItMayNotReplace(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, space workspace)
		wantErr string
	}{
		{
			name: "a directory that is not a previous export",
			prepare: func(t *testing.T, space workspace) {
				require.NoError(t, os.Mkdir(space.output, 0o750))
				require.NoError(t, os.WriteFile(filepath.Join(space.output, "unrelated.txt"), []byte("keep"), 0o600))
			},
			wantErr: "not a previous export",
		},
		{
			name: "a directory whose marker is a directory",
			prepare: func(t *testing.T, space workspace) {
				require.NoError(t, os.MkdirAll(filepath.Join(space.output, export.MarkerName), 0o750))
			},
			wantErr: "not a previous export",
		},
		{
			name: "a symbolic link",
			prepare: func(t *testing.T, space workspace) {
				target := t.TempDir()
				require.NoError(t, os.WriteFile(filepath.Join(target, export.MarkerName), nil, 0o600))
				require.NoError(t, os.Symlink(target, space.output))
			},
			wantErr: "symbolic link",
		},
		{
			name: "a file",
			prepare: func(t *testing.T, space workspace) {
				require.NoError(t, os.WriteFile(space.output, []byte("keep"), 0o600))
			},
			wantErr: "not a directory",
		},
		{
			name:    "a missing parent",
			prepare: func(t *testing.T, space workspace) { require.NoError(t, os.Remove(space.root)) },
			wantErr: "lock",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("a"))

			test.prepare(t, space)

			var before map[string]entry
			if _, err := os.Stat(space.root); err == nil {
				before = snapshot(t, space.root)
			}

			summary, err := space.run(t, t.Context(), source)
			require.ErrorContains(t, err, test.wantErr)
			assert.Equal(t, export.StatusFailed, summary.Status)

			if before != nil {
				after := snapshot(t, space.root)
				delete(after, ".out.lock")
				assert.Equal(t, before, after, "nothing is changed")
			}
		})
	}
}

func TestExportReplacesAnEmptyOutputDirectory(t *testing.T) {
	space := newWorkspace(t)
	require.NoError(t, os.Mkdir(space.output, 0o750))

	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("a"))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, map[string]string{notes.String() + "/a.md": "a"}, files(t, space.output))
}

func TestExportRefusesToRunConcurrentlyWithAnother(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("a"))

	var concurrent export.Summary

	var concurrentErr error

	source.onContent = func(ctx context.Context, _ []byte) (io.ReadCloser, error) {
		source.onContent = nil
		concurrent, concurrentErr = space.run(t, ctx, source)

		return nil, nil
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)
	assert.Equal(t, export.StatusOK, summary.Status)

	require.ErrorContains(t, concurrentErr, "another export to this directory is running")
	assert.Equal(t, export.StatusFailed, concurrent.Status)
	assert.Equal(t, map[string]string{notes.String() + "/a.md": "a"}, files(t, space.output))
}

func TestExportFilePermissions(t *testing.T) {
	// Directories are created 0750 and files 0640, less the umask.
	probe := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(probe, "dir"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(probe, "file"), nil, 0o640))

	wantModes := snapshot(t, probe)

	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "dir/a.md", []byte("a"))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	tree := snapshot(t, space.output)
	assert.Equal(t, wantModes["dir"].Mode, tree[notes.String()].Mode)
	assert.Equal(t, wantModes["dir"].Mode, tree[notes.String()+"/dir"].Mode)
	assert.Equal(t, wantModes["file"].Mode, tree[notes.String()+"/dir/a.md"].Mode)
	assert.Zero(t, tree[notes.String()+"/dir/a.md"].Mode&0o007, "never readable by others")

	info, err := os.Stat(space.output)
	require.NoError(t, err)
	assert.Equal(t, fs.ModeDir|0o750, info.Mode(), "the export directory itself is set explicitly")
}

func TestExportSummaryTiming(t *testing.T) {
	space := newWorkspace(t)
	start := time.Date(2026, 10, 18, 3, 0, 0, 0, time.UTC)
	calls := 0

	summary, err := export.Run(t.Context(), export.Options{
		Output: space.output,
		Source: newFakeSource(),
		Logger: slog.New(slog.DiscardHandler),
		Now: func() time.Time {
			calls++

			return start.Add(time.Duration(calls-1) * 90 * time.Second)
		},
	})
	require.NoError(t, err)

	assert.Equal(t, start, summary.StartedAt)
	assert.InDelta(t, 90.0, summary.DurationSeconds, 0.001)
}

func TestExportFailureOnTheExportDiskNamesNoDocumentPath(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("skipping: root ignores directory permissions, which this test uses to make writes fail")
	}

	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "first.md", []byte("first"))
	source.addDocument(notes, "secret-project/plan.md", []byte("plan"))

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	before := snapshot(t, space.output)

	// The disk refuses writes after the first document.
	source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
		source.onContent = nil

		staging := space.stagingDirectories(t)
		require.Len(t, staging, 1)

		vaultDir := filepath.Join(staging[0], notes.String())
		require.NoError(t, os.Chmod(vaultDir, 0o500))
		t.Cleanup(func() { _ = os.Chmod(vaultDir, 0o700) })

		return nil, nil
	}

	summary, err := space.run(t, t.Context(), source)
	require.ErrorIs(t, err, fs.ErrPermission)

	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.NotContains(t, summary.Error, "secret-project")
	assert.Equal(t, before, snapshot(t, space.output), "the previous export is untouched")
}

func TestExportReadsEveryPageAtTheListedHeadSeq(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	work := source.addVault("Work", store.EncryptionNone)
	source.vaults[0].HeadSeq = 7
	source.vaults[1].HeadSeq = 9

	for index := range 5 {
		source.addDocument(notes, fmt.Sprintf("note-%d.md", index), []byte("note"))
		source.addDocument(work, fmt.Sprintf("work-%d.md", index), []byte("work"))
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	// Five documents at page size 2 take three pages per vault.
	assert.Equal(t, map[uuid.UUID][]int64{notes: {7, 7, 7}, work: {9, 9, 9}}, source.seqs)

	require.Len(t, summary.VaultDetails, 2)
	assert.Equal(t, int64(7), summary.VaultDetails[0].HeadSeq)
	assert.Equal(t, int64(9), summary.VaultDetails[1].HeadSeq)
}

func TestExportRemovesOnlyItsOwnStagingLeftovers(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("a"))

	// Leftovers of interrupted runs against out: os.MkdirTemp's suffix is
	// a decimal number.
	for _, name := range []string{".out.staging-0", ".out.staging-4294967295"} {
		require.NoError(t, os.Mkdir(filepath.Join(space.root, name), 0o700))
	}

	// Entries of exports to siblings such as out.staging-foo and
	// out.staging-1, and other names that merely share the prefix.
	kept := []string{
		".out.staging-",
		".out.staging-1.lock",
		".out.staging-1.staging-2",
		".out.staging-12a",
		".out.staging-foo.lock",
		".out.staging-foo.staging-3",
		".out.staging--1",
		".out.staging-+1",
	}
	for _, name := range kept {
		require.NoError(t, os.Mkdir(filepath.Join(space.root, name), 0o700))
	}

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	want := append([]string{".out.lock", "out"}, kept...)
	slices.Sort(want)

	assert.Equal(t, want, space.siblings(t))
}

func TestExportReportsASwapThatHappenedWhenSyncingItFails(t *testing.T) {
	tests := []struct {
		name       string
		missing    bool
		wantStatus string
	}{
		{name: "every document exported", wantStatus: export.StatusOK},
		{name: "a document's content missing", missing: true, wantStatus: export.StatusPartial},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("version 1"))

			_, err := space.run(t, t.Context(), source)
			require.NoError(t, err)

			source.documents[notes] = nil
			source.addDocument(notes, "a.md", []byte("version 2"))

			lost := source.addDocument(notes, "lost.md", []byte("lost"))
			if test.missing {
				delete(source.content, hex.EncodeToString(source.documents[notes][1].ContentRef))
			} else {
				source.documents[notes] = source.documents[notes][:1]
			}

			synced := 0

			export.SetSyncAfterSwapForTest(t, func(string) error {
				synced++

				return errors.New("injected sync failure")
			})

			var logs bytes.Buffer

			summary, err := export.Run(t.Context(), export.Options{
				Output:   space.output,
				Source:   source,
				Logger:   slog.New(slog.NewJSONHandler(&logs, nil)),
				PageSize: 2,
			})
			require.NoError(t, err, "the new export is in place")

			assert.Equal(t, 1, synced)
			assert.Equal(t, test.wantStatus, summary.Status)
			assert.Empty(t, summary.Error)
			assert.Equal(t, map[string]string{notes.String() + "/a.md": "version 2"}, files(t, space.output))
			assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t))

			if test.missing {
				assert.Equal(t, map[uuid.UUID]string{lost: "stored content is missing"}, documentErrors(summary))
			}

			assert.Contains(t, logs.String(), `"level":"WARN"`)
			assert.Contains(t, logs.String(), "injected sync failure")
			assert.NotContains(t, logs.String(), "untouched")
		})
	}
}

func TestExportLeavesNoEmptyDirectoryForARefusedDocument(t *testing.T) {
	segment256 := strings.Repeat("y", 253) + ".md"

	type document struct {
		path    string
		content string
		missing bool
	}

	tests := []struct {
		name      string
		documents []document
		// want is the files in the vault tree by path, and in the unplaced
		// tree by "unplaced/" and their content.
		want map[string]string
	}{
		{
			name:      "a name over 255 bytes in new folders",
			documents: []document{{path: "a/b/" + segment256, content: "too long"}},
			want:      map[string]string{"unplaced/too long": "too long"},
		},
		{
			name:      "a folder name over 255 bytes",
			documents: []document{{path: "a/" + segment256 + "/note.md", content: "too long"}},
			want:      map[string]string{"unplaced/too long": "too long"},
		},
		{
			name:      "missing content in new folders",
			documents: []document{{path: "a/b/gone.md", content: "gone", missing: true}},
			want:      map[string]string{},
		},
		{
			name: "missing content beside another document",
			documents: []document{
				{path: "shared/kept.md", content: "kept"},
				{path: "shared/sub/gone.md", content: "gone", missing: true},
				{path: "shared/" + segment256, content: "too long"},
			},
			want: map[string]string{"shared/kept.md": "kept", "unplaced/too long": "too long"},
		},
		{
			name: "a later document in a removed folder",
			documents: []document{
				{path: "a/b/gone.md", content: "gone", missing: true},
				{path: "a/" + segment256, content: "too long"},
				{path: "a/b/kept.md", content: "kept"},
			},
			want: map[string]string{"a/b/kept.md": "kept", "unplaced/too long": "too long"},
		},
		{
			name: "missing content of a document that cannot be placed",
			documents: []document{
				{path: "f", content: "a file"},
				{path: "f/gone.md", content: "gone", missing: true},
			},
			want: map[string]string{"f": "a file"},
		},
		{
			// Issue #430 item 1: the folder made for the refused document
			// must not push the next one out of the tree.
			name: "a file named like the folder of a refused name over 255 bytes",
			documents: []document{
				{path: "x/" + strings.Repeat("y", 300), content: "too long"},
				{path: "x", content: "x file"},
			},
			want: map[string]string{"x": "x file", "unplaced/too long": "too long"},
		},
		{
			name: "a file named like the folder of a document with missing content",
			documents: []document{
				{path: "x/gone.md", content: "gone", missing: true},
				{path: "x", content: "x file"},
			},
			want: map[string]string{"x": "x file"},
		},
		{
			// Issue #430 item 2.
			name: "every unplaced document has missing content",
			documents: []document{
				{path: "f", content: "a file"},
				{path: "f/gone.md", content: "gone", missing: true},
				{path: strings.Repeat("y", 300), content: "gone too", missing: true},
			},
			want: map[string]string{"f": "a file"},
		},
		{
			name: "an unplaced document after a removed unplaced folder",
			documents: []document{
				{path: "f", content: "a file"},
				{path: "f/gone.md", content: "gone", missing: true},
				{path: "f/kept.md", content: "kept"},
			},
			want: map[string]string{"f": "a file", "unplaced/kept": "kept"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)

			for _, document := range test.documents {
				source.addDocument(notes, document.path, []byte(document.content))

				if document.missing {
					added := source.documents[notes][len(source.documents[notes])-1]
					delete(source.content, hex.EncodeToString(added.ContentRef))
				}
			}

			_, err := space.run(t, t.Context(), source)
			require.NoError(t, err)

			got := map[string]string{}

			for path, content := range files(t, space.output) {
				if relative, found := strings.CutPrefix(path, notes.String()+"/"); found {
					got[relative] = content
				} else {
					got["unplaced/"+content] = content
				}
			}

			assert.Equal(t, test.want, got)

			// The vault's own directory exists even when it holds nothing.
			empty := slices.DeleteFunc(emptyDirectories(t, space.output), func(path string) bool { return path == notes.String() })
			assert.Empty(t, empty)
			verifyManifests(t, space.output)
		})
	}
}

func TestExportMarksADeletedVault(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()

	live := source.addVault("Live", store.EncryptionNone)
	source.addDocument(live, "a.md", []byte("live"))

	deleted := source.addVault("Deleted", store.EncryptionNone)
	source.addDocument(deleted, "a.md", []byte("deleted"))

	deletedAt := time.Date(2026, 10, 20, 12, 30, 0, 0, time.FixedZone("CEST", 2*60*60))
	source.vaults[1].DeletedAt = &deletedAt

	_, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, map[string]string{
		live.String() + "/a.md":    "live",
		deleted.String() + "/a.md": "deleted",
	}, files(t, space.output), "a deleted vault is still exported")

	marker, err := os.ReadFile(filepath.Join(space.output, deleted.String()+export.DeletedSuffix))
	require.NoError(t, err)
	assert.Equal(t, "2026-10-20T10:30:00Z\n", string(marker), "the marker holds the deletion time")

	_, err = os.Stat(filepath.Join(space.output, live.String()+export.DeletedSuffix))
	require.ErrorIs(t, err, fs.ErrNotExist, "a live vault has no marker")
}
