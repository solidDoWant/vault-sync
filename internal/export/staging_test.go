//go:build linux

package export_test

import (
	"context"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestExportRemovesKilledRunsStagingDirectoriesWhateverTheOutputName(t *testing.T) {
	// os.MkdirTemp would put its random number in place of the last "*"
	// of such a name, so the next run would not recognize the staging
	// directory as one (issue #430 item 4).
	for _, base := range []string{"a*b", "*", "out*", "out"} {
		t.Run(base, func(t *testing.T) {
			root := t.TempDir()
			space := workspace{root: root, output: filepath.Join(root, base)}
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("a"))

			// A run killed mid-export.
			killed := filepath.Join(root, "."+base+".staging-123")
			require.NoError(t, os.MkdirAll(filepath.Join(killed, "vault"), 0o700))
			require.NoError(t, os.WriteFile(filepath.Join(killed, "vault", "partial.md"), []byte("partial"), 0o600))

			// This run's own staging directory is what a run killed at
			// this point would leave behind.
			var during []string

			source.onContent = func(context.Context, []byte) (io.ReadCloser, error) {
				during = space.siblings(t)

				return nil, nil
			}

			_, err := space.run(t, t.Context(), source)
			require.NoError(t, err)

			want := []string{"." + base + ".lock", base}
			slices.Sort(want)
			assert.Equal(t, want, space.siblings(t), "the killed run's staging directory is removed")
			assert.Equal(t, map[string]string{notes.String() + "/a.md": "a"}, files(t, space.output))

			staging := regexp.MustCompile(`^` + regexp.QuoteMeta("."+base+".staging-") + `[0-9]+$`)
			others := slices.DeleteFunc(slices.Clone(during), func(name string) bool { return name == "."+base+".lock" })
			require.Len(t, others, 1, "only this run's staging directory is beside the output: %v", during)
			assert.Regexp(t, staging, others[0], "a run killed now would leave a staging directory the next run removes")
		})
	}
}

func TestExportNeverFollowsASymbolicLinkAtTheLockFile(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("a"))

	outside := t.TempDir()
	require.NoError(t, os.Symlink(filepath.Join(outside, "target"), filepath.Join(space.root, ".out.lock")))

	summary, err := space.run(t, t.Context(), source)
	require.Error(t, err)
	assert.Equal(t, export.StatusFailed, summary.Status)

	assert.Empty(t, snapshot(t, outside), "nothing is created through the link")
	assert.Equal(t, []string{".out.lock"}, space.siblings(t), "no export is written")
}

// plantStagingEntry creates an entry of the given kind ("directory", "file"
// or "symlink") at path, as another process could between removeStale and
// mkdirStaging.
func plantStagingEntry(t *testing.T, kind, path, outside string) {
	t.Helper()

	switch kind {
	case "directory":
		require.NoError(t, os.Mkdir(path, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(path, "kept.md"), []byte("kept"), 0o600))
	case "file":
		require.NoError(t, os.WriteFile(path, []byte("kept"), 0o600))
	case "symlink":
		require.NoError(t, os.Symlink(filepath.Join(outside, "target"), path))
	default:
		t.Fatalf("unknown kind %q", kind)
	}
}

// stagingEntries returns the snapshot entries of the workspace root that are
// named like staging directories, and what is under them.
func (space workspace) stagingEntries(t *testing.T) map[string]entry {
	t.Helper()

	entries := snapshot(t, space.root)
	maps.DeleteFunc(entries, func(name string, _ entry) bool { return !strings.HasPrefix(name, ".out.staging-") })

	return entries
}

