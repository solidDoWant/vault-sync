//go:build integration

package vaultcmd_test

import (
	"crypto/sha256"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// The server's side of deleting a shared vault (docs/acceptance/phase-3.md,
// P3-12; the devices' side is in plugin/test/e2e/specs/shared-vault.e2e.ts):
// the data stays for 30 days, during which the operator can undo the
// deletion, and is purged after them.
func TestDeletedSharedVault(t *testing.T) {
	t.Run("[P3-12] the server keeps a deleted vault's data for 30 days, the operator can undelete it until then, and it is purged after", func(t *testing.T) {
		fixture := newFixture(t)
		ctx := t.Context()

		owner, err := fixture.store.UpsertUser(ctx, testIssuer, "owner", "")
		require.NoError(t, err)

		member, err := fixture.store.UpsertUser(ctx, testIssuer, "member", "")
		require.NoError(t, err)

		device, err := fixture.store.RegisterDevice(ctx, owner, "laptop", nil, 10)
		require.NoError(t, err)

		vault, err := fixture.store.CreateVault(ctx, owner, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 10)
		require.NoError(t, err)

		codeHash := []byte("member-code-hash-000000000000000")
		_, err = fixture.store.InVault(vault.ID).CreateInvitation(ctx, owner, uuid.Nil, store.RoleEditor, codeHash, time.Hour, 10, nil, nil)
		require.NoError(t, err)

		_, err = fixture.store.RedeemInvitation(ctx, member, codeHash, 10, nil, nil)
		require.NoError(t, err)

		content := []byte("a shared note")
		sum := sha256.Sum256(content)
		blobKey := blobstore.BlobKey(vault.ID, sum[:])
		vaultStore := fixture.store.InVault(vault.ID)
		require.NoError(t, fixture.objects.Put(ctx, blobKey, content))
		require.NoError(t, vaultStore.RecordCompleteBlob(ctx, sum[:], int64(len(content))))

		documentID := uuid.Must(uuid.NewV7())
		committed, err := vaultStore.CommitRevision(ctx, store.NewRevision{
			ID: uuid.Must(uuid.NewV7()), DocumentID: documentID, Kind: "text",
			ContentRef: sum[:], ContentSize: int64(len(content)), Path: "a.md", PathKey: "a.md",
			DeviceID: device.ID, UserID: owner,
		})
		require.NoError(t, err)

		// Deleted, and 30 days not yet over: invisible to every member, but kept.
		require.NoError(t, fixture.store.DeleteVault(ctx, vault.ID))
		fixture.deletedAgo(t, vault.ID, "29 days 23 hours 59 minutes")

		for _, user := range []uuid.UUID{owner, member} {
			_, err = fixture.store.VaultRole(ctx, vault.ID, user)
			require.ErrorIs(t, err, store.ErrVaultDeleted, "every member's requests are refused")
		}

		assert.Equal(t, retention.Result{}, fixture.purge(t, 0), "nothing is purged within 30 days")

		// The operator undoes the deletion: the data is all there.
		code, stdout, stderr := fixture.run(t, "undelete", vault.ID.String())
		require.Equal(t, 0, code, stderr)
		assert.Contains(t, stdout, vault.ID.String())

		role, err := fixture.store.VaultRole(ctx, vault.ID, member)
		require.NoError(t, err)
		assert.Equal(t, store.RoleEditor, role)

		history, err := vaultStore.DocumentHistory(ctx, documentID, 0, 10)
		require.NoError(t, err)
		require.Len(t, history.Revisions, 1)
		assert.Equal(t, committed.ID, history.Revisions[0].ID)

		reader, err := fixture.objects.Open(ctx, blobKey)
		require.NoError(t, err)

		data, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.NoError(t, reader.Close())
		assert.Equal(t, content, data)

		// Deleted again, and 30 days over: purged, and past undoing.
		require.NoError(t, fixture.store.DeleteVault(ctx, vault.ID))
		fixture.deletedAgo(t, vault.ID, "30 days 1 second")

		assert.Equal(t, retention.Result{VaultsPurged: 1}, fixture.purge(t, 0))

		_, err = fixture.objects.Open(ctx, blobKey)
		require.Error(t, err, "the vault's blobs are gone")

		code, stdout, stderr = fixture.run(t, "undelete", vault.ID.String())
		assert.Equal(t, 1, code)
		assert.Empty(t, stdout)
		assert.Contains(t, stderr, "does not exist or has been purged")
	})
}
