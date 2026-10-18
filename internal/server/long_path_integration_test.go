//go:build integration

package server_test

import (
	"crypto/rand"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/text/unicode/norm"

	"github.com/solidDoWant/vault-sync/internal/api"
)

// randomLetters returns length random lower-case ASCII letters. PostgreSQL
// cannot compress them meaningfully, so a path made of them is stored (and
// indexed) at full size.
func randomLetters(t *testing.T, length int) string {
	t.Helper()

	const alphabet = "abcdefghijklmnopqrstuvwxyz"

	random := make([]byte, length)
	_, err := rand.Read(random)
	require.NoError(t, err)

	letters := make([]byte, length)
	for index, value := range random {
		letters[index] = alphabet[int(value)%len(alphabet)]
	}

	return string(letters)
}

// incompressiblePath returns a random path of exactly length bytes.
func incompressiblePath(t *testing.T, length int) string {
	t.Helper()

	return randomLetters(t, length-len(".md")) + ".md"
}

// Issue #121, criterion 1: a maximum-length path that does not compress is
// committed, listed and fetched like any other.
func TestMaximumLengthIncompressiblePathSyncs(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	paths := []string{incompressiblePath(t, api.MaxPathBytes), incompressiblePath(t, api.MaxPathBytes)}

	committed := make(map[string]string, len(paths))

	for _, path := range paths {
		revision := alice.mustCommit(t, alice.create(t, path, content))
		assert.Equal(t, path, string(revision.GetPath()))

		committed[revision.GetId()] = path
	}

	// Renaming a document to another maximum-length path rewrites its
	// path key, so the index must take it too.
	first := alice.mustCommit(t, alice.create(t, "first.md", content))
	renamedPath := incompressiblePath(t, api.MaxPathBytes)
	renamed := alice.mustCommit(t, alice.next(t, first, renamedPath, content, false))
	fixture.requireDocumentMirrorsHead(t, first.GetDocumentId(), renamed)

	committed[renamed.GetId()] = renamedPath

	listed := map[string]string{}
	for _, revision := range alice.allChanges(t, 0, 0) {
		listed[revision.GetId()] = string(revision.GetPath())
	}

	for revisionID, path := range committed {
		assert.Equal(t, path, listed[revisionID], "the change feed lists revision %s", revisionID)

		fetched, err := alice.revision(t, revisionID)
		require.NoError(t, err)
		assert.Equal(t, path, string(fetched.GetPath()))
		assert.Equal(t, content.GetBlobId(), fetched.GetContentRef().GetBlobId())

		history := alice.history(t, fetched.GetDocumentId())
		require.NotEmpty(t, history)
		assert.Equal(t, revisionID, history[0].GetId())
	}
}

// Issue #121, criterion 2: maximum-length paths that differ only in case or
// Unicode normalization collide, exactly as short paths do.
func TestMaximumLengthPathKeyCollisions(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	// accentedPath returns a random path ending in "é", which is 2 bytes
	// composed (NFC) and 3 decomposed (NFD), so its NFD spelling is exactly
	// the maximum length.
	accentedPath := func(t *testing.T) string {
		t.Helper()

		path := randomLetters(t, api.MaxPathBytes-len(".md")-len(norm.NFD.String("é"))) + "é.md"
		require.Len(t, norm.NFD.String(path), api.MaxPathBytes)

		return path
	}

	tests := []struct {
		name string
		// paths returns the existing document's path and the new one's.
		paths   func(t *testing.T) (existing, other string)
		collide bool
	}{
		{name: "identical", collide: true, paths: func(t *testing.T) (string, string) {
			path := incompressiblePath(t, api.MaxPathBytes)

			return path, path
		}},
		{name: "case", collide: true, paths: func(t *testing.T) (string, string) {
			path := incompressiblePath(t, api.MaxPathBytes)

			return path, strings.ToUpper(path)
		}},
		{name: "NFC and NFD", collide: true, paths: func(t *testing.T) (string, string) {
			path := accentedPath(t)

			return norm.NFC.String(path), norm.NFD.String(path)
		}},
		{name: "NFD and upper-case NFC", collide: true, paths: func(t *testing.T) (string, string) {
			path := accentedPath(t)

			return norm.NFD.String(path), norm.NFC.String(strings.ToUpper(path))
		}},
		{name: "last letter differs", collide: false, paths: func(t *testing.T) (string, string) {
			stem := randomLetters(t, api.MaxPathBytes-len("x.md"))

			return stem + "a.md", stem + "b.md"
		}},
		{name: "first letter differs", collide: false, paths: func(t *testing.T) (string, string) {
			stem := randomLetters(t, api.MaxPathBytes-len("x.md"))

			return "a" + stem + ".md", "b" + stem + ".md"
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			existing, other := test.paths(t)
			require.Len(t, existing, api.MaxPathBytes-strings.Count(existing, "é"))

			alice.mustCommit(t, alice.create(t, existing, content))

			before := fixture.headSeq(t, alice.vaultID)
			_, err := alice.commit(t, alice.create(t, other, content))

			if !test.collide {
				require.NoError(t, err)

				return
			}

			requireCode(t, connect.CodeAlreadyExists, err)
			assert.Equal(t, before, fixture.headSeq(t, alice.vaultID), "nothing is committed")
		})
	}
}

// Issue #121, criterion 3: a path longer than the maximum is invalid_argument,
// however it compresses.
func TestOverLongIncompressiblePathIsInvalid(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	for _, length := range []int{api.MaxPathBytes + 1, 2 * api.MaxPathBytes, api.MaxPathKeyBytes + 1} {
		_, err := alice.commit(t, alice.create(t, incompressiblePath(t, length), content))
		requireCode(t, connect.CodeInvalidArgument, err, "a %d-byte path", length)
	}

	assert.Zero(t, fixture.headSeq(t, alice.vaultID), "nothing is committed")
}
