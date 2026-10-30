//go:build integration

package server_test

import (
	"encoding/base64"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
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

// invitedLogEntries lists vaultID's log as caller, holding invitationID.
func (fixture *syncFixture) invitedLogEntries(t *testing.T, caller *keyedMember, vaultID, invitationID string, pageSize uint32, token string) (*vaultsyncv1.ListLogEntriesResponse, error) {
	t.Helper()

	response, err := fixture.vaultKeys(1).ListLogEntries(t.Context(), authorized(&vaultsyncv1.ListLogEntriesRequest{
		VaultId: vaultID, InvitationId: invitationID, PageSize: pageSize, PageToken: token,
	}, caller.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// A non-member holding the <id> of a pending invitation reads the vault's
// log, in the members' pages; every id that is not pending for that vault
// gets GetInvitationSlots's NOT_FOUND.
func TestTheHolderOfAnInvitationIDReadsTheLogAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 1)
	otherVaultID := fixture.encryptedVaultWithEpochs(t, alice, 1)
	members := fixture.members(0)

	invite := func(t *testing.T) signedInvitation {
		t.Helper()

		invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
		_, err := members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation), alice.token))
		require.NoError(t, err)

		return invitation
	}

	alice.vaultID = vaultID
	invitation := invite(t)
	anotherInvitation := invite(t)

	memberLog, err := fixture.logEntries(t, alice, 0, "")
	require.NoError(t, err)
	require.Len(t, memberLog.GetEntries(), 3, "genesis and two invites")

	invited, err := fixture.invitedLogEntries(t, bob, vaultID, invitation.codeID, 0, "")
	require.NoError(t, err)
	assert.True(t, proto.Equal(memberLog, invited), "the holder reads what a member reads")

	// The members' pagination: a page of one, then the rest.
	first, err := fixture.invitedLogEntries(t, bob, vaultID, invitation.codeID, 1, "")
	require.NoError(t, err)
	require.Len(t, first.GetEntries(), 1)
	require.NotEmpty(t, first.GetNextPageToken())
	rest, err := fixture.invitedLogEntries(t, bob, vaultID, invitation.codeID, 1000, first.GetNextPageToken())
	require.NoError(t, err)
	require.Len(t, rest.GetEntries(), 2)
	assert.Empty(t, rest.GetNextPageToken())
	assert.Equal(t, uint64(2), rest.GetEntries()[0].GetSeq())

	// Anonymous callers are refused, the id notwithstanding.
	_, err = fixture.vaultKeys(1).ListLogEntries(t.Context(), connect.NewRequest(&vaultsyncv1.ListLogEntriesRequest{
		VaultId: vaultID, InvitationId: invitation.codeID,
	}))
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), err)

	// Without an id a non-member is refused as before.
	_, err = fixture.invitedLogEntries(t, bob, vaultID, "", 0, "")
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

	notFound := func(t *testing.T, vaultID, id string) {
		t.Helper()

		_, err := fixture.invitedLogEntries(t, bob, vaultID, id, 0, "")
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

		var connectErr *connect.Error
		require.ErrorAs(t, err, &connectErr)
		assert.Equal(t, "invitation not found or no longer valid", connectErr.Message())

		// GetInvitationSlots refuses the same ids with the same error.
		if vaultID == otherVaultID {
			return
		}

		_, slotsErr := members.GetInvitationSlots(t.Context(), authorized(&vaultsyncv1.GetInvitationSlotsRequest{Id: id}, bob.token))

		var slotsConnectErr *connect.Error
		require.ErrorAs(t, slotsErr, &slotsConnectErr)
		assert.Equal(t, slotsConnectErr.Code(), connectErr.Code())
		assert.Equal(t, slotsConnectErr.Message(), connectErr.Message())
	}

	notFound(t, vaultID, base64.RawURLEncoding.EncodeToString(make([]byte, 16)))
	notFound(t, vaultID, "not-an-id")
	notFound(t, vaultID, invitation.code)
	notFound(t, otherVaultID, invitation.codeID)

	revoked := invite(t)
	_, err = members.RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: vaultID, InvitationId: revoked.id.String(), LogEntry: fixture.idEntry(t, alice, e2ee.EntryRevokeInvitation, revoked.id, alice),
	}, alice.token))
	require.NoError(t, err)
	notFound(t, vaultID, revoked.codeID)

	expired := invite(t)
	_, err = fixture.pool.Exec(t.Context(), `UPDATE vault_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, expired.id)
	require.NoError(t, err)
	notFound(t, vaultID, expired.codeID)

	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: fixture.redeemSlots(t, bob, invitation),
	}, bob.token))
	require.NoError(t, err)

	// Bob is a member now: the redeemed id is ignored, not refused.
	bob.vaultID = vaultID
	_, err = fixture.invitedLogEntries(t, bob, vaultID, invitation.codeID, 0, "")
	require.NoError(t, err)

	carol := fixture.keyedMember(t, "carol")
	_, err = fixture.invitedLogEntries(t, carol, vaultID, invitation.codeID, 0, "")
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err, "a redeemed id")
	_, err = fixture.invitedLogEntries(t, carol, vaultID, anotherInvitation.codeID, 0, "")
	require.NoError(t, err, "the other pending invitation still reads")
}
