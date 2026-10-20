//go:build linux

package export_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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
