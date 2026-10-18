//go:build linux

package export_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
		{ID: secret, Name: "Secret", Encryption: "e2ee", HeadSeq: 42, Skipped: export.SkippedE2EE},
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

	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "the previous export is removed")
}

func TestExportWritesOnlyInsideTheVaultDirectory(t *testing.T) {
	// Every shared validity vector (SPEC.md §6.2) plus traversal attempts
	// a database row could carry if it bypassed CommitRevision. Each path
	// gets its own vault, so valid paths cannot conflict with each other.
	paths := loadPathVectors(t)
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
	refused := map[uuid.UUID]bool{}

	for _, vector := range paths {
		vault := source.addVault(vector.Name, store.EncryptionNone)
		document := source.addDocument(vault, vector.Path, []byte(vector.Name))

		if vector.Valid {
			wantFiles[vault.String()+"/"+vector.Path] = vector.Name
		} else {
			refused[document] = true
		}
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, wantFiles, files(t, space.output), "valid paths are written verbatim; invalid ones are not")
	assert.Equal(t, []string{".out.lock", "out"}, space.siblings(t), "nothing is written beside the export")

	assert.Equal(t, export.StatusPartial, summary.Status)
	assert.Equal(t, len(refused), summary.DocumentErrors)

	reasons := documentErrors(summary)
	assert.Len(t, reasons, min(len(refused), 100))

	for document, reason := range reasons {
		assert.True(t, refused[document], "document %s was refused but its path is valid", document)
		assert.Equal(t, "path is not vault-relative", reason)
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

	assert.Equal(t, map[uuid.UUID]string{
		throughDirectory: "path crosses a symbolic link",
		ontoFile:         "path conflicts with another document's file or directory",
	}, documentErrors(summary))
	assert.Equal(t, export.StatusPartial, summary.Status)

	exported := snapshot(t, filepath.Join(space.output, notes.String()))
	assert.Equal(t, "plants links", exported["plant.md"].Content)
	assert.True(t, exported["linked"].Mode.IsDir(), "the new tree has a real directory where the old one had a link")
	assert.Equal(t, "where the old tree had a link", exported["linked/escape.md"].Content)
	assert.True(t, exported["target.md"].Mode.IsRegular())
	assert.Equal(t, "where the old tree had a link", exported["target.md"].Content)
}

func TestExportLeavesOutDocumentsItCannotWriteFaithfully(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)

	source.addDocument(notes, "a", []byte("a file"))
	underFile := source.addDocument(notes, "a/b.md", []byte("a file under a file"))
	source.addDocument(notes, "dir/b.md", []byte("makes dir a directory"))
	fileOnDirectory := source.addDocument(notes, "dir", []byte("a file where a directory is"))

	tooLong := source.addDocument(notes, strings.Repeat("x", 256)+".md", []byte("name over 255 bytes"))

	shortContent := source.addDocument(notes, "short.md", []byte("short"))
	longContent := source.addDocument(notes, "long.md", []byte("long"))
	corrupt := source.addDocument(notes, "corrupt.md", []byte("original"))
	missing := source.addDocument(notes, "missing.md", []byte("missing"))

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

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, map[uuid.UUID]string{
		underFile:       "path conflicts with another document's file or directory",
		fileOnDirectory: "path conflicts with another document's file or directory",
		tooLong:         "path cannot be created on this filesystem",
		shortContent:    "stored content does not have the blob's size",
		longContent:     "stored content does not have the blob's size",
		corrupt:         "stored content does not match its blob id",
		missing:         "stored content is missing",
	}, documentErrors(summary))

	assert.Equal(t, map[string]string{
		notes.String() + "/a":        "a file",
		notes.String() + "/dir/b.md": "makes dir a directory",
	}, files(t, space.output), "a left-out document leaves no file behind")

	assert.Equal(t, export.StatusPartial, summary.Status)
	assert.Equal(t, 7, summary.DocumentErrors)
	assert.EqualValues(t, 2, summary.Files)
	assert.EqualValues(t, 6+21, summary.Bytes)
}

func TestExportListsAtMostOneHundredDocumentErrors(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()

	first := source.addVault("First", store.EncryptionNone)
	for range 60 {
		source.addDocument(first, "../escape.md", []byte("x"))
	}

	second := source.addVault("Second", store.EncryptionNone)
	for range 41 {
		source.addDocument(second, "../escape.md", []byte("x"))
	}

	summary, err := space.run(t, t.Context(), source)
	require.NoError(t, err)

	assert.Equal(t, 101, summary.DocumentErrors)
	require.Len(t, summary.VaultDetails, 2)
	assert.Len(t, summary.VaultDetails[0].DocumentErrors, 60)
	assert.Len(t, summary.VaultDetails[1].DocumentErrors, 40)
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
