//go:build integration

package store_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"slices"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// keyFixture is an E2EE vault whose owner and members all have user keys.
type keyFixture struct {
	pool    *pgxpool.Pool
	queries *store.Store
	vault   *store.VaultStore
	owner   uuid.UUID
	members []uuid.UUID
}

func randomBytes(t *testing.T, size int) []byte {
	t.Helper()

	value := make([]byte, size)
	_, err := rand.Read(value)
	require.NoError(t, err)

	return value
}

func (fixture *keyFixture) keyedUser(t *testing.T, subject string) uuid.UUID {
	t.Helper()

	user, err := fixture.queries.UpsertUser(t.Context(), testIssuer, subject, "")
	require.NoError(t, err)

	require.NoError(t, fixture.queries.CreateUserKey(t.Context(), user, randomBytes(t, 32), randomBytes(t, 32), store.Wrapping{
		WrappedPrivateKey: randomBytes(t, 98),
		Params:            store.PassphraseParams{Suite: 1, MemoryKiB: 65536, Iterations: 3, Parallelism: 1, Salt: randomBytes(t, 16)},
		AuthKeyHash:       randomBytes(t, 32),
	}))

	return user
}

// newKeyFixture creates the vault with an owner and memberCount editors,
// and its first epoch.
func newKeyFixture(t *testing.T, memberCount int) *keyFixture {
	t.Helper()

	pool := migratedPool(t)
	fixture := &keyFixture{pool: pool, queries: store.New(pool)}
	fixture.owner = fixture.keyedUser(t, "owner")

	vault, err := fixture.queries.CreateVault(t.Context(), fixture.owner, store.NewVault{Name: "Secret", Encryption: store.EncryptionE2EE}, 10)
	require.NoError(t, err)

	fixture.vault = fixture.queries.InVault(vault.ID)

	for index := range memberCount {
		member := fixture.keyedUser(t, "member-"+string(rune('a'+index)))
		_, err := pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`, vault.ID, member)
		require.NoError(t, err)

		fixture.members = append(fixture.members, member)
	}

	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 0, append([]uuid.UUID{fixture.owner}, fixture.members...)...))
	require.NoError(t, err)

	return fixture
}

func (fixture *keyFixture) nextEpoch(t *testing.T, expected int32, recipients ...uuid.UUID) store.NextEpoch {
	t.Helper()

	next := store.NextEpoch{ExpectedEpoch: expected, Commitment: randomBytes(t, 32)}
	for _, recipient := range recipients {
		next.Slots = append(next.Slots, store.KeySlot{RecipientKind: store.RecipientUser, RecipientID: recipient.String(), WrappedKey: randomBytes(t, 105)})
	}

	return next
}

// logEntry returns the next entry of the vault's membership log with a
// verifier that accepts it: the store's tests check its storage, not the
// signatures, which the API's verifier checks.
func (fixture *keyFixture) logEntry(t *testing.T) *store.LogAppend {
	t.Helper()

	log, err := fixture.vault.ListLogEntries(t.Context(), 0, 1000)
	require.NoError(t, err)

	return &store.LogAppend{
		Entry: store.LogEntry{
			Seq: int64(len(log)) + 1, PrevHash: make([]byte, 32), Type: 0x05,
			Payload: randomBytes(t, 16), Signatures: [][]byte{randomBytes(t, 64)},
		},
		Verify: func(uuid.UUID, uuid.UUID, []store.LogEntry) error { return nil },
	}
}

func (fixture *keyFixture) state(t *testing.T) store.KeyState {
	t.Helper()

	state, err := fixture.vault.KeyState(t.Context())
	require.NoError(t, err)

	return state
}

func (fixture *keyFixture) isMember(t *testing.T, user uuid.UUID) bool {
	t.Helper()

	var member bool
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM vault_members WHERE vault_id = $1 AND user_id = $2)`,
		fixture.vault.VaultID(), user).Scan(&member))

	return member
}

