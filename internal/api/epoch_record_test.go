package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"slices"
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
	// rotations is the deployment's escrow chain the service is configured with.
	rotations []e2ee.EscrowRotation
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
		Escrow: api.Escrow{PublicKey: vault.escrowPublic, KeyID: vault.escrowKeyID, Bundle: vault.escrow, Rotations: vault.rotations},
	}
	ctx := authz.WithMembership(auth.WithUser(context.Background(), auth.User{ID: vault.ownerID}), authz.Membership{VaultID: vault.vaultID, Role: store.RoleOwner})

	_, err := service.RotateEpoch(ctx, connect.NewRequest(request))
	require.NoError(t, err)
	require.NotNil(t, recorder.next.Check, "an E2EE rotation is checked against the log")

	log := storedLog(stored)
	log = append(log, recorder.next.EscrowEntries...)

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

func TestRotateEpochMovesAnEscrowedVaultToTheNextKeyOfTheEscrowChain(t *testing.T) {
	// moved is a vault whose log names an older escrow key, the rotation
	// statement from it to the vault's current escrow key (signed by the
	// older key), and the owner's request moving the vault to the current
	// key: its escrow entry, an escrow slot for the current key and the
	// record signed at the entry, with the log the store holds.
	moved := func(t *testing.T) (*signedVault, *vaultsyncv1.RotateEpochRequest, []e2ee.Entry, e2ee.EscrowRotation) {
		t.Helper()

		vault := newSignedVault(t)

		_, oldPublic, err := e2ee.GenerateKeyPair()
		require.NoError(t, err)

		oldRecipient, err := e2ee.AgeRecipient(oldPublic)
		require.NoError(t, err)

		oldSignPub, oldSignKey, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)

		old := e2ee.EscrowBundle{SignPub: oldSignPub, Recipient: oldRecipient}
		vault.log.Escrow(t, vault.ownerID, &old)
		stored := vault.log.Entries

		rotation, err := e2ee.SignEscrowRotation(oldSignKey, old, *vault.escrow)
		require.NoError(t, err)

		vault.log.Rotations = []e2ee.EscrowRotation{rotation}
		entry := vault.log.Escrow(t, vault.ownerID, vault.escrow)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(entry)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, vault.escrowKeyID))

		return vault, request, stored, rotation
	}

	t.Run("with the escrow chain the entry and the epoch are accepted", func(t *testing.T) {
		vault, request, stored, rotation := moved(t)
		vault.rotations = []e2ee.EscrowRotation{rotation}

		escrow, err := vault.check(t, request, stored)
		require.NoError(t, err)
		assert.True(t, escrow)
	})

	t.Run("without a chained statement the new key is refused", func(t *testing.T) {
		vault, request, stored, _ := moved(t)

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})
}

// otherEscrowKey returns a fresh escrow bundle and its key id, which the
// deployment's escrow chain does not reach.
func otherEscrowKey(t *testing.T) (e2ee.EscrowBundle, string) {
	t.Helper()

	_, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(public)
	require.NoError(t, err)

	signPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	keyID, err := e2ee.EscrowKeyID(public)
	require.NoError(t, err)

	return e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}, keyID
}

// rotateEpoch sends request to RotateEpoch of vault's service and returns
// its error and whether the store was reached.
func (vault *signedVault) rotateEpoch(t *testing.T, request *vaultsyncv1.RotateEpochRequest) (bool, error) {
	t.Helper()

	recorder := &keyRecorder{}
	service := api.VaultKeyService{
		Keys:   func(uuid.UUID) api.VaultKeyStore { return recorder },
		Escrow: api.Escrow{PublicKey: vault.escrowPublic, KeyID: vault.escrowKeyID, Bundle: vault.escrow, Rotations: vault.rotations},
	}
	ctx := authz.WithMembership(auth.WithUser(t.Context(), auth.User{ID: vault.ownerID}), authz.Membership{VaultID: vault.vaultID, Role: store.RoleOwner})

	_, err := service.RotateEpoch(ctx, connect.NewRequest(request))

	return recorder.calls > 0, err
}

