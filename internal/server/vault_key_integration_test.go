//go:build integration

package server_test

import (
	"bytes"
	"encoding/hex"
	"net/http"
	"slices"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Issue #694: vault key epochs and key slots.

// keyedMember is a user with a real X25519 user key, working in one vault.
type keyedMember struct {
	*syncClient

	userID     uuid.UUID
	privateKey []byte
	publicKey  []byte
	// secret signs the member's entries in E2EE vaults' membership logs.
	secret e2ee.UserSecret
}

func (fixture *syncFixture) vaultKeys(replica int) vaultsyncv1connect.VaultKeyServiceClient {
	return vaultsyncv1connect.NewVaultKeyServiceClient(http.DefaultClient, fixture.replicas[replica%len(fixture.replicas)].apiURL())
}

// keyedMember registers a device for subject and creates their user key.
func (fixture *syncFixture) keyedMember(t *testing.T, subject string) *keyedMember {
	t.Helper()

	client := fixture.client(t, subject, "")

	privateKey, publicKey, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	material := newUserKeyMaterial(t)
	material.publicKey = publicKey
	require.NoError(t, fixture.createUserKey(t, client.token, material))

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	return &keyedMember{
		syncClient: client, userID: userID(t, fixture.pool, fixture.issuer.URL, subject),
		privateKey: privateKey, publicKey: publicKey, secret: secret,
	}
}

// e2eeVault creates an E2EE vault owned by owner through the store, its
// genesis signed by owner.
func (fixture *syncFixture) e2eeVault(t *testing.T, owner *keyedMember, escrow bool) string {
	t.Helper()

	var escrowBundle *e2ee.EscrowBundle

	if escrow {
		_, escrowKey, err := e2ee.GenerateKeyPair()
		require.NoError(t, err)

		escrowBundle = escrowBundleOf(t, escrowKey)
	}

	bundle, err := owner.secret.Bundle(owner.userID.String())
	require.NoError(t, err)

	payload, err := e2ee.GenesisPayload(bundle, escrowBundle)
	require.NoError(t, err)

	id := uuid.Must(uuid.NewV7())
	genesis := signedEntry(t, id.String(), 1, make([]byte, e2ee.HashSize), e2ee.EntryGenesis, payload, owner.secret.SignKey())

	vault, err := store.New(fixture.pool).CreateVault(t.Context(), owner.userID, store.NewVault{
		ID: id, Name: "Secret", Encryption: store.EncryptionE2EE, Escrow: escrow,
		Genesis: &store.LogEntry{Seq: 1, PrevHash: genesis.GetPrevHash(), Type: byte(e2ee.EntryGenesis), Payload: payload, Signatures: genesis.GetSignatures()},
	}, 100)
	require.NoError(t, err)

	owner.vaultID = vault.ID.String()

	return owner.vaultID
}

// join makes member a member of owner's vault with role, through an
// invitation, with signed log entries in an E2EE vault.
func (fixture *syncFixture) join(t *testing.T, owner, member *keyedMember, role vaultsyncv1.VaultRole) {
	t.Helper()

	if !fixture.encrypted(t, owner) {
		invitation := fixture.mustInvite(t, owner.token, owner.vaultID, role)
		_, err := fixture.redeem(t, member.token, invitation.GetCode())
		require.NoError(t, err)

		member.vaultID = owner.vaultID

		return
	}

	invitation := fixture.signedInvitation(t, owner, role)

	_, err := fixture.members(0).CreateInvitation(t.Context(), authorized(fixture.inviteRequest(t, owner, role, invitation), owner.token))
	require.NoError(t, err)

	_, err = fixture.members(1).RedeemInvitation(t.Context(), authorized(&vaultsyncv1.RedeemInvitationRequest{
		Code: invitation.code, LogEntry: fixture.redeemEntry(t, owner, member, invitation), Slots: fixture.redeemSlots(t, member, invitation),
	}, member.token))
	require.NoError(t, err)

	member.vaultID = owner.vaultID
}

// nextEpoch is the epoch after expected in vaultID, its key epochKey
// committed to and sealed to each recipient (docs/design/crypto.md).
func nextEpoch(t *testing.T, vaultID string, expected uint32, epochKey []byte, recipients ...*keyedMember) *vaultsyncv1.NextEpoch {
	t.Helper()

	commitment, err := e2ee.KeyCommitment(epochKey, vaultID, uint64(expected)+1)
	require.NoError(t, err)

	next := &vaultsyncv1.NextEpoch{ExpectedEpoch: expected, Commitment: commitment}
	for _, recipient := range recipients {
		slot := sealedSlot(t, vaultID, expected+1, epochKey, recipient)
		slot.Epoch = 0 // implied by expected_epoch

		next.Slots = append(next.Slots, slot)
	}

	return next
}

func slotOf(vaultID string, epoch uint32, recipient *keyedMember) e2ee.KeySlot {
	return e2ee.KeySlot{VaultID: vaultID, Epoch: uint64(epoch), RecipientKind: e2ee.RecipientUser, RecipientID: recipient.userID.String()}
}

func sealedSlot(t *testing.T, vaultID string, epoch uint32, epochKey []byte, recipient *keyedMember) *vaultsyncv1.KeySlot {
	t.Helper()

	wrapped, err := e2ee.SealKeySlot(recipient.publicKey, epochKey, slotOf(vaultID, epoch, recipient))
	require.NoError(t, err)

	return &vaultsyncv1.KeySlot{
		Epoch:         epoch,
		RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER,
		RecipientId:   recipient.userID.String(),
		WrappedKey:    wrapped,
	}
}

// rotate sends next, with its record signed by caller at the head of the
// vault's log when its membership changes built it (signedLog), and
// otherwise at the head of a log rewritten to match the vault's members
// (vaultLog).
func (fixture *syncFixture) rotate(t *testing.T, replica int, caller *keyedMember, next *vaultsyncv1.NextEpoch) (*vaultsyncv1.KeyEpoch, error) {
	t.Helper()

	log, ok := fixture.signedLog(t, caller)
	if !ok {
		log = fixture.vaultLog(t, caller.vaultID)
	}

	record := fixture.signedRecord(t, log, caller.vaultID, caller.userID, next)

	response, err := fixture.vaultKeys(replica).RotateEpoch(t.Context(), authorized(&vaultsyncv1.RotateEpochRequest{
		VaultId: caller.vaultID, NextEpoch: next, Record: record,
	}, caller.token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetEpoch(), nil
}

func (fixture *syncFixture) epochs(t *testing.T, caller *keyedMember) *vaultsyncv1.ListEpochsResponse {
	t.Helper()

	response, err := fixture.vaultKeys(1).ListEpochs(t.Context(), authorized(&vaultsyncv1.ListEpochsRequest{VaultId: caller.vaultID}, caller.token))
	require.NoError(t, err)

	return response.Msg
}

func (fixture *syncFixture) ownSlots(t *testing.T, caller *keyedMember) []*vaultsyncv1.KeySlot {
	t.Helper()

	response, err := fixture.vaultKeys(1).ListKeySlots(t.Context(), authorized(&vaultsyncv1.ListKeySlotsRequest{VaultId: caller.vaultID}, caller.token))
	require.NoError(t, err)

	return response.Msg.GetSlots()
}

func (fixture *syncFixture) missingSlots(t *testing.T, caller *keyedMember) []*vaultsyncv1.MissingSlot {
	t.Helper()

	response, err := fixture.vaultKeys(0).ListMissingSlots(t.Context(), authorized(&vaultsyncv1.ListMissingSlotsRequest{VaultId: caller.vaultID}, caller.token))
	require.NoError(t, err)

	return response.Msg.GetMissingSlots()
}

func (fixture *syncFixture) removeWithEpoch(t *testing.T, owner, removed *keyedMember, next *vaultsyncv1.NextEpoch) error {
	t.Helper()

	_, err := fixture.members(1).RemoveMember(t.Context(), authorized(fixture.removalRequest(t, owner, removed, next), owner.token))

	return err
}

// removalRequest is owner's removal of removed with next: in an E2EE vault
// with the remove-member entry signed by owner and next's record at it.
func (fixture *syncFixture) removalRequest(t *testing.T, owner, removed *keyedMember, next *vaultsyncv1.NextEpoch) *vaultsyncv1.RemoveMemberRequest {
	t.Helper()

	request := &vaultsyncv1.RemoveMemberRequest{VaultId: owner.vaultID, UserId: removed.userID.String(), NextEpoch: next}
	if fixture.encrypted(t, owner) {
		request.LogEntry = fixture.idEntry(t, owner, e2ee.EntryRemoveMember, removed.userID, owner)
		request.Record = fixture.removalRecord(t, owner, request.GetLogEntry(), next)
	}

	return request
}

// removalRecord is next's record signed by owner at entry, the remove-member
// entry after the head of the vault's log, or nil when there is no next
// epoch, its commitment cannot be signed or the log does not verify with
// entry (the removal is refused for those first).
func (fixture *syncFixture) removalRecord(t *testing.T, owner *keyedMember, entry *vaultsyncv1.LogEntry, next *vaultsyncv1.NextEpoch) *vaultsyncv1.EpochRecord {
	t.Helper()

	if entry == nil || next == nil || len(next.GetCommitment()) != e2ee.MACSize {
		return nil
	}

	log, ok := fixture.signedLog(t, owner)
	if !ok {
		log = fixture.vaultLog(t, owner.vaultID)
	}

	extended := &logtest.Log{
		VaultID: log.VaultID, Entries: append(slices.Clone(log.Entries), logEntryOf(owner.vaultID, entry)), Secrets: log.Secrets,
	}

	if _, err := e2ee.ReplayLog(extended.VaultID, extended.Entries, e2ee.ReplayOptions{}); err != nil {
		return nil
	}

	return fixture.signedRecord(t, extended, owner.vaultID, owner.userID, next)
}

// openSlot unwraps the epoch key of a slot listed to member and checks it
// against the epoch's commitment.
func (fixture *syncFixture) openSlot(t *testing.T, member *keyedMember, slot *vaultsyncv1.KeySlot) []byte {
	t.Helper()

	epochKey, err := e2ee.OpenKeySlot(member.privateKey, slot.GetWrappedKey(), slotOf(member.vaultID, slot.GetEpoch(), member))
	require.NoError(t, err)

	for _, epoch := range fixture.epochs(t, member).GetEpochs() {
		if epoch.GetEpoch() == slot.GetEpoch() {
			require.NoError(t, e2ee.VerifyKeyCommitment(epochKey, epoch.GetCommitment(), member.vaultID, uint64(slot.GetEpoch())))
		}
	}

	return epochKey
}

func requireEpochNotCurrent(t *testing.T, err error) {
	t.Helper()

	require.Error(t, err)
	assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
	assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_EPOCH_NOT_CURRENT, api.ErrorReasonOf(err), err)
}

// Criterion 1: every member lists only their own slots and unwraps the epoch
// key from them; the server stores and returns only wrapped keys.
func TestEveryMemberListsOnlyTheirOwnKeySlotsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")
	outsider := fixture.keyedMember(t, "outsider")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	outsider.vaultID = vaultID

	initial := fixture.epochs(t, carol)
	assert.Zero(t, initial.GetCurrentEpoch())
	assert.True(t, initial.GetRotationPending(), "a new E2EE vault asks an owner for its first epoch")

	epochKey, err := e2ee.GenerateKey()
	require.NoError(t, err)

	created, err := fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, epochKey, alice, bob, carol))
	require.NoError(t, err)
	assert.Equal(t, uint32(1), created.GetEpoch())

	for _, member := range []*keyedMember{alice, bob, carol} {
		slots := fixture.ownSlots(t, member)
		require.Len(t, slots, 1)
		assert.Equal(t, member.userID.String(), slots[0].GetRecipientId(), "only the caller's own slot")
		assert.Equal(t, uint32(1), slots[0].GetEpoch())
		assert.Equal(t, epochKey, fixture.openSlot(t, member, slots[0]))
	}

	_, err = fixture.vaultKeys(0).ListKeySlots(t.Context(), authorized(&vaultsyncv1.ListKeySlotsRequest{VaultId: vaultID}, outsider.token))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), err)

	state := fixture.epochs(t, carol)
	assert.Equal(t, uint32(1), state.GetCurrentEpoch())
	assert.False(t, state.GetRotationPending())
	require.Len(t, state.GetEpochs(), 1)
	assert.Equal(t, alice.userID.String(), state.GetEpochs()[0].GetCreatorUserId())

	// No column holds the unwrapped key.
	for _, table := range []string{"key_slots", "vault_key_epochs", "vaults", "revisions", "vault_members", "user_keys"} {
		var rows string
		require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT coalesce(json_agg(t)::text, '') FROM `+table+` t`).Scan(&rows))
		assert.NotContains(t, rows, hex.EncodeToString(epochKey), table)
	}

	// Nor does any response.
	for _, member := range []*keyedMember{alice, bob, carol} {
		encoded, err := proto.Marshal(fixture.epochs(t, member))
		require.NoError(t, err)
		assert.False(t, bytes.Contains(encoded, epochKey))

		for _, slot := range fixture.ownSlots(t, member) {
			assert.False(t, bytes.Contains(slot.GetWrappedKey(), epochKey))
		}
	}
}

// Criterion 2: an owner's removal from an E2EE vault and the next epoch
// commit together; without a valid next epoch nothing changes.
func TestRemoveMemberCommitsTheNextEpochAtomicallyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	first, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, first, alice, bob, carol))
	require.NoError(t, err)

	second, err := e2ee.GenerateKey()
	require.NoError(t, err)

	shortCommitment := nextEpoch(t, alice.vaultID, 1, second, alice, carol)
	shortCommitment.Commitment = shortCommitment.GetCommitment()[:31]

	refused := []struct {
		name string
		next *vaultsyncv1.NextEpoch
		code connect.Code
	}{
		{"no next epoch", nil, connect.CodeInvalidArgument},
		{"a remaining member without a slot", nextEpoch(t, alice.vaultID, 1, second, alice), connect.CodeInvalidArgument},
		{"a slot for the removed member", nextEpoch(t, alice.vaultID, 1, second, alice, carol, bob), connect.CodeInvalidArgument},
		{"a commitment of 31 bytes", shortCommitment, connect.CodeInvalidArgument},
		{"a stale expected epoch", nextEpoch(t, alice.vaultID, 0, second, alice, carol), connect.CodeFailedPrecondition},
	}

	for _, testCase := range refused {
		err := fixture.removeWithEpoch(t, alice, bob, testCase.next)
		require.Error(t, err, testCase.name)
		assert.Equal(t, testCase.code, connect.CodeOf(err), "%s: %v", testCase.name, err)

		if testCase.code == connect.CodeFailedPrecondition {
			requireEpochNotCurrent(t, err)
		}

		assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, bob.token, vaultID), "%s: bob stays", testCase.name)
		assert.Equal(t, uint32(1), fixture.epochs(t, carol).GetCurrentEpoch(), testCase.name)
	}

	require.NoError(t, fixture.removeWithEpoch(t, alice, bob, nextEpoch(t, alice.vaultID, 1, second, alice, carol)))
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID))

	state := fixture.epochs(t, carol)
	assert.Equal(t, uint32(2), state.GetCurrentEpoch())
	assert.False(t, state.GetRotationPending())

	slots := fixture.ownSlots(t, carol)
	require.Len(t, slots, 2)
	assert.Equal(t, second, fixture.openSlot(t, carol, slots[1]))

	var bobSlots int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM key_slots WHERE recipient_id = $1`, bob.userID.String()).Scan(&bobSlots))
	assert.Equal(t, 1, bobSlots, "the removed member has no slot for the new epoch")

	// A plaintext vault takes no next epoch.
	plain := fixture.createVault(t, alice.token, "Plain").GetId()
	alice.vaultID = plain
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	err = fixture.removeWithEpoch(t, alice, carol, nextEpoch(t, alice.vaultID, 0, second, alice))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, carol.token, plain))
	require.NoError(t, fixture.removeWithEpoch(t, alice, carol, nil))
}

