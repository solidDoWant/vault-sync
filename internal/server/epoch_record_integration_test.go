//go:build integration

package server_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"slices"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/e2ee/logtest"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// membershipLogs holds the membership log written for each vault whose
// members were added without log entries (e2eeVault and join), so that
// their rotations can carry a signed epoch record.
var membershipLogs = struct {
	sync.Mutex
	byVault map[string]membershipLog
}{byVault: map[string]membershipLog{}}

type membershipLog struct {
	members string
	log     *logtest.Log
}

// vaultLog returns a membership log matching the vault's keyed members and
// their roles, signed by fresh keys, and stores it as the vault's log. It
// rewrites the log only when the members changed since the last call.
func (fixture *syncFixture) vaultLog(t *testing.T, vaultID string) *logtest.Log {
	t.Helper()

	rows, err := fixture.pool.Query(t.Context(), `
		SELECT m.user_id, m.role FROM vault_members m JOIN user_keys k ON k.user_id = m.user_id
		WHERE m.vault_id = $1 ORDER BY m.role = 'owner' DESC, m.user_id`, vaultID)
	require.NoError(t, err)

	type member struct {
		userID uuid.UUID
		role   store.Role
	}

	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (member, error) {
		var value member

		return value, row.Scan(&value.userID, &value.role)
	})
	require.NoError(t, err)
	require.NotEmpty(t, members)
	require.Equal(t, store.RoleOwner, members[0].role, "the vault has an owner")

	key := fmt.Sprint(members)

	membershipLogs.Lock()
	defer membershipLogs.Unlock()

	if cached, ok := membershipLogs.byVault[vaultID]; ok && cached.members == key {
		return cached.log
	}

	roles := map[store.Role]e2ee.Role{store.RoleOwner: e2ee.RoleOwner, store.RoleEditor: e2ee.RoleEditor, store.RoleViewer: e2ee.RoleViewer}
	log := logtest.New(t, uuid.MustParse(vaultID), members[0].userID, nil)

	for _, joined := range members[1:] {
		log.Join(t, members[0].userID, joined.userID, roles[joined.role])
	}

	err = pgx.BeginFunc(t.Context(), fixture.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(t.Context(), `DELETE FROM vault_log_entries WHERE vault_id = $1`, vaultID); err != nil {
			return err
		}

		for _, entry := range log.Entries {
			_, err := tx.Exec(t.Context(), `
				INSERT INTO vault_log_entries (vault_id, seq, prev_hash, entry_type, payload, signatures)
				VALUES ($1, $2, $3, $4, $5, $6)`, vaultID, entry.Seq, entry.PrevHash, int16(entry.Type), entry.Payload, entry.Signatures)
			if err != nil {
				return err
			}
		}

		return nil
	})
	require.NoError(t, err)

	membershipLogs.byVault[vaultID] = membershipLog{members: key, log: log}

	return log
}

// signedRecord is the record of next in vaultID, signed at the log's head
// by signerID (an owner's key, or the caller's when it is not an owner).
func (fixture *syncFixture) signedRecord(t *testing.T, log *logtest.Log, vaultID string, signerID uuid.UUID, next *vaultsyncv1.NextEpoch) *vaultsyncv1.EpochRecord {
	t.Helper()

	var prevCommitment []byte

	if next.GetExpectedEpoch() > 0 {
		err := fixture.pool.QueryRow(t.Context(), `SELECT commitment FROM vault_key_epochs WHERE vault_id = $1 AND epoch = $2`,
			vaultID, next.GetExpectedEpoch()).Scan(&prevCommitment)
		if err != nil {
			prevCommitment = make([]byte, e2ee.MACSize)
		}
	}

	if _, ok := log.Secrets[signerID.String()]; !ok {
		signerID = firstOwner(t, log)
	}

	return logtest.RecordMessage(log.Record(t, signerID, uint64(next.GetExpectedEpoch())+1, next.GetCommitment(), prevCommitment))
}