func TestNewE2EEVaultHasNoEpochAndAPendingRotation(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	for _, encryption := range []store.Encryption{store.EncryptionE2EE, store.EncryptionNone} {
		vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Vault", Encryption: encryption}, 10)
		require.NoError(t, err)

		state, err := queries.InVault(vault.ID).KeyState(t.Context())
		require.NoError(t, err)
		assert.Equal(t, int32(0), state.CurrentEpoch)
		assert.Equal(t, encryption == store.EncryptionE2EE, state.RotationPending, encryption)
	}
}

// A new E2EE vault has no key epoch yet, so it refuses every commit until
// its first epoch exists, epoch 0 included; a plaintext vault accepts
// epoch 0. Nothing of the refused commit is stored.
func TestNewE2EEVaultRefusesCommitsBeforeItsFirstEpoch(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	device, err := queries.RegisterDevice(t.Context(), owner, "laptop", nil, 10)
	require.NoError(t, err)

	content := sha256.Sum256([]byte("content"))

	tests := []struct {
		name          string
		encryption    store.Encryption
		assertErr     require.ErrorAssertionFunc
		wantRevisions int
	}{
		{"an E2EE vault without an epoch", store.EncryptionE2EE, func(t require.TestingT, err error, _ ...any) {
			require.ErrorIs(t, err, store.ErrEpochNotCurrent)
		}, 0},
		{"a plaintext vault", store.EncryptionNone, require.NoError, 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: test.name, Encryption: test.encryption}, 10)
			require.NoError(t, err)

			_, err = pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')", vault.ID, content[:])
			require.NoError(t, err)

			_, err = queries.InVault(vault.ID).CommitRevision(t.Context(), store.NewRevision{
				ID: uuid.Must(uuid.NewV7()), DocumentID: uuid.Must(uuid.NewV7()), Kind: "text",
				ContentRef: content[:], ContentSize: 7, Path: "note.md", PathKey: uuid.NewString(),
				DeviceID: device.ID, UserID: owner, Epoch: 0,
			})
			test.assertErr(t, err)

			var revisions int
			require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM revisions WHERE vault_id = $1", vault.ID).Scan(&revisions))
			assert.Equal(t, test.wantRevisions, revisions)
		})
	}
}

