//go:build integration

package server_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// membershipSnapshot is what a membership change of vaultID can change: its
// members and roles, its invitations, its epoch and its log.
func (fixture *syncFixture) membershipSnapshot(t *testing.T, vaultID string) string {
	t.Helper()

	var snapshot string

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `
		SELECT concat_ws(' | ',
			(SELECT string_agg(user_id::text || '=' || role, ',' ORDER BY user_id) FROM vault_members WHERE vault_id = $1),
			(SELECT string_agg(id::text, ',' ORDER BY id) FROM vault_invitations WHERE vault_id = $1),
			(SELECT current_epoch::text || ',' || rotation_pending::text FROM vaults WHERE id = $1),
			(SELECT count(*)::text FROM vault_log_entries WHERE vault_id = $1))`, vaultID).Scan(&snapshot))

	return snapshot
}

// staleEntry is an entry at the seq of the head of lister's vault log, on
// top of the entry before it: correctly signed, but not the next one.
func (fixture *syncFixture) staleEntry(t *testing.T, lister *keyedMember, entryType e2ee.EntryType, payload []byte, keys ...ed25519.PrivateKey) *vaultsyncv1.LogEntry {
	t.Helper()

	entries := fixture.vaultLog(t, lister)
	require.GreaterOrEqual(t, len(entries), 2)

	prevHash, err := logEntryOf(lister.vaultID, entries[len(entries)-2]).Hash()
	require.NoError(t, err)

	return signedEntry(t, lister.vaultID, entries[len(entries)-1].GetSeq(), prevHash, entryType, payload, keys...)
}

// logChange is one membership change of an E2EE vault and its entry.
type logChange struct {
	lister    *keyedMember
	entryType e2ee.EntryType
	payload   []byte
	// keys sign the valid entry; wrongKeys are a signer without the right.
	keys, wrongKeys []ed25519.PrivateKey
	call            func(entry *vaultsyncv1.LogEntry) error
}

// requireRefusalsThenAccept checks that change is refused without an entry,
// with a bad signature, with the wrong signer and with a stale seq (as a
// retryable conflict), each time changing nothing; then that its valid
// entry is accepted and appended.
func (fixture *syncFixture) requireRefusalsThenAccept(t *testing.T, change logChange) {
	t.Helper()

	vaultID := change.lister.vaultID
	before := fixture.membershipSnapshot(t, vaultID)

	badSignature := fixture.nextEntry(t, change.lister, change.entryType, change.payload, change.keys...)
	badSignature.Signatures[len(badSignature.GetSignatures())-1][0] ^= 1

	refusals := []struct {
		name  string
		entry *vaultsyncv1.LogEntry
		code  connect.Code
	}{
		{"no entry", nil, connect.CodeInvalidArgument},
		{"a bad signature", badSignature, connect.CodeInvalidArgument},
		{"the wrong signer", fixture.nextEntry(t, change.lister, change.entryType, change.payload, change.wrongKeys...), connect.CodeInvalidArgument},
		{"a stale seq", fixture.staleEntry(t, change.lister, change.entryType, change.payload, change.keys...), connect.CodeAborted},
	}

	for _, refusal := range refusals {
		err := change.call(refusal.entry)
		require.Error(t, err, refusal.name)
		assert.Equal(t, refusal.code, connect.CodeOf(err), "%s: %v", refusal.name, err)
		assert.Equal(t, before, fixture.membershipSnapshot(t, vaultID), "%s: nothing changes", refusal.name)
	}

	valid := fixture.nextEntry(t, change.lister, change.entryType, change.payload, change.keys...)
	require.NoError(t, change.call(valid))

	entries := fixture.vaultLog(t, change.lister)
	assert.True(t, proto.Equal(valid, entries[len(entries)-1]), "the entry is appended as signed")
}

