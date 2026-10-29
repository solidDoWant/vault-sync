package export_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"filippo.io/age"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// escrowKey is one escrow key: its identity, bundle and signing key.
type escrowKey struct {
	identity export.EscrowIdentity
	public   []byte
	bundle   e2ee.EscrowBundle
	signing  ed25519.PrivateKey
}

func newEscrowKey(t *testing.T) escrowKey {
	t.Helper()

	identity, public := newEscrowIdentity(t)

	recipient, err := e2ee.AgeRecipient(public)
	require.NoError(t, err)

	signPub, signing, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	return escrowKey{identity: identity, public: public, bundle: e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}, signing: signing}
}

// rotationServer is an in-memory deployment: the stored escrow chain, the
// vaults with their epochs and escrow slots, and the job-only endpoint's
// checks.
type rotationServer struct {
	t          *testing.T
	root       e2ee.EscrowBundle
	rotations  []e2ee.EscrowRotation
	appends    int
	vaults     []store.Vault
	epochs     map[uuid.UUID][]store.Epoch
	slots      map[uuid.UUID][]store.KeySlot
	epochKeys  map[uuid.UUID]map[int32][]byte
	onReplaced func()
}

func newRotationServer(t *testing.T, root e2ee.EscrowBundle) *rotationServer {
	t.Helper()

	return &rotationServer{
		t: t, root: root, epochs: map[uuid.UUID][]store.Epoch{}, slots: map[uuid.UUID][]store.KeySlot{},
		epochKeys: map[uuid.UUID]map[int32][]byte{},
	}
}

func (server *rotationServer) head() e2ee.EscrowBundle {
	head, err := e2ee.VerifyEscrowChain(server.root, server.rotations)
	require.NoError(server.t, err)

	return head
}

// addVault adds a vault with epochs 1..epochs, each with one escrow slot
// wrapped to key.
func (server *rotationServer) addVault(key escrowKey, epochs int, deleted bool) uuid.UUID {
	vault := store.Vault{ID: uuid.New(), Encryption: store.EncryptionE2EE, Escrow: true}
	if deleted {
		now := vault.CreatedAt
		vault.DeletedAt = &now
	}

	server.vaults = append(server.vaults, vault)
	slices.SortFunc(server.vaults, func(left, right store.Vault) int { return bytes.Compare(left.ID[:], right.ID[:]) })
	server.epochKeys[vault.ID] = map[int32][]byte{}

	for epoch := int32(1); epoch <= int32(epochs); epoch++ {
		server.addEpoch(vault.ID, epoch, key)
	}

	return vault.ID
}

func (server *rotationServer) addEpoch(vaultID uuid.UUID, epoch int32, key escrowKey) {
	epochKey := make([]byte, e2ee.KeySize)
	_, err := rand.Read(epochKey)
	require.NoError(server.t, err)

	commitment, err := e2ee.KeyCommitment(epochKey, vaultID.String(), uint64(epoch))
	require.NoError(server.t, err)

	server.epochKeys[vaultID][epoch] = epochKey
	server.epochs[vaultID] = append(server.epochs[vaultID], store.Epoch{Epoch: epoch, Commitment: commitment})
	server.slots[vaultID] = append(server.slots[vaultID], store.KeySlot{
		Epoch: epoch, RecipientKind: store.RecipientEscrow, RecipientID: key.identity.KeyID, WrappedKey: sealSlot(server.t, key, vaultID, epoch, epochKey),
	})
}

func sealSlot(t *testing.T, key escrowKey, vaultID uuid.UUID, epoch int32, epochKey []byte) []byte {
	t.Helper()

	wrapped, err := e2ee.SealKeySlot(key.public, epochKey, e2ee.KeySlot{
		VaultID: vaultID.String(), Epoch: uint64(epoch), RecipientKind: e2ee.RecipientEscrow, RecipientID: key.identity.KeyID,
	})
	require.NoError(t, err)

	return wrapped
}

