//go:build integration

package main_test

import (
	"archive/tar"
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
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

	// The previous release has committed revisions when the new release
	// rolls out.
	var revisions *upgradeRevisions
	if previousHasRevisions(t, previous, token, before.GetId()) {
		revisions = commitBeforeUpgrade(t, previous, token, before.GetId())
	}

	// The new release starts beside it and migrates the database.
	current := cluster.start(t, "current", currentBinary)

	// Both serve requests on the newer schema, whichever gets each one.
	assert.ElementsMatch(t, []string{before.GetId()}, listVaultIDs(t, current, token))

	if revisions != nil {
		revisions.commitDuringUpgrade(t, previous, current)
	}

	after := createVault(t, current, token, "After the upgrade")
	alongside := createVault(t, previous, token, "Created by the previous release on the newer schema")
	vaults := []string{before.GetId(), after.GetId(), alongside.GetId()}

	assert.ElementsMatch(t, vaults, listVaultIDs(t, previous, token))
	assert.ElementsMatch(t, vaults, listVaultIDs(t, current, token))

	if revisions != nil {
		requirePathKeysAcrossReleases(t, previous, current, token, alongside.GetId())
	}

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

	if revisions != nil {
		revisions.commitAfterRestart(t, restarted, current)
	}
}

// previousHasRevisions reports whether the previous release serves revision
// commits and the change feed (SPEC.md §6). Every release since revisions
// were added does; only an older release selected with previousReleaseEnv
// may not, and then the rolling upgrade is tested without them.
func previousHasRevisions(t *testing.T, previous *instance, token, vaultID string) bool {
	t.Helper()

	_, err := previous.sync().ListChanges(t.Context(), authorized(&vaultsyncv1.ListChangesRequest{VaultId: vaultID}, token))
	if connect.CodeOf(err) != connect.CodeUnimplemented {
		require.NoError(t, err, "list changes on the previous release")

		return true
	}

	require.NotEmpty(t, os.Getenv(previousReleaseEnv),
		"the previous release must serve revisions unless %s selects an older one", previousReleaseEnv)
	t.Logf("the previous release (%s) predates revisions; testing the upgrade without them", os.Getenv(previousReleaseEnv))

	return false
}

// requirePathKeysAcrossReleases checks that live path keys stay unique, and
// that collisions are ALREADY_EXISTS, when both releases commit on the newer
// schema, whichever release holds the path. A release that indexes path_key
// itself fails on long paths that do not compress (#121), so maximum-length
// random paths are used too; on the newer schema the previous release
// accepts them as well.
func requirePathKeysAcrossReleases(t *testing.T, previous, current *instance, token, vaultID string) {
	t.Helper()

	client := newSyncClient(t, previous, token, vaultID)
	content := client.content(t, previous, "path keys across releases")

	// The longest path a commit may create: 1024 bytes, in names of at
	// most 255.
	random := make([]byte, 1024-len(".md"))
	_, err := rand.Read(random)
	require.NoError(t, err)

	for index, value := range random {
		random[index] = 'a' + value%26
		if index%251 == 250 {
			random[index] = '/'
		}
	}

	longPath := string(random) + ".md"

	tests := []struct {
		name            string
		holder, other   *instance
		existing, taken string
	}{
		{name: "previous holds, current collides", holder: previous, other: current, existing: "from-previous.md", taken: "FROM-PREVIOUS.md"},
		{name: "current holds, previous collides", holder: current, other: previous, existing: "from-current.md", taken: "From-Current.md"},
		{name: "maximum length, previous holds", holder: previous, other: current, existing: "p" + longPath[1:], taken: "P" + longPath[1:]},
		{name: "maximum length, current holds", holder: current, other: previous, existing: "c" + longPath[1:], taken: "C" + longPath[1:]},
	}

	for _, test := range tests {
		client.mustCommit(t, test.holder, client.create(t, test.existing, content))

		_, err := client.commit(t, test.other, client.create(t, test.taken, content))
		assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), "%s: %v", test.name, err)
	}
}

// upgradeRevisions is one client's revisions of one document, committed
// through both releases during a rolling upgrade.
type upgradeRevisions struct {
	client    *syncClient
	content   *vaultsyncv1.ContentRef
	committed []*vaultsyncv1.Revision
}

// commitBeforeUpgrade commits a document's first revision on the previous
// release, before the new release starts.
func commitBeforeUpgrade(t *testing.T, previous *instance, token, vaultID string) *upgradeRevisions {
	t.Helper()

	client := newSyncClient(t, previous, token, vaultID)
	content := client.content(t, previous, "written before the upgrade")

	revisions := &upgradeRevisions{client: client, content: content}
	revisions.commit(t, previous, client.create(t, "note.md", content))
	revisions.requireListed(t, previous)

	return revisions
}

