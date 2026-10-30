package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// escrowBundle returns a fresh escrow bundle and its signing key.
func escrowBundle(t *testing.T) (e2ee.EscrowBundle, ed25519.PrivateKey) {
	t.Helper()

	_, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(public)
	require.NoError(t, err)

	signPub, signKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	return e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}, signKey
}

func TestMembershipChangesVerifyAfterTheLogMovedAlongTheEscrowChain(t *testing.T) {
	vaultID, ownerID, editorID := uuid.New(), uuid.New(), uuid.New()
	old, oldSignKey := escrowBundle(t)
	current, _ := escrowBundle(t)

	rotation, err := e2ee.SignEscrowRotation(oldSignKey, old, current)
	require.NoError(t, err)

	log := logtest.New(t, vaultID, ownerID, &old)
	log.Rotations = []e2ee.EscrowRotation{rotation}
	log.Join(t, ownerID, editorID, e2ee.RoleEditor)
	log.Escrow(t, ownerID, &current)

	payload := append(editorID[:], byte(e2ee.RoleViewer))
	entry := log.Entry(t, e2ee.EntrySetRole, payload, log.SignKey(ownerID))

	stored := make([]store.LogEntry, len(log.Entries))
	for index, logged := range log.Entries {
		stored[index] = store.LogEntry{Seq: int64(logged.Seq), PrevHash: logged.PrevHash, Type: byte(logged.Type), Payload: logged.Payload, Signatures: logged.Signatures} //nolint:gosec // small test values.
	}

	cases := []struct {
		name   string
		escrow Escrow
		check  require.ErrorAssertionFunc
	}{
		{name: "with the escrow chain", escrow: Escrow{Rotations: []e2ee.EscrowRotation{rotation}}, check: require.NoError},
		{name: "without the escrow chain", escrow: Escrow{}, check: require.Error},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			appended, err := logAppend(logtest.EntryMessage(entry), records(e2ee.EntrySetRole, payload), testCase.escrow.replayOptions())
			require.NoError(t, err)

			testCase.check(t, appended.Verify(vaultID, uuid.Nil, stored))
		})
	}
}