func (server *rotationServer) slot(vaultID uuid.UUID, epoch int32) store.KeySlot {
	for _, slot := range server.slots[vaultID] {
		if slot.Epoch == epoch {
			return slot
		}
	}

	server.t.Fatalf("vault %s epoch %d has no escrow slot", vaultID, epoch)

	return store.KeySlot{}
}

// EscrowChain implements export.RotationSource.
func (server *rotationServer) EscrowChain(context.Context) (store.EscrowChain, error) {
	root, err := server.root.Encode()
	require.NoError(server.t, err)

	chain := store.EscrowChain{Root: root}

	for _, rotation := range server.rotations {
		encoded, err := rotation.NewBundle.Encode()
		require.NoError(server.t, err)

		chain.Rotations = append(chain.Rotations, store.EscrowRotationStatement{OldBundleHash: rotation.OldBundleHash, NewBundle: encoded, Signature: rotation.Signature})
	}

	return chain, nil
}

// Vaults implements export.RotationSource.
func (server *rotationServer) Vaults(_ context.Context, after uuid.UUID, limit int) ([]store.Vault, error) {
	var page []store.Vault

	for _, vault := range server.vaults {
		if bytes.Compare(vault.ID[:], after[:]) > 0 && len(page) < limit {
			page = append(page, vault)
		}
	}

	return page, nil
}

// Epochs implements export.RotationSource.
func (server *rotationServer) Epochs(_ context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.Epoch, error) {
	var page []store.Epoch

	for _, epoch := range server.epochs[vaultID] {
		if epoch.Epoch > after && len(page) < limit {
			page = append(page, epoch)
		}
	}

	return page, nil
}

// AllEscrowSlots implements export.RotationSource.
func (server *rotationServer) AllEscrowSlots(_ context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.KeySlot, error) {
	var page []store.KeySlot

	for _, slot := range server.slots[vaultID] {
		if slot.Epoch > after && len(page) < limit {
			page = append(page, slot)
		}
	}

	return page, nil
}

// AppendEscrowRotation implements export.RotationWriter, with the
// endpoint's check against the chain's head.
func (server *rotationServer) AppendEscrowRotation(_ context.Context, statement e2ee.EscrowRotation) error {
	if _, err := e2ee.VerifyEscrowChain(server.head(), []e2ee.EscrowRotation{statement}); err != nil {
		return err
	}

	server.rotations = append(server.rotations, statement)
	server.appends++

	return nil
}

// ReplaceEscrowSlot implements export.RotationWriter, with the endpoint's
// checks: the new slot is on the head's key and the old one is still there.
func (server *rotationServer) ReplaceEscrowSlot(_ context.Context, replacement store.EscrowSlotReplacement) error {
	public, err := e2ee.ParseAgeRecipient(server.head().Recipient)
	require.NoError(server.t, err)

	headKeyID, err := e2ee.EscrowKeyID(public)
	require.NoError(server.t, err)
	require.Equal(server.t, headKeyID, replacement.NewRecipientID, "the endpoint refuses a new slot not on the head's key")

	slots := server.slots[replacement.VaultID]
	for index, slot := range slots {
		if slot.Epoch == replacement.Epoch && slot.RecipientID == replacement.OldRecipientID {
			slots[index] = store.KeySlot{Epoch: slot.Epoch, RecipientKind: store.RecipientEscrow, RecipientID: replacement.NewRecipientID, WrappedKey: replacement.WrappedKey}

			if server.onReplaced != nil {
				server.onReplaced()
			}

			return nil
		}
	}

	return export.ErrEscrowSlotGone
}

func rotate(t *testing.T, server *rotationServer, target escrowKey, identities []export.EscrowIdentity, signing []ed25519.PrivateKey) export.RotationSummary {
	t.Helper()

	summary, err := export.Rotate(t.Context(), export.RotationOptions{
		Source: server, Writer: server, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Target: target.bundle, Identities: identities, SigningKeys: signing, PageSize: 2,
	})
	require.NoError(t, err)

	return summary
}

