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
			Name string `json:"name"`
			Path string `json:"path"`
			New  bool   `json:"new"`
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
			revisions := fixture.count(t, "revisions", alice.vaultID)
			documents := fixture.count(t, "documents", alice.vaultID)

			_, err := alice.commit(t, alice.create(t, vector.Path, content))
			if vector.New {
				require.NoError(t, err, "path %q", vector.Path)

				accepted++

				assert.Equal(t, revisions+1, fixture.count(t, "revisions", alice.vaultID))

				return
			}

			requireCode(t, connect.CodeInvalidArgument, err, "path %q", vector.Path)
			assert.Equal(t, revisions, fixture.count(t, "revisions", alice.vaultID), "nothing is written for %q", vector.Path)
			assert.Equal(t, documents, fixture.count(t, "documents", alice.vaultID), "nothing is written for %q", vector.Path)
		})
	}

	assert.Positive(t, accepted)
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad paths are not internal errors")
}

// TestCommitEnforcesSharedPathText drives every shared path text vector
// (testdata/paths/text.json, also asserted by the TypeScript client, #148)
// through CommitRevision in a plaintext vault, as a create: it is accepted
// exactly for the valid vectors, and an invalid one writes nothing.
func TestCommitEnforcesSharedPathText(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "paths", "text.json"))
	require.NoError(t, err)

	var file struct {
		Vectors []struct {
			Name   string `json:"name"`
			Path   string `json:"path"`
			Repeat int    `json:"repeat"`
			Valid  bool   `json:"valid"`
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
			if vector.Valid {
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
