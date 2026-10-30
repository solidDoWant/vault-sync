//go:build integration

package store_test

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// pendingInvitation is an E2EE invitation to the fixture's vault, with a
// slot for every epoch, and the keyed user who holds its code.
type pendingInvitation struct {
	id       uuid.UUID
	codeHash []byte
	holder   uuid.UUID
}

func (fixture *keyFixture) pendingInvitation(t *testing.T, holder string) pendingInvitation {
	t.Helper()

	invitation := pendingInvitation{id: uuid.Must(uuid.NewV7()), codeHash: randomBytes(t, 32), holder: fixture.keyedUser(t, holder)}

	slots := []store.KeySlot{}
	for epoch := int32(1); epoch <= fixture.state(t).CurrentEpoch; epoch++ {
		slots = append(slots, store.KeySlot{Epoch: epoch, RecipientKind: store.RecipientInvitation, RecipientID: invitation.id.String(), WrappedKey: randomBytes(t, 105)})
	}

	_, err := fixture.vault.CreateInvitation(t.Context(), fixture.owner, invitation.id, store.RoleEditor, invitation.codeHash, time.Hour, 10, fixture.logEntry(t),
		&store.InvitationKeys{Slots: slots, Anchor: randomBytes(t, 96)})
	require.NoError(t, err)

	return invitation
}

func (fixture *keyFixture) redeemSlots(t *testing.T, user uuid.UUID) []store.KeySlot {
	t.Helper()

	slots := []store.KeySlot{}
	for epoch := int32(1); epoch <= fixture.state(t).CurrentEpoch; epoch++ {
		slots = append(slots, store.KeySlot{Epoch: epoch, RecipientKind: store.RecipientUser, RecipientID: user.String(), WrappedKey: randomBytes(t, 105)})
	}

	return slots
}

// A redemption after the invitation's revocation gets
// ErrInvitationNotFound (NOT_FOUND), stores nothing, and the holder does
// not become a member.
func TestRedeemingARevokedInvitationIsNotFound(t *testing.T) {
	fixture := newKeyFixture(t, 0)
	invitation := fixture.pendingInvitation(t, "holder")

	redeemEntry, slots := fixture.logEntry(t), fixture.redeemSlots(t, invitation.holder)

	require.NoError(t, fixture.vault.RevokeInvitation(t.Context(), invitation.id, fixture.logEntry(t)))

	_, err := fixture.queries.RedeemInvitation(t.Context(), invitation.holder, invitation.codeHash, 10, redeemEntry, slots)
	require.ErrorIs(t, err, store.ErrInvitationNotFound)
	assert.False(t, fixture.isMember(t, invitation.holder))

	stored, err := fixture.vault.ListKeySlots(t.Context(), store.RecipientUser, invitation.holder.String(), 0, 10)
	require.NoError(t, err)
	assert.Empty(t, stored)
}

// A redemption racing the invitation's revocation, both built on the same
// log head, is serialized by the vault lock: exactly one lands. A losing
// redemption gets ErrInvitationNotFound; a losing revocation's log append
// is stale (ErrLogConflict, ABORTED), so its device re-reads the log and
// finds the invitation redeemed.
func TestARedemptionRacingARevocationIsSerialized(t *testing.T) {
	fixture := newKeyFixture(t, 0)

	const rounds = 8

	for round := range rounds {
		invitation := fixture.pendingInvitation(t, "holder-"+string(rune('a'+round)))
		redeemEntry, revokeEntry, slots := fixture.logEntry(t), fixture.logEntry(t), fixture.redeemSlots(t, invitation.holder)

		var redeemErr, revokeErr error

		var group sync.WaitGroup

		group.Go(func() {
			_, redeemErr = fixture.queries.RedeemInvitation(t.Context(), invitation.holder, invitation.codeHash, 10, redeemEntry, slots)
		})
		group.Go(func() {
			revokeErr = fixture.vault.RevokeInvitation(t.Context(), invitation.id, revokeEntry)
		})

		group.Wait()

		if redeemErr == nil {
			require.ErrorIs(t, revokeErr, store.ErrLogConflict, "round %d: the revocation loses", round)
			assert.True(t, fixture.isMember(t, invitation.holder), "round %d", round)

			continue
		}

		require.ErrorIs(t, redeemErr, store.ErrInvitationNotFound, "round %d: the redemption loses", round)
		require.NoError(t, revokeErr, "round %d", round)
		assert.False(t, fixture.isMember(t, invitation.holder), "round %d", round)
	}
}
