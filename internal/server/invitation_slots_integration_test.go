//go:build integration

package server_test

import (
	"crypto/sha256"
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

// Invitations to E2EE vaults carry their key slots
// (docs/design/encryption.md, "Invitations").

// invitationSlotCount returns how many invitation key slots vaultID holds.
func (fixture *syncFixture) invitationSlotCount(t *testing.T, vaultID string) int {
	t.Helper()

	var count int

	require.NoError(t, fixture.pool.QueryRow(t.Context(),
		`SELECT count(*) FROM key_slots WHERE vault_id = $1 AND recipient_kind = 'invitation'`, vaultID).Scan(&count))

	return count
}

// encryptedVaultWithEpochs creates an E2EE vault owned by owner with the
// given number of epochs, each wrapped to owner.
func (fixture *syncFixture) encryptedVaultWithEpochs(t *testing.T, owner *keyedMember, epochs int) string {
	t.Helper()

	vaultID := fixture.e2eeVault(t, owner, false)

	for epoch := range epochs {
		key := make([]byte, e2ee.KeySize)
		key[0] = byte(epoch + 1)

		_, err := fixture.rotate(t, 0, owner, nextEpoch(t, vaultID, uint32(epoch), key, owner)) //nolint:gosec // small.
		require.NoError(t, err)
	}

	return vaultID
}

func TestCreatingAnEncryptedInvitationNeedsOneSlotPerEpochAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 2)
	keys := fixture.epochKeys(t, alice)
	members := fixture.members(0)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	other := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	slot := func(epoch uint32) *vaultsyncv1.KeySlot {
		return invitationSlot(t, vaultID, epoch, keys[epoch], invitation)
	}

	userSlot := sealedSlot(t, vaultID, 2, keys[2], alice)

	cases := map[string]struct {
		mutate func(*vaultsyncv1.CreateInvitationRequest)
		code   connect.Code
	}{
		"no keys at all": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.IdHash, request.Slots, request.InviteAnchor = nil, nil, nil
		}, code: connect.CodeInvalidArgument},
		"no slots": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.Slots = nil
		}, code: connect.CodeFailedPrecondition},
		"one epoch missing": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.Slots = []*vaultsyncv1.KeySlot{slot(1)}
		}, code: connect.CodeFailedPrecondition},
		"an epoch the vault does not have": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.Slots = []*vaultsyncv1.KeySlot{slot(1), slot(2), invitationSlot(t, vaultID, 3, keys[2], invitation)}
		}, code: connect.CodeInvalidArgument},
		"two slots for one epoch": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			duplicate := slot(2)
			duplicate.WrappedKey = slot(2).GetWrappedKey()
			request.Slots = []*vaultsyncv1.KeySlot{slot(1), slot(2), duplicate}
		}, code: connect.CodeInvalidArgument},
		"a slot for another invitation": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.Slots = []*vaultsyncv1.KeySlot{slot(1), invitationSlot(t, vaultID, 2, keys[2], other)}
		}, code: connect.CodeInvalidArgument},
		"a user slot": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.Slots = []*vaultsyncv1.KeySlot{slot(1), userSlot}
		}, code: connect.CodeInvalidArgument},
		"no id hash": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.IdHash = nil
		}, code: connect.CodeInvalidArgument},
		"no invite anchor": {mutate: func(request *vaultsyncv1.CreateInvitationRequest) {
			request.InviteAnchor = nil
		}, code: connect.CodeInvalidArgument},
	}

	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			request := fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation)
			test.mutate(request)

			_, err := members.CreateInvitation(t.Context(), authorized(request, alice.token))
			require.Error(t, err)
			assert.Equal(t, test.code, connect.CodeOf(err), err)
			assert.Zero(t, fixture.count(t, "vault_invitations", vaultID), "nothing is stored")
			assert.Zero(t, fixture.invitationSlotCount(t, vaultID))
		})
	}

	request := fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation)
	require.Len(t, request.GetSlots(), 2)

	response, err := members.CreateInvitation(t.Context(), authorized(request, alice.token))
	require.NoError(t, err)
	assert.Empty(t, response.Msg.GetCode(), "the inviting device made the code")
	assert.Equal(t, 2, fixture.invitationSlotCount(t, vaultID))

	// The server stores only SHA-256 of <id>'s bytes, never the secret.
	rawID, err := base64.RawURLEncoding.DecodeString(invitation.codeID)
	require.NoError(t, err)

	want := sha256.Sum256(rawID)

	var stored []byte

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT code_hash FROM vault_invitations WHERE id = $1`, invitation.id).Scan(&stored))
	assert.Equal(t, want[:], stored)

	// The same <id> cannot be used twice.
	again := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	againRequest := fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, again)
	againRequest.IdHash = invitation.idHash
	_, err = members.CreateInvitation(t.Context(), authorized(againRequest, alice.token))
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), err)
}

func TestPlaintextInvitationsTakeNoKeySlotsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	vaultID := fixture.createVault(t, alice.token, "Plain").GetId()

	_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
		VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR,
		IdHash: make([]byte, sha256.Size), InviteAnchor: make([]byte, api.InviteAnchorBytes),
	}, alice.token))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	assert.Zero(t, fixture.count(t, "vault_invitations", vaultID))

	invitation := fixture.mustInvite(t, alice.token, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	_, err = fixture.members(0).RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code:  invitation.GetCode(),
		Slots: []*vaultsyncv1.KeySlot{{Epoch: 1, RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER, RecipientId: bob.userID.String(), WrappedKey: []byte{1}}},
	}, bob.token))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID))
}

func TestTheHolderOfAnInvitationIDReadsItsSlotsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 2)
	members := fixture.members(0)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	request := fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, invitation)
	request.InviteAnchor = make([]byte, api.InviteAnchorBytes)
	request.InviteAnchor[0] = 7
	_, err := members.CreateInvitation(t.Context(), authorized(request, alice.token))
	require.NoError(t, err)

	response, err := members.GetInvitationSlots(t.Context(), authorized(&vaultsyncv1.GetInvitationSlotsRequest{Id: invitation.codeID}, bob.token))
	require.NoError(t, err)
	assert.Equal(t, invitation.id.String(), response.Msg.GetInvitationId())
	assert.Equal(t, vaultID, response.Msg.GetVaultId())
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, response.Msg.GetRole())
	assert.Equal(t, request.GetInviteAnchor(), response.Msg.GetInviteAnchor())
	require.Len(t, response.Msg.GetEpochs(), 2)
	require.Len(t, response.Msg.GetSlots(), 2)

	for index, slot := range response.Msg.GetSlots() {
		epoch := response.Msg.GetEpochs()[index]
		assert.Equal(t, uint32(index+1), slot.GetEpoch()) //nolint:gosec // small.
		assert.Equal(t, epoch.GetEpoch(), slot.GetEpoch())
		assert.NotNil(t, epoch.GetRecord(), "the signed record comes with the epoch")

		key, err := e2ee.OpenKeySlot(invitation.privateKey, slot.GetWrappedKey(), e2ee.KeySlot{
			VaultID: vaultID, Epoch: uint64(slot.GetEpoch()), RecipientKind: e2ee.RecipientInvitation, RecipientID: invitation.id.String(),
		})
		require.NoError(t, err)
		require.NoError(t, e2ee.VerifyKeyCommitment(key, epoch.GetCommitment(), vaultID, uint64(slot.GetEpoch())))
	}

	_, err = members.GetInvitationSlots(t.Context(), connect.NewRequest(&vaultsyncv1.GetInvitationSlotsRequest{Id: invitation.codeID}))
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), err)

	// Revoked, expired, used and unknown ids all get the same NOT_FOUND.
	notFound := func(t *testing.T, id string) {
		t.Helper()

		_, err := members.GetInvitationSlots(t.Context(), authorized(&vaultsyncv1.GetInvitationSlotsRequest{Id: id}, bob.token))
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

		var connectErr *connect.Error
		require.ErrorAs(t, err, &connectErr)
		assert.Equal(t, "invitation not found or no longer valid", connectErr.Message())
	}

	notFound(t, base64.RawURLEncoding.EncodeToString(make([]byte, 16)))
	notFound(t, "not-an-id")
	notFound(t, invitation.code)

	revoked := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	_, err = members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, revoked), alice.token))
	require.NoError(t, err)
	_, err = members.RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: vaultID, InvitationId: revoked.id.String(), LogEntry: fixture.idEntry(t, alice, e2ee.EntryRevokeInvitation, revoked.id, alice),
	}, alice.token))
	require.NoError(t, err)
	notFound(t, revoked.codeID)

	expired := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	_, err = members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, expired), alice.token))
	require.NoError(t, err)
	_, err = fixture.pool.Exec(t.Context(), `UPDATE vault_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, expired.id)
	require.NoError(t, err)
	notFound(t, expired.codeID)

	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: fixture.redeemSlots(t, bob, invitation),
	}, bob.token))
	require.NoError(t, err)
	notFound(t, invitation.codeID)
}

