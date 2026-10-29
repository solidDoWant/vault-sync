package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// signedVault is a vault with an owner and an editor in its log, and the
// RotateEpoch request for its epoch 3 that the owner signs at the head.
type signedVault struct {
	vaultID, ownerID, editorID uuid.UUID
	log                        *logtest.Log
	prevCommitment             []byte
	escrow                     *e2ee.EscrowBundle
	escrowKeyID                string
	escrowPublic               []byte
}

func newSignedVault(t *testing.T) *signedVault {
	t.Helper()

	vault := &signedVault{vaultID: uuid.New(), ownerID: uuid.New(), editorID: uuid.New(), prevCommitment: bytes.Repeat([]byte{7}, 32)}
	vault.log = logtest.New(t, vault.vaultID, vault.ownerID, nil)
	vault.log.Join(t, vault.ownerID, vault.editorID, e2ee.RoleEditor)

	_, escrowPublic, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(escrowPublic)
	require.NoError(t, err)

	signPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	vault.escrow = &e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}
	vault.escrowKeyID, err = e2ee.EscrowKeyID(escrowPublic)
	require.NoError(t, err)

	vault.escrowPublic = escrowPublic

	return vault
}

func (vault *signedVault) slot(kind vaultsyncv1.KeyRecipientKind, id string) *vaultsyncv1.KeySlot {
	return &vaultsyncv1.KeySlot{RecipientKind: kind, RecipientId: id, WrappedKey: bytes.Repeat([]byte{9}, 105)}
}

// request is the RotateEpoch of epoch 3 with a slot for each member, and
// record signed by the owner at the log's head.
func (vault *signedVault) request(t *testing.T) *vaultsyncv1.RotateEpochRequest {
	t.Helper()

	commitment := bytes.Repeat([]byte{5}, 32)
	record := vault.log.Record(t, vault.ownerID, 3, commitment, vault.prevCommitment)

	return &vaultsyncv1.RotateEpochRequest{
		NextEpoch: &vaultsyncv1.NextEpoch{ExpectedEpoch: 2, Commitment: commitment, Slots: []*vaultsyncv1.KeySlot{
			vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, vault.ownerID.String()),
			vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, vault.editorID.String()),
		}},
		Record: logtest.RecordMessage(record),
	}
}

// storedLog is the log as the store holds it, without the entries of
// pending, which travel with the request.
func storedLog(entries []e2ee.Entry) []store.LogEntry {
	log := make([]store.LogEntry, len(entries))
	for index, entry := range entries {
		log[index] = store.LogEntry{
			Seq: int64(entry.Seq), PrevHash: entry.PrevHash, Type: byte(entry.Type), Payload: entry.Payload, Signatures: entry.Signatures, //nolint:gosec // small test values.
		}
	}

	return log
}

// check sends request to RotateEpoch and runs the check it hands the store
// on stored (the store appends the escrow entry), as the store does under
// the vault row lock.
func (vault *signedVault) check(t *testing.T, request *vaultsyncv1.RotateEpochRequest, stored []e2ee.Entry) (bool, error) {
	t.Helper()

	recorder := &keyRecorder{}
	service := api.VaultKeyService{
		Keys:   func(uuid.UUID) api.VaultKeyStore { return recorder },
		Escrow: api.Escrow{PublicKey: vault.escrowPublic, KeyID: vault.escrowKeyID},
	}
	ctx := authz.WithMembership(auth.WithUser(context.Background(), auth.User{ID: vault.ownerID}), authz.Membership{VaultID: vault.vaultID, Role: store.RoleOwner})

	_, err := service.RotateEpoch(ctx, connect.NewRequest(request))
	require.NoError(t, err)
	require.NotNil(t, recorder.next.Check, "an E2EE rotation is checked against the log")

	log := storedLog(stored)
	if recorder.next.EscrowEntry != nil {
		log = append(log, *recorder.next.EscrowEntry)
	}

	return recorder.next.Check(log, vault.prevCommitment)
}

