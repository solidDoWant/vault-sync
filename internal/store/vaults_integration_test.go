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

func vaultIDs(vaults []store.Vault) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(vaults))
	for _, vault := range vaults {
		ids = append(ids, vault.ID)
	}

	return ids
}

func TestCreateVaultMakesTheCreatorItsOnlyMember(t *testing.T) {
	queries := store.New(migratedPool(t))

	alice, err := queries.UpsertUser(t.Context(), testIssuer, "alice")
	require.NoError(t, err)

	bob, err := queries.UpsertUser(t.Context(), testIssuer, "bob")
	require.NoError(t, err)

	created, err := queries.CreateVault(t.Context(), alice, store.NewVault{Name: "Notes", Encryption: store.EncryptionE2EE, Escrow: true}, 10)
	require.NoError(t, err)

	assert.Equal(t, uuid.Version(7), created.ID.Version())
	assert.Equal(t, store.RoleOwner, created.Role)
	assert.Zero(t, created.HeadSeq)
	assert.False(t, created.CreatedAt.IsZero())

	aliceVaults, err := queries.ListVaults(t.Context(), alice, uuid.Nil, 100)
	require.NoError(t, err)
	require.Len(t, aliceVaults, 1)
	assert.Equal(t, created, aliceVaults[0])

	bobVaults, err := queries.ListVaults(t.Context(), bob, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Empty(t, bobVaults)

	role, err := queries.VaultRole(t.Context(), created.ID, alice)
	require.NoError(t, err)
	assert.Equal(t, store.RoleOwner, role)

	_, err = queries.VaultRole(t.Context(), created.ID, bob)
	require.ErrorIs(t, err, store.ErrVaultNotFound, "a non-member is told the vault does not exist")

	_, err = queries.VaultRole(t.Context(), uuid.Must(uuid.NewV7()), alice)
	require.ErrorIs(t, err, store.ErrVaultNotFound)
}

func TestListVaultsReportsEachMembersRoleAndPaginates(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	alice, err := queries.UpsertUser(t.Context(), testIssuer, "alice")
	require.NoError(t, err)

	bob, err := queries.UpsertUser(t.Context(), testIssuer, "bob")
	require.NoError(t, err)

	var owned []uuid.UUID

	for range 5 {
		vault, err := queries.CreateVault(t.Context(), alice, store.NewVault{Name: "Vault", Encryption: store.EncryptionNone}, 10)
		require.NoError(t, err)

		owned = append(owned, vault.ID)
	}

	// Membership management is Phase 3; seed memberships directly.
	_, err = pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor'), ($3, $2, 'viewer')`,
		owned[1], bob, owned[3])
	require.NoError(t, err)

	var pages [][]uuid.UUID

	after := uuid.Nil

	for {
		page, err := queries.ListVaults(t.Context(), alice, after, 2)
		require.NoError(t, err)

		if len(page) == 0 {
			break
		}

		pages = append(pages, vaultIDs(page))
		after = page[len(page)-1].ID
	}

	assert.Equal(t, [][]uuid.UUID{owned[0:2], owned[2:4], owned[4:5]}, pages)

	bobVaults, err := queries.ListVaults(t.Context(), bob, uuid.Nil, 100)
	require.NoError(t, err)
	require.Len(t, bobVaults, 2)
	assert.Equal(t, []uuid.UUID{owned[1], owned[3]}, vaultIDs(bobVaults))
	assert.Equal(t, store.RoleEditor, bobVaults[0].Role)
	assert.Equal(t, store.RoleViewer, bobVaults[1].Role)

	for _, vault := range bobVaults {
		role, err := queries.VaultRole(t.Context(), vault.ID, bob)
		require.NoError(t, err)
		assert.Equal(t, vault.Role, role)
	}
}

func TestCreateVaultEnforcesTheLimitUnderConcurrency(t *testing.T) {
	queries := store.New(migratedPool(t))

	user, err := queries.UpsertUser(t.Context(), testIssuer, "alice")
	require.NoError(t, err)

	const (
		limit    = 3
		attempts = 12
	)

	errs := make([]error, attempts)

	var group sync.WaitGroup

	for attempt := range attempts {
		group.Go(func() {
			_, errs[attempt] = queries.CreateVault(t.Context(), user, store.NewVault{Name: "Vault", Encryption: store.EncryptionNone}, limit)
		})
	}

	group.Wait()

	succeeded := 0

	for _, err := range errs {
		if err == nil {
			succeeded++

			continue
		}

		require.ErrorIs(t, err, store.ErrVaultLimit)
	}

	assert.Equal(t, limit, succeeded)

	vaults, err := queries.ListVaults(t.Context(), user, uuid.Nil, 100)
	require.NoError(t, err)
	assert.Len(t, vaults, limit)
}

func TestCreateVaultRequiresAnExistingUser(t *testing.T) {
	queries := store.New(migratedPool(t))

	_, err := queries.CreateVault(t.Context(), uuid.New(), store.NewVault{Name: "Vault", Encryption: store.EncryptionNone}, 10)
	require.ErrorIs(t, err, store.ErrUserNotFound)
}

