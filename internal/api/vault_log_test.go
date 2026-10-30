package api_test

import (
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
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// creatingStore records the vault CreateVault hands the store.
type creatingStore struct {
	recordingStore

	created *store.NewVault
	err     error
}

func (recorder *creatingStore) CreateVault(_ context.Context, _ uuid.UUID, vault store.NewVault, _ int) (store.Vault, error) {
	recorder.writes++
	recorder.created = &vault

	id := vault.ID
	if id == uuid.Nil {
		id = uuid.New()
	}

	return store.Vault{ID: id, Name: vault.Name, Encryption: vault.Encryption, Escrow: vault.Escrow, Role: store.RoleOwner}, recorder.err
}

// genesisEntry is the genesis of vaultID by userID, unsigned.
func genesisEntry(t *testing.T, vaultID, userID uuid.UUID, secret e2ee.UserSecret, escrow *e2ee.EscrowBundle) e2ee.Entry {
	t.Helper()

	bundle, err := secret.Bundle(userID.String())
	require.NoError(t, err)

	payload, err := e2ee.GenesisPayload(bundle, escrow)
	require.NoError(t, err)

	return e2ee.Entry{VaultID: vaultID.String(), Seq: 1, PrevHash: make([]byte, e2ee.HashSize), Type: e2ee.EntryGenesis, Payload: payload}
}

func logEntryProto(entry e2ee.Entry) *vaultsyncv1.LogEntry {
	return &vaultsyncv1.LogEntry{
		Seq: entry.Seq, PrevHash: entry.PrevHash, Type: uint32(entry.Type), Payload: entry.Payload, Signatures: entry.Signatures,
	}
}

func escrowBundle(t *testing.T) *e2ee.EscrowBundle {
	t.Helper()

	signPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	_, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(publicKey)
	require.NoError(t, err)

	return &e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}
}