func firstOwner(t *testing.T, log *logtest.Log) uuid.UUID {
	t.Helper()

	states := log.States(t)
	for userID, member := range states[len(states)-1].Members {
		if member.Role == e2ee.RoleOwner {
			return uuid.MustParse(userID)
		}
	}

	require.FailNow(t, "the log has no owner")

	return uuid.Nil
}

// e2eeVaultByAPI creates an E2EE vault owned by owner through CreateVault,
// with a genuine genesis entry, and returns its log.
func (fixture *syncFixture) e2eeVaultByAPI(t *testing.T, owner *keyedMember) *logtest.Log {
	t.Helper()

	vaultID := uuid.Must(uuid.NewV7())
	log := logtest.New(t, vaultID, owner.userID, nil)

	_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name: "Secret", Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE,
		NewVaultId: vaultID.String(), Genesis: logtest.EntryMessage(log.Entries[0]),
	}, owner.token))
	require.NoError(t, err)

	owner.vaultID = vaultID.String()

	return log
}

func (fixture *syncFixture) rotateSigned(t *testing.T, caller *keyedMember, request *vaultsyncv1.RotateEpochRequest) (*vaultsyncv1.KeyEpoch, error) {
	t.Helper()

	request.VaultId = caller.vaultID

	response, err := fixture.vaultKeys(0).RotateEpoch(t.Context(), authorized(request, caller.token))
	if err != nil {
		return nil, err
	}

	return response.Msg.GetEpoch(), nil
}

// vaultSnapshot is what a refused rotation must leave unchanged.
type vaultSnapshot struct {
	currentEpoch int32
	escrow       bool
	epochs       int
	slots        int
	logEntries   int
}

func (fixture *syncFixture) snapshot(t *testing.T, vaultID string) vaultSnapshot {
	t.Helper()

	var snapshot vaultSnapshot

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `
		SELECT current_epoch, escrow,
			(SELECT count(*) FROM vault_key_epochs WHERE vault_id = $1),
			(SELECT count(*) FROM key_slots WHERE vault_id = $1),
			(SELECT count(*) FROM vault_log_entries WHERE vault_id = $1)
		FROM vaults WHERE id = $1`, vaultID).
		Scan(&snapshot.currentEpoch, &snapshot.escrow, &snapshot.epochs, &snapshot.slots, &snapshot.logEntries))

	return snapshot
}