// Criterion 4: of concurrent rotations with the same expected epoch, on
// separate connections, exactly one wins; the others get
// ErrEpochNotCurrent and nothing of theirs is stored.
func TestConcurrentRotationsCreateExactlyOneEpoch(t *testing.T) {
	fixture := newKeyFixture(t, 2)
	recipients := append([]uuid.UUID{fixture.owner}, fixture.members...)

	const rotations = 8

	results := make([]error, rotations)
	commitments := make([][]byte, rotations)

	var group sync.WaitGroup

	for index := range rotations {
		next := fixture.nextEpoch(t, 1, recipients...)
		commitments[index] = next.Commitment

		group.Go(func() {
			_, results[index] = fixture.vault.RotateEpoch(t.Context(), fixture.owner, next)
		})
	}

	group.Wait()

	winner := -1

	for index, err := range results {
		if err == nil {
			require.Equal(t, -1, winner, "only one rotation may win")
			winner = index

			continue
		}

		require.ErrorIs(t, err, store.ErrEpochNotCurrent)
	}

	require.NotEqual(t, -1, winner, "one rotation wins")
	assert.Equal(t, int32(2), fixture.state(t).CurrentEpoch)

	epochs, err := fixture.vault.ListEpochs(t.Context(), 0, 10)
	require.NoError(t, err)
	require.Len(t, epochs, 2)
	assert.Equal(t, commitments[winner], epochs[1].Commitment)

	var slots int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM key_slots WHERE vault_id = $1 AND epoch = 2`,
		fixture.vault.VaultID()).Scan(&slots))
	assert.Equal(t, len(recipients), slots, "only the winner's slots are stored")
}

// Criterion 4, removals: concurrent removals of different members, each
// with the next epoch for the members it leaves, cannot both apply. Exactly
// one member is removed; the other removal changes nothing.
func TestConcurrentRemovalsCreateExactlyOneEpoch(t *testing.T) {
	fixture := newKeyFixture(t, 4)

	const removals = 4

	results := make([]error, removals)

	var group sync.WaitGroup

	for index := range removals {
		removed := fixture.members[index]

		remaining := []uuid.UUID{fixture.owner}
		for _, member := range fixture.members {
			if member != removed {
				remaining = append(remaining, member)
			}
		}

		next := fixture.nextEpoch(t, 1, remaining...)

		group.Go(func() {
			results[index] = fixture.vault.RemoveMember(t.Context(), fixture.owner, removed, &next, fixture.logEntry(t))
		})
	}

	group.Wait()

	won := 0

	for index, err := range results {
		if err == nil {
			won++

			assert.False(t, fixture.isMember(t, fixture.members[index]))

			continue
		}

		require.ErrorIs(t, err, store.ErrEpochNotCurrent)
		assert.True(t, fixture.isMember(t, fixture.members[index]), "a refused removal keeps the member")
	}

	assert.Equal(t, 1, won)
	assert.Equal(t, int32(2), fixture.state(t).CurrentEpoch)
}

// Criteria 2 and 3: the recipients of a new epoch are exactly the members
// with a user key; a removal without a valid next epoch keeps the member.
func TestEpochRecipientsAreExactlyTheKeyedMembers(t *testing.T) {
	fixture := newKeyFixture(t, 2)
	removed, kept := fixture.members[0], fixture.members[1]

	// A member without a user key is not a recipient.
	keyless, err := fixture.queries.UpsertUser(t.Context(), testIssuer, "keyless", "")
	require.NoError(t, err)
	_, err = fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'viewer')`, fixture.vault.VaultID(), keyless)
	require.NoError(t, err)

	cases := []struct {
		name string
		next *store.NextEpoch
		want error
	}{
		{"no next epoch", nil, store.ErrNextEpochRequired},
		{"a remaining member missing", new(fixture.nextEpoch(t, 1, fixture.owner)), store.ErrInvalidRecipients},
		{"the removed member included", new(fixture.nextEpoch(t, 1, fixture.owner, kept, removed)), store.ErrInvalidRecipients},
		{"a keyless member included", new(fixture.nextEpoch(t, 1, fixture.owner, kept, keyless)), store.ErrInvalidRecipients},
		{"a non-member included", new(fixture.nextEpoch(t, 1, fixture.owner, kept, uuid.Must(uuid.NewV7()))), store.ErrInvalidRecipients},
		{"an escrow slot in a vault without escrow", func() *store.NextEpoch {
			next := fixture.nextEpoch(t, 1, fixture.owner, kept)
			next.Slots = append(next.Slots, store.KeySlot{RecipientKind: store.RecipientEscrow, RecipientID: "escrow", WrappedKey: []byte{1}})

			return &next
		}(), store.ErrInvalidRecipients},
		{"a stale expected epoch", new(fixture.nextEpoch(t, 0, fixture.owner, kept)), store.ErrEpochNotCurrent},
	}

	for _, testCase := range cases {
		err := fixture.vault.RemoveMember(t.Context(), fixture.owner, removed, testCase.next, nil)
		require.ErrorIs(t, err, testCase.want, testCase.name)
		assert.True(t, fixture.isMember(t, removed), "%s: the member stays", testCase.name)
		assert.Equal(t, int32(1), fixture.state(t).CurrentEpoch, testCase.name)
	}

	require.NoError(t, fixture.vault.RemoveMember(t.Context(), fixture.owner, removed, new(fixture.nextEpoch(t, 1, fixture.owner, kept)), fixture.logEntry(t)))
	assert.False(t, fixture.isMember(t, removed))
	assert.Equal(t, store.KeyState{Encryption: store.EncryptionE2EE, CurrentEpoch: 2}, fixture.state(t))
}

func TestRemoveMemberOfAPlaintextVaultTakesNoNextEpoch(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	member, err := queries.UpsertUser(t.Context(), testIssuer, "member", "")
	require.NoError(t, err)

	created, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Plain", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	_, err = pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`, created.ID, member)
	require.NoError(t, err)

	vault := queries.InVault(created.ID)
	next := store.NextEpoch{Commitment: make([]byte, 32)}

	require.ErrorIs(t, vault.RemoveMember(t.Context(), owner, member, &next, nil), store.ErrUnexpectedNextEpoch)
	require.NoError(t, vault.RemoveMember(t.Context(), owner, member, nil, nil))

	_, err = vault.RotateEpoch(t.Context(), owner, next)
	require.ErrorIs(t, err, store.ErrNotEncrypted)
}

