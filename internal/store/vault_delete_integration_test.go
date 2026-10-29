//go:build integration

package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestDeletedVaultIsRefusedToMembersAndHiddenFromEveryone(t *testing.T) {
	queries := store.New(migratedPool(t))

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	viewer, err := queries.UpsertUser(t.Context(), testIssuer, "viewer", "")
	require.NoError(t, err)

	outsider, err := queries.UpsertUser(t.Context(), testIssuer, "outsider", "")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	kept, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Kept", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	codeHash := []byte("viewer-code-hash-000000000000000")
	_, err = queries.InVault(vault.ID).CreateInvitation(t.Context(), owner, store.RoleViewer, codeHash, time.Hour, 10)
	require.NoError(t, err)

	_, err = queries.RedeemInvitation(t.Context(), viewer, codeHash, 10)
	require.NoError(t, err)

	pendingHash := []byte("pending-code-hash-00000000000000")
	_, err = queries.InVault(vault.ID).CreateInvitation(t.Context(), owner, store.RoleEditor, pendingHash, time.Hour, 10)
	require.NoError(t, err)

	require.NoError(t, queries.DeleteVault(t.Context(), vault.ID))

	for _, member := range []uuid.UUID{owner, viewer} {
		_, err := queries.VaultRole(t.Context(), vault.ID, member)
		require.ErrorIs(t, err, store.ErrVaultDeleted)

		_, _, err = queries.MemberHeadSeq(t.Context(), vault.ID, member)
		require.ErrorIs(t, err, store.ErrVaultDeleted)
	}

	// A non-member cannot tell the deleted vault from a missing one.
	_, err = queries.VaultRole(t.Context(), vault.ID, outsider)
	require.ErrorIs(t, err, store.ErrVaultNotFound)

	_, _, err = queries.MemberHeadSeq(t.Context(), vault.ID, outsider)
	require.ErrorIs(t, err, store.ErrVaultNotFound)

	members, err := queries.VaultMembers(t.Context(), vault.ID, []uuid.UUID{owner, viewer, outsider})
	require.ErrorIs(t, err, store.ErrVaultDeleted)
	assert.Equal(t, map[uuid.UUID]bool{owner: true, viewer: true}, members)

	ownerVaults, err := queries.ListVaults(t.Context(), owner, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Equal(t, []uuid.UUID{kept.ID}, vaultIDs(ownerVaults))

	viewerVaults, err := queries.ListVaults(t.Context(), viewer, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Empty(t, viewerVaults)

	// Its pending invitation no longer admits anyone.
	_, err = queries.RedeemInvitation(t.Context(), outsider, pendingHash, 10)
	require.ErrorIs(t, err, store.ErrInvitationNotFound)

	// The other vault is untouched.
	role, err := queries.VaultRole(t.Context(), kept.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, store.RoleOwner, role)
}

func TestDeleteVaultRefusesADeletedOrMissingVault(t *testing.T) {
	queries := store.New(migratedPool(t))

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	require.NoError(t, queries.DeleteVault(t.Context(), vault.ID))
	require.ErrorIs(t, queries.DeleteVault(t.Context(), vault.ID), store.ErrVaultDeleted)
	require.ErrorIs(t, queries.DeleteVault(t.Context(), uuid.Must(uuid.NewV7())), store.ErrVaultNotFound)
}

func TestDeletedVaultDoesNotCountTowardTheOwnedVaultLimit(t *testing.T) {
	queries := store.New(migratedPool(t))

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	const limit = 3

	var owned []store.Vault

	for range limit {
		vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, limit)
		require.NoError(t, err)

		owned = append(owned, vault)
	}

	_, err = queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Over", Encryption: store.EncryptionNone}, limit)
	require.ErrorIs(t, err, store.ErrVaultLimit)

	require.NoError(t, queries.DeleteVault(t.Context(), owned[0].ID))

	_, err = queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Room made", Encryption: store.EncryptionNone}, limit)
	require.NoError(t, err)

	_, err = queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Over again", Encryption: store.EncryptionNone}, limit)
	require.ErrorIs(t, err, store.ErrVaultLimit)
}

func TestDeleteVaultNotifiesTheVaultsSubscribers(t *testing.T) {
	queries := store.New(migratedPool(t))

	owner, err := queries.UpsertUser(t.Context(), testIssuer, "owner", "")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), owner, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	ready := make(chan struct{})
	changes := make(chan store.VaultChange, 16)
	listened := make(chan error, 1)

	go func() {
		listened <- queries.ListenVaultChanges(ctx, store.ListenOptions{
			Ready:  func(context.Context) { close(ready) },
			Handle: func(change store.VaultChange) { changes <- change },
		})
	}()

	select {
	case <-ready:
	case err := <-listened:
		require.NoError(t, err)
		t.Fatal("the listener stopped before it was ready")
	}

	require.NoError(t, queries.DeleteVault(t.Context(), vault.ID))

	select {
	case change := <-changes:
		assert.Equal(t, store.VaultChange{VaultID: vault.ID, Seq: 0}, change)
	case <-time.After(30 * time.Second):
		t.Fatal("DeleteVault sent no notification")
	}

	cancel()
	require.NoError(t, <-listened)
}
