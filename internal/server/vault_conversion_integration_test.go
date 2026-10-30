//go:build integration

package server_test

import (
	"encoding/base64"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// convertibleMember registers a device for subject and creates their user
// key from a user secret, so that the bundle the server stores is the one
// their device signs with.
func (fixture *syncFixture) convertibleMember(t *testing.T, subject string) *keyedMember {
	t.Helper()

	client := fixture.client(t, subject, "")
	id := userID(t, fixture.pool, fixture.issuer.URL, subject)

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	bundle, err := secret.Bundle(id.String())
	require.NoError(t, err)

	material := newUserKeyMaterial(t)
	material.publicKey = bundle.KEMPub
	material.signPublicKey = bundle.SignPub
	require.NoError(t, fixture.createUserKey(t, client.token, material))

	return &keyedMember{syncClient: client, userID: id, publicKey: bundle.KEMPub, secret: secret}
}

// plaintextVault creates a plaintext vault owned by owner.
func (fixture *syncFixture) plaintextVault(t *testing.T, owner *keyedMember) {
	t.Helper()

	owner.vaultID = fixture.createVault(t, owner.token, "Notes").GetId()
}

// convertingMember is a member the members entry names, with its role.
type convertingMember struct {
	member *keyedMember
	role   e2ee.Role
}

// conversion is a ConvertVault request built as the owner's device builds
// it, and epoch 1's key.
type conversion struct {
	request  *vaultsyncv1.ConvertVaultRequest
	epochKey []byte
}

// conversionOf builds owner's conversion of their vault at its current head
// change sequence number (see conversionAt).
func (fixture *syncFixture) conversionOf(t *testing.T, owner *keyedMember, others []convertingMember, paths map[string]string) conversion {
	t.Helper()

	var headSeq int64

	err := fixture.pool.QueryRow(t.Context(), `SELECT head_seq FROM vaults WHERE id = $1`, owner.vaultID).Scan(&headSeq)
	require.NoError(t, err)

	return conversionAt(t, owner, others, paths, uint64(headSeq)) //nolint:gosec // head_seq is never negative.
}

// conversionAt builds owner's conversion of their vault: genesis, a members
// entry with convertedAtSeq naming others, epoch 1 wrapped to every member
// and its record at the log's head, and the path key of each live document
// in paths (document id to current path).
func conversionAt(t *testing.T, owner *keyedMember, others []convertingMember, paths map[string]string, convertedAtSeq uint64) conversion {
	t.Helper()

	vaultID := owner.vaultID

	ownerBundle, err := owner.secret.Bundle(owner.userID.String())
	require.NoError(t, err)

	genesisPayload, err := e2ee.GenesisPayload(ownerBundle, nil)
	require.NoError(t, err)

	genesis, err := e2ee.Entry{
		VaultID: vaultID, Seq: 1, PrevHash: make([]byte, e2ee.HashSize), Type: e2ee.EntryGenesis, Payload: genesisPayload,
	}.Sign(owner.secret.SignKey())
	require.NoError(t, err)

	entries := []e2ee.Entry{genesis}
	request := &vaultsyncv1.ConvertVaultRequest{VaultId: vaultID, Genesis: logtest.EntryMessage(genesis)}
	recipients := []*keyedMember{owner}

	listed := make([]e2ee.Member, 0, len(others))

	for _, other := range others {
		bundle, err := other.member.secret.Bundle(other.member.userID.String())
		require.NoError(t, err)

		listed = append(listed, e2ee.Member{Bundle: bundle, Role: other.role})
		recipients = append(recipients, other.member)
	}

	payload, err := e2ee.MembersPayload(convertedAtSeq, listed)
	require.NoError(t, err)

	prevHash, err := genesis.Hash()
	require.NoError(t, err)

	members, err := e2ee.Entry{
		VaultID: vaultID, Seq: 2, PrevHash: prevHash, Type: e2ee.EntryMembers, Payload: payload,
	}.Sign(owner.secret.SignKey())
	require.NoError(t, err)

	entries = append(entries, members)
	request.MembersEntry = logtest.EntryMessage(members)

	states, err := e2ee.ReplayLog(vaultID, entries, e2ee.ReplayOptions{})
	require.NoError(t, err)

	head := states[len(states)-1]

	epochKey, err := e2ee.GenerateKey()
	require.NoError(t, err)

	request.NextEpoch = nextEpoch(t, vaultID, 0, epochKey, recipients...)

	epochRecipients, err := e2ee.EpochRecipients(head)
	require.NoError(t, err)

	record, err := e2ee.EpochRecord{
		VaultID: vaultID, Epoch: 1, Commitment: request.GetNextEpoch().GetCommitment(), PrevCommitment: make([]byte, e2ee.MACSize),
		LogSeq: head.Seq, LogHash: head.Hash, Recipients: epochRecipients,
	}.Sign(owner.secret.SignKey())
	require.NoError(t, err)

	request.Record = logtest.RecordMessage(record)

	for documentID, path := range paths {
		request.PathKeys = append(request.PathKeys, &vaultsyncv1.DocumentPathKey{DocumentId: documentID, PathKey: pathKeyOf(t, epochKey, path)})
	}

	return conversion{request: request, epochKey: epochKey}
}

// pathKeyOf is path's encrypted path key under epoch 1's key.
func pathKeyOf(t *testing.T, epochKey []byte, path string) []byte {
	t.Helper()

	secret, err := e2ee.DeriveSubkey(epochKey, e2ee.LabelPathKeySecret)
	require.NoError(t, err)

	key, err := e2ee.PathKey(secret, path)
	require.NoError(t, err)

	return key
}

func (fixture *syncFixture) convert(t *testing.T, caller *keyedMember, request *vaultsyncv1.ConvertVaultRequest) (*vaultsyncv1.ConvertVaultResponse, error) {
	t.Helper()

	response, err := fixture.vaultKeys(0).ConvertVault(t.Context(), authorized(request, caller.token))
	if err != nil {
		return nil, err
	}

	return response.Msg, nil
}

// conversionRefusal returns the ConversionRefused detail of err, or nil.
func conversionRefusal(err error) *vaultsyncv1.ConversionRefused {
	connectErr, ok := errors.AsType[*connect.Error](err)
	if !ok {
		return nil
	}

	for _, detail := range connectErr.Details() {
		if value, valueErr := detail.Value(); valueErr == nil {
			if refused, ok := value.(*vaultsyncv1.ConversionRefused); ok {
				return refused
			}
		}
	}

	return nil
}

// conversionState is what a refused conversion must leave unchanged.
type conversionState struct {
	encryption    store.Encryption
	conversionSeq *int64
	logEntries    int
	epochs        int
	pathKeys      []string
}

func (fixture *syncFixture) conversionState(t *testing.T, vaultID string) conversionState {
	t.Helper()

	var state conversionState

	err := fixture.pool.QueryRow(t.Context(), `
		SELECT v.encryption, v.conversion_seq,
		       (SELECT count(*) FROM vault_log_entries WHERE vault_id = v.id),
		       (SELECT count(*) FROM vault_key_epochs WHERE vault_id = v.id),
		       ARRAY(SELECT path_key FROM documents WHERE vault_id = v.id ORDER BY id)
		FROM vaults v WHERE v.id = $1`, vaultID).
		Scan(&state.encryption, &state.conversionSeq, &state.logEntries, &state.epochs, &state.pathKeys)
	require.NoError(t, err)

	return state
}

func TestConvertVaultRefusesMembersWithoutAKeyAndPendingInvitationsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.convertibleMember(t, "alice")
	fixture.plaintextVault(t, alice)

	bob := fixture.convertibleMember(t, "bob")
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	// Dave is a member without a user key.
	dave := &keyedMember{syncClient: fixture.client(t, "dave", "")}
	dave.userID = userID(t, fixture.pool, fixture.issuer.URL, "dave")
	fixture.join(t, alice, dave, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	invitation := fixture.mustInvite(t, alice.token, alice.vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	before := fixture.conversionState(t, alice.vaultID)
	request := fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, nil).request

	_, err := fixture.convert(t, alice, request)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%v", err)

	refusal := conversionRefusal(err)
	require.NotNil(t, refusal, "the refusal lists what blocks the conversion")
	assert.Equal(t, []string{dave.userID.String()}, refusal.GetMembersWithoutKey())
	assert.Equal(t, []string{invitation.GetInvitation().GetId()}, refusal.GetPendingInvitations())
	assert.Equal(t, before, fixture.conversionState(t, alice.vaultID), "a refused conversion changes nothing")

	// Revoking the invitation leaves only the member without a key.
	_, err = fixture.members(0).RevokeInvitation(t.Context(), authorized(&vaultsyncv1.RevokeInvitationRequest{
		VaultId: alice.vaultID, InvitationId: invitation.GetInvitation().GetId(),
	}, alice.token))
	require.NoError(t, err)

	_, err = fixture.convert(t, alice, request)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%v", err)

	refusal = conversionRefusal(err)
	require.NotNil(t, refusal)
	assert.Equal(t, []string{dave.userID.String()}, refusal.GetMembersWithoutKey())
	assert.Empty(t, refusal.GetPendingInvitations())
	assert.Equal(t, before, fixture.conversionState(t, alice.vaultID))

	// A pending invitation alone blocks a vault whose members all have keys.
	erin := fixture.convertibleMember(t, "erin")
	fixture.plaintextVault(t, erin)
	pending := fixture.mustInvite(t, erin.token, erin.vaultID, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	_, err = fixture.convert(t, erin, fixture.conversionOf(t, erin, nil, nil).request)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%v", err)

	refusal = conversionRefusal(err)
	require.NotNil(t, refusal)
	assert.Empty(t, refusal.GetMembersWithoutKey())
	assert.Equal(t, []string{pending.GetInvitation().GetId()}, refusal.GetPendingInvitations())
	assert.Equal(t, store.EncryptionNone, fixture.conversionState(t, erin.vaultID).encryption)
}

// convertedVault is a plaintext vault with history, converted by its owner.
type convertedVault struct {
	alice, bob, carol *keyedMember
	conversion        conversion
	response          *vaultsyncv1.ConvertVaultResponse
	// edited has two revisions; deleted is a tombstone; kept is live.
	edited, deleted, kept *vaultsyncv1.Revision
	editedFirst           *vaultsyncv1.Revision
	headBefore            uint64
}

func newConvertedVault(t *testing.T, fixture *syncFixture) convertedVault {
	t.Helper()

	var vault convertedVault

	vault.alice = fixture.convertibleMember(t, "alice")
	fixture.plaintextVault(t, vault.alice)

	vault.bob = fixture.convertibleMember(t, "bob")
	fixture.join(t, vault.alice, vault.bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	vault.carol = fixture.convertibleMember(t, "carol")
	fixture.join(t, vault.alice, vault.carol, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER)

	alice := vault.alice
	vault.editedFirst = alice.mustCommit(t, alice.create(t, "Plan.md", alice.content(t, "first")))
	vault.edited = alice.mustCommit(t, alice.next(t, vault.editedFirst, "Plans/Plan.md", alice.content(t, "second"), false))
	created := alice.mustCommit(t, alice.create(t, "Old.md", alice.content(t, "old")))
	vault.deleted = alice.mustCommit(t, alice.next(t, created, "Old.md", alice.content(t, "old"), true))
	vault.kept = vault.bob.mustCommit(t, vault.bob.create(t, "Kept.md", vault.bob.content(t, "kept")))
	vault.headBefore = vault.kept.GetSeq()

	vault.conversion = fixture.conversionOf(t, alice, []convertingMember{{vault.bob, e2ee.RoleEditor}, {vault.carol, e2ee.RoleViewer}},
		map[string]string{vault.edited.GetDocumentId(): "Plans/Plan.md", vault.kept.GetDocumentId(): "Kept.md"})

	response, err := fixture.convert(t, alice, vault.conversion.request)
	require.NoError(t, err)

	vault.response = response

	return vault
}

func TestConvertVaultRefusesAStaleOrInconsistentConversionAtomicallyAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.convertibleMember(t, "alice")
	fixture.plaintextVault(t, alice)

	bob := fixture.convertibleMember(t, "bob")
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	plan := alice.mustCommit(t, alice.create(t, "Plan.md", alice.content(t, "plan")))
	notes := alice.mustCommit(t, alice.create(t, "Notes.md", alice.content(t, "notes")))
	paths := map[string]string{plan.GetDocumentId(): "Plan.md", notes.GetDocumentId(): "Notes.md"}
	before := fixture.conversionState(t, alice.vaultID)

	tests := []struct {
		name    string
		request func() *vaultsyncv1.ConvertVaultRequest
		code    connect.Code
	}{
		{
			name: "a live document without its path key",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				return fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, map[string]string{plan.GetDocumentId(): "Plan.md"}).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "a path key for a document the vault does not have",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				extra := map[string]string{uuid.Must(uuid.NewV7()).String(): "Other.md"}
				for id, path := range paths {
					extra[id] = path
				}

				return fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, extra).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "two live documents with the same path key",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				return fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}},
					map[string]string{plan.GetDocumentId(): "Same.md", notes.GetDocumentId(): "same.md"}).request
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "a members entry with another role than the server's",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				return fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleViewer}}, paths).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "a members entry without the vault's other members",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				request := fixture.conversionOf(t, alice, nil, paths).request
				request.NextEpoch.Slots = append(request.NextEpoch.Slots, sealedSlot(t, alice.vaultID, 0, make([]byte, 32), bob))

				return request
			},
			code: connect.CodeAborted,
		},
		{
			name: "no members entry",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				request := fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths).request
				request.MembersEntry = nil
				request.Record.LogSeq = 1

				return request
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "a converted_at_seq before the vault's head",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				return conversionAt(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths, notes.GetSeq()-1).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "a converted_at_seq after the vault's head",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				return conversionAt(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths, notes.GetSeq()+1).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "a member's keys other than the server's",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				impostor := &keyedMember{syncClient: bob.syncClient, userID: bob.userID}
				secret, err := e2ee.GenerateUserSecret()
				require.NoError(t, err)

				bundle, err := secret.Bundle(bob.userID.String())
				require.NoError(t, err)

				impostor.secret, impostor.publicKey = secret, bundle.KEMPub

				return fixture.conversionOf(t, alice, []convertingMember{{impostor, e2ee.RoleEditor}}, paths).request
			},
			code: connect.CodeAborted,
		},
		{
			name: "a record that names the genesis instead of the members entry",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				request := fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths).request
				request.Record.LogSeq = 1

				return request
			},
			code: connect.CodeInvalidArgument,
		},
		{
			name: "a genesis signed by another key than the caller's",
			request: func() *vaultsyncv1.ConvertVaultRequest {
				request := fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths).request
				request.Genesis.Signatures[0][0] ^= 0xff

				return request
			},
			code: connect.CodeInvalidArgument,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := fixture.convert(t, alice, test.request())
			require.Equal(t, test.code, connect.CodeOf(err), "%v", err)
			assert.Equal(t, before, fixture.conversionState(t, alice.vaultID), "a refused conversion changes nothing")
		})
	}

	// The same vault then converts.
	_, err := fixture.convert(t, alice, fixture.conversionOf(t, alice, []convertingMember{{bob, e2ee.RoleEditor}}, paths).request)
	require.NoError(t, err)
}