// Criteria 3 and 5: leaving marks a rotation pending; commits under the
// current epoch go on until the next epoch exists, then only it is
// accepted.
func TestCommitsFollowTheCurrentEpoch(t *testing.T) {
	fixture := newKeyFixture(t, 2)
	leaver, kept := fixture.members[0], fixture.members[1]

	device, err := fixture.queries.RegisterDevice(t.Context(), kept, "laptop", nil, 10)
	require.NoError(t, err)

	content := sha256.Sum256([]byte("content"))
	_, err = fixture.pool.Exec(t.Context(), "INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 7, 'complete')", fixture.vault.VaultID(), content[:])
	require.NoError(t, err)

	commit := func(epoch int32) (store.Revision, store.NewRevision, error) {
		revision := store.NewRevision{
			ID: uuid.Must(uuid.NewV7()), DocumentID: uuid.Must(uuid.NewV7()), Kind: "text",
			ContentRef: content[:], ContentSize: 7, Path: "ciphertext", PathKey: uuid.NewString(),
			DeviceID: device.ID, UserID: kept, Epoch: epoch,
		}
		committed, err := fixture.vault.CommitRevision(t.Context(), revision)

		return committed, revision, err
	}

	require.NoError(t, fixture.vault.LeaveVault(t.Context(), leaver, fixture.logEntry(t)))
	assert.Equal(t, store.KeyState{Encryption: store.EncryptionE2EE, CurrentEpoch: 1, RotationPending: true}, fixture.state(t))

	committed, beforeRotation, err := commit(1)
	require.NoError(t, err, "pending: the current epoch is still accepted")
	assert.Equal(t, int32(1), committed.Epoch)

	for _, epoch := range []int32{0, 2} {
		_, _, err := commit(epoch)
		require.ErrorIs(t, err, store.ErrEpochNotCurrent, "epoch %d", epoch)
	}

	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 1, fixture.owner, kept, leaver))
	require.ErrorIs(t, err, store.ErrInvalidRecipients, "the member who left gets no slot")

	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 1, fixture.owner, kept))
	require.NoError(t, err)
	assert.Equal(t, store.KeyState{Encryption: store.EncryptionE2EE, CurrentEpoch: 2}, fixture.state(t))

	for _, epoch := range []int32{1, 3} {
		_, _, err := commit(epoch)
		require.ErrorIs(t, err, store.ErrEpochNotCurrent, "epoch %d after the rotation", epoch)
	}

	committed, _, err = commit(2)
	require.NoError(t, err)
	assert.Equal(t, int32(2), committed.Epoch)

	// A retry of a commit applied under the old epoch gets it back.
	retried, err := fixture.vault.CommitRevision(t.Context(), beforeRotation)
	require.NoError(t, err)
	assert.Equal(t, int32(1), retried.Epoch)

	// The same revision id under another epoch is another revision.
	beforeRotation.Epoch = 2
	_, err = fixture.vault.CommitRevision(t.Context(), beforeRotation)
	require.ErrorIs(t, err, store.ErrRevisionConflict)
}