// A RotateEpoch whose record is not signed by an owner at its log position,
// or whose recipients differ from the log, is refused and nothing changes;
// a valid one creates the epoch and stores its record, which ListEpochs
// returns. An owner's escrow entry turns escrow on in the same transaction.
func TestRotateEpochVerifiesTheSignedRecordAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	log := fixture.e2eeVaultByAPI(t, alice)

	epochKey := bytes.Repeat([]byte{1}, 32)
	request := func(t *testing.T) *vaultsyncv1.RotateEpochRequest {
		t.Helper()

		next := nextEpoch(t, alice.vaultID, 0, epochKey, alice)

		return &vaultsyncv1.RotateEpochRequest{NextEpoch: next, Record: fixture.signedRecord(t, log, alice.vaultID, alice.userID, next)}
	}

	_, stranger, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	refused := map[string]func(t *testing.T, request *vaultsyncv1.RotateEpochRequest){
		"no record": func(_ *testing.T, request *vaultsyncv1.RotateEpochRequest) { request.Record = nil },
		"signed by a key outside the log": func(t *testing.T, request *vaultsyncv1.RotateEpochRequest) {
			record := log.Record(t, alice.userID, 1, request.GetNextEpoch().GetCommitment(), nil)
			signed, err := record.Sign(stranger)
			require.NoError(t, err)

			request.Record = logtest.RecordMessage(signed)
		},
		"an extra recipient": func(t *testing.T, request *vaultsyncv1.RotateEpochRequest) {
			record := log.Record(t, alice.userID, 1, request.GetNextEpoch().GetCommitment(), nil)
			record.Recipients = append(record.Recipients, e2ee.EpochRecipient{Kind: 0x01, ID: bytes.Repeat([]byte{0xff}, 16), KeyHash: make([]byte, 32)})
			signed, err := record.Sign(log.SignKey(alice.userID))
			require.NoError(t, err)

			request.Record = logtest.RecordMessage(signed)
		},
		"a recipient with another key than the log's": func(t *testing.T, request *vaultsyncv1.RotateEpochRequest) {
			record := log.Record(t, alice.userID, 1, request.GetNextEpoch().GetCommitment(), nil)
			record.Recipients[0].KeyHash = bytes.Repeat([]byte{2}, 32)
			signed, err := record.Sign(log.SignKey(alice.userID))
			require.NoError(t, err)

			request.Record = logtest.RecordMessage(signed)
		},
		"an escrow entry signed by a key outside the log": func(t *testing.T, request *vaultsyncv1.RotateEpochRequest) {
			entry := log.Entry(t, e2ee.EntryEscrow, []byte{0x00}, stranger)
			request.EscrowEntry = logtest.EntryMessage(entry)
		},
	}

	before := fixture.snapshot(t, alice.vaultID)

	for name, mutate := range refused {
		t.Run(name, func(t *testing.T) {
			request := request(t)
			mutate(t, request)

			_, err := fixture.rotateSigned(t, alice, request)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
			assert.Equal(t, before, fixture.snapshot(t, alice.vaultID), "nothing changes")
		})
	}

	valid := request(t)
	created, err := fixture.rotateSigned(t, alice, valid)
	require.NoError(t, err)
	assert.Equal(t, uint32(1), created.GetEpoch())
	assert.True(t, proto.Equal(valid.GetRecord(), created.GetRecord()), "the record is returned as signed")

	listed := fixture.epochs(t, alice)
	require.Len(t, listed.GetEpochs(), 1)
	assert.True(t, proto.Equal(valid.GetRecord(), listed.GetEpochs()[0].GetRecord()), "ListEpochs returns the stored record")

	// Turning escrow on: the owner's escrow entry and the record at it.
	escrowPublic := fixture.escrowPublic

	escrowID, err := e2ee.EscrowKeyID(escrowPublic)
	require.NoError(t, err)

	entry := log.Escrow(t, alice.userID, fixture.escrowBundle)
	next := nextEpoch(t, alice.vaultID, 1, epochKey, alice)
	next.Slots = append(next.Slots, &vaultsyncv1.KeySlot{
		RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, RecipientId: escrowID, WrappedKey: bytes.Repeat([]byte{9}, 105),
	})

	escrowOn := &vaultsyncv1.RotateEpochRequest{
		NextEpoch: next, EscrowEntry: logtest.EntryMessage(entry),
		Record: logtest.RecordMessage(log.Record(t, alice.userID, 2, next.GetCommitment(), created.GetCommitment())),
	}

	_, err = fixture.rotateSigned(t, alice, escrowOn)
	require.NoError(t, err)

	after := fixture.snapshot(t, alice.vaultID)
	assert.Equal(t, vaultSnapshot{currentEpoch: 2, escrow: true, epochs: 2, slots: 3, logEntries: 2}, after, "the entry, the epoch and escrow land together")

	page, err := fixture.logEntries(t, alice, 0, "")
	require.NoError(t, err)
	require.Len(t, page.GetEntries(), 2)
	assert.True(t, proto.Equal(escrowOn.GetEscrowEntry(), page.GetEntries()[1]), "the escrow entry is appended as signed")
}

