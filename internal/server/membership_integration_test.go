//go:build integration

package server_test

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// Issue #33: vault membership management and invitations.

func (fixture *syncFixture) members(replica int) vaultsyncv1connect.MembershipServiceClient {
	return vaultsyncv1connect.NewMembershipServiceClient(http.DefaultClient, fixture.replicas[replica%len(fixture.replicas)].apiURL())
}

func (fixture *syncFixture) invite(t *testing.T, token, vaultID string, role vaultsyncv1.VaultRole, ttlSeconds uint32) (*vaultsyncv1.CreateInvitationResponse, error) {
	t.Helper()

	response, err := fixture.members(0).CreateInvitation(t.Context(), authorized(&vaultsyncv1.CreateInvitationRequest{
		VaultId: vaultID, Role: role, TtlSeconds: ttlSeconds,
	}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

func (fixture *syncFixture) mustInvite(t *testing.T, token, vaultID string, role vaultsyncv1.VaultRole) *vaultsyncv1.CreateInvitationResponse {
	t.Helper()

	invitation, err := fixture.invite(t, token, vaultID, role, 0)
	require.NoError(t, err)

	return invitation
}

func (fixture *syncFixture) redeem(t *testing.T, token, code string) (*vaultsyncv1.Vault, error) {
	t.Helper()

	response, err := fixture.members(1).RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{Code: code}, token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetVault(), nil
}

func (fixture *syncFixture) setRole(t *testing.T, token, vaultID, subject string, role vaultsyncv1.VaultRole) error {
	t.Helper()

	_, err := fixture.members(0).UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
		VaultId: vaultID, UserId: userID(t, fixture.pool, fixture.issuer.URL, subject).String(), Role: role,
	}, token))

	return err
}

func (fixture *syncFixture) removeMember(t *testing.T, token, vaultID, subject string) error {
	t.Helper()

	_, err := fixture.members(0).RemoveMember(t.Context(), authorized(&vaultsyncv1.RemoveMemberRequest{
		VaultId: vaultID, UserId: userID(t, fixture.pool, fixture.issuer.URL, subject).String(),
	}, token))

	return err
}

func (fixture *syncFixture) leave(t *testing.T, token, vaultID string) error {
	t.Helper()

	_, err := fixture.members(1).LeaveVault(t.Context(), authorized(&vaultsyncv1.LeaveVaultRequest{VaultId: vaultID}, token))

	return err
}

// roleIn returns the caller's role in vaultID as ListVaults reports it, or
// VAULT_ROLE_UNSPECIFIED when the caller is not a member.
func (fixture *syncFixture) roleIn(t *testing.T, token, vaultID string) vaultsyncv1.VaultRole {
	t.Helper()

	for _, vault := range fixture.listVaults(t, token) {
		if vault.GetId() == vaultID {
			return vault.GetRole()
		}
	}

	return vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED
}

