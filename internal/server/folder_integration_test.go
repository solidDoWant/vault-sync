//go:build integration

package server_test

import (
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// createFolder returns a request creating a new folder document at path.
func (client *syncClient) createFolder(t *testing.T, path string) *vaultsyncv1.CommitRevisionRequest {
	t.Helper()

	request := client.create(t, path, nil)
	request.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER

	return request
}

func TestFolderWithoutContentIsListed(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	request := alice.createFolder(t, "Projects/Empty")
	created := alice.mustCommit(t, request)
	assert.Equal(t, vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER, created.GetKind())
	assert.Nil(t, created.GetContentRef())
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), created)

	// A retry of the same commit is idempotent.
	retried := alice.mustCommit(t, request)
	assert.Equal(t, created.GetId(), retried.GetId())
	assert.Equal(t, created.GetSeq(), retried.GetSeq())

	renamed := alice.mustCommit(t, alice.next(t, created, "Projects/Renamed", nil, false))
	deleted := alice.mustCommit(t, alice.next(t, renamed, "Projects/Renamed", nil, true))

	changes := alice.allChanges(t, 0, 0)
	assert.Equal(t, []string{created.GetId(), renamed.GetId(), deleted.GetId()}, revisionIDs(changes))

	for _, change := range changes {
		assert.Equal(t, vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER, change.GetKind())
		assert.Nil(t, change.GetContentRef())
		assert.Equal(t, created.GetDocumentId(), change.GetDocumentId())
	}

	assert.Equal(t, []byte("Projects/Renamed"), changes[1].GetPath())
	assert.True(t, changes[2].GetDeleted())
	fixture.requireDocumentMirrorsHead(t, created.GetDocumentId(), deleted)
}

func TestFolderWithContentIsRefused(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "content")

	request := alice.createFolder(t, "Folder")
	request.ContentRef = content
	_, err := alice.commit(t, request)
	requireCode(t, connect.CodeInvalidArgument, err)

	// Nor can a folder gain content later, alive or as a tombstone.
	folder := alice.mustCommit(t, alice.createFolder(t, "Folder"))

	for _, deleted := range []bool{false, true} {
		_, err = alice.commit(t, alice.next(t, folder, "Folder", content, deleted))
		requireCode(t, connect.CodeInvalidArgument, err, "deleted %v", deleted)
	}

	// A file without content is still refused.
	_, err = alice.commit(t, alice.create(t, "note.md", nil))
	requireCode(t, connect.CodeInvalidArgument, err)

	// A folder and a file never share a path, and kinds do not change.
	_, err = alice.commit(t, alice.create(t, "folder", content))
	requireCode(t, connect.CodeAlreadyExists, err)

	toText := alice.next(t, folder, "Folder", content, false)
	toText.Kind = vaultsyncv1.DocumentKind_DOCUMENT_KIND_TEXT
	_, err = alice.commit(t, toText)
	requireCode(t, connect.CodeInvalidArgument, err)

	assert.Equal(t, 1, fixture.count(t, "revisions", alice.vaultID))
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad input is not an internal error")
}