func TestVaultMembersReturnsOnlyTheMembersAmongTheGivenUsers(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	alice, err := queries.UpsertUser(t.Context(), testIssuer, "alice")
	require.NoError(t, err)

	bob, err := queries.UpsertUser(t.Context(), testIssuer, "bob")
	require.NoError(t, err)

	carol, err := queries.UpsertUser(t.Context(), testIssuer, "carol")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), alice, store.NewVault{Name: "Vault", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	other, err := queries.CreateVault(t.Context(), carol, store.NewVault{Name: "Other", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	// Membership management is Phase 3; seed memberships directly.
	_, err = pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'viewer')`, vault.ID, bob)
	require.NoError(t, err)

	tests := []struct {
		name    string
		vaultID uuid.UUID
		users   []uuid.UUID
		members map[uuid.UUID]bool
	}{
		{
			name:    "members and a member of another vault",
			vaultID: vault.ID,
			users:   []uuid.UUID{alice, bob, carol},
			members: map[uuid.UUID]bool{alice: true, bob: true},
		},
		{
			name:    "only users asked about",
			vaultID: vault.ID,
			users:   []uuid.UUID{bob, uuid.New()},
			members: map[uuid.UUID]bool{bob: true},
		},
		{
			name:    "no users",
			vaultID: vault.ID,
			users:   []uuid.UUID{},
			members: map[uuid.UUID]bool{},
		},
		{
			name:    "the other vault",
			vaultID: other.ID,
			users:   []uuid.UUID{alice, bob, carol},
			members: map[uuid.UUID]bool{carol: true},
		},
		{
			name:    "a vault that does not exist",
			vaultID: uuid.New(),
			users:   []uuid.UUID{alice, bob, carol},
			members: map[uuid.UUID]bool{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			members, err := queries.VaultMembers(t.Context(), test.vaultID, test.users)
			require.NoError(t, err)
			assert.Equal(t, test.members, members)
		})
	}
}

// TestVaultStoreCannotReachAnotherVault proves that ids from one vault cannot
// be used through another vault's handle (issue #10, criterion 5).
func TestVaultStoreCannotReachAnotherVault(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	f := newFixture(t, pool)

	// A second document in the other vault, and a blob with the same content
	// address in both vaults (blob ids are per vault).
	document2, head2 := newID(), newID()
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault2, document2, head2, "other.md", false))

	_, err := pool.Exec(t.Context(), `INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, 1234, 'uploading')`, f.vault2, f.blob)
	require.NoError(t, err)

	vault1 := queries.InVault(uuid.MustParse(f.vault))
	vault2 := queries.InVault(uuid.MustParse(f.vault2))

	tests := []struct {
		name string
		// lookup returns the vault id of the record found through vault.
		lookup func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error)
		// home is the vault the record belongs to; other is any other.
		home, other *store.VaultStore
	}{
		{
			name: "document",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				document, err := vault.Document(t.Context(), uuid.MustParse(document2))

				return document.VaultID, err
			},
			home: vault2, other: vault1,
		},
		{
			name: "revision",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				revision, err := vault.Revision(t.Context(), uuid.MustParse(head2))

				return revision.VaultID, err
			},
			home: vault2, other: vault1,
		},
		{
			name: "document of the first vault",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				document, err := vault.Document(t.Context(), uuid.MustParse(f.document))

				return document.VaultID, err
			},
			home: vault1, other: vault2,
		},
		{
			name: "revision of the first vault",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				revision, err := vault.Revision(t.Context(), uuid.MustParse(f.head))

				return revision.VaultID, err
			},
			home: vault1, other: vault2,
		},
		{
			name: "blob",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				blob, err := vault.Blob(t.Context(), f.blob2)

				return blob.VaultID, err
			},
			home: vault2, other: vault1,
		},
		{
			name: "blob stored in neither vault",
			lookup: func(t *testing.T, vault *store.VaultStore) (uuid.UUID, error) {
				blob, err := vault.Blob(t.Context(), blobID("not stored anywhere"))

				return blob.VaultID, err
			},
			home: nil, other: vault1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.home != nil {
				vaultID, err := test.lookup(t, test.home)
				require.NoError(t, err)
				assert.Equal(t, test.home.VaultID(), vaultID)
			}

			_, err := test.lookup(t, test.other)
			require.ErrorIs(t, err, store.ErrNotFound)
		})
	}

	t.Run("same blob id in two vaults resolves to each vault's own blob", func(t *testing.T) {
		blob1, err := vault1.Blob(t.Context(), f.blob)
		require.NoError(t, err)

		blob2, err := vault2.Blob(t.Context(), f.blob)
		require.NoError(t, err)

		assert.Equal(t, vault1.VaultID(), blob1.VaultID)
		assert.Equal(t, int64(9), blob1.Size)
		assert.Equal(t, "complete", blob1.State)
		assert.Equal(t, vault2.VaultID(), blob2.VaultID)
		assert.Equal(t, int64(1234), blob2.Size)
		assert.Equal(t, "uploading", blob2.State)
	})
}