// requireOnKey checks that every escrow slot is on key and opens, with the
// age library as `age --decrypt` does, to its epoch's key.
func requireOnKey(t *testing.T, server *rotationServer, key escrowKey) {
	t.Helper()

	ageIdentityString, err := e2ee.AgeIdentity(key.identity.PrivateKey)
	require.NoError(t, err)

	ageIdentity, err := age.ParseHybridIdentity(ageIdentityString)
	require.NoError(t, err)

	for vaultID, slots := range server.slots {
		for _, slot := range slots {
			require.Equal(t, key.identity.KeyID, slot.RecipientID, "vault %s epoch %d", vaultID, slot.Epoch)

			reader, err := age.Decrypt(bytes.NewReader(slot.WrappedKey), ageIdentity)
			require.NoError(t, err)

			payload, err := io.ReadAll(reader)
			require.NoError(t, err)
			require.Equal(t, server.epochKeys[vaultID][slot.Epoch], payload[:e2ee.KeySize])
		}
	}
}

func TestRotateRewrapsEverySlotIncludingDeletedVaults(t *testing.T) {
	t.Parallel()

	oldKey, newKey := newEscrowKey(t), newEscrowKey(t)
	server := newRotationServer(t, oldKey.bundle)
	server.addVault(oldKey, 3, false)
	server.addVault(oldKey, 1, true)
	server.addVault(oldKey, 2, false)

	summary := rotate(t, server, newKey, []export.EscrowIdentity{oldKey.identity, newKey.identity}, []ed25519.PrivateKey{newKey.signing, oldKey.signing})

	assert.Equal(t, export.StatusOK, summary.Status)
	assert.Equal(t, 6, summary.Rewrapped)
	assert.Equal(t, 0, summary.OldKeySlots)
	assert.Equal(t, 3, summary.Vaults)
	assert.Empty(t, summary.Failures)
	requireOnKey(t, server, newKey)
}

func TestRotateAppendsOneStatementSignedByTheHead(t *testing.T) {
	t.Parallel()

	oldKey, newKey := newEscrowKey(t), newEscrowKey(t)
	server := newRotationServer(t, oldKey.bundle)
	server.addVault(oldKey, 1, false)

	identities := []export.EscrowIdentity{oldKey.identity, newKey.identity}
	signing := []ed25519.PrivateKey{oldKey.signing, newKey.signing}

	first := rotate(t, server, newKey, identities, signing)
	assert.True(t, first.AppendedStatement)
	require.Len(t, server.rotations, 1)

	oldEncoded, err := oldKey.bundle.Encode()
	require.NoError(t, err)

	oldHash := sha256.Sum256(oldEncoded)
	assert.Equal(t, oldHash[:], server.rotations[0].OldBundleHash, "the statement moves from the head")
	assert.Equal(t, newKey.bundle, server.head())

	second := rotate(t, server, newKey, identities, signing)
	assert.False(t, second.AppendedStatement)
	assert.Equal(t, 1, server.appends, "a repeat run never appends a second statement")
	assert.Equal(t, export.StatusOK, second.Status)
}