// Criterion 6: an added member lacks a slot for every epoch until an owner
// grants them; grants never replace a stored slot.
func TestAddedMemberIsMissingEverySlotUntilGranted(t *testing.T) {
	fixture := newKeyFixture(t, 1)

	_, err := fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 1, fixture.owner, fixture.members[0]))
	require.NoError(t, err)

	missing, err := fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Empty(t, missing)

	joiner := fixture.keyedUser(t, "joiner")
	_, err = fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'viewer')`, fixture.vault.VaultID(), joiner)
	require.NoError(t, err)

	var publicKey []byte
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT public_key FROM user_keys WHERE user_id = $1`, joiner).Scan(&publicKey))

	missing, err = fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Equal(t, []store.MissingSlot{{Epoch: 1, UserID: joiner, PublicKey: publicKey}, {Epoch: 2, UserID: joiner, PublicKey: publicKey}}, missing)

	slot := store.KeySlot{Epoch: 1, RecipientKind: store.RecipientUser, RecipientID: joiner.String(), WrappedKey: randomBytes(t, 105)}

	for _, invalid := range []struct {
		slot store.KeySlot
		want error
	}{
		{store.KeySlot{Epoch: 3, RecipientKind: store.RecipientUser, RecipientID: joiner.String(), WrappedKey: []byte{1}}, store.ErrEpochNotFound},
		{store.KeySlot{Epoch: 1, RecipientKind: store.RecipientUser, RecipientID: uuid.NewString(), WrappedKey: []byte{1}}, store.ErrInvalidRecipients},
		{store.KeySlot{Epoch: 1, RecipientKind: store.RecipientEscrow, RecipientID: "escrow", WrappedKey: []byte{1}}, store.ErrInvalidRecipients},
	} {
		_, err := fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{slot, invalid.slot})
		require.ErrorIs(t, err, invalid.want)
	}

	missing, err = fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Len(t, missing, 2, "a refused call stores nothing")

	added, err := fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{slot})
	require.NoError(t, err)
	assert.Equal(t, 1, added)

	missing, err = fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Equal(t, []store.MissingSlot{{Epoch: 2, UserID: joiner, PublicKey: publicKey}}, missing)

	replacement := slot
	replacement.WrappedKey = randomBytes(t, 105)
	added, err = fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{replacement})
	require.NoError(t, err)
	assert.Zero(t, added)

	slots, err := fixture.vault.ListKeySlots(t.Context(), store.RecipientUser, joiner.String(), 0, 10)
	require.NoError(t, err)
	require.Len(t, slots, 1)
	assert.True(t, bytes.Equal(slot.WrappedKey, slots[0].WrappedKey), "a stored slot is never replaced")
	assert.Equal(t, fixture.owner, slots[0].CreatedBy)
}

func TestListMissingSlotsPagesByEpochAndUser(t *testing.T) {
	fixture := newKeyFixture(t, 0)

	_, err := fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 1, fixture.owner))
	require.NoError(t, err)

	for _, subject := range []string{"x", "y"} {
		joiner := fixture.keyedUser(t, subject)
		_, err := fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`, fixture.vault.VaultID(), joiner)
		require.NoError(t, err)
	}

	var pages [][]store.MissingSlot

	afterEpoch, afterUser := int32(0), uuid.Nil

	for {
		page, err := fixture.vault.ListMissingSlots(t.Context(), afterEpoch, afterUser, 1)
		require.NoError(t, err)

		if len(page) == 0 {
			break
		}

		pages = append(pages, page)
		afterEpoch, afterUser = page[0].Epoch, page[0].UserID
	}

	require.Len(t, pages, 4, "two members times two epochs")
	assert.Equal(t, int32(1), pages[1][0].Epoch)
	assert.Equal(t, int32(2), pages[2][0].Epoch)
	assert.NotEqual(t, pages[0][0].UserID, pages[1][0].UserID)
}

// An owner who removes themselves from an E2EE vault would create, and so
// know, the epoch meant to exclude them: RemoveMember refuses it and the
// vault is unchanged. LeaveVault is the way out.
func TestRemoveMemberRefusesSelfRemovalFromAnE2EEVault(t *testing.T) {
	fixture := newKeyFixture(t, 1)
	other := fixture.members[0]

	_, err := fixture.pool.Exec(t.Context(), `UPDATE vault_members SET role = 'owner' WHERE vault_id = $1 AND user_id = $2`, fixture.vault.VaultID(), other)
	require.NoError(t, err)

	countSlots := func() int {
		var slots int
		require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM key_slots WHERE vault_id = $1`, fixture.vault.VaultID()).Scan(&slots))

		return slots
	}

	slotsBefore := countSlots()

	for _, next := range []*store.NextEpoch{new(fixture.nextEpoch(t, 1, other)), nil} {
		err := fixture.vault.RemoveMember(t.Context(), fixture.owner, fixture.owner, next, fixture.logEntry(t))
		require.ErrorIs(t, err, store.ErrSelfRemoval)
		assert.True(t, fixture.isMember(t, fixture.owner), "the owner stays")
		assert.Equal(t, store.KeyState{Encryption: store.EncryptionE2EE, CurrentEpoch: 1}, fixture.state(t))
		assert.Equal(t, slotsBefore, countSlots())
	}

	require.NoError(t, fixture.vault.LeaveVault(t.Context(), fixture.owner, fixture.logEntry(t)))
	assert.False(t, fixture.isMember(t, fixture.owner))
}