func TestRedeemingStoresTheNewcomersSlotsAndDeletesTheInvitationsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 2)
	members := fixture.members(0)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err := members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation), alice.token))
	require.NoError(t, err)

	own := fixture.redeemSlots(t, bob, invitation)
	require.Len(t, own, 2)

	keys := fixture.epochKeys(t, alice)
	before := fixture.membershipSnapshot(t, vaultID)

	cases := map[string][]*vaultsyncv1.KeySlot{
		"no slots":                         nil,
		"one epoch missing":                own[:1],
		"a slot for another member":        {own[0], sealedSlot(t, vaultID, 2, keys[2], carol)},
		"an extra slot for another member": {own[0], own[1], sealedSlot(t, vaultID, 2, keys[2], carol)},
		"an epoch the vault does not have": {own[0], own[1], sealedSlot(t, vaultID, 3, keys[2], bob)},
	}

	for name, slots := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
				Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: slots,
			}, bob.token))
			require.Error(t, err)
			assert.Contains(t, []connect.Code{connect.CodeInvalidArgument, connect.CodeFailedPrecondition}, connect.CodeOf(err), err)
			assert.Equal(t, before, fixture.membershipSnapshot(t, vaultID), "the refusal changes nothing")
			assert.Equal(t, 2, fixture.invitationSlotCount(t, vaultID), "the invitation keeps its slots")
			assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID))
		})
	}

	// A user without a user key cannot redeem: they could not read the vault.
	dave := fixture.client(t, "dave", "")
	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: own,
	}, dave.token))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	assert.ErrorContains(t, err, "needs a user key", "refused for lacking a user key, before its slots are looked at")
	assert.Equal(t, before, fixture.membershipSnapshot(t, vaultID))

	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: own,
	}, bob.token))
	require.NoError(t, err)

	bob.vaultID = vaultID
	stored := fixture.ownSlots(t, bob)
	require.Len(t, stored, 2)

	for index, slot := range stored {
		assert.Equal(t, own[index].GetEpoch(), slot.GetEpoch())
		assert.Equal(t, own[index].GetWrappedKey(), slot.GetWrappedKey())
		assert.Equal(t, keys[slot.GetEpoch()], fixture.openSlot(t, bob, slot))
	}

	assert.Zero(t, fixture.invitationSlotCount(t, vaultID), "the invitation's slots are deleted")
	assert.Empty(t, fixture.missingSlots(t, alice), "the newcomer lacks no slot")
}