// Criteria 3 and 5: a member leaving marks a rotation pending, commits under
// the current epoch go on until an owner rotates, and then only the new
// epoch is accepted.
func TestLeavingMarksARotationPendingAndCommitsFollowTheEpochAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	content := carol.content(t, "ciphertext")
	commit := func(replica int, epoch uint32) (*vaultsyncv1.Revision, error) {
		request := carol.encryptedCreate(t, epoch, opaqueBytes(t, 60), opaqueBytes(t, 32), content)

		return carol.commitOn(t, replica, request)
	}

	_, err := commit(0, 1)
	requireEpochNotCurrent(t, err) // no epoch yet

	_, err = commit(0, 0)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, key, alice, bob, carol))
	require.NoError(t, err)

	_, err = fixture.members(1).LeaveVault(t.Context(), authorized(&vaultsyncv1.LeaveVaultRequest{
		VaultId: vaultID, LogEntry: fixture.idEntry(t, bob, e2ee.EntryLeave, bob.userID, bob),
	}, bob.token))
	require.NoError(t, err)

	state := fixture.epochs(t, carol)
	assert.Equal(t, uint32(1), state.GetCurrentEpoch())
	assert.True(t, state.GetRotationPending())

	pending, err := commit(1, 1)
	require.NoError(t, err, "while the rotation is pending, the current epoch is accepted")
	assert.Equal(t, uint32(1), pending.GetEpoch())

	_, err = commit(0, 2)
	requireEpochNotCurrent(t, err)

	next, err := e2ee.GenerateKey()
	require.NoError(t, err)

	for _, invalid := range []*vaultsyncv1.NextEpoch{
		nextEpoch(t, alice.vaultID, 1, next, alice),             // carol missing
		nextEpoch(t, alice.vaultID, 1, next, alice, carol, bob), // bob left
	} {
		_, err := fixture.rotate(t, 1, alice, invalid)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
		assert.True(t, fixture.epochs(t, carol).GetRotationPending())
	}

	_, err = fixture.rotate(t, 1, carol, nextEpoch(t, alice.vaultID, 1, next, alice, carol))
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "an editor cannot rotate")

	created, err := fixture.rotate(t, 1, alice, nextEpoch(t, alice.vaultID, 1, next, alice, carol))
	require.NoError(t, err)
	assert.Equal(t, uint32(2), created.GetEpoch())

	state = fixture.epochs(t, carol)
	assert.Equal(t, uint32(2), state.GetCurrentEpoch())
	assert.False(t, state.GetRotationPending())

	for replica, epoch := range []uint32{1, 3} {
		_, err := commit(replica, epoch)
		requireEpochNotCurrent(t, err)
	}

	committed, err := commit(1, 2)
	require.NoError(t, err)
	assert.Equal(t, uint32(2), committed.GetEpoch())

	epochs := map[string]uint32{}
	for _, revision := range carol.allChanges(t, 0, 0) {
		epochs[revision.GetId()] = revision.GetEpoch()
	}

	assert.Equal(t, map[string]uint32{pending.GetId(): 1, committed.GetId(): 2}, epochs, "every revision reports its epoch")

	// A plaintext vault's revisions carry epoch 0.
	plain := fixture.createVault(t, alice.token, "Plain").GetId()
	plainContent := alice.in(plain).content(t, "text")

	request := alice.in(plain).create(t, "a.md", plainContent)
	request.Epoch = 1
	_, err = alice.in(plain).commit(t, request)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)

	request.Epoch = 0
	assert.Zero(t, alice.in(plain).mustCommit(t, request).GetEpoch())
}