// A plaintext vault's RotateEpoch is refused as before, with or without a
// record and an escrow entry, and no log entry is stored.
func TestRotateEpochOnAPlaintextVaultIsUnchangedAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")

	vault, err := store.New(fixture.pool).CreateVault(t.Context(), alice.userID, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 100)
	require.NoError(t, err)

	alice.vaultID = vault.ID.String()
	next := nextEpoch(t, alice.vaultID, 0, bytes.Repeat([]byte{1}, 32), alice)
	log := logtest.New(t, vault.ID, alice.userID, nil)

	for name, request := range map[string]*vaultsyncv1.RotateEpochRequest{
		"without a record": {NextEpoch: next},
		"with a record and an escrow entry": {
			NextEpoch: next, Record: logtest.RecordMessage(log.Record(t, alice.userID, 1, next.GetCommitment(), nil)),
			EscrowEntry: logtest.EntryMessage(log.Entry(t, e2ee.EntryEscrow, []byte{0x00}, log.SignKey(alice.userID))),
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := fixture.rotateSigned(t, alice, request)
			assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
			assert.Equal(t, vaultSnapshot{}, fixture.snapshot(t, alice.vaultID))
		})
	}
}

// An E2EE RemoveMember stores the entry, the epoch and its record together
// when the record is signed by an owner at the remove-member entry, names
// that entry and lists the log's recipients after it; a missing record,
// another signer, another position or other recipients are refused as
// RotateEpoch refuses them, and nothing changes.
func TestRemoveMemberVerifiesTheSignedRecordAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")
	carol := fixture.keyedMember(t, "carol")

	vaultID := fixture.e2eeVault(t, alice, false)
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)
	fixture.join(t, alice, carol, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	first, err := e2ee.GenerateKey()
	require.NoError(t, err)

	_, err = fixture.rotate(t, 0, alice, nextEpoch(t, vaultID, 0, first, alice, bob, carol))
	require.NoError(t, err)

	second, err := e2ee.GenerateKey()
	require.NoError(t, err)

	log, ok := fixture.signedLog(t, alice)
	require.True(t, ok, "the membership changes built the vault's log")

	firstCommitment := fixture.epochs(t, alice).GetEpochs()[0].GetCommitment()

	// removal is a valid removal of bob; afterRemoval is the log with its
	// entry appended, for records built by hand.
	removal := func(t *testing.T) (*vaultsyncv1.RemoveMemberRequest, *logtest.Log) {
		t.Helper()

		request := fixture.removalRequest(t, alice, bob, nextEpoch(t, vaultID, 1, second, alice, carol))
		require.NotNil(t, request.GetRecord())

		afterRemoval := &logtest.Log{
			VaultID: vaultID, Entries: append(slices.Clone(log.Entries), logEntryOf(vaultID, request.GetLogEntry())),
			Secrets: map[string]e2ee.UserSecret{alice.userID.String(): alice.secret},
		}

		return request, afterRemoval
	}

	_, stranger, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	resign := func(t *testing.T, record e2ee.EpochRecord, key ed25519.PrivateKey) *vaultsyncv1.EpochRecord {
		t.Helper()

		signed, err := record.Sign(key)
		require.NoError(t, err)

		return logtest.RecordMessage(signed)
	}

	refused := map[string]func(t *testing.T, request *vaultsyncv1.RemoveMemberRequest, afterRemoval *logtest.Log){
		"no record": func(_ *testing.T, request *vaultsyncv1.RemoveMemberRequest, _ *logtest.Log) { request.Record = nil },
		"signed by a key outside the log": func(t *testing.T, request *vaultsyncv1.RemoveMemberRequest, afterRemoval *logtest.Log) {
			record := afterRemoval.Record(t, alice.userID, 2, request.GetNextEpoch().GetCommitment(), firstCommitment)
			request.Record = resign(t, record, stranger)
		},
		"signed by an editor": func(t *testing.T, request *vaultsyncv1.RemoveMemberRequest, afterRemoval *logtest.Log) {
			record := afterRemoval.Record(t, alice.userID, 2, request.GetNextEpoch().GetCommitment(), firstCommitment)
			request.Record = resign(t, record, carol.secret.SignKey())
		},
		"at the log position before the entry": func(t *testing.T, request *vaultsyncv1.RemoveMemberRequest, _ *logtest.Log) {
			before := &logtest.Log{VaultID: vaultID, Entries: log.Entries, Secrets: log.Secrets}
			record := before.Record(t, alice.userID, 2, request.GetNextEpoch().GetCommitment(), firstCommitment)
			// The members there include bob; drop him so only the position differs.
			record.Recipients = slices.DeleteFunc(record.Recipients, func(recipient e2ee.EpochRecipient) bool {
				return bytes.Equal(recipient.ID, bob.userID[:])
			})
			request.Record = resign(t, record, alice.secret.SignKey())
		},
		"the removed member as a recipient": func(t *testing.T, request *vaultsyncv1.RemoveMemberRequest, afterRemoval *logtest.Log) {
			record := afterRemoval.Record(t, alice.userID, 2, request.GetNextEpoch().GetCommitment(), firstCommitment)
			record.Recipients = append(record.Recipients, e2ee.EpochRecipient{Kind: 0x01, ID: bob.userID[:], KeyHash: record.Recipients[0].KeyHash})
			slices.SortFunc(record.Recipients, func(left, right e2ee.EpochRecipient) int {
				if left.Kind != right.Kind {
					return int(left.Kind) - int(right.Kind)
				}

				return bytes.Compare(left.ID, right.ID)
			})
			request.Record = resign(t, record, alice.secret.SignKey())
		},
	}

	before := fixture.snapshot(t, vaultID)

	for name, mutate := range refused {
		t.Run(name, func(t *testing.T) {
			request, afterRemoval := removal(t)
			mutate(t, request, afterRemoval)

			_, err := fixture.members(1).RemoveMember(t.Context(), authorized(request, alice.token))
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
			require.ErrorContains(t, err, store.ErrEpochRecord.Error())
			assert.Equal(t, before, fixture.snapshot(t, vaultID), "neither the entry nor the epoch is stored")
			assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, bob.token, vaultID), "bob stays")
		})
	}

	valid, _ := removal(t)
	_, err = fixture.members(1).RemoveMember(t.Context(), authorized(valid, alice.token))
	require.NoError(t, err)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED, fixture.roleIn(t, bob.token, vaultID))

	after := fixture.snapshot(t, vaultID)
	assert.Equal(t, before.logEntries+1, after.logEntries, "the entry is appended")
	assert.Equal(t, int32(2), after.currentEpoch)

	listed := fixture.epochs(t, alice)
	require.Len(t, listed.GetEpochs(), 2)
	assert.True(t, proto.Equal(valid.GetRecord(), listed.GetEpochs()[1].GetRecord()), "the removal's epoch carries its record")
}

