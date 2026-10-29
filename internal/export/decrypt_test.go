//go:build linux

package export_test

import (
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// newEscrowIdentity returns a new escrow identity and its public key.
func newEscrowIdentity(t *testing.T) (export.EscrowIdentity, []byte) {
	t.Helper()

	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	identity, err := export.NewEscrowIdentity(private)
	require.NoError(t, err)

	return identity, public
}

// encryptedVault is an end-to-end encrypted vault in a fakeSource, with the
// key of each of its epochs.
type encryptedVault struct {
	id   uuid.UUID
	keys map[int32][]byte
}

// addEncryptedVault adds an encrypted vault, with escrow or without, and
// returns it without epochs.
func (source *fakeSource) addEncryptedVault(name string, escrow bool) *encryptedVault {
	id := uuid.Must(uuid.NewV7())
	source.vaults = append(source.vaults, store.Vault{ID: id, Name: name, Encryption: store.EncryptionE2EE, Escrow: escrow, HeadSeq: 42})

	return &encryptedVault{id: id, keys: map[int32][]byte{}}
}

// addEpoch adds the vault's next epoch with a new key and its commitment,
// and returns the epoch.
func (source *fakeSource) addEpoch(t *testing.T, vault *encryptedVault) int32 {
	t.Helper()

	epoch := int32(len(vault.keys) + 1)
	vault.keys[epoch] = newKey(t)

	commitment, err := e2ee.KeyCommitment(vault.keys[epoch], vault.id.String(), uint64(epoch))
	require.NoError(t, err)

	source.epochs[vault.id] = append(source.epochs[vault.id], store.Epoch{Epoch: epoch, Commitment: commitment})

	return epoch
}

// addEscrowSlot wraps key, as the key of the vault's epoch, to the escrow
// public key named by keyID.
func (source *fakeSource) addEscrowSlot(t *testing.T, vault *encryptedVault, epoch int32, keyID string, public, key []byte) {
	t.Helper()

	wrapped, err := e2ee.SealKeySlot(public, key, e2ee.KeySlot{
		VaultID: vault.id.String(), Epoch: uint64(epoch), RecipientKind: e2ee.RecipientEscrow, RecipientID: keyID,
	})
	require.NoError(t, err)

	if source.slots[vault.id] == nil {
		source.slots[vault.id] = map[string][]store.KeySlot{}
	}

	source.slots[vault.id][keyID] = append(source.slots[vault.id][keyID], store.KeySlot{
		Epoch: epoch, RecipientKind: store.RecipientEscrow, RecipientID: keyID, WrappedKey: wrapped,
	})
}

// addEncryptedDocument adds a live document whose path and content are
// sealed under the vault's epoch the way a device seals them, and returns
// its id.
func (source *fakeSource) addEncryptedDocument(t *testing.T, vault *encryptedVault, epoch int32, path string, content []byte) uuid.UUID {
	t.Helper()

	id := uuid.Must(uuid.NewV7())
	key := vault.keys[epoch]

	subkey := func(label e2ee.Label) []byte {
		derived, err := e2ee.DeriveSubkey(key, label)
		require.NoError(t, err)

		return derived
	}

	pathAD, err := e2ee.PathAD(vault.id.String(), id.String(), uint64(epoch))
	require.NoError(t, err)

	sealedPath, err := e2ee.Seal(subkey(e2ee.LabelPath), []byte(path), pathAD)
	require.NoError(t, err)

	contentAD, err := e2ee.ContentAD(vault.id.String(), uint64(epoch))
	require.NoError(t, err)

	sealedContent, err := e2ee.Seal(subkey(e2ee.LabelContent), content, contentAD)
	require.NoError(t, err)

	blobID, err := e2ee.BlobID(subkey(e2ee.LabelBlobIDSecret), content)
	require.NoError(t, err)

	source.content[hex.EncodeToString(blobID)] = sealedContent
	source.documents[vault.id] = append(source.documents[vault.id], store.LiveDocument{
		ID: id, Kind: "text", RevisionID: uuid.Must(uuid.NewV7()), Path: string(sealedPath),
		ContentRef: blobID, Size: int64(len(sealedContent)), Epoch: epoch,
	})

	return id
}

func newKey(t *testing.T) []byte {
	t.Helper()

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	return key
}

func TestExportDecryptsAnEscrowedVaultUnderSeveralEpochs(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	identity, public := newEscrowIdentity(t)

	vault := source.addEncryptedVault("Private", true)

	documents := map[string]string{}

	// Three epochs, more than a page, each with its own key.
	for _, document := range []struct{ path, content string }{
		{"first.md", "written under epoch 1"},
		{"folder/second.md", "written under epoch 2"},
		{"folder/deeper/third.md", "written under epoch 3"},
	} {
		epoch := source.addEpoch(t, vault)
		source.addEscrowSlot(t, vault, epoch, identity.KeyID, public, vault.keys[epoch])
		source.addEncryptedDocument(t, vault, epoch, document.path, []byte(document.content))

		documents[vault.id.String()+"/"+document.path] = document.content
	}

	// Two documents with equal content share one blob.
	source.addEncryptedDocument(t, vault, 3, "copy.md", []byte("written under epoch 3"))
	documents[vault.id.String()+"/copy.md"] = "written under epoch 3"

	summary, err := space.run(t, t.Context(), source, identity)
	require.NoError(t, err)

	assert.Equal(t, documents, files(t, space.output), "the tree holds plaintext paths and contents")

	manifests := verifyManifests(t, space.output)
	require.Contains(t, manifests, vault.id)
	assert.Equal(t, "e2ee", manifests[vault.id].Vault.Encryption)

	paths := []string{}

	for _, document := range manifests[vault.id].Documents {
		assert.Equal(t, "placed", document.Status)
		paths = append(paths, document.Path)
	}

	assert.ElementsMatch(t, []string{"first.md", "folder/second.md", "folder/deeper/third.md", "copy.md"}, paths,
		"the manifest holds plaintext paths")

	assert.Equal(t, export.StatusOK, summary.Status)
	assert.Equal(t, 1, summary.Vaults)
	assert.Zero(t, summary.SkippedVaults)
	assert.Zero(t, summary.FailedVaults)
	assert.EqualValues(t, 4, summary.Files)
	assert.EqualValues(t, 21*4, summary.Bytes, "bytes count the plaintext")
}

func TestExportDecryptsWithEveryEscrowIdentityDuringARotation(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	old, oldPublic := newEscrowIdentity(t)
	current, currentPublic := newEscrowIdentity(t)

	vault := source.addEncryptedVault("Private", true)
	first := source.addEpoch(t, vault)
	source.addEscrowSlot(t, vault, first, old.KeyID, oldPublic, vault.keys[first])
	source.addEncryptedDocument(t, vault, first, "old.md", []byte("old key"))

	second := source.addEpoch(t, vault)
	source.addEscrowSlot(t, vault, second, current.KeyID, currentPublic, vault.keys[second])
	source.addEncryptedDocument(t, vault, second, "new.md", []byte("new key"))

	summary, err := space.run(t, t.Context(), source, current, old)
	require.NoError(t, err)
	assert.Equal(t, export.StatusOK, summary.Status)

	assert.Equal(t, map[string]string{
		vault.id.String() + "/old.md": "old key",
		vault.id.String() + "/new.md": "new key",
	}, files(t, space.output))
}

func TestExportSkipsAndReportsEncryptedVaultsItCannotDecrypt(t *testing.T) {
	identity, public := newEscrowIdentity(t)

	source := newFakeSource()
	notes := source.addVault("Notes", store.EncryptionNone)
	source.addDocument(notes, "a.md", []byte("plain"))

	unescrowed := source.addEncryptedVault("No escrow", false)
	epoch := source.addEpoch(t, unescrowed)
	source.addEncryptedDocument(t, unescrowed, epoch, "secret.md", []byte("members only"))

	escrowed := source.addEncryptedVault("Escrow", true)
	epoch = source.addEpoch(t, escrowed)
	source.addEscrowSlot(t, escrowed, epoch, identity.KeyID, public, escrowed.keys[epoch])
	source.addEncryptedDocument(t, escrowed, epoch, "escrowed.md", []byte("escrowed"))

	t.Run("a vault without escrow is skipped", func(t *testing.T) {
		space := newWorkspace(t)

		summary, err := space.run(t, t.Context(), source, identity)
		require.NoError(t, err)

		assert.Equal(t, map[string]string{
			notes.String() + "/a.md":              "plain",
			escrowed.id.String() + "/escrowed.md": "escrowed",
		}, files(t, space.output))

		assertNotExported(t, space, unescrowed.id)
		assert.Equal(t, export.StatusOK, summary.Status)
		assert.Equal(t, 2, summary.Vaults)
		assert.Equal(t, 1, summary.SkippedVaults)
		assert.Equal(t, export.VaultSummary{ID: unescrowed.id, Name: "No escrow", Encryption: "e2ee", HeadSeq: 42, Skipped: export.SkippedNoEscrow},
			summary.VaultDetails[1])
	})

	t.Run("without an escrow identity every encrypted vault is skipped", func(t *testing.T) {
		space := newWorkspace(t)

		summary, err := space.run(t, t.Context(), source)
		require.NoError(t, err)

		assert.Equal(t, map[string]string{notes.String() + "/a.md": "plain"}, files(t, space.output))

		assertNotExported(t, space, unescrowed.id)
		assertNotExported(t, space, escrowed.id)
		assert.Equal(t, export.StatusOK, summary.Status)
		assert.Equal(t, 2, summary.SkippedVaults)
		assert.Equal(t, export.SkippedNoEscrow, summary.VaultDetails[1].Skipped)
		assert.Equal(t, export.SkippedNoEscrowIdentity, summary.VaultDetails[2].Skipped)
	})
}

func TestExportFailsAVaultWhoseEscrowSlotDoesNotVerify(t *testing.T) {
	identity, public := newEscrowIdentity(t)
	_, otherPublic := newEscrowIdentity(t)

	tests := []struct {
		name string
		// slot adds the escrow slot of the vault's second epoch.
		slot       func(t *testing.T, source *fakeSource, vault *encryptedVault)
		wantReason string
	}{
		{
			name: "a slot holding another key fails its key commitment",
			slot: func(t *testing.T, source *fakeSource, vault *encryptedVault) {
				source.addEscrowSlot(t, vault, 2, identity.KeyID, public, newKey(t))
			},
			wantReason: "the escrow slot of epoch 2 fails its key commitment",
		},
		{
			name: "a slot holding the first epoch's key fails the second epoch's commitment",
			slot: func(t *testing.T, source *fakeSource, vault *encryptedVault) {
				source.addEscrowSlot(t, vault, 2, identity.KeyID, public, vault.keys[1])
			},
			wantReason: "the escrow slot of epoch 2 fails its key commitment",
		},
		{
			name: "a slot sealed to another key does not open",
			slot: func(t *testing.T, source *fakeSource, vault *encryptedVault) {
				source.addEscrowSlot(t, vault, 2, identity.KeyID, otherPublic, vault.keys[2])
			},
			wantReason: "the escrow slot of epoch 2 does not open with the escrow identity",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			space := newWorkspace(t)
			source := newFakeSource()

			notes := source.addVault("Notes", store.EncryptionNone)
			source.addDocument(notes, "a.md", []byte("plain"))

			vault := source.addEncryptedVault("Private", true)
			first := source.addEpoch(t, vault)
			source.addEscrowSlot(t, vault, first, identity.KeyID, public, vault.keys[first])
			source.addEncryptedDocument(t, vault, first, "first.md", []byte("first"))

			second := source.addEpoch(t, vault)
			test.slot(t, source, vault)
			source.addEncryptedDocument(t, vault, second, "second.md", []byte("second"))

			summary, err := space.run(t, t.Context(), source, identity)
			require.NoError(t, err, "one vault's keys do not stop the export of the others")

			assert.Equal(t, map[string]string{notes.String() + "/a.md": "plain"}, files(t, space.output))
			assertNotExported(t, space, vault.id)

			assert.Equal(t, export.StatusPartial, summary.Status)
			assert.Equal(t, 1, summary.Vaults)
			assert.Equal(t, 1, summary.FailedVaults)
			assert.Zero(t, summary.SkippedVaults)
			assert.Equal(t, export.VaultSummary{ID: vault.id, Name: "Private", Encryption: "e2ee", HeadSeq: 42, Failed: test.wantReason},
				summary.VaultDetails[1])
		})
	}
}