func TestRotateEpochWithAnEscrowResetEntry(t *testing.T) {
	escrowSlot := func(vault *signedVault, keyID string) *vaultsyncv1.KeySlot {
		return vault.slot(vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, keyID)
	}

	// escrowedToOld is a vault whose log names old, an escrow key that no
	// signed rotation leads from to the chain's head (vault.escrow), and
	// the log the store holds.
	escrowedToOld := func(t *testing.T) (*signedVault, e2ee.EscrowBundle, string, []e2ee.Entry) {
		t.Helper()

		vault := newSignedVault(t)
		old, oldKeyID := otherEscrowKey(t)
		vault.log.Escrow(t, vault.ownerID, &old)

		return vault, old, oldKeyID, slices.Clone(vault.log.Entries)
	}

	// adoption is the owner's request moving the vault from old to the
	// head: the escrow reset entry signed by signerID, a slot for the head
	// and the record signed at the entry.
	adoption := func(t *testing.T, vault *signedVault, signerID uuid.UUID, last e2ee.EscrowBundle) *vaultsyncv1.RotateEpochRequest {
		t.Helper()

		entry := vault.log.EscrowReset(t, signerID, last, *vault.escrow)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(entry)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		return request
	}

	t.Run("an owner's escrow reset entry with a rotation creates the epoch escrowed to the new key", func(t *testing.T) {
		vault, old, _, stored := escrowedToOld(t)
		request := adoption(t, vault, vault.ownerID, old)

		escrow, err := vault.check(t, request, stored)
		require.NoError(t, err)
		assert.True(t, escrow)
	})

	t.Run("an epoch of the adoption escrowed to the old key is refused", func(t *testing.T) {
		vault, old, oldKeyID, stored := escrowedToOld(t)
		request := adoption(t, vault, vault.ownerID, old)
		request.NextEpoch.Slots[2] = escrowSlot(vault, oldKeyID)

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})

	// forged is the owner's request with an escrow reset entry the log
	// replay must refuse; its record is signed before the entry, which the
	// replay reaches first.
	forged := func(t *testing.T, vault *signedVault, signerID uuid.UUID, last e2ee.EscrowBundle) *vaultsyncv1.RotateEpochRequest {
		t.Helper()

		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(vault.log.EscrowReset(t, signerID, last, *vault.escrow))
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		return request
	}

	t.Run("an escrow reset entry forged by a non-owner is refused with INVALID_ARGUMENT", func(t *testing.T) {
		vault, old, _, stored := escrowedToOld(t)

		_, err := vault.check(t, forged(t, vault, vault.editorID, old), stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
		require.ErrorContains(t, err, "membership log does not verify")
		requireCode(t, connect.CodeInvalidArgument, api.KeyError(err))
	})

	t.Run("an escrow reset entry naming another bundle than the log's last is refused with INVALID_ARGUMENT", func(t *testing.T) {
		vault, _, _, stored := escrowedToOld(t)
		elsewhere, _ := otherEscrowKey(t)

		_, err := vault.check(t, forged(t, vault, vault.ownerID, elsewhere), stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
		require.ErrorContains(t, err, "membership log does not verify")
		requireCode(t, connect.CodeInvalidArgument, api.KeyError(err))
	})

	t.Run("an escrow reset entry to a key that is not the chain's head gets ESCROW_NOT_CURRENT", func(t *testing.T) {
		vault, old, _, _ := escrowedToOld(t)
		other, otherKeyID := otherEscrowKey(t)
		entry := vault.log.EscrowReset(t, vault.ownerID, old, other)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(entry)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, otherKeyID))

		reached, err := vault.rotateEpoch(t, request)
		requireCode(t, connect.CodeFailedPrecondition, err)
		assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_ESCROW_NOT_CURRENT, api.ErrorReasonOf(err))
		assert.False(t, reached, "refused before the store")
	})

	t.Run("an escrow on entry naming a key that is not the chain's head gets ESCROW_NOT_CURRENT", func(t *testing.T) {
		vault := newSignedVault(t)
		other, otherKeyID := otherEscrowKey(t)
		entry := vault.log.Escrow(t, vault.ownerID, &other)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(entry)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, otherKeyID))

		reached, err := vault.rotateEpoch(t, request)
		requireCode(t, connect.CodeFailedPrecondition, err)
		assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_ESCROW_NOT_CURRENT, api.ErrorReasonOf(err))
		assert.False(t, reached, "refused before the store")
	})

	t.Run("until adoption a new epoch escrowed to the log's bundle is accepted", func(t *testing.T) {
		vault, _, oldKeyID, stored := escrowedToOld(t)
		request := vault.request(t)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, oldKeyID))

		escrow, err := vault.check(t, request, stored)
		require.NoError(t, err)
		assert.True(t, escrow)
	})

	t.Run("until adoption a new epoch escrowed to the chain's head is refused", func(t *testing.T) {
		vault, _, _, stored := escrowedToOld(t)
		request := vault.request(t)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
	})

	// offState is a vault that turned escrow off while its log named old,
	// and the owner's request turning it on again with the head: the escrow
	// reset entry, the escrow on entry, a slot for the head and the record
	// signed at the escrow on entry.
	offState := func(t *testing.T) (*signedVault, *vaultsyncv1.RotateEpochRequest, []e2ee.Entry) {
		t.Helper()

		vault, old, _, _ := escrowedToOld(t)
		vault.log.Escrow(t, vault.ownerID, nil)
		stored := slices.Clone(vault.log.Entries)

		reset := vault.log.EscrowReset(t, vault.ownerID, old, *vault.escrow)
		on := vault.log.Escrow(t, vault.ownerID, vault.escrow)
		request := vault.request(t)
		request.EscrowResetEntry = logtest.EntryMessage(reset)
		request.EscrowEntry = logtest.EntryMessage(on)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		return vault, request, stored
	}

	t.Run("with escrow off an escrow reset entry and an escrow on entry are appended with the epoch", func(t *testing.T) {
		vault, request, stored := offState(t)

		escrow, err := vault.check(t, request, stored)
		require.NoError(t, err)
		assert.True(t, escrow)
	})

	t.Run("with escrow off an escrow on entry to the head without the reset is refused", func(t *testing.T) {
		vault, _, _, _ := escrowedToOld(t)
		vault.log.Escrow(t, vault.ownerID, nil)
		stored := slices.Clone(vault.log.Entries)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(vault.log.Escrow(t, vault.ownerID, vault.escrow))
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
		require.ErrorContains(t, err, "membership log does not verify")
	})

	t.Run("with escrow off an escrow reset entry sent alone is refused", func(t *testing.T) {
		vault, old, _, _ := escrowedToOld(t)
		vault.log.Escrow(t, vault.ownerID, nil)
		stored := slices.Clone(vault.log.Entries)
		reset := vault.log.EscrowReset(t, vault.ownerID, old, *vault.escrow)
		request := vault.request(t)
		request.EscrowEntry = logtest.EntryMessage(reset)

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
		require.ErrorContains(t, err, "must come before the escrow on entry")
	})

	t.Run("with escrow on an escrow reset entry before an escrow on entry is refused", func(t *testing.T) {
		vault, old, _, stored := escrowedToOld(t)
		reset := vault.log.EscrowReset(t, vault.ownerID, old, *vault.escrow)
		on := vault.log.Escrow(t, vault.ownerID, vault.escrow)
		request := vault.request(t)
		request.EscrowResetEntry = logtest.EntryMessage(reset)
		request.EscrowEntry = logtest.EntryMessage(on)
		request.NextEpoch.Slots = append(request.NextEpoch.Slots, escrowSlot(vault, vault.escrowKeyID))

		_, err := vault.check(t, request, stored)
		require.ErrorIs(t, err, store.ErrEpochRecord)
		require.ErrorContains(t, err, "only for a vault with escrow off")
	})
}