func TestExportRetriesTheStagingNameWhenItIsTaken(t *testing.T) {
	tests := []struct {
		name string
		kind string
		// collisions is how many candidate names are taken.
		collisions  int
		requireErr  require.ErrorAssertionFunc
		wantAttempt int
	}{
		{name: "a directory at the first name", kind: "directory", collisions: 1, wantAttempt: 2},
		{name: "a file at the first name", kind: "file", collisions: 1, wantAttempt: 2},
		{name: "a symbolic link at the first name", kind: "symlink", collisions: 1, wantAttempt: 2},
		{name: "the first 99 names taken", kind: "directory", collisions: 99, wantAttempt: 100},
		{name: "the first 100 names taken", kind: "file", collisions: 100, requireErr: require.Error, wantAttempt: 100},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.requireErr == nil {
				test.requireErr = require.NoError
			}

			space := newWorkspace(t)
			outside := t.TempDir()
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("a"))

			// Each taken name is planted when it is drawn, after the run
			// has removed stale staging directories.
			attempts := 0
			planted := map[string]entry{}

			export.SetStagingSuffixForTest(t, func() uint32 {
				attempts++
				if attempts <= test.collisions {
					name := ".out.staging-" + strconv.Itoa(attempts)
					plantStagingEntry(t, test.kind, filepath.Join(space.root, name), outside)
					planted = space.stagingEntries(t)
				}

				return uint32(attempts)
			})

			summary, err := space.run(t, t.Context(), source)
			test.requireErr(t, err)
			assert.Equal(t, test.wantAttempt, attempts, "candidate names drawn")

			require.NotEmpty(t, planted)
			assert.Equal(t, planted, space.stagingEntries(t), "the planted entries are untouched, and no staging directory is left")
			assert.Empty(t, snapshot(t, outside), "nothing is created through a planted link")

			if err != nil {
				assert.Equal(t, export.StatusFailed, summary.Status)
				assert.Contains(t, err.Error(), "too many name collisions")
				assert.NoDirExists(t, space.output)

				return
			}

			assert.Equal(t, export.StatusOK, summary.Status)
			assert.Equal(t, map[string]string{notes.String() + "/a.md": "a"}, files(t, space.output))
		})
	}
}

func TestExportRefusesALockFileThatIsNotAPlainFileOfItsOwn(t *testing.T) {
	tests := []struct {
		name  string
		plant func(t *testing.T, lockPath, outside string)
	}{
		{
			name: "a hard link to another file",
			plant: func(t *testing.T, lockPath, outside string) {
				target := filepath.Join(outside, "target")
				require.NoError(t, os.WriteFile(target, []byte("unrelated"), 0o644))
				require.NoError(t, os.Link(target, lockPath))
			},
		},
		{
			name: "a FIFO",
			plant: func(t *testing.T, lockPath, _ string) {
				require.NoError(t, syscall.Mkfifo(lockPath, 0o600))
			},
		},
		{
			name: "a directory",
			plant: func(t *testing.T, lockPath, _ string) {
				require.NoError(t, os.Mkdir(lockPath, 0o700))
			},
		},
		{
			name: "a file owned by another user",
			plant: func(t *testing.T, lockPath, _ string) {
				if os.Geteuid() != 0 {
					t.Skip("giving a file to another user needs root")
				}

				require.NoError(t, os.WriteFile(lockPath, nil, 0o666))
				require.NoError(t, os.Chown(lockPath, 65534, 65534))
			},
		},
		{
			// Runs without root: the lock file is the running user's own,
			// but the export is made to see itself as another uid.
			name: "a file owned by a uid other than the running user's",
			plant: func(t *testing.T, lockPath, _ string) {
				require.NoError(t, os.WriteFile(lockPath, nil, 0o600))

				export.SetEffectiveUIDForTest(t, func() int { return os.Geteuid() + 1 })
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			outside := t.TempDir()
			source := newFakeSource()
			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("a"))

			lockPath := filepath.Join(space.root, ".out.lock")
			test.plant(t, lockPath, outside)

			before, err := os.Lstat(lockPath)
			require.NoError(t, err)

			beforeOutside := snapshot(t, outside)

			summary, err := space.run(t, t.Context(), source)
			require.Error(t, err)
			assert.Equal(t, export.StatusFailed, summary.Status)
			assert.Contains(t, err.Error(), "lock file")

			after, err := os.Lstat(lockPath)
			require.NoError(t, err)
			assert.Equal(t, before.Mode(), after.Mode(), "the planted entry keeps its type and permissions")
			assert.Equal(t, before.Size(), after.Size())
			assert.Equal(t, before.ModTime(), after.ModTime())
			assert.Equal(t, beforeOutside, snapshot(t, outside), "the hard link's target is unchanged")
			assert.Equal(t, []string{".out.lock"}, space.siblings(t), "no export is written")
		})
	}
}
