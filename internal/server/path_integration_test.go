//go:build integration

package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/api"
)

// TestCommitEnforcesSharedPathValidity drives every shared path validity
// vector (testdata/paths/validity.json, also asserted by the TypeScript
// client) through CommitRevision in a plaintext vault, as a create: it is
// accepted exactly for the vectors that are new paths. It reproduces issues
// #139 (backslash ".." segments and drive or UNC prefixes were accepted),
// #191 (a create at a path containing "\" was accepted) and #148 (a create
// at a path starting with one character and ":" was accepted).
func TestCommitEnforcesSharedPathValidity(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "validity.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []struct {
			Name   string `json:"name"`
			Path   string `json:"path"`
			Repeat int    `json:"repeat"`
			Suffix string `json:"suffix"`
			New    bool   `json:"new"`
		} `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	accepted := 0

	for _, vector := range file.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			path := strings.Repeat(vector.Path, max(vector.Repeat, 1)) + vector.Suffix
			revisions := fixture.count(t, "revisions", alice.vaultID)
			documents := fixture.count(t, "documents", alice.vaultID)

			_, err := alice.commit(t, alice.create(t, path, content))
			if vector.New {
				require.NoError(t, err, "path %q", path)

				accepted++

				assert.Equal(t, revisions+1, fixture.count(t, "revisions", alice.vaultID))

				return
			}

			requireCode(t, connect.CodeInvalidArgument, err, "path %q", path)
			assert.Equal(t, revisions, fixture.count(t, "revisions", alice.vaultID), "nothing is written for %q", path)
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written for %q", path)
		})
	}

	assert.Positive(t, accepted)
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad paths are not internal errors")
}

// TestCommitEnforcesSharedPathText drives every shared path text vector
// (testdata/paths/text.json, also asserted by the TypeScript client, #148)
// through CommitRevision in a plaintext vault, as a create: it is accepted
// exactly for the new vectors (valid, and within the new-path length
// limits), and any other writes nothing.
func TestCommitEnforcesSharedPathText(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "text.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []struct {
			Name   string `json:"name"`
			Path   string `json:"path"`
			Repeat int    `json:"repeat"`
			Valid  bool   `json:"valid"`
			New    bool   `json:"new"`
		} `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	accepted, refused := 0, 0

	for _, vector := range file.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			path := strings.Repeat(vector.Path, max(vector.Repeat, 1))
			revisions := fixture.count(t, "revisions", alice.vaultID)
			documents := fixture.count(t, "documents", alice.vaultID)

			_, err := alice.commit(t, alice.create(t, path, content))
			if vector.New {
				require.NoError(t, err, "path of %d bytes", len(path))

				accepted++

				assert.Equal(t, revisions+1, fixture.count(t, "revisions", alice.vaultID))

				return
			}

			refused++

			requireCode(t, connect.CodeInvalidArgument, err, "path of %d bytes", len(path))
			assert.Equal(t, revisions, fixture.count(t, "revisions", alice.vaultID), "nothing is written")
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written")
		})
	}

	assert.Positive(t, accepted)
	assert.Positive(t, refused)
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad paths are not internal errors")
}