// Criterion 4: of concurrent rotations, on both replicas, with the same
// expected epoch, exactly one succeeds.
func TestConcurrentRotationsAcrossReplicasCreateOneEpochAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")

	fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, key, alice, bob))
	require.NoError(t, err)

	const rotations = 6

	results := make([]error, rotations)

	var group sync.WaitGroup

	for index := range rotations {
		caller := alice
		if index%2 == 1 {
			caller = bob
		}

		next := nextEpoch(t, alice.vaultID, 1, key, alice, bob)

		group.Go(func() {
			_, results[index] = fixture.rotate(t, index, caller, next)
		})
	}

	group.Wait()

	won := 0

	for _, err := range results {
		if err == nil {
			won++

			continue
		}

		requireEpochNotCurrent(t, err)
	}

	assert.Equal(t, 1, won)
	assert.Equal(t, uint32(2), fixture.epochs(t, bob).GetCurrentEpoch())
	assert.Len(t, fixture.ownSlots(t, bob), 2)
}

// A member without slots (one who joined before invitations carried key
// slots) is missing a slot for every epoch until an owner grants them.
func TestAddedMemberIsListedAsMissingSlotsUntilGrantedAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	dave := fixture.keyedMember(t, "dave")

	fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	keys := make([][]byte, 2)

	for index := range keys {
		var err error

		keys[index], err = e2ee.GenerateKey()
		require.NoError(t, err)

		_, err = fixture.rotate(t, index, alice, nextEpoch(t, alice.vaultID, uint32(index), keys[index], alice, bob)) //nolint:gosec // small test values.
		require.NoError(t, err)
	}

	assert.Empty(t, fixture.missingSlots(t, alice))

	fixture.join(t, alice, dave, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)
	assert.Empty(t, fixture.missingSlots(t, alice), "a redeeming member stores their own slots")

	_, err := fixture.pool.Exec(t.Context(), `DELETE FROM key_slots WHERE vault_id = $1 AND recipient_id = $2`, alice.vaultID, dave.userID.String())
	require.NoError(t, err)

	missing := fixture.missingSlots(t, alice)
	require.Len(t, missing, 2)

	for index, slot := range missing {
		assert.Equal(t, uint32(index+1), slot.GetEpoch()) //nolint:gosec // small test values.
		assert.Equal(t, dave.userID.String(), slot.GetUserId())
		assert.Equal(t, dave.publicKey, slot.GetPublicKey())
	}

	assert.Empty(t, fixture.ownSlots(t, dave))

	_, err = fixture.vaultKeys(0).ListMissingSlots(t.Context(), authorized(&vaultsyncv1.ListMissingSlotsRequest{VaultId: alice.vaultID}, bob.token))
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "editors do not grant keys")

	_, err = fixture.vaultKeys(0).AddKeySlots(t.Context(), authorized(&vaultsyncv1.AddKeySlotsRequest{
		VaultId: alice.vaultID, Slots: []*vaultsyncv1.KeySlot{sealedSlot(t, alice.vaultID, 1, keys[0], dave)},
	}, bob.token))
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "editors do not grant keys")

	grant := func(epoch uint32) uint32 {
		response, err := fixture.vaultKeys(1).AddKeySlots(t.Context(), authorized(&vaultsyncv1.AddKeySlotsRequest{
			VaultId: alice.vaultID, Slots: []*vaultsyncv1.KeySlot{sealedSlot(t, alice.vaultID, epoch, keys[epoch-1], dave)},
		}, alice.token))
		require.NoError(t, err)

		return response.Msg.GetAdded()
	}

	assert.Equal(t, uint32(1), grant(1))
	require.Len(t, fixture.missingSlots(t, alice), 1)
	assert.Equal(t, uint32(2), fixture.missingSlots(t, alice)[0].GetEpoch())

	assert.Equal(t, uint32(1), grant(2))
	assert.Empty(t, fixture.missingSlots(t, alice))
	assert.Zero(t, grant(2), "a granted slot is kept, not replaced")

	slots := fixture.ownSlots(t, dave)
	require.Len(t, slots, 2)

	for index, slot := range slots {
		assert.Equal(t, keys[index], fixture.openSlot(t, dave, slot))
	}

	_, err = fixture.vaultKeys(0).AddKeySlots(t.Context(), authorized(&vaultsyncv1.AddKeySlotsRequest{
		VaultId: alice.vaultID, Slots: []*vaultsyncv1.KeySlot{sealedSlot(t, alice.vaultID, 3, keys[0], dave)},
	}, alice.token))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "epoch 3 does not exist")
}