func TestRotateReportsAndKeepsASlotThatFailsItsCommitment(t *testing.T) {
	t.Parallel()

	oldKey, newKey := newEscrowKey(t), newEscrowKey(t)
	server := newRotationServer(t, oldKey.bundle)
	vaultID := server.addVault(oldKey, 2, false)

	// Epoch 2's slot holds another key than the one its commitment names.
	wrong := make([]byte, e2ee.KeySize)
	_, err := rand.Read(wrong)
	require.NoError(t, err)

	badSlot := sealSlot(t, oldKey, vaultID, 2, wrong)
	server.slots[vaultID][1].WrappedKey = badSlot

	summary := rotate(t, server, newKey, []export.EscrowIdentity{oldKey.identity, newKey.identity}, []ed25519.PrivateKey{oldKey.signing, newKey.signing})

	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.Equal(t, 1, summary.Rewrapped)
	assert.Equal(t, 1, summary.OldKeySlots)
	assert.Equal(t, 1, summary.FailedSlots)
	require.Len(t, summary.Failures, 1)
	assert.Equal(t, export.SlotFailure{VaultID: vaultID, Epoch: 2, RecipientID: oldKey.identity.KeyID, Reason: summary.Failures[0].Reason}, summary.Failures[0])
	assert.Contains(t, summary.Failures[0].Reason, "commitment")
	assert.Equal(t, badSlot, server.slot(vaultID, 2).WrappedKey, "the failing slot is left in place")
	assert.Equal(t, oldKey.identity.KeyID, server.slot(vaultID, 2).RecipientID)
	assert.Equal(t, newKey.identity.KeyID, server.slot(vaultID, 1).RecipientID)
}

func TestRotateCatchesASlotWrappedToTheOldKeyDuringTheSwitch(t *testing.T) {
	t.Parallel()

	oldKey, newKey := newEscrowKey(t), newEscrowKey(t)
	server := newRotationServer(t, oldKey.bundle)
	vaultID := server.addVault(oldKey, 1, false)
	identities := []export.EscrowIdentity{oldKey.identity, newKey.identity}
	signing := []ed25519.PrivateKey{oldKey.signing, newKey.signing}

	// A device creates epoch 2 with the old key while the first run goes.
	server.onReplaced = func() {
		server.onReplaced = nil
		server.addEpoch(vaultID, 2, oldKey)
	}

	first := rotate(t, server, newKey, identities, signing)
	assert.Equal(t, export.StatusFailed, first.Status, "the run does not report done while an old-key slot is left")
	assert.Equal(t, 1, first.OldKeySlots)

	second := rotate(t, server, newKey, identities, signing)
	assert.Equal(t, export.StatusOK, second.Status)
	assert.Equal(t, 1, second.Rewrapped)
	assert.Equal(t, 0, second.OldKeySlots)

	// The old identity is no longer needed.
	third := rotate(t, server, newKey, []export.EscrowIdentity{newKey.identity}, []ed25519.PrivateKey{newKey.signing})
	assert.Equal(t, export.StatusOK, third.Status)
	assert.Equal(t, 0, third.Rewrapped)
	requireOnKey(t, server, newKey)
}

func TestRotateRefusesToStartWithoutTheKeys(t *testing.T) {
	t.Parallel()

	oldKey, newKey := newEscrowKey(t), newEscrowKey(t)

	tests := []struct {
		name       string
		identities []export.EscrowIdentity
		signing    []ed25519.PrivateKey
		message    string
	}{
		{name: "no target identity", identities: []export.EscrowIdentity{oldKey.identity}, signing: []ed25519.PrivateKey{oldKey.signing, newKey.signing}, message: "target's identity"},
		{name: "no target signing key", identities: []export.EscrowIdentity{oldKey.identity, newKey.identity}, signing: []ed25519.PrivateKey{oldKey.signing}, message: "target's signing key"},
		{name: "no head signing key", identities: []export.EscrowIdentity{oldKey.identity, newKey.identity}, signing: []ed25519.PrivateKey{newKey.signing}, message: "chain's head"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			server := newRotationServer(t, oldKey.bundle)
			vaultID := server.addVault(oldKey, 1, false)
			before := server.slot(vaultID, 1)

			summary, err := export.Rotate(t.Context(), export.RotationOptions{
				Source: server, Writer: server, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
				Target: newKey.bundle, Identities: test.identities, SigningKeys: test.signing,
			})
			require.Error(t, err)
			assert.True(t, strings.Contains(err.Error(), test.message), err.Error())
			assert.Equal(t, export.StatusFailed, summary.Status)
			assert.Empty(t, server.rotations)
			assert.Equal(t, before, server.slot(vaultID, 1))
		})
	}
}