// Criterion 1: an owner's invitation returns a single-use, expiring code,
// and another user who redeems it becomes a member with its role.
func TestInvitationMakesTheRedeemerAMemberOnceAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Household").GetId()
	content := alice.content(t, "v1")

	before := time.Now()
	created := fixture.mustInvite(t, alice.token, alice.vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	require.NotEmpty(t, created.GetCode())
	invitation := created.GetInvitation()
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, invitation.GetRole())
	assert.Equal(t, userID(t, fixture.pool, fixture.issuer.URL, "alice").String(), invitation.GetCreatorUserId())
	assert.WithinDuration(t, before.Add(api.DefaultInvitationTTL), invitation.GetExpireTime().AsTime(), time.Minute)

	// The code is high-entropy and never stored: only its hash is.
	raw, err := base64.RawURLEncoding.DecodeString(created.GetCode())
	require.NoError(t, err)
	assert.Len(t, raw, 32)

	var row string
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT row_to_json(i)::text FROM vault_invitations i WHERE id = $1`,
		invitation.GetId()).Scan(&row))
	assert.NotContains(t, row, created.GetCode(), "the code itself is not stored")
	assert.NotContains(t, row, hex.EncodeToString(raw), "the code itself is not stored")

	listed, err := fixture.members(1).ListInvitations(t.Context(), authorized(&vaultsyncv1.ListInvitationsRequest{VaultId: alice.vaultID}, alice.token))
	require.NoError(t, err)
	require.Len(t, listed.Msg.GetInvitations(), 1)
	assert.Equal(t, invitation.GetId(), listed.Msg.GetInvitations()[0].GetId())

	bob := fixture.client(t, "bob", alice.vaultID)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, alice.vaultID))

	joined, err := fixture.redeem(t, bob.token, created.GetCode())
	require.NoError(t, err)
	assert.Equal(t, alice.vaultID, joined.GetId())
	assert.Equal(t, "Household", joined.GetName())
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, joined.GetRole())
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, bob.token, alice.vaultID))

	// Bob can now write.
	bob.mustCommit(t, bob.create(t, "from-bob.md", content))

	// The code is used up: a second redemption fails, even by another user.
	carol := fixture.token(t, "carol")
	_, err = fixture.redeem(t, carol, created.GetCode())
	requireCode(t, connect.CodeNotFound, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, carol, alice.vaultID))

	listed, err = fixture.members(0).ListInvitations(t.Context(), authorized(&vaultsyncv1.ListInvitationsRequest{VaultId: alice.vaultID}, alice.token))
	require.NoError(t, err)
	assert.Empty(t, listed.Msg.GetInvitations(), "a used invitation is no longer pending")

	// A member redeeming another invitation keeps their role and does not
	// use the invitation up.
	viewerInvite := fixture.mustInvite(t, alice.token, alice.vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	_, err = fixture.redeem(t, bob.token, viewerInvite.GetCode())
	requireCode(t, connect.CodeAlreadyExists, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, bob.token, alice.vaultID))

	joined, err = fixture.redeem(t, carol, viewerInvite.GetCode())
	require.NoError(t, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, joined.GetRole())

	members, err := fixture.members(0).ListMembers(t.Context(), authorized(&vaultsyncv1.ListMembersRequest{VaultId: alice.vaultID}, alice.token))
	require.NoError(t, err)

	roles := map[string]vaultsyncv1.VaultRole{}
	for _, member := range members.Msg.GetMembers() {
		roles[member.GetUserId()] = member.GetRole()
	}

	assert.Equal(t, map[string]vaultsyncv1.VaultRole{
		userID(t, fixture.pool, fixture.issuer.URL, "alice").String(): vaultsyncv1.VaultRole_VAULT_ROLE_OWNER,
		userID(t, fixture.pool, fixture.issuer.URL, "bob").String():   vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR,
		userID(t, fixture.pool, fixture.issuer.URL, "carol").String(): vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER,
	}, roles)
}

// Criterion 1: concurrent redemptions of one code admit exactly one user.
func TestConcurrentRedemptionsOfOneCodeAdmitOneUserAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	owner := fixture.token(t, "owner")
	vaultID := fixture.createVault(t, owner, "Contended").GetId()

	const redeemers = 8

	tokens := make([]string, redeemers)
	for index := range tokens {
		tokens[index] = fixture.token(t, "redeemer-"+string(rune('a'+index)))
		fixture.listVaults(t, tokens[index]) // provisions the user
	}

	for range 5 {
		code := fixture.mustInvite(t, owner, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER).GetCode()
		errs := make([]error, redeemers)

		var group sync.WaitGroup

		for index := range redeemers {
			group.Go(func() { _, errs[index] = fixture.redeem(t, tokens[index], code) })
		}

		group.Wait()

		succeeded := 0

		for index, err := range errs {
			if err == nil {
				succeeded++

				require.NoError(t, fixture.removeMember(t, owner, vaultID, "redeemer-"+string(rune('a'+index))))

				continue
			}

			requireCode(t, connect.CodeNotFound, err)
		}

		assert.Equal(t, 1, succeeded)
	}
}

// Criterion 2: an expired, revoked, used, unknown or malformed code fails
// with one and the same error, which names no vault.
func TestFailedRedemptionsRevealNothingAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	vault := fixture.createVault(t, alice, "Secret Garden")
	mallory := fixture.token(t, "mallory")
	fixture.listVaults(t, mallory)

	expired := fixture.mustInvite(t, alice, vault.GetId(), vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)
	revoked := fixture.mustInvite(t, alice, vault.GetId(), vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)
	_, err := fixture.members(1).RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: vault.GetId(), InvitationId: revoked.GetInvitation().GetId(),
	}, alice))
	require.NoError(t, err)

	used := fixture.mustInvite(t, alice, vault.GetId(), vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	_, err = fixture.redeem(t, fixture.token(t, "bob"), used.GetCode())
	require.NoError(t, err)

	// Expired last: creating an invitation prunes the vault's expired ones,
	// and this row must still exist when it is redeemed.
	_, err = fixture.pool.Exec(t.Context(), `UPDATE vault_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
		expired.GetInvitation().GetId())
	require.NoError(t, err)

	unknown := make([]byte, 32)
	_, err = rand.Read(unknown)
	require.NoError(t, err)

	codes := map[string]string{
		"expired":   expired.GetCode(),
		"revoked":   revoked.GetCode(),
		"used":      used.GetCode(),
		"unknown":   base64.RawURLEncoding.EncodeToString(unknown),
		"empty":     "",
		"malformed": "not a code",
		"too long":  expired.GetCode() + "A",
		"too short": expired.GetCode()[:42],
		"huge":      strings.Repeat("A", 4096),
	}

	var bodies []string

	for name, code := range codes {
		response := fixture.callJSON(t, vaultsyncv1connect.MembershipServiceRedeemInvitationProcedure, mallory, map[string]string{"code": code})
		assert.Equal(t, "not_found", response.code, name)
		assert.NotContains(t, string(response.body), vault.GetId(), name)
		assert.NotContains(t, string(response.body), vault.GetName(), name)

		bodies = append(bodies, string(response.body))
	}

	for _, body := range bodies {
		assert.Equal(t, bodies[0], body, "every failed redemption gets the same answer")
	}

	assert.Empty(t, fixture.listVaults(t, mallory))

	// An expired invitation is no longer pending and cannot be revoked.
	listed, err := fixture.members(0).ListInvitations(t.Context(), authorized(&vaultsyncv1.ListInvitationsRequest{VaultId: vault.GetId()}, alice))
	require.NoError(t, err)
	assert.Empty(t, listed.Msg.GetInvitations())

	for _, invitationID := range []string{expired.GetInvitation().GetId(), revoked.GetInvitation().GetId(), newV7(t)} {
		_, err = fixture.members(0).RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
			VaultId: vault.GetId(), InvitationId: invitationID,
		}, alice))
		requireCode(t, connect.CodeNotFound, err)
	}

	// An invitation of another vault cannot be revoked through this one.
	other := fixture.createVault(t, alice, "Other")
	foreign := fixture.mustInvite(t, alice, other.GetId(), vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	_, err = fixture.members(0).RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: vault.GetId(), InvitationId: foreign.GetInvitation().GetId(),
	}, alice))
	requireCode(t, connect.CodeNotFound, err)

	_, err = fixture.redeem(t, mallory, foreign.GetCode())
	require.NoError(t, err, "the foreign invitation was not revoked")
}