// commitDuringUpgrade commits on both releases on the newer schema, and
// retries a commit of one release on the other.
func (revisions *upgradeRevisions) commitDuringUpgrade(t *testing.T, previous, current *instance) {
	t.Helper()

	revisions.requireListed(t, current, previous)

	revisions.commit(t, current, revisions.next(t, "edited on the current release"))

	request := revisions.next(t, "edited on the previous release")
	committed := revisions.commit(t, previous, request)

	retried := revisions.client.mustCommit(t, current, request)
	assert.Truef(t, proto.Equal(committed, withAnchorsOfBoth([]*vaultsyncv1.Revision{committed}, []*vaultsyncv1.Revision{retried})[0]), "a commit of the previous release retried on the current one returns it:\nwant %v\ngot  %v",
		committed, retried)

	revisions.requireListed(t, previous, current)
}

// commitAfterRestart commits on a restarted previous release and the current
// release.
func (revisions *upgradeRevisions) commitAfterRestart(t *testing.T, restarted, current *instance) {
	t.Helper()

	revisions.requireListed(t, restarted, current)

	request := revisions.next(t, "edited after the restart")
	committed := revisions.commit(t, restarted, request)

	retried := revisions.client.mustCommit(t, current, request)
	assert.Truef(t, proto.Equal(committed, withAnchorsOfBoth([]*vaultsyncv1.Revision{committed}, []*vaultsyncv1.Revision{retried})[0]), "a commit of the restarted release retried on the current one returns it:\nwant %v\ngot  %v",
		committed, retried)

	revisions.commit(t, current, revisions.next(t, "edited on the current release after the restart"))
	revisions.requireListed(t, current, restarted)
}

// next returns a request for a revision on top of the document's head that
// moves it to path.
func (revisions *upgradeRevisions) next(t *testing.T, path string) *vaultsyncv1.CommitRevisionRequest {
	t.Helper()

	head := revisions.committed[len(revisions.committed)-1]

	return revisions.client.next(t, head, path+".md", revisions.content, false)
}

func (revisions *upgradeRevisions) commit(t *testing.T, server *instance, request *vaultsyncv1.CommitRevisionRequest) *vaultsyncv1.Revision {
	t.Helper()

	committed := revisions.client.mustCommit(t, server, request)
	revisions.committed = append(revisions.committed, committed)

	return committed
}

// requireListed checks that each of servers lists exactly the committed
// revisions, alone and in pages alternating over servers, and that each
// reports the document's history.
func (revisions *upgradeRevisions) requireListed(t *testing.T, servers ...*instance) {
	t.Helper()

	history := slices.Clone(revisions.committed)
	slices.Reverse(history)

	for _, server := range servers {
		changes, headSeq := revisions.client.changes(t, 0, server)
		requireSameRevisions(t, revisions.committed, withAnchorsOfBoth(revisions.committed, changes), "changes listed by %s", server.name)
		requireGapless(t, changes, headSeq)

		if !strings.HasPrefix(server.name, "previous") {
			// Including revisions the previous release inserted, before
			// and after this release's migration (#155).
			for _, revision := range changes {
				require.Len(t, revision.GetAnchor(), 16, "%s lists seq %d without an anchor", server.name, revision.GetSeq())
			}
		}

		requireSameRevisions(t, history, withAnchorsOfBoth(history, revisions.client.history(t, history[0].GetDocumentId(), 0, server)), "history from %s", server.name)
	}

	changes, headSeq := revisions.client.changes(t, 1, servers...)
	requireSameRevisions(t, revisions.committed, withAnchorsOfBoth(revisions.committed, changes), "changes paged across releases")
	requireGapless(t, changes, headSeq)
}

// withAnchorsOfBoth returns got with Revision.anchor (#155) copied from want
// where exactly one of them lacks it: the previous release does not know the
// field, so only one release's answer has it. Where both have an anchor,
// got keeps its own, and requireSameRevisions compares them.
func withAnchorsOfBoth(want, got []*vaultsyncv1.Revision) []*vaultsyncv1.Revision {
	if len(want) != len(got) {
		return got
	}

	adjusted := make([]*vaultsyncv1.Revision, len(got))

	for index, revision := range got {
		adjusted[index] = revision

		wantAnchor := want[index].GetAnchor()
		if (len(wantAnchor) == 0) != (len(revision.GetAnchor()) == 0) {
			copied := proto.CloneOf(revision)
			copied.Anchor = wantAnchor
			adjusted[index] = copied
		}
	}

	return adjusted
}
