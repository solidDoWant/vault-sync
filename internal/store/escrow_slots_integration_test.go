//go:build integration

package store_test

import (
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// escrowedVault creates an escrow vault with one epoch whose escrow slot is
// wrapped to oldKey.
func escrowedVault(t *testing.T, oldKey string) (*keyFixture, uuid.UUID) {
	t.Helper()

	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := &keyFixture{pool: pool, queries: queries}
	fixture.owner = fixture.keyedUser(t, "owner")

	vault, err := queries.CreateVault(t.Context(), fixture.owner, store.NewVault{Name: "Escrowed", Encryption: store.EncryptionE2EE, Escrow: true}, 10)
	require.NoError(t, err)

	fixture.vault = queries.InVault(vault.ID)

	next := fixture.nextEpoch(t, 0, fixture.owner)
	next.Slots = append(next.Slots, store.KeySlot{RecipientKind: store.RecipientEscrow, RecipientID: oldKey, WrappedKey: randomBytes(t, 105)})
	_, err = fixture.vault.RotateEpoch(t.Context(), fixture.owner, next)
	require.NoError(t, err)

	return fixture, vault.ID
}

func escrowSlots(t *testing.T, fixture *keyFixture) []store.KeySlot {
	t.Helper()

	slots, err := fixture.vault.ListEscrowSlots(t.Context(), 0, 10)
	require.NoError(t, err)

	return slots
}

func TestReplaceEscrowSlotReplacesTheOldKeysSlot(t *testing.T) {
	fixture, vaultID := escrowedVault(t, "old-key")
	wrapped := randomBytes(t, 200)

	err := fixture.queries.ReplaceEscrowSlot(t.Context(), store.EscrowSlotReplacement{
		VaultID: vaultID, Epoch: 1, OldRecipientID: "old-key", NewRecipientID: "new-key", WrappedKey: wrapped,
	})
	require.NoError(t, err)

	slots := escrowSlots(t, fixture)
	require.Len(t, slots, 1, "the epoch keeps exactly one escrow slot")
	assert.Equal(t, "new-key", slots[0].RecipientID)
	assert.Equal(t, wrapped, slots[0].WrappedKey)
}

func TestReplaceEscrowSlotRequiresTheOldSlot(t *testing.T) {
	fixture, vaultID := escrowedVault(t, "old-key")

	for name, replacement := range map[string]store.EscrowSlotReplacement{
		"another old key": {VaultID: vaultID, Epoch: 1, OldRecipientID: "other-key", NewRecipientID: "new-key", WrappedKey: []byte{1}},
		"another epoch":   {VaultID: vaultID, Epoch: 2, OldRecipientID: "old-key", NewRecipientID: "new-key", WrappedKey: []byte{1}},
		"another vault":   {VaultID: uuid.New(), Epoch: 1, OldRecipientID: "old-key", NewRecipientID: "new-key", WrappedKey: []byte{1}},
	} {
		t.Run(name, func(t *testing.T) {
			err := fixture.queries.ReplaceEscrowSlot(t.Context(), replacement)
			require.ErrorIs(t, err, store.ErrNotFound)

			slots := escrowSlots(t, fixture)
			require.Len(t, slots, 1)
			assert.Equal(t, "old-key", slots[0].RecipientID, "nothing changes")
		})
	}
}

func TestConcurrentEscrowSlotReplacementsReplaceOnce(t *testing.T) {
	fixture, vaultID := escrowedVault(t, "old-key")

	const jobs = 4

	errs := make([]error, jobs)

	var wait sync.WaitGroup

	for index := range jobs {
		wait.Go(func() {
			errs[index] = fixture.queries.ReplaceEscrowSlot(t.Context(), store.EscrowSlotReplacement{
				VaultID: vaultID, Epoch: 1, OldRecipientID: "old-key", NewRecipientID: "new-key", WrappedKey: []byte{byte(index + 1)},
			})
		})
	}

	wait.Wait()

	succeeded := 0

	for _, err := range errs {
		if err == nil {
			succeeded++

			continue
		}

		require.ErrorIs(t, err, store.ErrNotFound)
	}

	assert.Equal(t, 1, succeeded)
	require.Len(t, escrowSlots(t, fixture), 1, "the epoch keeps exactly one escrow slot")
}

func TestReplaceEscrowSlotAppliesToADeletedVault(t *testing.T) {
	fixture, vaultID := escrowedVault(t, "old-key")

	_, err := fixture.pool.Exec(t.Context(), `UPDATE vaults SET deleted_at = now() - interval '29 days' WHERE id = $1`, vaultID)
	require.NoError(t, err)

	err = fixture.queries.ReplaceEscrowSlot(t.Context(), store.EscrowSlotReplacement{
		VaultID: vaultID, Epoch: 1, OldRecipientID: "old-key", NewRecipientID: "new-key", WrappedKey: []byte{1},
	})
	require.NoError(t, err)

	var recipients []string
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT array_agg(recipient_id) FROM key_slots WHERE vault_id = $1 AND recipient_kind = 'escrow'`, vaultID).Scan(&recipients))
	assert.Equal(t, []string{"new-key"}, recipients)
}