func TestARotationSinceReadingTheSlotsRefusesTheRedemptionAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 1)
	members := fixture.members(0)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err := members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation), alice.token))
	require.NoError(t, err)

	own := fixture.redeemSlots(t, bob, invitation)

	// A new epoch must include the pending invitation.
	key := make([]byte, e2ee.KeySize)
	key[0] = 9
	withoutInvitation := nextEpoch(t, vaultID, 1, key, alice)
	_, err = fixture.rotate(t, 0, alice, withoutInvitation)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	assert.Len(t, fixture.epochs(t, alice).GetEpochs(), 1)

	withInvitation := nextEpoch(t, vaultID, 1, key, alice)
	slot := invitationSlot(t, vaultID, 2, key, invitation)
	slot.Epoch = 0
	withInvitation.Slots = append(withInvitation.Slots, slot)
	_, err = fixture.rotate(t, 0, alice, withInvitation)
	require.NoError(t, err)
	assert.Equal(t, 2, fixture.invitationSlotCount(t, vaultID))

	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: own,
	}, bob.token))
	requireEpochNotCurrent(t, err)

	// Reading the slots again covers the new epoch.
	_, err = members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, alice, bob, invitation), Slots: fixture.redeemSlots(t, bob, invitation),
	}, bob.token))
	require.NoError(t, err)

	bob.vaultID = vaultID
	assert.Equal(t, key, fixture.openSlot(t, bob, fixture.ownSlots(t, bob)[1]))
}

