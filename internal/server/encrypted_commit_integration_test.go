//go:build integration

package server_test

import (
	"crypto/rand"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// sealedPathOverhead is what sealing adds to a path (docs/design/crypto.md):
// the suite byte, the 24-byte nonce and the 16-byte tag.
const sealedPathOverhead = 1 + 24 + 16

// encryptedVaultAtEpoch creates an E2EE vault owned by owner with epoch
// rotations epochs, each a fresh key wrapped to owner and members.
func (fixture *syncFixture) encryptedVaultAtEpoch(t *testing.T, owner *keyedMember, epochs uint32, members ...*keyedMember) {
	t.Helper()

	fixture.e2eeVault(t, owner, false)

	for _, member := range members {
		fixture.join(t, owner, member, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	}

	recipients := append([]*keyedMember{owner}, members...)

	for expected := range epochs {
		key, err := e2ee.GenerateKey()
		require.NoError(t, err)

		_, err = fixture.rotate(t, 0, owner, nextEpoch(t, owner.vaultID, expected, key, recipients...))
		require.NoError(t, err)
	}
}

// opaqueBytes returns size random bytes: neither UTF-8 nor free of NUL, as
// ciphertext and HMACs are not.
func opaqueBytes(t *testing.T, size int) []byte {
	t.Helper()

	value := make([]byte, size)
	_, err := rand.Read(value)
	require.NoError(t, err)

	// Make sure the value is not text, whatever rand drew.
	value[0], value[size-1] = 0x00, 0xff

	return value
}

// encryptedCreate returns a request creating a new text document under
// epoch with the given ciphertext path and path key.
func (client *syncClient) encryptedCreate(t *testing.T, epoch uint32, path, pathKey []byte, content *vaultsyncv1.ContentRef) *vaultsyncv1.CommitRevisionRequest {
	t.Helper()

	request := client.create(t, "", content)
	request.Path = path
	request.PathKey = pathKey
	request.Epoch = epoch

	return request
}

func TestEncryptedCommitStoresCiphertextPathsAndClientPathKeys(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	fixture.encryptedVaultAtEpoch(t, alice, 2, bob)

	content := alice.content(t, "ciphertext content")
	path := opaqueBytes(t, api.MaxPathBytes+sealedPathOverhead)
	pathKey := opaqueBytes(t, 32)

	request := alice.encryptedCreate(t, 2, path, pathKey, content)
	committed, err := alice.commit(t, request)
	require.NoError(t, err, "a ciphertext path with a 32-byte path_key lands under the current epoch")
	assert.Equal(t, path, committed.GetPath())
	assert.Equal(t, uint32(2), committed.GetEpoch())

	retried, err := alice.commit(t, request)
	require.NoError(t, err, "a retry with identical bytes gets the committed revision back")
	assert.Equal(t, committed.GetId(), retried.GetId())

	changes := bob.allChanges(t, 0, 0)
	require.Len(t, changes, 1)
	assert.Equal(t, path, changes[0].GetPath(), "ListChanges returns the committed bytes")

	read, err := bob.revision(t, committed.GetId())
	require.NoError(t, err)
	assert.Equal(t, path, read.GetPath())

	history := bob.history(t, committed.GetDocumentId())
	require.Len(t, history, 1)
	assert.Equal(t, path, history[0].GetPath())

	// An edit in place and a rename keep working on ciphertext paths.
	edit := alice.next(t, committed, "", content, false)
	edit.Path, edit.PathKey, edit.Epoch = path, pathKey, 2
	edited := alice.mustCommit(t, edit)

	renamedPath := opaqueBytes(t, 1)
	rename := alice.next(t, edited, "", content, false)
	rename.Path, rename.PathKey, rename.Epoch = renamedPath, opaqueBytes(t, 32), 2
	renamed := alice.mustCommit(t, rename)
	assert.Equal(t, renamedPath, renamed.GetPath())

	// A 32-byte path_key that contains "/" in base64 or text form has no
	// folders: a key that is a prefix of another is no collision.
	slashes := []byte("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")
	alice.mustCommit(t, alice.encryptedCreate(t, 2, opaqueBytes(t, 50), slashes, content))

	folder := alice.encryptedCreate(t, 2, opaqueBytes(t, 50), opaqueBytes(t, 32), nil)
	folder.Kind, folder.ContentRef = vaultsyncv1.DocumentKind_DOCUMENT_KIND_FOLDER, nil
	alice.mustCommit(t, folder)
}

func TestEncryptedCommitRefusesATakenPathKey(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	fixture.encryptedVaultAtEpoch(t, alice, 1)

	content := alice.content(t, "ciphertext content")
	pathKey := opaqueBytes(t, 32)

	first := alice.mustCommit(t, alice.encryptedCreate(t, 1, opaqueBytes(t, 60), pathKey, content))

	before := fixture.headSeq(t, alice.vaultID)
	_, err := alice.commit(t, alice.encryptedCreate(t, 1, opaqueBytes(t, 60), pathKey, content))
	requireCode(t, connect.CodeAlreadyExists, err, "another document with a live document's path_key")
	assert.Equal(t, before, fixture.headSeq(t, alice.vaultID), "nothing is committed")

	other := alice.mustCommit(t, alice.encryptedCreate(t, 1, opaqueBytes(t, 60), opaqueBytes(t, 32), content))
	rename := alice.next(t, other, "", content, false)
	rename.Path, rename.PathKey, rename.Epoch = opaqueBytes(t, 60), pathKey, 1
	_, err = alice.commit(t, rename)
	requireCode(t, connect.CodeAlreadyExists, err, "a rename onto a live document's path_key")

	// Once the holder is deleted, the key is free.
	tombstone := alice.next(t, first, "", content, true)
	tombstone.Path, tombstone.PathKey, tombstone.Epoch = first.GetPath(), pathKey, 1
	alice.mustCommit(t, tombstone)

	_, err = alice.commit(t, alice.encryptedCreate(t, 1, opaqueBytes(t, 60), pathKey, content))
	require.NoError(t, err)
}

func TestEncryptedCommitValidatesPathsAndPathKeys(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	fixture.encryptedVaultAtEpoch(t, alice, 1)

	content := alice.content(t, "ciphertext content")

	for _, test := range []struct {
		name          string
		path, pathKey []byte
		wantCode      connect.Code
	}{
		{name: "the largest sealed path", path: opaqueBytes(t, api.MaxPathBytes+sealedPathOverhead), pathKey: opaqueBytes(t, 32)},
		{name: "a one-byte path", path: opaqueBytes(t, 1), pathKey: opaqueBytes(t, 32)},
		{name: "a path one byte over", path: opaqueBytes(t, api.MaxPathBytes+sealedPathOverhead+1), pathKey: opaqueBytes(t, 32), wantCode: connect.CodeInvalidArgument},
		{name: "an empty path", pathKey: opaqueBytes(t, 32), wantCode: connect.CodeInvalidArgument},
		{name: "no path_key", path: opaqueBytes(t, 60), wantCode: connect.CodeInvalidArgument},
		{name: "a 31-byte path_key", path: opaqueBytes(t, 60), pathKey: opaqueBytes(t, 31), wantCode: connect.CodeInvalidArgument},
		{name: "a 33-byte path_key", path: opaqueBytes(t, 60), pathKey: opaqueBytes(t, 33), wantCode: connect.CodeInvalidArgument},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := fixture.headSeq(t, alice.vaultID)
			_, err := alice.commit(t, alice.encryptedCreate(t, 1, test.path, test.pathKey, content))

			if test.wantCode == 0 {
				require.NoError(t, err)

				return
			}

			requireCode(t, test.wantCode, err)
			assert.Equal(t, before, fixture.headSeq(t, alice.vaultID), "nothing is committed")
		})
	}
}

func TestEncryptedCommitRefusesViewersAndNonMembers(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	carol := fixture.keyedMember(t, "carol")
	mallory := fixture.keyedMember(t, "mallory")

	fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, key, alice, carol))
	require.NoError(t, err)

	mallory.vaultID = alice.vaultID
	content := alice.content(t, "ciphertext content")

	for _, test := range []struct {
		client *syncClient
		code   connect.Code
	}{
		{client: carol.syncClient, code: connect.CodePermissionDenied},
		{client: mallory.syncClient, code: connect.CodeNotFound},
	} {
		_, err := test.client.commit(t, test.client.encryptedCreate(t, 1, opaqueBytes(t, 60), opaqueBytes(t, 32), content))
		requireCode(t, test.code, err)
	}

	assert.Zero(t, fixture.headSeq(t, alice.vaultID), "nothing was written")
}
