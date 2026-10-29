//go:build integration

package server_test

import (
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

func (fixture *syncFixture) logEntries(t *testing.T, caller *keyedMember, pageSize uint32, token string) (*vaultsyncv1.ListLogEntriesResponse, error) {
	t.Helper()

	response, err := fixture.vaultKeys(1).ListLogEntries(t.Context(), authorized(&vaultsyncv1.ListLogEntriesRequest{
		VaultId: caller.vaultID, PageSize: pageSize, PageToken: token,
	}, caller.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *syncFixture) vaultCount(t *testing.T) int {
	t.Helper()

	var count int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM vaults`).Scan(&count))

	return count
}

// An E2EE CreateVault whose genesis entry is missing or does not verify is
// refused, and no vault (and no log entry) is created.
func TestCreateVaultRefusesAMissingOrBadlySignedGenesisAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")

	missing := e2eeCreateRequest(t, "Secret", alice.userID, nil)
	missing.Genesis = nil

	tampered := e2eeCreateRequest(t, "Secret", alice.userID, nil)
	tampered.Genesis.Signatures[0][0] ^= 1

	otherVault := e2eeCreateRequest(t, "Secret", alice.userID, nil)
	otherVault.NewVaultId = uuid.Must(uuid.NewV7()).String()

	tests := map[string]*vaultsyncv1.CreateVaultRequest{
		"missing genesis":          missing,
		"tampered signature":       tampered,
		"signed for another vault": otherVault,
		"another user's genesis":   e2eeCreateRequest(t, "Secret", uuid.Must(uuid.NewV7()), nil),
	}

	for name, request := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(request, alice.token))
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
		})
	}

	assert.Zero(t, fixture.vaultCount(t), "no vault is created")
	assert.Empty(t, fixture.listVaults(t, alice.token))

	var entries int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM vault_log_entries`).Scan(&entries))
	assert.Zero(t, entries, "no log entry is stored")
}

// A member lists the vault's log in seq order and in bounded pages; a
// non-member is refused. The created vault has the id its genesis was signed
// over, and the genesis entry comes back exactly as signed.
func TestListLogEntriesPagesTheLogForMembersOnlyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	viewer := fixture.keyedMember(t, "viewer")
	outsider := fixture.keyedMember(t, "outsider")

	request := e2eeCreateRequest(t, "Secret", alice.userID, nil)
	request.Genesis = alice.genesis(t, request.GetNewVaultId())
	response, err := fixture.vaultClient().CreateVault(t.Context(), authorized(request, alice.token))
	require.NoError(t, err)
	require.Equal(t, request.GetNewVaultId(), response.Msg.GetVault().GetId(), "the vault has the id the genesis signs")

	alice.vaultID = response.Msg.GetVault().GetId()
	fixture.join(t, alice, viewer, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	outsider.vaultID = alice.vaultID

	_, err = fixture.logEntries(t, outsider, 0, "")
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "a non-member is refused")

	page, err := fixture.logEntries(t, viewer, 0, "")
	require.NoError(t, err)
	require.Len(t, page.GetEntries(), 3, "the genesis, then the viewer's invite and redeem entries")
	assert.True(t, proto.Equal(request.GetGenesis(), page.GetEntries()[0]), "the genesis is stored as signed")
	assert.Empty(t, page.GetNextPageToken())

	// The listing pages through whatever the log holds, in seq order.
	for seq := 4; seq <= 5; seq++ {
		_, err := fixture.pool.Exec(t.Context(), `
			INSERT INTO vault_log_entries (vault_id, seq, prev_hash, entry_type, payload, signatures)
			VALUES ($1, $2, $3, 2, $4, $5)`,
			alice.vaultID, seq, make([]byte, 32), []byte{byte(seq)}, [][]byte{make([]byte, 64)})
		require.NoError(t, err)
	}

	var (
		seqs  []uint64
		token string
		pages int
	)

	// Bounded, so a cursor that does not advance fails instead of hanging.
	for range 10 {
		page, err := fixture.logEntries(t, alice, 2, token)
		require.NoError(t, err)
		assert.LessOrEqual(t, len(page.GetEntries()), 2, "a page holds at most page_size entries")

		pages++

		for _, entry := range page.GetEntries() {
			seqs = append(seqs, entry.GetSeq())
		}

		token = page.GetNextPageToken()
		if token == "" {
			break
		}
	}

	assert.Empty(t, token, "the listing ends")
	assert.Equal(t, []uint64{1, 2, 3, 4, 5}, seqs)
	assert.Equal(t, 3, pages)
}

// A plaintext vault is created as before, without a log.
func TestCreateVaultPlaintextHasNoLogAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")

	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()

	page, err := fixture.logEntries(t, alice, 0, "")
	require.NoError(t, err)
	assert.Empty(t, page.GetEntries())
	assert.Zero(t, fixture.count(t, "vault_log_entries", alice.vaultID))
}

// A new vault id that names an existing vault is refused, and the existing
// vault and its log are untouched.
func TestCreateVaultRefusesATakenVaultIDAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")

	first := e2eeCreateRequest(t, "Secret", alice.userID, nil)
	_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(first, alice.token))
	require.NoError(t, err)

	second := e2eeCreateRequest(t, "Mine now", bob.userID, nil)
	second.NewVaultId = first.GetNewVaultId()
	second.Genesis = signedGenesis(t, uuid.MustParse(first.GetNewVaultId()), bob.userID, nil)

	_, err = fixture.vaultClient().CreateVault(t.Context(), authorized(second, bob.token))
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), err)
	assert.Empty(t, fixture.listVaults(t, bob.token))

	alice.vaultID = first.GetNewVaultId()
	page, err := fixture.logEntries(t, alice, 0, "")
	require.NoError(t, err)
	require.Len(t, page.GetEntries(), 1)
	assert.True(t, proto.Equal(first.GetGenesis(), page.GetEntries()[0]))
}