func TestRemoveMemberLetsAnOwnerRemoveThemselvesFromAPlaintextVault(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	other, err := queries.UpsertUser(t.Context(), testIssuer, "other", "")
	require.NoError(t, err)

	created, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Plain", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	_, err = pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'owner')`, created.ID, other)
	require.NoError(t, err)

	require.NoError(t, queries.InVault(created.ID).RemoveMember(t.Context(), owner, owner, nil, nil))

	var member bool
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM vault_members WHERE vault_id = $1 AND user_id = $2)`, created.ID, owner).Scan(&member))
	assert.False(t, member)
}

func TestListEscrowSlotsListsEveryEpochsEscrowSlot(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := &keyFixture{pool: pool, queries: queries}
	fixture.owner = fixture.keyedUser(t, "owner")

	vault, err := queries.CreateVault(t.Context(), fixture.owner, store.NewVault{Name: "Escrowed", Encryption: store.EncryptionE2EE, Escrow: true}, 10)
	require.NoError(t, err)

	fixture.vault = queries.InVault(vault.ID)

	var wrapped [][]byte

	for epoch := range int32(3) {
		next := fixture.nextEpoch(t, epoch, fixture.owner)
		escrow := store.KeySlot{RecipientKind: store.RecipientEscrow, RecipientID: "escrow-key", WrappedKey: randomBytes(t, 105)}
		next.Slots = append(next.Slots, escrow)
		wrapped = append(wrapped, escrow.WrappedKey)

		_, err := fixture.vault.RotateEpoch(t.Context(), fixture.owner, next)
		require.NoError(t, err)
	}

	slots, err := fixture.vault.ListEscrowSlots(t.Context(), 0, 2)
	require.NoError(t, err)
	require.Len(t, slots, 2)

	rest, err := fixture.vault.ListEscrowSlots(t.Context(), slots[1].Epoch, 2)
	require.NoError(t, err)
	require.Len(t, rest, 1)

	for index, slot := range append(slots, rest...) {
		assert.Equal(t, int32(index+1), slot.Epoch) //nolint:gosec // small test values.
		assert.Equal(t, store.RecipientEscrow, slot.RecipientKind)
		assert.Equal(t, "escrow-key", slot.RecipientID)
		assert.True(t, bytes.Equal(wrapped[index], slot.WrappedKey), "epoch %d's escrow slot", index+1)
	}
}

func TestEveryEpochOfAnEscrowVaultHasExactlyOneEscrowSlot(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := &keyFixture{pool: pool, queries: queries}
	fixture.owner = fixture.keyedUser(t, "owner")

	vault, err := queries.CreateVault(t.Context(), fixture.owner, store.NewVault{Name: "Escrowed", Encryption: store.EncryptionE2EE, Escrow: true}, 10)
	require.NoError(t, err)

	fixture.vault = queries.InVault(vault.ID)

	escrowSlot := func(epoch int32, id string) store.KeySlot {
		return store.KeySlot{Epoch: epoch, RecipientKind: store.RecipientEscrow, RecipientID: id, WrappedKey: randomBytes(t, 105)}
	}

	refused := []struct {
		name   string
		escrow []store.KeySlot
	}{
		{"no escrow slot", nil},
		{"two escrow slots", []store.KeySlot{escrowSlot(0, "escrow-key"), escrowSlot(0, "retiring-key")}},
	}

	for _, refusal := range refused {
		next := fixture.nextEpoch(t, 0, fixture.owner)
		next.Slots = append(next.Slots, refusal.escrow...)

		_, err := fixture.vault.RotateEpoch(t.Context(), fixture.owner, next)
		require.ErrorIs(t, err, store.ErrInvalidRecipients, refusal.name)
		assert.Equal(t, int32(0), fixture.state(t).CurrentEpoch, "%s: no epoch is created", refusal.name)
	}

	next := fixture.nextEpoch(t, 0, fixture.owner)
	next.Slots = append(next.Slots, escrowSlot(0, "escrow-key"))
	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, next)
	require.NoError(t, err, "one escrow slot")

	_, err = fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{escrowSlot(1, "retiring-key")})
	require.ErrorIs(t, err, store.ErrInvalidRecipients, "a second escrow slot for a stored epoch")

	added, err := fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{escrowSlot(1, "escrow-key")})
	require.NoError(t, err, "the epoch's own escrow slot again")
	assert.Equal(t, 0, added, "a stored slot is kept")

	slots, err := fixture.vault.ListEscrowSlots(t.Context(), 0, 10)
	require.NoError(t, err)
	require.Len(t, slots, 1)
	assert.Equal(t, "escrow-key", slots[0].RecipientID)
}

func TestAddKeySlotsTakesOneEscrowSlotPerEpoch(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := &keyFixture{pool: pool, queries: queries}
	fixture.owner = fixture.keyedUser(t, "owner")

	vault, err := queries.CreateVault(t.Context(), fixture.owner, store.NewVault{Name: "Escrowed", Encryption: store.EncryptionE2EE, Escrow: true}, 10)
	require.NoError(t, err)

	fixture.vault = queries.InVault(vault.ID)

	// An epoch without an escrow slot, as one made before escrow was on.
	_, err = pool.Exec(t.Context(), `UPDATE vaults SET escrow = false WHERE id = $1`, vault.ID)
	require.NoError(t, err)
	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, fixture.nextEpoch(t, 0, fixture.owner))
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE vaults SET escrow = true WHERE id = $1`, vault.ID)
	require.NoError(t, err)

	escrowSlot := func(id string) store.KeySlot {
		return store.KeySlot{Epoch: 1, RecipientKind: store.RecipientEscrow, RecipientID: id, WrappedKey: randomBytes(t, 105)}
	}

	_, err = fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{escrowSlot("escrow-key"), escrowSlot("retiring-key")})
	require.ErrorIs(t, err, store.ErrInvalidRecipients, "two escrow slots for one epoch")

	added, err := fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{escrowSlot("escrow-key")})
	require.NoError(t, err)
	assert.Equal(t, 1, added)
}

