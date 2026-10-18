//go:build integration

package main_test

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
)

// previousReleaseEnv overrides the git revision built as the previous
// release by TestRollingUpgrade.
const previousReleaseEnv = "VAULT_SYNC_TEST_PREVIOUS_RELEASE"

// skipOrFail skips the test, except in CI, where the previous release must
// always be available (the workflow checks out the full history).
func skipOrFail(t *testing.T, format string, arguments ...any) {
	t.Helper()

	if os.Getenv("CI") != "" {
		t.Fatalf(format, arguments...)
	}

	t.Skipf(format, arguments...)
}

func git(t *testing.T, arguments ...string) (string, error) {
	t.Helper()

	var stderr bytes.Buffer

	command := exec.CommandContext(t.Context(), "git", arguments...)
	command.Stderr = &stderr

	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(arguments, " "), err, strings.TrimSpace(stderr.String()))
	}

	return strings.TrimSpace(string(output)), nil
}

// previousRelease returns the revision the previous release was built from.
// Every merge to master is released, so that is where this change branched
// from master, or, on master itself, the previous commit.
func previousRelease(t *testing.T) string {
	t.Helper()

	if ref := os.Getenv(previousReleaseEnv); ref != "" {
		revision, err := git(t, "rev-parse", "--verify", ref+"^{commit}")
		if err != nil {
			t.Fatalf("%s=%s: %v", previousReleaseEnv, ref, err)
		}

		return revision
	}

	head, err := git(t, "rev-parse", "--verify", "HEAD")
	if err != nil {
		skipOrFail(t, "cannot find the previous release without git history (or set %s): %v", previousReleaseEnv, err)
	}

	base, err := git(t, "merge-base", "HEAD", "origin/master")
	if err != nil {
		skipOrFail(t, "cannot find the previous release; fetch origin/master with full history (or set %s): %v", previousReleaseEnv, err)
	}

	if base != head {
		return base
	}

	parent, err := git(t, "rev-parse", "--verify", "HEAD^")
	if err != nil {
		skipOrFail(t, "cannot find the previous release; fetch the full history (or set %s): %v", previousReleaseEnv, err)
	}

	return parent
}

// buildRelease builds the server as of revision, from a clean export of the
// repository at that revision.
func buildRelease(t *testing.T, revision string) string {
	t.Helper()

	source := t.TempDir()

	root, err := git(t, "rev-parse", "--show-toplevel")
	require.NoError(t, err)

	// Run at the root: from a subdirectory, git archive exports only it.
	archive := exec.CommandContext(t.Context(), "git", "archive", "--format=tar", revision)
	archive.Dir = root

	var stderr bytes.Buffer

	archive.Stderr = &stderr

	tarball, err := archive.Output()
	require.NoError(t, err, "git archive %s: %s", revision, stderr.String())
	require.NoError(t, extract(tarball, source))

	binary := filepath.Join(t.TempDir(), "vault-sync-server-previous")

	build := exec.CommandContext(t.Context(), "go", "build", "-o", binary, "./cmd/vault-sync-server")
	build.Dir = source

	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOFLAGS=-mod=readonly")

	output, err := build.CombinedOutput()
	require.NoError(t, err, "build the previous release (%s): %s", revision, output)

	return binary
}

// extract writes the regular files and directories of a tar archive below
// directory.
func extract(tarball []byte, directory string) error {
	reader := tar.NewReader(bytes.NewReader(tarball))

	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}

		if err != nil {
			return err
		}

		target := filepath.Join(directory, filepath.FromSlash(header.Name))
		if !strings.HasPrefix(target, directory+string(filepath.Separator)) {
			return fmt.Errorf("archive entry %q escapes the directory", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}

			file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode)&0o755|0o600)
			if err != nil {
				return err
			}

			_, err = io.Copy(file, reader)
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}

			if err != nil {
				return err
			}
		}
	}
}

// Criterion 5: during a rolling upgrade the previous release and this one
// run together on one database (SPEC.md §12): this release's migrations
// apply while the previous release is serving, both serve every request
// correctly, including the halves of one upload, and the previous release
// can still (re)start on the newer schema, as it does when a rollout is
// rolled back or one of its pods restarts mid-rollout.
func TestRollingUpgrade(t *testing.T) {
	cluster := newDeployment(t)

	revision := previousRelease(t)
	t.Logf("previous release: %s", revision)

	previousBinary := buildRelease(t, revision)
	currentBinary := buildServer(t)

	// The previous release creates the schema and serves alone at first.
	previous := cluster.start(t, "previous", previousBinary)

	token := cluster.token(t, "alice")
	before := createVault(t, previous, token, "Before the upgrade")

	content, blobID := randomBlob(t, blobstore.PartSize+3*config.DefaultBlobMaxChunkBytes+7)
	early := &blobClient{token: token, vaultID: before.GetId(), blobID: blobID, content: content}

	_, err := early.begin(t, previous)
	require.NoError(t, err)

	// An upload is in progress when the new release rolls out.
	received := early.sendChunks(t, 0, 3, previous)

	// The new release starts beside it and migrates the database.
	current := cluster.start(t, "current", currentBinary)

	// Both serve requests on the newer schema, whichever gets each one.
	assert.ElementsMatch(t, []string{before.GetId()}, listVaultIDs(t, current, token))

	after := createVault(t, current, token, "After the upgrade")
	alongside := createVault(t, previous, token, "Created by the previous release on the newer schema")
	vaults := []string{before.GetId(), after.GetId(), alongside.GetId()}

	assert.ElementsMatch(t, vaults, listVaultIDs(t, previous, token))
	assert.ElementsMatch(t, vaults, listVaultIDs(t, current, token))

	resumed, err := early.begin(t, current)
	require.NoError(t, err)
	require.Equal(t, uint64(received), resumed.GetReceivedSize())

	early.sendChunks(t, received, 0, current, previous)

	_, err = early.commit(t, previous)
	require.NoError(t, err)
	early.requireStored(t, current, previous)

	content, blobID = randomBlob(t, 5*config.DefaultBlobMaxChunkBytes+11)
	late := &blobClient{token: token, vaultID: after.GetId(), blobID: blobID, content: content}

	_, err = late.begin(t, previous)
	require.NoError(t, err)
	late.sendChunks(t, 0, 0, previous, current)

	_, err = late.commit(t, current)
	require.NoError(t, err)
	late.requireStored(t, previous, current)

	// A previous-release pod restarting mid-rollout starts on the newer
	// schema and serves.
	require.NoError(t, previous.process.Command.Process.Signal(syscall.SIGTERM))

	select {
	case <-previous.process.Exited():
		require.NoError(t, previous.process.Err())
	case <-time.After(30 * time.Second):
		t.Fatal("the previous release did not stop")
	}

	restarted := cluster.start(t, "previous-restarted", previousBinary)

	restartedVault := createVault(t, restarted, token, "Created after the restart")
	vaults = append(vaults, restartedVault.GetId())

	assert.ElementsMatch(t, vaults, listVaultIDs(t, restarted, token))
	assert.ElementsMatch(t, vaults, listVaultIDs(t, current, token))
	early.requireStored(t, restarted)
	late.requireStored(t, restarted, current)
}
