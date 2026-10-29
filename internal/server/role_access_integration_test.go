//go:build integration

package server_test

import (
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// The server enforces every role on every request, whatever the client
// sends (docs/design/sharing.md, Roles): each call here is what a modified
// client would send, built by hand rather than by the plugin, which never
// sends a viewer's commit.
func TestServerRefusesAccessByRoleAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Shared").GetId()
	note := alice.mustCommit(t, alice.create(t, "note.md", alice.content(t, "the owner's note\n")))
	noteBlob := blobIDOf([]byte("the owner's note\n"))

	join := func(subject string, role vaultsyncv1.VaultRole) *syncClient {
		t.Helper()

		member := fixture.client(t, subject, alice.vaultID)
		_, err := fixture.redeem(t, member.token, fixture.mustInvite(t, alice.token, alice.vaultID, role).GetCode())
		require.NoError(t, err)

		return member
	}

	viewer := join("victor", vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	removed := join("rita", vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	// A member until removed: their commit is accepted before, refused after.
	removed.mustCommit(t, removed.create(t, "rita.md", removed.content(t, "rita's note\n")))
	require.NoError(t, fixture.removeMember(t, alice.token, alice.vaultID, "rita"))

	stranger := fixture.client(t, "mallory", alice.vaultID)

	// Every read and write a client can make on a vault's data.
	read := func(client *syncClient) map[string]error {
		_, changes := client.changes(t, 0, 0)
		_, revision := client.revision(t, note.GetId())
		_, history := client.historyPage(t, note.GetDocumentId(), 0, "")
		_, download := fixture.download(t, client.token, client.vaultID, noteBlob, 0, 1)

		return map[string]error{"ListChanges": changes, "GetRevision": revision, "GetDocumentHistory": history, "DownloadBlob": download}
	}
	write := func(client *syncClient) map[string]error {
		content := []byte("written by " + client.deviceID + "\n")
		blobID := blobIDOf(content)
		_, begin := fixture.begin(t, client.token, client.vaultID, blobID, len(content))
		_, put := fixture.put(t, client.token, client.vaultID, blobID, 0, content)
		_, commitBlob := fixture.commit(t, client.token, client.vaultID, blobID)
		// A new document, and an edit of the owner's note, each pointing at content the server holds.
		_, create := client.commit(t, client.create(t, "new.md", &vaultsyncv1.ContentRef{BlobId: noteBlob, Size: uint64(len("the owner's note\n"))}))
		_, edit := client.commit(t, client.next(t, note, "note.md", &vaultsyncv1.ContentRef{BlobId: noteBlob, Size: uint64(len("the owner's note\n"))}, false))
		_, remove := client.commit(t, client.next(t, note, "note.md", nil, true))

		return map[string]error{"BeginBlob": begin, "PutBlobChunk": put, "CommitBlob": commitBlob, "CommitRevision (create)": create, "CommitRevision (edit)": edit, "CommitRevision (delete)": remove}
	}

	t.Run("[P3-13] a non-member can neither read nor write", func(t *testing.T) {
		for procedure, err := range read(stranger) {
			requireCode(t, connect.CodeNotFound, err, procedure)
		}

		for procedure, err := range write(stranger) {
			requireCode(t, connect.CodeNotFound, err, procedure)
		}
	})

	t.Run("[P3-13] a removed member can neither read nor write", func(t *testing.T) {
		for procedure, err := range read(removed) {
			requireCode(t, connect.CodeNotFound, err, procedure)
		}

		for procedure, err := range write(removed) {
			requireCode(t, connect.CodeNotFound, err, procedure)
		}
	})

	t.Run("[P3-13] a viewer reads, and their commits and blob uploads are refused", func(t *testing.T) {
		before := fixture.headSeq(t, alice.vaultID)

		for procedure, err := range read(viewer) {
			require.NoError(t, err, procedure)
		}

		for procedure, err := range write(viewer) {
			requireCode(t, connect.CodePermissionDenied, err, procedure)
		}

		// Nothing the refused calls sent reached the vault.
		require.Equal(t, before, fixture.headSeq(t, alice.vaultID))
	})
}