// Criterion 3: a role change and a removal apply to the member's next
// request, on every replica, and a removal ends their open realtime
// subscriptions without waiting for a commit.
func TestMembershipChangesTakeEffectAtOnceAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.client(t, "alice", "")
	alice.vaultID = fixture.createVault(t, alice.token, "Notes").GetId()
	content := alice.content(t, "v1")

	bob := fixture.client(t, "bob", alice.vaultID)
	_, err := fixture.redeem(t, bob.token, fixture.mustInvite(t, alice.token, alice.vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR).GetCode())
	require.NoError(t, err)

	first := bob.mustCommit(t, bob.create(t, "a.md", content))

	// Demoted to viewer: the next write is refused on both replicas, reads
	// still work.
	require.NoError(t, fixture.setRole(t, alice.token, alice.vaultID, "bob", vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER))

	for replica := range 2 {
		_, err = bob.commitOn(t, replica, bob.create(t, "b.md", content))
		requireCode(t, connect.CodePermissionDenied, err, "replica %d", replica)
	}

	_, err = bob.changes(t, 0, 0)
	require.NoError(t, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, fixture.roleIn(t, bob.token, alice.vaultID))

	// Promoted back to editor: the next write is accepted.
	require.NoError(t, fixture.setRole(t, alice.token, alice.vaultID, "bob", vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR))
	bob.mustCommit(t, bob.create(t, "c.md", content))

	// Removed: the subscription on the other replica ends at once, with no
	// commit to trigger it, and the next request is refused as for a
	// non-member.
	socket := fixture.realtime(t, 1, bob.token)
	head := socket.subscribe(1, alice.vaultID)
	assert.Greater(t, head, first.GetSeq())

	watcher := fixture.realtime(t, 1, alice.token)
	watcher.subscribe(1, alice.vaultID)

	require.NoError(t, fixture.removeMember(t, alice.token, alice.vaultID, "bob"))

	frame := socket.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
	assert.Equal(t, alice.vaultID, frame.GetError().GetVaultId())

	// Remaining members are told the unchanged head, so they do not pull.
	requireVaultChanged(t, watcher.read(), alice.vaultID, head)

	for replica := range 2 {
		_, err = bob.commitOn(t, replica, bob.create(t, "d.md", content))
		requireCode(t, connect.CodeNotFound, err, "replica %d", replica)
	}

	_, err = bob.changes(t, 0, 0)
	requireCode(t, connect.CodeNotFound, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, alice.vaultID))

	err = fixture.removeMember(t, alice.token, alice.vaultID, "bob")
	requireCode(t, connect.CodeNotFound, err, "bob is no longer a member")
}

