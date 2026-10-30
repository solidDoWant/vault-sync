//go:build integration

package store_test

import (
	"crypto/sha256"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// rekeyFixture is a keyFixture with a device of the owner's to commit with.
type rekeyFixture struct {
	*keyFixture
	device uuid.UUID
}

func newRekeyFixture(t *testing.T, memberCount int) *rekeyFixture {
	t.Helper()

	fixture := newKeyFixture(t, memberCount)

	device, err := fixture.queries.RegisterDevice(t.Context(), fixture.owner, "laptop", nil, 10)
	require.NoError(t, err)

	return &rekeyFixture{keyFixture: fixture, device: device.ID}
}

// blob stores a complete blob of size 7 named after content.
func (fixture *rekeyFixture) blob(t *testing.T, content string) []byte {
	t.Helper()

	blobID := sha256.Sum256([]byte(content))
	_, err := fixture.pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')",
		fixture.vault.VaultID(), blobID[:])
	require.NoError(t, err)

	return blobID[:]
}

// commit commits a revision of document under the vault's current epoch,
// on top of base (uuid.Nil for a new document).
func (fixture *rekeyFixture) commit(t *testing.T, document, base uuid.UUID, kind string, content []byte, deleted bool) store.Revision {
	t.Helper()

	revision := store.NewRevision{
		ID: uuid.Must(uuid.NewV7()), DocumentID: document, Kind: kind,
		BaseRevID:  uuid.NullUUID{UUID: base, Valid: base != uuid.Nil},
		ContentRef: content, Path: "sealed-" + uuid.NewString(), PathKey: "key-" + document.String(), Deleted: deleted,
		DeviceID: fixture.device, UserID: fixture.owner, Epoch: fixture.state(t).CurrentEpoch,
	}
	if content != nil {
		revision.ContentSize = 7
	}

	committed, err := fixture.vault.CommitRevision(t.Context(), revision)
	require.NoError(t, err)

	return committed
}

// rotate creates the next epoch for the owner and the members.
func (fixture *rekeyFixture) rotate(t *testing.T) {
	t.Helper()

	_, err := fixture.vault.RotateEpoch(t.Context(), fixture.owner,
		fixture.nextEpoch(t, fixture.state(t).CurrentEpoch, append([]uuid.UUID{fixture.owner}, fixture.members...)...))
	require.NoError(t, err)
}

func (fixture *rekeyFixture) revision(t *testing.T, id uuid.UUID) store.Revision {
	t.Helper()

	revision, err := fixture.vault.Revision(t.Context(), id)
	require.NoError(t, err)

	return revision
}

func (fixture *rekeyFixture) replace(t *testing.T, revision uuid.UUID, from, to int32, path string, content []byte) bool {
	t.Helper()

	replacement := store.RevisionCiphertext{RevisionID: revision, FromEpoch: from, ToEpoch: to, Path: path, ContentRef: content}
	if content != nil {
		replacement.ContentSize = 7
	}

	replaced, err := fixture.vault.ReplaceRevisionCiphertext(t.Context(), replacement)
	require.NoError(t, err)

	return replaced
}

