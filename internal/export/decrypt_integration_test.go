//go:build integration && linux

package export_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// escrowedStoreVault is an escrowed vault in the database, as devices
// leave it, with its epoch keys.
type escrowedStoreVault struct {
	id   uuid.UUID
	keys map[int32][]byte
}

// rotate creates the vault's next epoch with a new key, wrapped to the
// escrow public key as its only slot (the vault's member has no user key),
// or with wrappedKey wrapped instead when it is not nil.
func (deployment *deployment) rotate(t *testing.T, vault *escrowedStoreVault, escrowPublic, wrappedKey []byte) int32 {
	t.Helper()

	expected := int32(len(vault.keys))
	epoch := expected + 1

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	vault.keys[epoch] = key
	if wrappedKey == nil {
		wrappedKey = key
	}

	commitment, err := e2ee.KeyCommitment(key, vault.id.String(), uint64(epoch))
	require.NoError(t, err)

	keyID, err := e2ee.EscrowKeyID(escrowPublic)
	require.NoError(t, err)

	wrapped, err := e2ee.SealKeySlot(escrowPublic, wrappedKey, e2ee.KeySlot{
		VaultID: vault.id.String(), Epoch: uint64(epoch), RecipientKind: e2ee.RecipientEscrow, RecipientID: keyID,
	})
	require.NoError(t, err)

	_, err = deployment.store.InVault(vault.id).RotateEpoch(t.Context(), deployment.user, store.NextEpoch{
		ExpectedEpoch: expected, Commitment: commitment,
		Slots: []store.KeySlot{{RecipientKind: store.RecipientEscrow, RecipientID: keyID, WrappedKey: wrapped}},
	})
	require.NoError(t, err)

	return epoch
}

// commitEncrypted commits a new document whose path and content are sealed
// under the vault's current epoch, as a device commits it.
func (deployment *deployment) commitEncrypted(t *testing.T, vault *escrowedStoreVault, path string, content []byte) {
	t.Helper()

	epoch := int32(len(vault.keys))
	key := vault.keys[epoch]
	document := uuid.Must(uuid.NewV7())

	subkey := func(label e2ee.Label) []byte {
		derived, err := e2ee.DeriveSubkey(key, label)
		require.NoError(t, err)

		return derived
	}

	pathAD, err := e2ee.PathAD(vault.id.String(), document.String(), uint64(epoch))
	require.NoError(t, err)

	sealedPath, err := e2ee.Seal(subkey(e2ee.LabelPath), []byte(path), pathAD)
	require.NoError(t, err)

	contentAD, err := e2ee.ContentAD(vault.id.String(), uint64(epoch))
	require.NoError(t, err)

	sealedContent, err := e2ee.Seal(subkey(e2ee.LabelContent), content, contentAD)
	require.NoError(t, err)

	blobID, err := e2ee.BlobID(subkey(e2ee.LabelBlobIDSecret), content)
	require.NoError(t, err)

	pathKey, err := e2ee.PathKey(subkey(e2ee.LabelPathKeySecret), path)
	require.NoError(t, err)

	require.NoError(t, deployment.objects.Put(t.Context(), blobstore.BlobKey(vault.id, blobID), sealedContent))

	_, err = deployment.pool.Exec(t.Context(), `
		INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')`,
		vault.id, blobID, len(sealedContent))
	require.NoError(t, err)

	_, err = deployment.store.InVault(vault.id).CommitRevision(t.Context(), store.NewRevision{
		ID: uuid.Must(uuid.NewV7()), DocumentID: document, Kind: "blob",
		ContentRef: blobID, ContentSize: int64(len(sealedContent)),
		Path: string(sealedPath), PathKey: string(pathKey), Epoch: epoch,
		DeviceID: deployment.device, UserID: deployment.user,
	})
	require.NoError(t, err)
}

func (deployment *deployment) createEscrowedVault(t *testing.T, name string) *escrowedStoreVault {
	t.Helper()

	vault, err := deployment.store.CreateVault(t.Context(), deployment.user, store.NewVault{Name: name, Encryption: store.EncryptionE2EE, Escrow: true}, 100)
	require.NoError(t, err)

	return &escrowedStoreVault{id: vault.ID, keys: map[int32][]byte{}}
}

func TestExportDecryptsEscrowedVaultsFromTheStore(t *testing.T) {
	t.Run("[P4-11] the export job decrypts an escrowed vault to plaintext, and skips and reports a vault without escrow", func(t *testing.T) {
		deployment := newDeployment(t)

		escrowPrivate, escrowPublic, err := e2ee.GenerateKeyPair()
		require.NoError(t, err)

		identity, err := e2ee.AgeIdentity(escrowPrivate)
		require.NoError(t, err)

		identityFile := filepath.Join(t.TempDir(), "escrow.key")
		require.NoError(t, os.WriteFile(identityFile, []byte("# escrow identity\n"+identity+"\n"), 0o600))

		private := deployment.createEscrowedVault(t, "Private")
		deployment.rotate(t, private, escrowPublic, nil)
		deployment.commitEncrypted(t, private, "first.md", []byte("epoch 1"))
		deployment.rotate(t, private, escrowPublic, nil)
		deployment.commitEncrypted(t, private, "folder/second.md", []byte("epoch 2"))
		deployment.rotate(t, private, escrowPublic, nil)
		deployment.commitEncrypted(t, private, "folder/third.md", []byte("epoch 3"))

		broken := deployment.createEscrowedVault(t, "Broken")
		deployment.rotate(t, broken, escrowPublic, nil)
		deployment.commitEncrypted(t, broken, "first.md", []byte("epoch 1"))

		wrongKey, err := e2ee.GenerateKey()
		require.NoError(t, err)

		deployment.rotate(t, broken, escrowPublic, wrongKey)

		unescrowed, err := deployment.store.CreateVault(t.Context(), deployment.user, store.NewVault{Name: "Members only", Encryption: store.EncryptionE2EE}, 100)
		require.NoError(t, err)

		env := deployment.env()
		env[config.EscrowIdentityFileEnv] = identityFile

		output := filepath.Join(t.TempDir(), "export")
		code, summary := runMain(t, t.Context(), env, output)

		assert.Equal(t, 1, code, "a failed vault makes the run partial")
		assert.Equal(t, export.StatusPartial, summary.Status, summary.Error)

		assert.Equal(t, map[string]string{
			private.id.String() + "/first.md":         "epoch 1",
			private.id.String() + "/folder/second.md": "epoch 2",
			private.id.String() + "/folder/third.md":  "epoch 3",
		}, files(t, output))

		manifests := verifyManifests(t, output)
		require.Len(t, manifests, 1)

		paths := []string{}

		for _, document := range manifests[private.id].Documents {
			paths = append(paths, document.Path)
		}

		assert.ElementsMatch(t, []string{"first.md", "folder/second.md", "folder/third.md"}, paths)

		assert.Equal(t, 1, summary.Vaults)
		assert.Equal(t, 1, summary.SkippedVaults)
		assert.Equal(t, 1, summary.FailedVaults)

		details := map[uuid.UUID]export.VaultSummary{}
		for _, vault := range summary.VaultDetails {
			details[vault.ID] = vault
		}

		assert.Equal(t, "the escrow slot of epoch 2 fails its key commitment", details[broken.id].Failed)
		assert.Equal(t, export.SkippedNoEscrow, details[unescrowed.ID].Skipped)
	})
}