// A plaintext vault's removal takes no record.
func TestRemoveMemberOfAPlaintextVaultTakesNoRecordAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")
	bob := fixture.keyedMember(t, "bob")

	vaultID := fixture.createVault(t, alice.token, "Plain").GetId()
	alice.vaultID = vaultID
	fixture.join(t, alice, bob, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR)

	log := logtest.New(t, uuid.MustParse(vaultID), alice.userID, nil)
	next := nextEpoch(t, vaultID, 0, bytes.Repeat([]byte{1}, 32), alice)
	record := logtest.RecordMessage(log.Record(t, alice.userID, 1, next.GetCommitment(), nil))

	for name, request := range map[string]*vaultsyncv1.RemoveMemberRequest{
		"a record alone":           {VaultId: vaultID, UserId: bob.userID.String(), Record: record},
		"a record with next_epoch": {VaultId: vaultID, UserId: bob.userID.String(), Record: record, NextEpoch: next},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := fixture.members(1).RemoveMember(t.Context(), authorized(request, alice.token))
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
			assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR, fixture.roleIn(t, bob.token, vaultID), "bob stays")
		})
	}

	require.NoError(t, fixture.removeWithEpoch(t, alice, bob, nil))
}

// A vault whose log names an escrow key before the escrow chain's head
// takes new epochs escrowed to that key until its owner adopts the head.
// After turning escrow off, the owner turns it on again with the head
// through an escrow reset entry and an escrow on entry, which are appended
// with the epoch in one transaction.
func TestRotateEpochAdoptsTheEscrowChainHeadAfterAnEscrowResetAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.keyedMember(t, "alice")

	_, oldPublic, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	old := escrowBundleOf(t, oldPublic)
	oldKeyID, err := e2ee.EscrowKeyID(oldPublic)
	require.NoError(t, err)

	headKeyID, err := e2ee.EscrowKeyID(fixture.escrowPublic)
	require.NoError(t, err)

	vaultID := uuid.Must(uuid.NewV7())
	log := logtest.New(t, vaultID, alice.userID, old)
	genesis := log.Entries[0]

	_, err = store.New(fixture.pool).CreateVault(t.Context(), alice.userID, store.NewVault{
		ID: vaultID, Name: "Secret", Encryption: store.EncryptionE2EE, Escrow: true,
		Genesis: &store.LogEntry{Seq: 1, PrevHash: genesis.PrevHash, Type: byte(genesis.Type), Payload: genesis.Payload, Signatures: genesis.Signatures},
	}, 100)
	require.NoError(t, err)

	alice.vaultID = vaultID.String()
	epochKey := bytes.Repeat([]byte{1}, 32)
	escrowSlot := func(keyID string) *vaultsyncv1.KeySlot {
		return &vaultsyncv1.KeySlot{RecipientKind: vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW, RecipientId: keyID, WrappedKey: bytes.Repeat([]byte{9}, 105)}
	}

	// Until adoption: epoch 1 is escrowed to the key the log names.
	next := nextEpoch(t, alice.vaultID, 0, epochKey, alice)
	next.Slots = append(next.Slots, escrowSlot(oldKeyID))
	first, err := fixture.rotateSigned(t, alice, &vaultsyncv1.RotateEpochRequest{NextEpoch: next, Record: fixture.signedRecord(t, log, alice.vaultID, alice.userID, next)})
	require.NoError(t, err)

	// Escrow off.
	off := log.Escrow(t, alice.userID, nil)
	next = nextEpoch(t, alice.vaultID, 1, epochKey, alice)
	second, err := fixture.rotateSigned(t, alice, &vaultsyncv1.RotateEpochRequest{
		NextEpoch: next, EscrowEntry: logtest.EntryMessage(off),
		Record: logtest.RecordMessage(log.Record(t, alice.userID, 2, next.GetCommitment(), first.GetCommitment())),
	})
	require.NoError(t, err)

	// Escrow on again with the head: the reset entry, then the on entry.
	reset := log.EscrowReset(t, alice.userID, *old, *fixture.escrowBundle)
	on := log.Escrow(t, alice.userID, fixture.escrowBundle)
	next = nextEpoch(t, alice.vaultID, 2, epochKey, alice)
	next.Slots = append(next.Slots, escrowSlot(headKeyID))
	adopt := &vaultsyncv1.RotateEpochRequest{
		NextEpoch: next, EscrowResetEntry: logtest.EntryMessage(reset), EscrowEntry: logtest.EntryMessage(on),
		Record: logtest.RecordMessage(log.Record(t, alice.userID, 3, next.GetCommitment(), second.GetCommitment())),
	}

	_, err = fixture.rotateSigned(t, alice, adopt)
	require.NoError(t, err)

	assert.Equal(t, vaultSnapshot{currentEpoch: 3, escrow: true, epochs: 3, slots: 5, logEntries: 4}, fixture.snapshot(t, alice.vaultID),
		"both entries, the epoch and escrow land together")

	page, err := fixture.logEntries(t, alice, 0, "")
	require.NoError(t, err)
	require.Len(t, page.GetEntries(), 4)
	assert.True(t, proto.Equal(adopt.GetEscrowResetEntry(), page.GetEntries()[2]), "the escrow reset entry is appended as signed")
	assert.True(t, proto.Equal(adopt.GetEscrowEntry(), page.GetEntries()[3]), "the escrow on entry is appended after it")
}