// TestCommitEnforcesSharedPathKeyLength drives every shared normalized path
// length vector (testdata/paths/key.json, also asserted by the TypeScript
// client, #100) through CommitRevision in a plaintext vault, as a create: it
// is accepted exactly for the new vectors (valid, and within the new-path
// length limits), and any other writes nothing.
func TestCommitEnforcesSharedPathKeyLength(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "key.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []struct {
			Name         string `json:"name"`
			Path         string `json:"path"`
			Repeat       int    `json:"repeat"`
			Suffix       string `json:"suffix"`
			SuffixRepeat int    `json:"suffixRepeat"`
			Valid        bool   `json:"valid"`
			New          bool   `json:"new"`
		} `json:"vectors"`
	}

	require.NoError(t, json.Unmarshal(data, &file))
	require.NotEmpty(t, file.Vectors)

	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	accepted, refused := 0, 0

	for _, vector := range file.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			path := strings.Repeat(vector.Path, max(vector.Repeat, 1)) + strings.Repeat(vector.Suffix, max(vector.SuffixRepeat, 1))
			revisions := fixture.count(t, "revisions", alice.vaultID)
			documents := fixture.count(t, "documents", alice.vaultID)

			_, err := alice.commit(t, alice.create(t, path, content))
			if vector.New {
				require.NoError(t, err, "path of %d bytes", len(path))

				accepted++

				assert.Equal(t, revisions+1, fixture.count(t, "revisions", alice.vaultID))

				return
			}

			refused++

			requireCode(t, connect.CodeInvalidArgument, err, "path of %d bytes", len(path))
			assert.Equal(t, revisions, fixture.count(t, "revisions", alice.vaultID), "nothing is written")
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written")
		})
	}

	assert.Positive(t, accepted)
	assert.Positive(t, refused)
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad paths are not internal errors")
}

// TestCommitRefusesUnportableNamesWithTheRule creates a document at a path
// for each portable-name rule of docs/design/engine.md §6: CommitRevision
// refuses it as INVALID_ARGUMENT, names the rule, and writes nothing.
func TestCommitRefusesUnportableNamesWithTheRule(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		reason string
	}{
		{name: "forbidden character", path: "notes/a?.md", reason: "must not contain any of"},
		{name: "control character", path: "a\tb.md", reason: "without control characters"},
		{name: "leading space", path: " a.md", reason: "must not start or end with a space"},
		{name: "trailing space", path: "notes /a.md", reason: "must not start or end with a space"},
		{name: "trailing dot", path: "a.md.", reason: "must not end in a dot"},
		{name: "reserved name", path: "notes/CON.md", reason: "Windows reserved name"},
		{name: "reserved name without an extension", path: "lpt9", reason: "Windows reserved name"},
		{name: "dot segment", path: "notes/./a.md", reason: "must be relative"},
		{name: "dot-dot segment", path: "../a.md", reason: "must be relative"},
		{name: "name longer than 255 bytes", path: strings.Repeat("a", 256), reason: "at most 255 bytes"},
		{name: "path longer than 1024 bytes", path: strings.Repeat(strings.Repeat("a", 254)+"/", 4) + "abcde", reason: "at most 1024 bytes"},
	}

	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			revisions := fixture.count(t, "revisions", alice.vaultID)
			documents := fixture.count(t, "documents", alice.vaultID)

			_, err := alice.commit(t, alice.create(t, test.path, content))
			requireCode(t, connect.CodeInvalidArgument, err, "path %q", test.path)
			assert.Contains(t, err.Error(), test.reason)
			assert.Equal(t, revisions, fixture.count(t, "revisions", alice.vaultID), "nothing is written")
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written")
		})
	}

	_, err := alice.commit(t, alice.create(t, strings.Repeat(strings.Repeat("a", 254)+"/", 4)+"abcd", content))
	require.NoError(t, err, "a 1024-byte path of 255-byte names is portable")
}

// TestCommitRefusesASecondLiveDocumentWithTheSamePathKey: paths that differ
// only in case, including the dotless ı and I that NTFS upcase takes for one
// name (docs/design/engine.md §6), share a path_key, so a second live
// document at one of them is ALREADY_EXISTS.
func TestCommitRefusesASecondLiveDocumentWithTheSamePathKey(t *testing.T) {
	tests := []struct {
		name          string
		first, second string
	}{
		{name: "a and A", first: "a.md", second: "A.md"},
		{name: "dotless i and I", first: "ı.md", second: "I.md"},
		{name: "I and dotless i", first: "notes/I.md", second: "notes/ı.md"},
	}

	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := alice.commit(t, alice.create(t, test.first, content))
			require.NoError(t, err)

			documents := fixture.count(t, "documents", alice.vaultID)

			_, err = alice.commit(t, alice.create(t, test.second, content))
			requireCode(t, connect.CodeAlreadyExists, err, "path %q after %q", test.second, test.first)
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written")
		})
	}
}