// An E2EE CreateVault stores its vault only with a genesis entry that
// verifies as the first entry of that vault's log, by the caller, with
// escrow as requested; a plaintext CreateVault takes neither a vault id nor
// a genesis entry.
func TestCreateVaultVerifiesTheGenesisEntry(t *testing.T) {
	caller := auth.User{ID: uuid.Must(uuid.NewV7()), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}}
	vaultID := uuid.Must(uuid.NewV7())

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	other, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	escrow := escrowBundle(t)

	_, escrowKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	signed := func(entry e2ee.Entry, keys ...ed25519.PrivateKey) *vaultsyncv1.LogEntry {
		signedEntry, err := entry.Sign(keys...)
		require.NoError(t, err)

		return logEntryProto(signedEntry)
	}

	genesis := genesisEntry(t, vaultID, caller.ID, secret, nil)
	valid := signed(genesis, secret.SignKey())

	tampered := signed(genesis, secret.SignKey())
	tampered.Signatures[0][0] ^= 1

	secondEntry := genesis
	secondEntry.Seq = 2

	linked := genesis
	linked.PrevHash = make([]byte, e2ee.HashSize)
	linked.PrevHash[0] = 1

	encrypted := vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE
	none := vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE

	tests := []struct {
		name        string
		request     *vaultsyncv1.CreateVaultRequest
		storeErr    error
		wantCode    connect.Code
		wantReason  vaultsyncv1.ErrorReason
		wantGenesis bool
	}{
		{name: "signed genesis", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: valid}, wantGenesis: true},
		{
			name: "signed genesis with escrow", wantGenesis: true,
			request: &vaultsyncv1.CreateVaultRequest{
				Encryption: encrypted, Escrow: true, NewVaultId: vaultID.String(),
				Genesis: signed(genesisEntry(t, vaultID, caller.ID, secret, escrow), secret.SignKey()),
			},
		},
		{name: "missing genesis", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String()}, wantCode: connect.CodeInvalidArgument},
		{name: "missing vault id", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, Genesis: valid}, wantCode: connect.CodeInvalidArgument},
		{name: "nil vault id", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: uuid.Nil.String(), Genesis: valid}, wantCode: connect.CodeInvalidArgument},
		{name: "unsigned genesis", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: logEntryProto(genesis)}, wantCode: connect.CodeInvalidArgument},
		{name: "tampered signature", request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: tampered}, wantCode: connect.CodeInvalidArgument},
		{
			name: "signed by another key", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: signed(genesis, other.SignKey())},
		},
		{
			name: "signed twice", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: signed(genesis, secret.SignKey(), secret.SignKey())},
		},
		{
			name: "signed for another vault", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: uuid.Must(uuid.NewV7()).String(), Genesis: valid},
		},
		{
			name: "not the first entry", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: signed(secondEntry, secret.SignKey())},
		},
		{
			name: "linked to a previous entry", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: signed(linked, secret.SignKey())},
		},
		{
			name: "type byte out of range", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: func() *vaultsyncv1.LogEntry {
				entry := signed(genesis, secret.SignKey())
				entry.Type = 0x101

				return entry
			}()},
		},
		{
			name: "another user's genesis", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{
				Encryption: encrypted, NewVaultId: vaultID.String(),
				Genesis: signed(genesisEntry(t, vaultID, uuid.Must(uuid.NewV7()), secret, nil), secret.SignKey()),
			},
		},
		{
			name: "escrow requested, genesis without", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, Escrow: true, NewVaultId: vaultID.String(), Genesis: valid},
		},
		{
			name: "genesis with escrow, escrow not requested", wantCode: connect.CodeInvalidArgument,
			request: &vaultsyncv1.CreateVaultRequest{
				Encryption: encrypted, NewVaultId: vaultID.String(),
				Genesis: signed(genesisEntry(t, vaultID, caller.ID, secret, escrow), secret.SignKey()),
			},
		},
		{
			name: "genesis with an escrow key that is not the escrow chain's head", wantCode: connect.CodeFailedPrecondition,
			wantReason: vaultsyncv1.ErrorReason_ERROR_REASON_ESCROW_NOT_CURRENT,
			request: &vaultsyncv1.CreateVaultRequest{
				Encryption: encrypted, Escrow: true, NewVaultId: vaultID.String(),
				Genesis: signed(genesisEntry(t, vaultID, caller.ID, secret, escrowBundle(t)), secret.SignKey()),
			},
		},
		{
			name: "vault id taken", storeErr: store.ErrVaultExists, wantCode: connect.CodeAlreadyExists,
			request: &vaultsyncv1.CreateVaultRequest{Encryption: encrypted, NewVaultId: vaultID.String(), Genesis: valid},
		},
		{name: "plaintext", request: &vaultsyncv1.CreateVaultRequest{Encryption: none}},
		{name: "plaintext with a vault id", request: &vaultsyncv1.CreateVaultRequest{Encryption: none, NewVaultId: vaultID.String()}, wantCode: connect.CodeInvalidArgument},
		{name: "plaintext with a genesis", request: &vaultsyncv1.CreateVaultRequest{Encryption: none, Genesis: valid}, wantCode: connect.CodeInvalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &creatingStore{err: test.storeErr}
			service := api.VaultService{Vaults: recorder, Escrow: api.Escrow{PublicKey: escrowKey, Bundle: escrow}}

			test.request.Name = "Notes"

			response, err := service.CreateVault(auth.WithUser(t.Context(), caller), connect.NewRequest(test.request))
			if test.wantCode != 0 {
				requireCode(t, test.wantCode, err)
				assert.Equal(t, test.wantReason, api.ErrorReasonOf(err))

				if test.storeErr == nil {
					assert.Zero(t, recorder.writes, "refused before the store")
				}

				return
			}

			require.NoError(t, err)
			require.NotNil(t, recorder.created)

			if !test.wantGenesis {
				assert.Equal(t, uuid.Nil, recorder.created.ID, "the store chooses a plaintext vault's id")
				assert.Nil(t, recorder.created.Genesis)

				return
			}

			assert.Equal(t, vaultID, recorder.created.ID)
			assert.Equal(t, vaultID.String(), response.Msg.GetVault().GetId())
			require.NotNil(t, recorder.created.Genesis)
			assert.Equal(t, int64(1), recorder.created.Genesis.Seq)
			assert.Equal(t, byte(e2ee.EntryGenesis), recorder.created.Genesis.Type)
			assert.Equal(t, test.request.GetGenesis().GetPayload(), recorder.created.Genesis.Payload)
			assert.Equal(t, test.request.GetGenesis().GetSignatures(), recorder.created.Genesis.Signatures)
			assert.Equal(t, test.request.GetGenesis().GetPrevHash(), recorder.created.Genesis.PrevHash)
		})
	}
}

func TestListLogEntriesReturnsTheStoredEntries(t *testing.T) {
	recorder := &keyRecorder{listed: 2}
	service, ctx := keyService(recorder)

	response, err := service.ListLogEntries(ctx, connect.NewRequest(&vaultsyncv1.ListLogEntriesRequest{}))
	require.NoError(t, err)

	entries := response.Msg.GetEntries()
	require.Len(t, entries, 2)

	for index, entry := range entries {
		assert.Equal(t, uint64(index+1), entry.GetSeq()) //nolint:gosec // small test values.
		assert.Equal(t, uint32(e2ee.EntryGenesis), entry.GetType())
		assert.Equal(t, [][]byte{{byte(index + 1)}}, entry.GetSignatures())
	}
}