func (fixture *rekeyFixture) slotCount(t *testing.T, epoch int32) int {
	t.Helper()

	var count int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM key_slots WHERE vault_id = $1 AND epoch = $2`,
		fixture.vault.VaultID(), epoch).Scan(&count))

	return count
}

func TestReplaceRevisionCiphertextMovesARevisionToTheCurrentEpoch(t *testing.T) {
	fixture := newRekeyFixture(t, 0)
	oldContent, newContent := fixture.blob(t, "epoch-1"), fixture.blob(t, "epoch-2")

	note := uuid.Must(uuid.NewV7())
	first := fixture.commit(t, note, uuid.Nil, "text", oldContent, false)
	head := fixture.commit(t, note, first.ID, "text", oldContent, true)

	folder := uuid.Must(uuid.NewV7())
	folderHead := fixture.commit(t, folder, uuid.Nil, store.KindFolder, nil, false)

	// The collector has seen the old content referenced, which ends its
	// release: only the rewrite can release it again.
	collected, err := fixture.vault.CollectBlob(t.Context(), oldContent, 0)
	require.NoError(t, err)
	require.False(t, collected)

	fixture.rotate(t)

	before, err := fixture.vault.Document(t.Context(), note)
	require.NoError(t, err)

	for _, revision := range []store.Revision{first, head} {
		assert.True(t, fixture.replace(t, revision.ID, 1, 2, "resealed-"+revision.ID.String(), newContent))

		moved := fixture.revision(t, revision.ID)
		assert.Equal(t, int32(2), moved.Epoch)
		assert.Equal(t, "resealed-"+revision.ID.String(), moved.Path)
		assert.Equal(t, newContent, moved.ContentRef)
		assert.Equal(t, revision.Seq, moved.Seq, "the change feed position is kept")
		assert.Equal(t, revision.Deleted, moved.Deleted, "a tombstone stays a tombstone")
	}

	after, err := fixture.vault.Document(t.Context(), note)
	require.NoError(t, err)
	assert.Equal(t, before, after, "which revision is current, and the path_key, are unchanged")

	// A folder has no content, and takes none.
	_, err = fixture.vault.ReplaceRevisionCiphertext(t.Context(), store.RevisionCiphertext{
		RevisionID: folderHead.ID, FromEpoch: 1, ToEpoch: 2, Path: "resealed-folder", ContentRef: newContent, ContentSize: 7,
	})
	require.ErrorIs(t, err, store.ErrCiphertextShape)
	assert.True(t, fixture.replace(t, folderHead.ID, 1, 2, "resealed-folder", nil))
	assert.Equal(t, int32(2), fixture.revision(t, folderHead.ID).Epoch)

	// The old ciphertext is no longer referenced, so the collector deletes it.
	collected, err = fixture.vault.CollectBlob(t.Context(), oldContent, 0)
	require.NoError(t, err)
	assert.True(t, collected, "the replaced content is released and collected")

	collected, err = fixture.vault.CollectBlob(t.Context(), newContent, 0)
	require.NoError(t, err)
	assert.False(t, collected, "the new content is referenced")
}

func TestReplaceRevisionCiphertextIsSkippedOnceItLost(t *testing.T) {
	fixture := newRekeyFixture(t, 0)
	oldContent := fixture.blob(t, "epoch-1")
	document := uuid.Must(uuid.NewV7())
	revision := fixture.commit(t, document, uuid.Nil, "text", oldContent, false)

	fixture.rotate(t)
	fixture.rotate(t)

	stored := fixture.revision(t, revision.ID)

	type testCase struct {
		from, to int32
	}

	for name, test := range map[string]testCase{
		"to_epoch no longer current":       {from: 1, to: 2},
		"revision no longer at from_epoch": {from: 2, to: 3},
	} {
		t.Run(name, func(t *testing.T) {
			assert.False(t, fixture.replace(t, revision.ID, test.from, test.to, "lost", fixture.blob(t, "lost-"+name)))
			assert.Equal(t, stored, fixture.revision(t, revision.ID), "a lost rewrite changes nothing")
		})
	}

	assert.True(t, fixture.replace(t, revision.ID, 1, 3, "winner", fixture.blob(t, "epoch-3")))
	moved := fixture.revision(t, revision.ID)

	assert.False(t, fixture.replace(t, revision.ID, 1, 3, "retried", fixture.blob(t, "retried")), "a second rewrite from the same epoch lost")
	assert.Equal(t, moved, fixture.revision(t, revision.ID))

	_, err := fixture.vault.ReplaceRevisionCiphertext(t.Context(), store.RevisionCiphertext{
		RevisionID: uuid.Must(uuid.NewV7()), FromEpoch: 1, ToEpoch: 3, Path: "missing", ContentRef: oldContent, ContentSize: 7,
	})
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestRetireEpochDeletesTheSlotsOfAnUnusedEpoch(t *testing.T) {
	fixture := newRekeyFixture(t, 1)
	content := fixture.blob(t, "content")

	first := fixture.commit(t, uuid.Must(uuid.NewV7()), uuid.Nil, "text", content, false)

	fixture.rotate(t)
	second := fixture.commit(t, uuid.Must(uuid.NewV7()), uuid.Nil, "text", content, false)

	fixture.rotate(t)
	fixture.rotate(t)

	require.ErrorIs(t, fixture.vault.RetireEpoch(t.Context(), 2), store.ErrEpochInUse, "a revision still uses epoch 2")
	require.ErrorIs(t, fixture.vault.RetireEpoch(t.Context(), 4), store.ErrEpochInUse, "epoch 4 is current")
	require.ErrorIs(t, fixture.vault.RetireEpoch(t.Context(), 5), store.ErrEpochNotFound)

	current := fixture.blob(t, "current")
	assert.True(t, fixture.replace(t, first.ID, 1, 4, "resealed", current))
	assert.True(t, fixture.replace(t, second.ID, 2, 4, "resealed", current))

	require.ErrorIs(t, fixture.vault.RetireEpoch(t.Context(), 1), store.ErrFirstEpochKept, "epoch 1 is kept even unused")
	assert.Equal(t, 2, fixture.slotCount(t, 1))

	require.NoError(t, fixture.vault.RetireEpoch(t.Context(), 2))
	assert.Zero(t, fixture.slotCount(t, 2), "the retired epoch's slots are deleted")
	assert.Equal(t, 2, fixture.slotCount(t, 3), "an unused epoch is kept until it is retired")
	require.NoError(t, fixture.vault.RetireEpoch(t.Context(), 2), "retiring a retired epoch changes nothing")

	epochs, err := fixture.vault.ListEpochs(t.Context(), 0, 10)
	require.NoError(t, err)
	require.Len(t, epochs, 4, "the retired epoch's record stays")

	for _, epoch := range epochs {
		assert.Equal(t, epoch.Epoch == 2, epoch.Retired, "epoch %d", epoch.Epoch)
	}

	// A retired epoch needs no slots: a new member misses every other epoch,
	// and a slot for the retired epoch is accepted but not stored.
	newcomer := fixture.keyedUser(t, "newcomer")
	_, err = fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`,
		fixture.vault.VaultID(), newcomer)
	require.NoError(t, err)

	missing, err := fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 10)
	require.NoError(t, err)

	missingEpochs := make([]int32, 0, len(missing))
	for _, slot := range missing {
		missingEpochs = append(missingEpochs, slot.Epoch)
	}

	assert.Equal(t, []int32{1, 3, 4}, missingEpochs)

	added, err := fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{
		{Epoch: 2, RecipientKind: store.RecipientUser, RecipientID: newcomer.String(), WrappedKey: randomBytes(t, 105)},
		{Epoch: 3, RecipientKind: store.RecipientUser, RecipientID: newcomer.String(), WrappedKey: randomBytes(t, 105)},
	})
	require.NoError(t, err)
	assert.Equal(t, 1, added)
	assert.Zero(t, fixture.slotCount(t, 2))

	// An invitation needs no slot for the retired epoch, and a redemption's
	// slot for it is accepted but not stored.
	invitationID := uuid.Must(uuid.NewV7())
	codeHash := randomBytes(t, 32)
	slotsFor := func(kind store.RecipientKind, id uuid.UUID, epochs ...int32) []store.KeySlot {
		slots := []store.KeySlot{}
		for _, epoch := range epochs {
			slots = append(slots, store.KeySlot{Epoch: epoch, RecipientKind: kind, RecipientID: id.String(), WrappedKey: randomBytes(t, 105)})
		}

		return slots
	}

	_, err = fixture.vault.CreateInvitation(t.Context(), fixture.owner, invitationID, store.RoleEditor, codeHash, time.Hour, 10, fixture.logEntry(t),
		&store.InvitationKeys{Slots: slotsFor(store.RecipientInvitation, invitationID, 1, 3, 4), Anchor: randomBytes(t, 96)})
	require.NoError(t, err)

	guest := fixture.keyedUser(t, "guest")
	_, err = fixture.queries.RedeemInvitation(t.Context(), guest, codeHash, 10, fixture.logEntry(t), slotsFor(store.RecipientUser, guest, 1, 2, 3, 4))
	require.NoError(t, err)
	assert.True(t, fixture.isMember(t, guest))
	assert.Zero(t, fixture.slotCount(t, 2))
}