// Concurrent grants of the same missing slot, on separate connections and
// each with its own wrapping, converge: every grant succeeds, exactly one
// stores the slot, and the stored slot is one of the granted wrappings.
func TestConcurrentGrantsOfAMissingSlotConverge(t *testing.T) {
	fixture := newKeyFixture(t, 0)

	joiner := fixture.keyedUser(t, "joiner")
	_, err := fixture.pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor')`, fixture.vault.VaultID(), joiner)
	require.NoError(t, err)

	const grants = 8

	wrappings := make([][]byte, grants)
	added := make([]int, grants)
	results := make([]error, grants)

	var group sync.WaitGroup

	for index := range grants {
		wrappings[index] = randomBytes(t, 105)
		slot := store.KeySlot{Epoch: 1, RecipientKind: store.RecipientUser, RecipientID: joiner.String(), WrappedKey: wrappings[index]}

		group.Go(func() {
			added[index], results[index] = fixture.vault.AddKeySlots(t.Context(), fixture.owner, []store.KeySlot{slot})
		})
	}

	group.Wait()

	stored := 0

	for index, err := range results {
		require.NoError(t, err, "grant %d", index)

		stored += added[index]
	}

	assert.Equal(t, 1, stored, "exactly one grant stores the slot")

	slots, err := fixture.vault.ListKeySlots(t.Context(), store.RecipientUser, joiner.String(), 0, 10)
	require.NoError(t, err)
	require.Len(t, slots, 1)
	assert.True(t, slices.ContainsFunc(wrappings, func(wrapping []byte) bool { return bytes.Equal(wrapping, slots[0].WrappedKey) }),
		"the stored slot is one of the granted wrappings")

	missing, err := fixture.vault.ListMissingSlots(t.Context(), 0, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Empty(t, missing)
}
