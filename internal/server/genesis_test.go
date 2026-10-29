package server_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// e2eeCreateRequest is a CreateVault request for a new E2EE vault whose
// genesis entry userID signs with a fresh user secret, recording escrow.
func e2eeCreateRequest(t *testing.T, name string, userID uuid.UUID, escrow *e2ee.EscrowBundle) *vaultsyncv1.CreateVaultRequest {
	t.Helper()

	vaultID := uuid.Must(uuid.NewV7())

	return &vaultsyncv1.CreateVaultRequest{
		Name:       name,
		Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE,
		Escrow:     escrow != nil,
		NewVaultId: vaultID.String(),
		Genesis:    signedGenesis(t, vaultID, userID, escrow),
	}
}

// signedGenesis is the genesis entry of vaultID, signed by userID with a
// fresh user secret.
func signedGenesis(t *testing.T, vaultID, userID uuid.UUID, escrow *e2ee.EscrowBundle) *vaultsyncv1.LogEntry {
	t.Helper()

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	bundle, err := secret.Bundle(userID.String())
	require.NoError(t, err)

	payload, err := e2ee.GenesisPayload(bundle, escrow)
	require.NoError(t, err)

	entry, err := e2ee.Entry{
		VaultID: vaultID.String(), Seq: 1, PrevHash: make([]byte, e2ee.HashSize), Type: e2ee.EntryGenesis, Payload: payload,
	}.Sign(secret.SignKey())
	require.NoError(t, err)

	return &vaultsyncv1.LogEntry{Seq: entry.Seq, PrevHash: entry.PrevHash, Type: uint32(entry.Type), Payload: entry.Payload, Signatures: entry.Signatures}
}

// userID returns the id of the user the store created for subject, which
// it does on the subject's first authenticated call.
func (memory *memoryStore) userID(t *testing.T, subject string) uuid.UUID {
	t.Helper()

	memory.mu.Lock()
	defer memory.mu.Unlock()

	for identity, id := range memory.users {
		if identity.Subject == subject {
			return id
		}
	}

	require.FailNow(t, "no user for subject", subject)

	return uuid.Nil
}

// escrowBundleOf is an escrow bundle naming the hybrid public key publicKey.
func escrowBundleOf(t *testing.T, publicKey []byte) *e2ee.EscrowBundle {
	t.Helper()

	signPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(publicKey)
	require.NoError(t, err)

	return &e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}
}