// Criterion 7: the new procedures resolve the caller's role in PostgreSQL:
// non-members are NOT_FOUND everywhere, viewers read epochs and their own
// slots but cannot grant or rotate.
func TestVaultKeyProceduresEnforceRolesAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	viewer := fixture.keyedMember(t, "viewer")
	outsider := fixture.keyedMember(t, "outsider")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, viewer, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	outsider.vaultID = vaultID

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)

	calls := map[string]func(caller *keyedMember) error{
		"ListKeySlots": func(caller *keyedMember) error {
			_, err := fixture.vaultKeys(0).ListKeySlots(t.Context(), authorized(&vaultsyncv1.ListKeySlotsRequest{VaultId: vaultID}, caller.token))
			return err
		},
		"ListEpochs": func(caller *keyedMember) error {
			_, err := fixture.vaultKeys(0).ListEpochs(t.Context(), authorized(&vaultsyncv1.ListEpochsRequest{VaultId: vaultID}, caller.token))
			return err
		},
		"ListLogEntries": func(caller *keyedMember) error {
			_, err := fixture.vaultKeys(0).ListLogEntries(t.Context(), authorized(&vaultsyncv1.ListLogEntriesRequest{VaultId: vaultID}, caller.token))
			return err
		},
		"ListMissingSlots": func(caller *keyedMember) error {
			_, err := fixture.vaultKeys(0).ListMissingSlots(t.Context(), authorized(&vaultsyncv1.ListMissingSlotsRequest{VaultId: vaultID}, caller.token))
			return err
		},
		"RotateEpoch": func(caller *keyedMember) error {
			_, err := fixture.rotate(t, 0, caller, nextEpoch(t, alice.vaultID, 0, key, alice, viewer))
			return err
		},
		"AddKeySlots": func(caller *keyedMember) error {
			_, err := fixture.vaultKeys(0).AddKeySlots(t.Context(), authorized(&vaultsyncv1.AddKeySlotsRequest{
				VaultId: vaultID, Slots: []*vaultsyncv1.KeySlot{sealedSlot(t, alice.vaultID, 1, key, viewer)},
			}, caller.token))

			return err
		},
	}

	for name, call := range calls {
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(call(outsider)), "%s as a non-member", name)

		err := call(viewer)
		if name == "ListKeySlots" || name == "ListEpochs" || name == "ListLogEntries" {
			assert.NoError(t, err, "%s as a viewer", name)
		} else {
			assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "%s as a viewer", name)
		}
	}

	assert.Zero(t, fixture.epochs(t, alice).GetCurrentEpoch(), "nothing was rotated by a refused caller")

	// A plaintext vault has no epochs.
	alice.vaultID = fixture.createVault(t, alice.token, "Plain").GetId()
	state := fixture.epochs(t, alice)
	assert.Zero(t, state.GetCurrentEpoch())
	assert.False(t, state.GetRotationPending())
	assert.Empty(t, state.GetEpochs())

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, key, alice))
	assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
}