func TestConvertVaultKeepsHistoryAndMembersAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	vault := newConvertedVault(t, fixture)
	alice := vault.alice

	assert.Equal(t, uint32(1), vault.response.GetEpoch().GetEpoch())
	assert.Equal(t, vault.headBefore, vault.response.GetConversionSeq(), "the conversion records the vault's head seq")

	// The vault is encrypted at epoch 1, with its log and the conversion seq.
	listed, err := fixture.vaultClient().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{}, alice.token))
	require.NoError(t, err)
	require.Len(t, listed.Msg.GetVaults(), 1)
	assert.Equal(t, vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE, listed.Msg.GetVaults()[0].GetEncryption())

	epochs := fixture.epochs(t, vault.carol)
	assert.Equal(t, uint32(1), epochs.GetCurrentEpoch())
	assert.False(t, epochs.GetRotationPending())
	assert.Equal(t, vault.headBefore, epochs.GetConversionSeq())
	assert.Len(t, fixture.listedLog(t, alice), 2, "genesis and the members entry")

	// Every member keeps their role and gets a slot for epoch 1.
	members, err := fixture.members(0).ListMembers(t.Context(), authorized(&vaultsyncv1.ListMembersRequest{VaultId: alice.vaultID}, alice.token))
	require.NoError(t, err)

	roles := map[string]vaultsyncv1.VaultRole{}
	for _, member := range members.Msg.GetMembers() {
		roles[member.GetUserId()] = member.GetRole()
	}

	assert.Equal(t, map[string]vaultsyncv1.VaultRole{
		alice.userID.String():       vaultsyncv1.VaultRole_VAULT_ROLE_OWNER,
		vault.bob.userID.String():   vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR,
		vault.carol.userID.String(): vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER,
	}, roles)

	for _, member := range []*keyedMember{alice, vault.bob, vault.carol} {
		slots := fixture.ownSlots(t, member)
		require.Len(t, slots, 1, "slot of %s", member.userID)
		assert.Equal(t, uint32(1), slots[0].GetEpoch())
	}

	// History is kept as it was, at epoch 0, every revision at or below the
	// conversion seq.
	history, err := alice.sync(0).GetDocumentHistory(t.Context(), authorized(&vaultsyncv1.GetDocumentHistoryRequest{
		VaultId: alice.vaultID, DocumentId: vault.edited.GetDocumentId(),
	}, alice.token))
	require.NoError(t, err)
	require.Len(t, history.Msg.GetRevisions(), 2)
	assert.Equal(t, []byte("Plans/Plan.md"), history.Msg.GetRevisions()[0].GetPath())
	assert.Equal(t, []byte("Plan.md"), history.Msg.GetRevisions()[1].GetPath())

	for _, revision := range history.Msg.GetRevisions() {
		assert.Equal(t, uint32(0), revision.GetEpoch())
	}

	tombstone, err := alice.sync(0).GetDocumentHistory(t.Context(), authorized(&vaultsyncv1.GetDocumentHistoryRequest{
		VaultId: alice.vaultID, DocumentId: vault.deleted.GetDocumentId(),
	}, alice.token))
	require.NoError(t, err)
	assert.True(t, tombstone.Msg.GetRevisions()[0].GetDeleted())
	assert.Len(t, tombstone.Msg.GetRevisions(), 2)

	var laterPlaintext int

	err = fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM revisions WHERE vault_id = $1 AND epoch = 0 AND seq > $2`,
		alice.vaultID, int64(vault.headBefore)).Scan(&laterPlaintext)
	require.NoError(t, err)
	assert.Zero(t, laterPlaintext)

	// Live documents now carry the encrypted path keys.
	for documentID, path := range map[string]string{vault.edited.GetDocumentId(): "Plans/Plan.md", vault.kept.GetDocumentId(): "Kept.md"} {
		var stored string

		err := fixture.pool.QueryRow(t.Context(), `SELECT path_key FROM documents WHERE id = $1`, documentID).Scan(&stored)
		require.NoError(t, err)
		assert.Equal(t, base64.RawURLEncoding.EncodeToString(pathKeyOf(t, vault.conversion.epochKey, path)), stored)
	}

	// A second conversion is refused.
	_, err = fixture.convert(t, alice, fixture.conversionOf(t, alice, nil, nil).request)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%v", err)
	assert.Nil(t, conversionRefusal(err))
}

func TestConvertedVaultRefusesPlaintextCommitsAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	vault := newConvertedVault(t, fixture)
	alice := vault.alice

	// A plaintext edit and a plaintext new document are refused with
	// VAULT_ENCRYPTED.
	for name, request := range map[string]*vaultsyncv1.CommitRevisionRequest{
		"edit":         alice.next(t, vault.edited, "Plans/Plan.md", alice.content(t, "third"), false),
		"new document": alice.create(t, "New.md", alice.content(t, "new")),
	} {
		_, err := alice.commit(t, request)
		require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%s: %v", name, err)
		assert.Equal(t, vaultsyncv1.ErrorReason_ERROR_REASON_VAULT_ENCRYPTED, api.ErrorReasonOf(err), name)
	}

	// A plaintext commit that read the vault before the switch is refused
	// under the vault row lock too.
	content := alice.content(t, "raced")
	_, err := store.New(fixture.pool).InVault(uuid.MustParse(alice.vaultID)).CommitRevision(t.Context(), store.NewRevision{
		ID: uuid.Must(uuid.NewV7()), DocumentID: uuid.Must(uuid.NewV7()), Kind: "text",
		ContentRef: content.GetBlobId(), ContentSize: int64(content.GetSize()), //nolint:gosec // a small test blob.
		Path: "Raced.md", PathKey: "raced.md", DeviceID: uuid.MustParse(alice.deviceID), UserID: alice.userID,
	})
	require.ErrorIs(t, err, store.ErrVaultEncrypted)

	// An encrypted commit at epoch 1 edits a converted document, and the
	// converted path keys still keep paths unique.
	edit := alice.next(t, vault.edited, "", alice.content(t, "sealed"), false)
	edit.Path = opaqueBytes(t, 64)
	edit.PathKey = pathKeyOf(t, vault.conversion.epochKey, "Plans/Plan.md")
	edit.Epoch = 1
	_, err = alice.commit(t, edit)
	require.NoError(t, err)

	clash := alice.encryptedCreate(t, 1, opaqueBytes(t, 64), pathKeyOf(t, vault.conversion.epochKey, "KEPT.md"), alice.content(t, "clash"))
	_, err = alice.commit(t, clash)
	require.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err), "%v", err)

	// Epoch 0 is accepted for a revision committed before the conversion:
	// the re-key job moves it to epoch 1.
	replaced, err := fixture.vaultKeys(0).ReplaceRevisionCiphertext(t.Context(), authorized(&vaultsyncv1.ReplaceRevisionCiphertextRequest{
		VaultId: alice.vaultID, RevisionId: vault.editedFirst.GetId(), FromEpoch: 0, ToEpoch: 1,
		Path: opaqueBytes(t, 64), ContentRef: alice.content(t, "first, sealed"),
	}, alice.token))
	require.NoError(t, err)
	assert.True(t, replaced.Msg.GetReplaced())
}