func TestRevokedAndExpiredInvitationsLoseTheirSlotsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 2)
	members := fixture.members(0)

	revoked := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err := members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, revoked), alice.token))
	require.NoError(t, err)

	expired := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err = members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, expired), alice.token))
	require.NoError(t, err)
	assert.Equal(t, 4, fixture.invitationSlotCount(t, vaultID))

	_, err = members.RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: vaultID, InvitationId: revoked.id.String(), LogEntry: fixture.idEntry(t, alice, e2ee.EntryRevokeInvitation, revoked.id, alice),
	}, alice.token))
	require.NoError(t, err)
	assert.Equal(t, 2, fixture.invitationSlotCount(t, vaultID), "the revoked invitation's slots are deleted")

	// An expired invitation's slots are unreachable at once, and the prune
	// on the vault's next invitation deletes them.
	_, err = fixture.pool.Exec(t.Context(), `UPDATE vault_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, expired.id)
	require.NoError(t, err)

	_, err = members.GetInvitationSlots(t.Context(), authorized(&vaultsyncv1.GetInvitationSlotsRequest{Id: expired.codeID}, alice.token))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

	next := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err = members.CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, next), alice.token))
	require.NoError(t, err)

	var remaining []string

	rows, err := fixture.pool.Query(t.Context(), `SELECT DISTINCT recipient_id FROM key_slots WHERE vault_id = $1 AND recipient_kind = 'invitation'`, vaultID)
	require.NoError(t, err)

	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		remaining = append(remaining, id)
	}

	require.NoError(t, rows.Err())
	assert.Equal(t, []string{next.id.String()}, remaining, "only the pending invitation keeps slots")
}

func TestInvitationSlotProceduresEnforceRolesAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	viewer := fixture.keyedMember(t, "viewer")
	outsider := fixture.keyedMember(t, "outsider")
	vaultID := fixture.encryptedVaultWithEpochs(t, alice, 1)
	fixture.join(t, alice, viewer, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	request := fixture.inviteRequest(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation)

	for caller, code := range map[*keyedMember]connect.Code{viewer: connect.CodePermissionDenied, outsider: connect.CodeNotFound} {
		_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(proto.Clone(request).(*vaultsyncv1.CreateInvitationRequest), caller.token))
		require.Error(t, err)
		assert.Equal(t, code, connect.CodeOf(err), err)
	}

	assert.Zero(t, fixture.count(t, "vault_invitations", vaultID))

	// Invitation slots are never listed through the members' key slots.
	_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(request, alice.token))
	require.NoError(t, err)

	_, err = fixture.vaultKeys(0).ListKeySlots(t.Context(), authorized(&vaultsyncv1.ListKeySlotsRequest{
		VaultId: vaultID, RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_INVITATION,
	}, alice.token))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)

	// AddKeySlots does not take invitation slots.
	_, err = fixture.vaultKeys(0).AddKeySlots(t.Context(), authorized(&vaultsyncv1.AddKeySlotsRequest{
		VaultId: vaultID, Slots: []*vaultsyncv1.KeySlot{{
			Epoch: 1, RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_INVITATION,
			RecipientId: uuid.Must(uuid.NewV7()).String(), WrappedKey: []byte{1},
		}},
	}, alice.token))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
}