// Every membership change of an E2EE vault carries its entry: one with a
// bad signature, the wrong signer or a stale seq is refused and nothing
// changes; the valid one is applied and appended.
func TestMembershipChangesRefuseEntriesThatDoNotVerifyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")
	dave := fixture.keyedMember(t, "dave")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	fixture.join(t, alice, dave, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	first, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, vaultID, 0, first, alice, bob, dave))
	require.NoError(t, err)

	members := fixture.members(0)
	owner, editor := []ed25519.PrivateKey{alice.secret.SignKey()}, []ed25519.PrivateKey{bob.secret.SignKey()}

	// CreateInvitation, for carol.
	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	var code string

	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntryInvite, payload: invitation.entry.GetPayload(), keys: owner, wrongKeys: editor,
		call: func(entry *vaultsyncv1.LogEntry) error {
			response, err := members.CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
				VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, LogEntry: entry,
			}, alice.token))
			if err == nil {
				code = response.Msg.GetCode()
				assert.Equal(t, invitation.id.String(), response.Msg.GetInvitation().GetId(), "the invitation has its entry's id")
			}

			return err
		},
	})

	// RedeemInvitation, by carol.
	bundle, err := carol.secret.Bundle(carol.userID.String())
	require.NoError(t, err)

	redeemPayload, err := e2ee.RedeemPayload(invitation.id.String(), bundle)
	require.NoError(t, err)

	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntryRedeem, payload: redeemPayload,
		keys:      []ed25519.PrivateKey{invitation.signKey, carol.secret.SignKey()},
		wrongKeys: []ed25519.PrivateKey{carol.secret.SignKey(), carol.secret.SignKey()},
		call: func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{Code: code, LogEntry: entry}, carol.token))

			return err
		},
	})
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, fixture.roleIn(t, carol.token, vaultID))

	// RevokeInvitation.
	revoked := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err = members.CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
		VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, LogEntry: revoked.entry,
	}, alice.token))
	require.NoError(t, err)

	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntryRevokeInvitation, payload: revoked.id[:], keys: owner, wrongKeys: editor,
		call: func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
				VaultId: vaultID, InvitationId: revoked.id.String(), LogEntry: entry,
			}, alice.token))

			return err
		},
	})

	// UpdateMemberRole: bob becomes a viewer.
	setRole, err := e2ee.SetRolePayload(bob.userID.String(), e2ee.RoleViewer)
	require.NoError(t, err)

	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntrySetRole, payload: setRole, keys: owner, wrongKeys: editor,
		call: func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
				VaultId: vaultID, UserId: bob.userID.String(), Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, LogEntry: entry,
			}, alice.token))

			return err
		},
	})
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, fixture.roleIn(t, bob.token, vaultID))

	// RemoveMember: dave, with the next epoch.
	second, err := e2ee.GenerateKey()
	require.NoError(t, err)

	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntryRemoveMember, payload: dave.userID[:], keys: owner, wrongKeys: editor,
		call: func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RemoveMember(t.Context(), authorized(&vaultsyncv1.RemoveMemberRequest{
				VaultId: vaultID, UserId: dave.userID.String(), NextEpoch: nextEpoch(t, vaultID, 1, second, alice, bob, carol), LogEntry: entry,
			}, alice.token))

			return err
		},
	})
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, dave.token, vaultID))

	// LeaveVault: bob leaves; only bob may sign it.
	fixture.requireRefusalsThenAccept(t, logChange{
		lister: alice, entryType: e2ee.EntryLeave, payload: bob.userID[:], keys: editor, wrongKeys: owner,
		call: func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.LeaveVault(t.Context(), authorized(&vaultsyncv1.LeaveVaultRequest{VaultId: vaultID, LogEntry: entry}, bob.token))

			return err
		},
	})
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID))
}

// An entry must record the requested change: a valid entry for another
// change is refused and nothing changes.
func TestMembershipChangesRefuseAnEntryForAnotherChangeAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	before := fixture.membershipSnapshot(t, vaultID)

	ownerRole, err := e2ee.SetRolePayload(bob.userID.String(), e2ee.RoleOwner)
	require.NoError(t, err)

	invitation := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	cases := map[string]func() error{
		"a set-role entry for another role": func() error {
			_, err := fixture.members(0).UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
				VaultId: vaultID, UserId: bob.userID.String(), Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER,
				LogEntry: fixture.nextEntry(t, alice, e2ee.EntrySetRole, ownerRole, alice.secret.SignKey()),
			}, alice.token))

			return err
		},
		"an invite entry for another role": func() error {
			_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
				VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, LogEntry: invitation.entry,
			}, alice.token))

			return err
		},
		"a set-role entry as a remove-member entry": func() error {
			_, err := fixture.members(0).LeaveVault(t.Context(), authorized(&vaultsyncv1.LeaveVaultRequest{
				VaultId: vaultID, LogEntry: fixture.nextEntry(t, alice, e2ee.EntrySetRole, ownerRole, bob.secret.SignKey()),
			}, bob.token))

			return err
		},
	}

	for name, call := range cases {
		err := call()
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%s: %v", name, err)
		assert.Equal(t, before, fixture.membershipSnapshot(t, vaultID), "%s: nothing changes", name)
	}
}

