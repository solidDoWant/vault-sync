// Package logtest builds signed membership logs and epoch records
// (docs/design/crypto.md) for tests of the server.
package logtest

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// Log is a vault's membership log as its members' devices sign it.
type Log struct {
	VaultID string
	Entries []e2ee.Entry
	// Secrets holds every member's user secret, by user id.
	Secrets map[string]e2ee.UserSecret
	// Rotations is the escrow chain the log is replayed with.
	Rotations []e2ee.EscrowRotation
}

// New returns the log of vaultID: its genesis entry, signed by creatorID
// with a fresh user secret, recording escrow.
func New(t *testing.T, vaultID, creatorID uuid.UUID, escrow *e2ee.EscrowBundle) *Log {
	t.Helper()

	log := &Log{VaultID: vaultID.String(), Secrets: map[string]e2ee.UserSecret{}}
	secret, bundle := log.newMember(t, creatorID)

	payload, err := e2ee.GenesisPayload(bundle, escrow)
	require.NoError(t, err)

	log.append(t, e2ee.EntryGenesis, payload, secret.SignKey())

	return log
}

func (log *Log) newMember(t *testing.T, userID uuid.UUID) (e2ee.UserSecret, e2ee.Bundle) {
	t.Helper()

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	bundle, err := secret.Bundle(userID.String())
	require.NoError(t, err)

	log.Secrets[userID.String()] = secret

	return secret, bundle
}

// Entry returns the next entry of the log, signed by keys, without
// appending it.
func (log *Log) Entry(t *testing.T, entryType e2ee.EntryType, payload []byte, keys ...ed25519.PrivateKey) e2ee.Entry {
	t.Helper()

	prevHash := make([]byte, e2ee.HashSize)

	if len(log.Entries) > 0 {
		var err error

		prevHash, err = log.Entries[len(log.Entries)-1].Hash()
		require.NoError(t, err)
	}

	entry, err := e2ee.Entry{
		VaultID: log.VaultID, Seq: uint64(len(log.Entries)) + 1, PrevHash: prevHash, Type: entryType, Payload: payload,
	}.Sign(keys...)
	require.NoError(t, err)

	return entry
}

func (log *Log) append(t *testing.T, entryType e2ee.EntryType, payload []byte, keys ...ed25519.PrivateKey) e2ee.Entry {
	t.Helper()

	entry := log.Entry(t, entryType, payload, keys...)
	log.Entries = append(log.Entries, entry)

	return entry
}

// Join appends the invite entry, signed by the owner inviterID, and the
// redeem entry of userID with role and a fresh user secret, and returns
// both entries.
func (log *Log) Join(t *testing.T, inviterID, userID uuid.UUID, role e2ee.Role) []e2ee.Entry {
	t.Helper()

	invitationID := uuid.New().String()

	inviteSignPub, inviteSignKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	_, invitationKEMPub, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	invite, err := e2ee.InvitePayload(invitationID, role, inviteSignPub, invitationKEMPub)
	require.NoError(t, err)

	inviteEntry := log.append(t, e2ee.EntryInvite, invite, log.SignKey(inviterID))

	secret, bundle := log.newMember(t, userID)

	redeem, err := e2ee.RedeemPayload(invitationID, bundle)
	require.NoError(t, err)

	return []e2ee.Entry{inviteEntry, log.append(t, e2ee.EntryRedeem, redeem, inviteSignKey, secret.SignKey())}
}

// Escrow appends the escrow on/off entry signed by the owner ownerID:
// escrow on with bundle, or off for nil.
func (log *Log) Escrow(t *testing.T, ownerID uuid.UUID, bundle *e2ee.EscrowBundle) e2ee.Entry {
	t.Helper()

	payload, err := e2ee.EscrowPayload(bundle)
	require.NoError(t, err)

	return log.append(t, e2ee.EntryEscrow, payload, log.SignKey(ownerID))
}

// EscrowReset appends the escrow reset entry from last to bundle, signed by
// the member signerID.
func (log *Log) EscrowReset(t *testing.T, signerID uuid.UUID, last, bundle e2ee.EscrowBundle) e2ee.Entry {
	t.Helper()

	payload, err := e2ee.EscrowResetPayload(last, bundle)
	require.NoError(t, err)

	return log.append(t, e2ee.EntryEscrowReset, payload, log.SignKey(signerID))
}

// SignKey returns the signing key of the member userID.
func (log *Log) SignKey(userID uuid.UUID) ed25519.PrivateKey {
	return log.Secrets[userID.String()].SignKey()
}

// States replays the log.
func (log *Log) States(t *testing.T) []e2ee.LogState {
	t.Helper()

	states, err := e2ee.ReplayLog(log.VaultID, log.Entries, e2ee.ReplayOptions{EscrowRotations: log.Rotations})
	require.NoError(t, err)

	return states
}

// Record returns the record of epoch, with commitment and prevCommitment
// (nil for epoch 1), at the log's head, signed by signerID.
func (log *Log) Record(t *testing.T, signerID uuid.UUID, epoch uint64, commitment, prevCommitment []byte) e2ee.EpochRecord {
	t.Helper()

	states := log.States(t)
	head := states[len(states)-1]

	recipients, err := e2ee.EpochRecipients(head)
	require.NoError(t, err)

	if prevCommitment == nil {
		prevCommitment = make([]byte, e2ee.MACSize)
	}

	record, err := e2ee.EpochRecord{
		VaultID: log.VaultID, Epoch: epoch, Commitment: commitment, PrevCommitment: prevCommitment,
		LogSeq: head.Seq, LogHash: head.Hash, Recipients: recipients,
	}.Sign(log.SignKey(signerID))
	require.NoError(t, err)

	return record
}

// EntryMessage is entry as the API carries it.
func EntryMessage(entry e2ee.Entry) *vaultsyncv1.LogEntry {
	return &vaultsyncv1.LogEntry{
		Seq: entry.Seq, PrevHash: entry.PrevHash, Type: uint32(entry.Type), Payload: entry.Payload, Signatures: entry.Signatures,
	}
}

// RecordMessage is record as RotateEpoch carries it.
func RecordMessage(record e2ee.EpochRecord) *vaultsyncv1.EpochRecord {
	message := &vaultsyncv1.EpochRecord{LogSeq: record.LogSeq, LogHash: record.LogHash, Signature: record.Signature}

	for _, recipient := range record.Recipients {
		message.Recipients = append(message.Recipients, &vaultsyncv1.EpochRecipient{
			Kind: uint32(recipient.Kind), RecipientId: recipient.ID, KeyHash: recipient.KeyHash,
		})
	}

	return message
}