// Criterion 3: leaving a vault without any revision (head_seq zero) also
// ends the member's realtime subscriptions at once.
func TestLeavingAnEmptyVaultEndsSubscriptionsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	vaultID := fixture.createVault(t, alice, "Empty").GetId()

	carol := fixture.token(t, "carol")
	_, err := fixture.redeem(t, carol, fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER).GetCode())
	require.NoError(t, err)

	socket := fixture.realtime(t, 0, carol)
	assert.Zero(t, socket.subscribe(1, vaultID))

	require.NoError(t, fixture.leave(t, carol, vaultID))

	frame := socket.read()
	require.NotNil(t, frame.GetError(), "expected an error frame, got %v", frame)
	assert.Equal(t, vaultsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND, frame.GetError().GetCode())
	assert.Equal(t, vaultID, frame.GetError().GetVaultId())
	assert.Empty(t, fixture.listVaults(t, carol))
}

// Criterion 4: a vault always keeps at least one owner.
func TestVaultAlwaysKeepsAnOwnerAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	vaultID := fixture.createVault(t, alice, "Notes").GetId()

	bob := fixture.token(t, "bob")
	_, err := fixture.redeem(t, bob, fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR).GetCode())
	require.NoError(t, err)

	// Alice is the only owner: she cannot be demoted, removed, or leave.
	for _, role := range []vaultsyncv1.VaultRole{vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER} {
		requireCode(t, connect.CodeFailedPrecondition, fixture.setRole(t, alice, vaultID, "alice", role))
	}

	requireCode(t, connect.CodeFailedPrecondition, fixture.removeMember(t, alice, vaultID, "alice"))
	requireCode(t, connect.CodeFailedPrecondition, fixture.leave(t, alice, vaultID))
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, fixture.roleIn(t, alice, vaultID))

	// "Changing" the last owner's role to owner is not a demotion.
	require.NoError(t, fixture.setRole(t, alice, vaultID, "alice", vaultsyncv1.VaultRole_VAULT_ROLE_OWNER))

	// With a second owner, the first may step down; then the second is
	// the last owner.
	require.NoError(t, fixture.setRole(t, alice, vaultID, "bob", vaultsyncv1.VaultRole_VAULT_ROLE_OWNER))
	require.NoError(t, fixture.leave(t, alice, vaultID))
	assert.Empty(t, fixture.listVaults(t, alice))

	requireCode(t, connect.CodeFailedPrecondition, fixture.leave(t, bob, vaultID))
	requireCode(t, connect.CodeFailedPrecondition, fixture.setRole(t, bob, vaultID, "bob", vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER))

	// Two owners demoting each other at the same time: exactly one
	// succeeds, so the vault keeps an owner.
	carol := fixture.token(t, "carol")
	_, err = fixture.redeem(t, carol, fixture.mustInvite(t, bob, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR).GetCode())
	require.NoError(t, err)

	tokens := map[string]string{"bob": bob, "carol": carol}

	for range 10 {
		require.NoError(t, fixture.setRole(t, tokens["bob"], vaultID, "carol", vaultsyncv1.VaultRole_VAULT_ROLE_OWNER))
		require.NoError(t, fixture.setRole(t, tokens["carol"], vaultID, "bob", vaultsyncv1.VaultRole_VAULT_ROLE_OWNER))

		errs := map[string]error{}

		var (
			group sync.WaitGroup
			mu    sync.Mutex
		)

		for subject, other := range map[string]string{"bob": "carol", "carol": "bob"} {
			group.Go(func() {
				var err error
				if subject == "bob" {
					err = fixture.removeMember(t, tokens[subject], vaultID, other)
				} else {
					err = fixture.setRole(t, tokens[subject], vaultID, other, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
				}

				mu.Lock()
				errs[subject] = err
				mu.Unlock()
			})
		}

		group.Wait()

		var owners int
		require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM vault_members WHERE vault_id = $1 AND role = 'owner'`, vaultID).Scan(&owners))
		assert.Equal(t, 1, owners)

		// Whoever lost is refused, either as the last owner's demotion or,
		// after being demoted or removed first, by authorization.
		failed := 0

		for _, err := range errs {
			if err != nil {
				failed++

				assert.Contains(t, []connect.Code{connect.CodeFailedPrecondition, connect.CodePermissionDenied, connect.CodeNotFound}, connect.CodeOf(err))
			}
		}

		assert.Equal(t, 1, failed)

		// Restore both as members for the next round.
		_, err = fixture.pool.Exec(t.Context(), `
			INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'owner')
			ON CONFLICT (vault_id, user_id) DO UPDATE SET role = 'owner'`,
			vaultID, userID(t, fixture.pool, fixture.issuer.URL, "bob"), userID(t, fixture.pool, fixture.issuer.URL, "carol"))
		require.NoError(t, err)
	}
}

// Invitations and memberships are bounded (SPEC.md §2, principle 4).
func TestMembershipLimitsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	vaultID := fixture.createVault(t, alice, "Busy").GetId()

	t.Run("invitation lifetime", func(t *testing.T) {
		maxSeconds := uint32(api.MaxInvitationTTL / time.Second)

		created, err := fixture.invite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, maxSeconds)
		require.NoError(t, err)
		assert.WithinDuration(t, time.Now().Add(api.MaxInvitationTTL), created.GetInvitation().GetExpireTime().AsTime(), time.Minute)

		_, err = fixture.invite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, maxSeconds+1)
		requireCode(t, connect.CodeInvalidArgument, err)

		_, err = fixture.invite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, 0)
		requireCode(t, connect.CodeInvalidArgument, err)

		_, err = fixture.invite(t, alice, vaultID, vaultsyncv1.VaultRole(99), 0)
		requireCode(t, connect.CodeInvalidArgument, err)

		_, err = fixture.pool.Exec(t.Context(), `DELETE FROM vault_invitations`)
		require.NoError(t, err)
	})

	t.Run("pending invitations", func(t *testing.T) {
		for range api.MaxPendingInvitationsPerVault {
			fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
		}

		_, err := fixture.invite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, 0)
		requireCode(t, connect.CodeResourceExhausted, err)

		// An expired invitation no longer counts, and is pruned.
		_, err = fixture.pool.Exec(t.Context(), `
			UPDATE vault_invitations SET expires_at = now() - interval '1 second'
			WHERE id = (SELECT id FROM vault_invitations WHERE vault_id = $1 ORDER BY id LIMIT 1)`, vaultID)
		require.NoError(t, err)

		fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
		assert.Equal(t, api.MaxPendingInvitationsPerVault, fixture.count(t, "vault_invitations", vaultID))

		_, err = fixture.pool.Exec(t.Context(), `DELETE FROM vault_invitations`)
		require.NoError(t, err)
	})

	t.Run("members", func(t *testing.T) {
		// Seed members up to one below the limit (the owner counts).
		_, err := fixture.pool.Exec(t.Context(), `
			WITH seeded AS (
				INSERT INTO users (id, oidc_issuer, oidc_subject)
				SELECT gen_random_uuid(), 'https://seeded.example', 'member-' || n FROM generate_series(1, $2) AS n
				RETURNING id
			)
			INSERT INTO vault_members (vault_id, user_id, role) SELECT $1, id, 'viewer' FROM seeded`,
			vaultID, api.MaxMembersPerVault-2)
		require.NoError(t, err)

		last := fixture.token(t, "last")
		_, err = fixture.redeem(t, last, fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER).GetCode())
		require.NoError(t, err, "the limit-th member may join")

		members, err := fixture.members(0).ListMembers(t.Context(), authorized(&vaultsyncv1.ListMembersRequest{VaultId: vaultID}, alice))
		require.NoError(t, err)
		assert.Len(t, members.Msg.GetMembers(), api.MaxMembersPerVault)

		overflow := fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
		extra := fixture.token(t, "extra")
		_, err = fixture.redeem(t, extra, overflow.GetCode())
		requireCode(t, connect.CodeResourceExhausted, err)
		assert.Empty(t, fixture.listVaults(t, extra))

		// The refused redemption did not use the invitation up.
		require.NoError(t, fixture.removeMember(t, alice, vaultID, "last"))

		_, err = fixture.redeem(t, extra, overflow.GetCode())
		require.NoError(t, err)
	})

	t.Run("ids", func(t *testing.T) {
		for _, userID := range []string{"", "nope", strings.ToUpper(newV7(t))} {
			_, err := fixture.members(0).RemoveMember(t.Context(), authorized(&vaultsyncv1.RemoveMemberRequest{VaultId: vaultID, UserId: userID}, alice))
			requireCode(t, connect.CodeInvalidArgument, err, "%q", userID)

			_, err = fixture.members(0).UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
				VaultId: vaultID, UserId: userID, Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER,
			}, alice))
			requireCode(t, connect.CodeInvalidArgument, err, "%q", userID)

			_, err = fixture.members(0).RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{VaultId: vaultID, InvitationId: userID}, alice))
			requireCode(t, connect.CodeInvalidArgument, err, "%q", userID)
		}

		_, err := fixture.members(0).RemoveMember(t.Context(), authorized(&vaultsyncv1.RemoveMemberRequest{VaultId: vaultID, UserId: newV7(t)}, alice))
		requireCode(t, connect.CodeNotFound, err)

		_, err = fixture.members(0).UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
			VaultId: vaultID, UserId: newV7(t), Role: vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER,
		}, alice))
		requireCode(t, connect.CodeNotFound, err)

		_, err = fixture.members(0).UpdateMemberRole(t.Context(), authorized(&vaultsyncv1.UpdateMemberRoleRequest{
			VaultId: vaultID, UserId: userID(t, fixture.pool, fixture.issuer.URL, "alice").String(),
		}, alice))
		requireCode(t, connect.CodeInvalidArgument, err, "unspecified role")
	})
}

// Criterion 5, against PostgreSQL with the membership handlers mounted:
// every membership procedure refuses editors, viewers and non-members, and
// only LeaveVault is open to every member.
func TestMembershipProceduresRefuseNonOwnersAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	vaultID := fixture.createVault(t, alice, "Notes").GetId()
	fixture.addMember(t, vaultID, "editor", "editor")
	fixture.addMember(t, vaultID, "viewer", "viewer")

	tokens := map[string]string{"editor": fixture.token(t, "editor"), "viewer": fixture.token(t, "viewer"), "outsider": fixture.token(t, "outsider")}
	pending := fixture.mustInvite(t, alice, vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)
	aliceID := userID(t, fixture.pool, fixture.issuer.URL, "alice").String()

	// Well-formed requests that an owner's call would carry out.
	bodies := map[string]map[string]any{
		vaultsyncv1connect.MembershipServiceCreateInvitationProcedure: {"vault_id": vaultID, "role": "VAULT_ROLE_OWNER"},
		vaultsyncv1connect.MembershipServiceListInvitationsProcedure:  {"vault_id": vaultID},
		vaultsyncv1connect.MembershipServiceRevokeInvitationProcedure: {"vault_id": vaultID, "invitation_id": pending.GetInvitation().GetId()},
		vaultsyncv1connect.MembershipServiceListMembersProcedure:      {"vault_id": vaultID},
		vaultsyncv1connect.MembershipServiceUpdateMemberRoleProcedure: {"vault_id": vaultID, "user_id": aliceID, "role": "VAULT_ROLE_VIEWER"},
		vaultsyncv1connect.MembershipServiceRemoveMemberProcedure:     {"vault_id": vaultID, "user_id": aliceID},
	}

	for procedure, body := range bodies {
		for subject, token := range tokens {
			response := fixture.callJSON(t, procedure, token, body)
			if subject == "outsider" {
				assert.True(t, response.deniedAsNonMember(), "%s as %s: %s", procedure, subject, response.body)
			} else {
				assert.Equal(t, "permission_denied", response.code, "%s as %s: %s", procedure, subject, response.body)
			}
		}
	}

	// Nothing changed: alice is still the owner, the invitation is pending,
	// and no other invitation was created.
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, fixture.roleIn(t, alice, vaultID))
	assert.Equal(t, 1, fixture.count(t, "vault_invitations", vaultID))

	// LeaveVault refuses only non-members.
	assert.True(t, fixture.callJSON(t, vaultsyncv1connect.MembershipServiceLeaveVaultProcedure, tokens["outsider"], map[string]string{"vault_id": vaultID}).deniedAsNonMember())

	for _, subject := range []string{"editor", "viewer"} {
		response := fixture.callJSON(t, vaultsyncv1connect.MembershipServiceLeaveVaultProcedure, tokens[subject], map[string]string{"vault_id": vaultID})
		assert.Empty(t, response.code, "%s: %s", subject, response.body)
		assert.Empty(t, fixture.listVaults(t, tokens[subject]))
	}
}