// Of two concurrent appends at the same seq, exactly one lands; the other
// gets a retryable conflict and changes nothing.
func TestConcurrentLogAppendsLandExactlyOnceAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")

	vaultID := fixture.e2eeVault(t, alice, false)

	const racers = 2

	invitations := make([]signedInvitation, racers)
	for index := range invitations {
		invitations[index] = fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	}

	require.Equal(t, invitations[0].entry.GetSeq(), invitations[1].entry.GetSeq(), "both append at the same seq")

	errs := make([]error, racers)

	var group sync.WaitGroup

	for index, invitation := range invitations {
		group.Go(func() {
			_, errs[index] = fixture.members(index).CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
				VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, LogEntry: invitation.entry,
			}, alice.token))
		})
	}

	group.Wait()

	landed := -1

	for index, err := range errs {
		if err == nil {
			assert.Equal(t, -1, landed, "only one append lands")

			landed = index

			continue
		}

		assert.Equal(t, connect.CodeAborted, connect.CodeOf(err), err)
	}

	require.NotEqual(t, -1, landed, "one append lands")

	entries := fixture.vaultLog(t, alice)
	require.Len(t, entries, 2)
	assert.True(t, proto.Equal(invitations[landed].entry, entries[1]))
	assert.Equal(t, 1, fixture.count(t, "vault_invitations", vaultID))

	// The loser retries on top of the winner.
	retried := fixture.signedInvitation(t, alice, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
		VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, LogEntry: retried.entry,
	}, alice.token))
	require.NoError(t, err)
}

// A plaintext vault has no log: its membership changes work without an
// entry, as before, and one carrying an entry is refused and changes
// nothing.
func TestPlaintextMembershipChangesTakeNoLogEntryAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")

	vaultID := fixture.createVault(t, alice.token, "Plain").GetId()
	alice.vaultID = vaultID
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	pending := fixture.mustInvite(t, alice.token, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	revocable := fixture.mustInvite(t, alice.token, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	signPub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	entry := signedEntry(t, vaultID, 2, make([]byte, e2ee.HashSize), e2ee.EntryRemoveMember, signPub[:16], alice.secret.SignKey())
	members := fixture.members(0)
	before := fixture.membershipSnapshot(t, vaultID)

	calls := map[string]func(*vaultsyncv1.LogEntry) error{
		"CreateInvitation": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{VaultId: vaultID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, LogEntry: entry}, alice.token))

			return err
		},
		"RevokeInvitation": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{VaultId: vaultID, InvitationId: revocable.GetInvitation().GetId(), LogEntry: entry}, alice.token))

			return err
		},
		"RedeemInvitation": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{Code: pending.GetCode(), LogEntry: entry}, carol.token))

			return err
		},
		"UpdateMemberRole": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{VaultId: vaultID, UserId: bob.userID.String(), Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, LogEntry: entry}, alice.token))

			return err
		},
		"RemoveMember": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.RemoveMember(t.Context(), authorized(&vaultsyncv1.RemoveMemberRequest{VaultId: vaultID, UserId: bob.userID.String(), LogEntry: entry}, alice.token))

			return err
		},
		"LeaveVault": func(entry *vaultsyncv1.LogEntry) error {
			_, err := members.LeaveVault(t.Context(), authorized(&vaultsyncv1.LeaveVaultRequest{VaultId: vaultID, LogEntry: entry}, bob.token))

			return err
		},
	}

	for name, call := range calls {
		err := call(entry)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%s: %v", name, err)
		assert.Equal(t, before, fixture.membershipSnapshot(t, vaultID), "%s: nothing changes", name)
	}

	// Without an entry, each works as before.
	for _, name := range []string{"CreateInvitation", "RedeemInvitation", "UpdateMemberRole", "RevokeInvitation", "RemoveMember"} {
		require.NoError(t, calls[name](nil), name)
	}

	assert.Zero(t, fixture.count(t, "vault_log_entries", vaultID), "a plaintext vault has no log")
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID), "bob was removed")
}