func TestExportReportsEncryptedDocumentsItCannotDecrypt(t *testing.T) {
	space := newWorkspace(t)
	source := newFakeSource()
	identity, public := newEscrowIdentity(t)

	vault := source.addEncryptedVault("Private", true)
	first := source.addEpoch(t, vault)
	source.addEscrowSlot(t, vault, first, identity.KeyID, public, vault.keys[first])

	readable := source.addEncryptedDocument(t, vault, first, "readable.md", []byte("readable"))

	tamperedContent := source.addEncryptedDocument(t, vault, first, "tampered-content.md", []byte("tampered"))
	sealed := source.content[hex.EncodeToString(source.documents[vault.id][1].ContentRef)]
	sealed[len(sealed)-1] ^= 1

	tamperedPath := source.addEncryptedDocument(t, vault, first, "tampered-path.md", []byte("content kept"))
	path := []byte(source.documents[vault.id][2].Path)
	path[len(path)-1] ^= 1
	source.documents[vault.id][2].Path = string(path)

	// Escrow was turned off: the second epoch has no escrow slot.
	second := source.addEpoch(t, vault)
	unescrowed := source.addEncryptedDocument(t, vault, second, "after-escrow-off.md", []byte("members only"))

	summary, err := space.run(t, t.Context(), source, identity)
	require.NoError(t, err)

	assert.Equal(t, map[string]string{
		vault.id.String() + "/readable.md":                       "readable",
		vault.id.String() + ".unplaced/" + tamperedPath.String(): "content kept",
	}, files(t, space.output))

	documents := verifyManifests(t, space.output)[vault.id].byID()
	assert.Equal(t, "placed", documents[readable].Status)
	assert.Equal(t, "missing", documents[tamperedContent].Status)
	assert.Equal(t, "stored content does not decrypt with the revision's epoch key", documents[tamperedContent].Reason)
	assert.Equal(t, "tampered-content.md", documents[tamperedContent].Path)
	assert.Equal(t, "unplaced", documents[tamperedPath].Status)
	assert.Equal(t, "path does not decrypt with the revision's epoch key", documents[tamperedPath].Reason)
	assert.Empty(t, documents[tamperedPath].Path)
	assert.Equal(t, "missing", documents[unescrowed].Status)
	assert.Equal(t, "no escrow key opens the revision's epoch", documents[unescrowed].Reason)

	assert.Equal(t, export.StatusPartial, summary.Status)
	assert.Equal(t, 2, summary.DocumentErrors)
	assert.EqualValues(t, 1, summary.Unplaced)
}

// assertNotExported checks that a vault has no directory and no manifest.
func assertNotExported(t *testing.T, space workspace, vaultID uuid.UUID) {
	t.Helper()

	_, err := os.Lstat(filepath.Join(space.output, vaultID.String()))
	require.ErrorIs(t, err, fs.ErrNotExist, "the vault has no directory")

	_, err = os.Lstat(filepath.Join(space.output, vaultID.String()+".manifest.jsonl"))
	require.ErrorIs(t, err, fs.ErrNotExist, "the vault has no manifest")
}