// An owner removing themselves from an E2EE vault with RemoveMember is
// refused and pointed to LeaveVault; nothing changes. In a plaintext vault
// it still works.
func TestRemoveMemberRefusesSelfRemovalFromAnE2EEVaultAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)

	first, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, alice.vaultID, 0, first, alice, bob))
	require.NoError(t, err)

	second, err := e2ee.GenerateKey()
	require.NoError(t, err)

	for _, next := range []*vaultsyncv1.NextEpoch{nextEpoch(t, alice.vaultID, 1, second, bob), nil} {
		err := fixture.removeWithEpoch(t, alice, alice, next)
		require.Error(t, err)
		assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
		assert.Contains(t, err.Error(), "LeaveVault")

		assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, fixture.roleIn(t, alice.token, vaultID), "alice stays")

		state := fixture.epochs(t, bob)
		assert.Equal(t, uint32(1), state.GetCurrentEpoch())
		assert.False(t, state.GetRotationPending())
		assert.Len(t, fixture.ownSlots(t, bob), 1, "no slot for a new epoch")
	}

	// A plaintext vault: unchanged.
	plain := fixture.createVault(t, alice.token, "Plain").GetId()
	alice.vaultID = plain
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER)

	require.NoError(t, fixture.removeWithEpoch(t, alice, alice, nil))
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, alice.token, plain))
}