func TestRotateEpochChecksTheSignedRecordAgainstTheLog(t *testing.T) {
	type testCase struct {
		name string
		// mutate changes the vault's request; stored is the log the
		// store holds (the vault's log when nil).
		mutate func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry
		valid  bool
	}

	resign := func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest, signKey ed25519.PrivateKey, change func(*e2ee.EpochRecord)) {
		t.Helper()

		record := vault.log.Record(t, vault.ownerID, 3, request.GetNextEpoch().GetCommitment(), vault.prevCommitment)
		change(&record)

		signed, err := record.Sign(signKey)
		require.NoError(t, err)

		request.Record = logtest.RecordMessage(signed)
	}

	cases := []testCase{
		{name: "signed by an owner at the head", valid: true, mutate: func(*testing.T, *signedVault, *vaultsyncv1.RotateEpochRequest) []e2ee.Entry { return nil }},
		{name: "no record", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.Record = nil

			return nil
		}},
		{name: "signed by an editor", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			resign(t, vault, request, vault.log.SignKey(vault.editorID), func(*e2ee.EpochRecord) {})

			return nil
		}},
		{name: "signed by a key outside the log", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			_, stranger, err := ed25519.GenerateKey(rand.Reader)
			require.NoError(t, err)
			resign(t, vault, request, stranger, func(*e2ee.EpochRecord) {})

			return nil
		}},
		{name: "signature changed", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.Record.Signature[0] ^= 1

			return nil
		}},
		{name: "signed over another commitment", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.NextEpoch.Commitment = bytes.Repeat([]byte{6}, 32)

			return nil
		}},
		{name: "signed over another epoch", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.NextEpoch.ExpectedEpoch = 3

			return nil
		}},
		{name: "signed over another previous commitment", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			resign(t, vault, request, vault.log.SignKey(vault.ownerID), func(record *e2ee.EpochRecord) { record.PrevCommitment = bytes.Repeat([]byte{8}, 32) })

			return nil
		}},
		{name: "a recipient omitted", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			resign(t, vault, request, vault.log.SignKey(vault.ownerID), func(record *e2ee.EpochRecord) { record.Recipients = record.Recipients[:1] })
			request.NextEpoch.Slots = request.GetNextEpoch().GetSlots()[:1]

			return nil
		}},
		{name: "a recipient with another key than the log's", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			resign(t, vault, request, vault.log.SignKey(vault.ownerID), func(record *e2ee.EpochRecord) {
				record.Recipients[1].KeyHash = bytes.Repeat([]byte{1}, 32)
			})

			return nil
		}},
		{name: "an extra recipient", mutate: func(t *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			stranger := uuid.New()

			resign(t, vault, request, vault.log.SignKey(vault.ownerID), func(record *e2ee.EpochRecord) {
				record.Recipients = append(record.Recipients, e2ee.EpochRecipient{Kind: 0x01, ID: stranger[:], KeyHash: bytes.Repeat([]byte{1}, 32)})
			})

			return nil
		}},
		{name: "a log position the store does not have", mutate: func(t *testing.T, vault *signedVault, _ *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			t.Helper()

			return vault.log.Entries[:1]
		}},
		{name: "a log hash the store does not have", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.Record.LogHash = bytes.Repeat([]byte{3}, 32)

			return nil
		}},
		{name: "slots not the record's recipients", mutate: func(_ *testing.T, vault *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.NextEpoch.Slots[1] = vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, uuid.NewString())

			return nil
		}},
		{name: "a slot short of the record's recipients", mutate: func(_ *testing.T, _ *signedVault, request *vaultsyncv1.RotateEpochRequest) []e2ee.Entry {
			request.NextEpoch.Slots = request.GetNextEpoch().GetSlots()[:1]

			return nil
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			vault := newSignedVault(t)
			request := vault.request(t)

			stored := testCase.mutate(t, vault, request)
			if stored == nil {
				stored = vault.log.Entries
			}

			escrow, err := vault.check(t, request, stored)
			if testCase.valid {
				require.NoError(t, err)
				assert.False(t, escrow)

				return
			}

			require.ErrorIs(t, err, store.ErrEpochRecord)
			requireCode(t, connect.CodeInvalidArgument, api.KeyError(err))
		})
	}
}

func TestRotateEpochChecksTheEscrowEntryWithTheRecord(t *testing.T) {
	// escrowOn is vault's request turning escrow on (the owner's entry) with an escrow slot,
	// the record signed at the escrow entry, and the log the store holds.
	escrowOn := func(t *testing.T, vault *signedVault) (*vaultsyncv1.RotateEpochRequest, []e2ee.Entry) {
		t.Helper()

		stored := vault.log.Entries
		entry := vault.log.Escrow(t, vault.ownerID, vault.escrow)

		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(entry)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, vault.escrowKeyID))

		return request, stored
	}

	t.Run("an owner's escrow entry turns escrow on", func(t *testing.T) {
		vault := newSignedVault(t)
		request, stored := escrowOn(t, vault)

		escrow, err := vault.check(t, request, stored)
		require.NoError(t, err)
		assert.True(t, escrow)
	})

	t.Run("an editor's escrow entry is refused", func(t *testing.T) {
		vault := newSignedVault(t)
		request, stored := escrowOn(t, vault)

		// The same entry signed by the editor: its hash, which the record
		// names, does not cover the signatures.
		byEditor, err := vault.log.Entries[len(vault.log.Entries)-1].Sign(vault.log.SignKey(vault.editorID))
		require.NoError(t, err)

		request.EscrowEntry = logtest.EntryMessage(byEditor)

		_, err = vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})

	t.Run("a record before the escrow entry is refused", func(t *testing.T) {
		vault := newSignedVault(t)
		before := vault.log.Record(t, vault.ownerID, 3, bytes.Repeat([]byte{5}, 32), vault.prevCommitment)
		request, stored := escrowOn(t, vault)
		request.Record = logtest.RecordMessage(before)
		request.NextEpoch.Slots = request.GetNextEpoch().GetSlots()[:2]

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})

	t.Run("escrow on without an escrow slot is refused", func(t *testing.T) {
		vault := newSignedVault(t)
		request, stored := escrowOn(t, vault)
		request.NextEpoch.Slots = request.GetNextEpoch().GetSlots()[:2]

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})

	t.Run("an entry of another type is refused before the store", func(t *testing.T) {
		vault := newSignedVault(t)
		request, _ := escrowOn(t, vault)
		request.EscrowEntry.Type = uint32(e2ee.EntryRemoveMember)

		recorder := &keyRecorder{}
		service, ctx := keyService(recorder)

		_, err := service.RotateEpoch(ctx, connect.NewRequest(request))
		requireCode(t, connect.CodeInvalidArgument, err)
		assert.Zero(t, recorder.calls)
	})
}
