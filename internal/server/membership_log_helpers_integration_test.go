//go:build integration

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

// The client side of an E2EE vault's membership log in these tests: each
// membership change signs the next entry on top of the log the server lists.

// vaultLog returns the whole log of lister's vault, as lister lists it.
func (fixture *syncFixture) vaultLog(t *testing.T, lister *keyedMember) []*vaultsyncv1.LogEntry {
	t.Helper()

	page, err := fixture.logEntries(t, lister, 1000, "")
	require.NoError(t, err)
	require.Empty(t, page.GetNextPageToken())

	return page.GetEntries()
}

// encrypted reports whether lister's vault has a membership log, which only
// E2EE vaults have.
func (fixture *syncFixture) encrypted(t *testing.T, lister *keyedMember) bool {
	t.Helper()

	return len(fixture.vaultLog(t, lister)) > 0
}

// nextEntry is the entry after the head of lister's vault log, signed by
// keys in order.
func (fixture *syncFixture) nextEntry(t *testing.T, lister *keyedMember, entryType e2ee.EntryType, payload []byte, keys ...ed25519.PrivateKey) *vaultsyncv1.LogEntry {
	t.Helper()

	entries := fixture.vaultLog(t, lister)
	require.NotEmpty(t, entries, "an E2EE vault's log starts with its genesis")

	head := entries[len(entries)-1]
	prevHash, err := logEntryOf(lister.vaultID, head).Hash()
	require.NoError(t, err)

	return signedEntry(t, lister.vaultID, head.GetSeq()+1, prevHash, entryType, payload, keys...)
}

func signedEntry(t *testing.T, vaultID string, seq uint64, prevHash []byte, entryType e2ee.EntryType, payload []byte, keys ...ed25519.PrivateKey) *vaultsyncv1.LogEntry {
	t.Helper()

	entry, err := e2ee.Entry{VaultID: vaultID, Seq: seq, PrevHash: prevHash, Type: entryType, Payload: payload}.Sign(keys...)
	require.NoError(t, err)

	return &vaultsyncv1.LogEntry{Seq: entry.Seq, PrevHash: entry.PrevHash, Type: uint32(entry.Type), Payload: entry.Payload, Signatures: entry.Signatures}
}

func logEntryOf(vaultID string, message *vaultsyncv1.LogEntry) e2ee.Entry {
	return e2ee.Entry{
		VaultID: vaultID, Seq: message.GetSeq(), PrevHash: message.GetPrevHash(), Type: e2ee.EntryType(message.GetType()),
		Payload: message.GetPayload(), Signatures: message.GetSignatures(),
	}
}

// logRoleOf is a role's byte in the log.
func logRoleOf(role vaultsyncv1.VaultRole) e2ee.Role {
	switch role {
	case vaultsyncv1.VaultRole_VAULT_ROLE_OWNER:
		return e2ee.RoleOwner
	case vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR:
		return e2ee.RoleEditor
	default:
		return e2ee.RoleViewer
	}
}

// signedInvitation is an invitation of an E2EE vault: its id, its invite
// entry signed by inviter, and its invitation signing key.
type signedInvitation struct {
	id      uuid.UUID
	entry   *vaultsyncv1.LogEntry
	signKey ed25519.PrivateKey
}

func (fixture *syncFixture) signedInvitation(t *testing.T, inviter *keyedMember, role vaultsyncv1.VaultRole) signedInvitation {
	t.Helper()

	signPub, signKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	_, kemPub, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	id := uuid.Must(uuid.NewV7())
	payload, err := e2ee.InvitePayload(id.String(), logRoleOf(role), signPub, kemPub)
	require.NoError(t, err)

	return signedInvitation{id: id, signKey: signKey, entry: fixture.nextEntry(t, inviter, e2ee.EntryInvite, payload, inviter.secret.SignKey())}
}

// redeemEntry is newcomer's redeem entry of invitation, on top of the log
// lister sees.
func (fixture *syncFixture) redeemEntry(t *testing.T, lister, newcomer *keyedMember, invitation signedInvitation) *vaultsyncv1.LogEntry {
	t.Helper()

	bundle, err := newcomer.secret.Bundle(newcomer.userID.String())
	require.NoError(t, err)

	payload, err := e2ee.RedeemPayload(invitation.id.String(), bundle)
	require.NoError(t, err)

	return fixture.nextEntry(t, lister, e2ee.EntryRedeem, payload, invitation.signKey, newcomer.secret.SignKey())
}

// idEntry is the next entry of type entryType naming id, signed by signer.
func (fixture *syncFixture) idEntry(t *testing.T, lister *keyedMember, entryType e2ee.EntryType, id uuid.UUID, signer *keyedMember) *vaultsyncv1.LogEntry {
	t.Helper()

	payload, err := e2ee.IDPayload(id.String())
	require.NoError(t, err)

	return fixture.nextEntry(t, lister, entryType, payload, signer.secret.SignKey())
}

// genesis is the genesis entry of vaultID without escrow, created and
// signed by member.
func (member *keyedMember) genesis(t *testing.T, vaultID string) *vaultsyncv1.LogEntry {
	t.Helper()

	bundle, err := member.secret.Bundle(member.userID.String())
	require.NoError(t, err)

	payload, err := e2ee.GenesisPayload(bundle, nil)
	require.NoError(t, err)

	return signedEntry(t, vaultID, 1, make([]byte, e2ee.HashSize), e2ee.EntryGenesis, payload, member.secret.SignKey())
}
