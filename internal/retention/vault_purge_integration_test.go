//go:build integration

package retention_test

import (
	"crypto/sha256"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// vaultTables are the tables that hold a vault's rows.
var vaultTables = []string{
	"vaults", "vault_members", "documents", "revisions", "blobs", "blob_uploads", "blob_upload_chunks",
	"blob_deletions", "purged_revisions", "vault_retention", "vault_invitations", "vault_key_epochs", "key_slots",
}

// fill gives vaultID a committed document, a staged upload chunk object, a
// pending invitation and a retention override, and returns the document's
// blob key.
func (fixture *fixture) fill(t *testing.T, vaultID uuid.UUID, content string) string {
	t.Helper()

	sum := sha256.Sum256([]byte(content))
	key := blobstore.BlobKey(vaultID, sum[:])
	require.NoError(t, fixture.objects.Put(t.Context(), key, []byte(content)))

	vault := fixture.store.InVault(vaultID)
	require.NoError(t, vault.RecordCompleteBlob(t.Context(), sum[:], int64(len(content))))

	_, err := vault.CommitRevision(t.Context(), store.NewRevision{
		ID: uuid.Must(uuid.NewV7()), DocumentID: uuid.Must(uuid.NewV7()), Kind: "text",
		ContentRef: sum[:], ContentSize: int64(len(content)), Path: "a.md", PathKey: "a.md",
		DeviceID: fixture.device, UserID: fixture.user,
	})
	require.NoError(t, err)

	chunk := blobstore.ChunkKey(vaultID, uuid.Must(uuid.NewV7()), 0, uuid.Must(uuid.NewV7()))
	require.NoError(t, fixture.objects.Put(t.Context(), chunk, []byte("staged")))

	_, err = vault.CreateInvitation(t.Context(), fixture.user, store.RoleEditor, sum[:], time.Hour, 10)
	require.NoError(t, err)

	require.NoError(t, fixture.store.SetVaultRetention(t.Context(), vaultID, policy))

	return key
}

// deletedAgo deletes vaultID and backdates its deletion by ago, a
// PostgreSQL interval.
func (fixture *fixture) deletedAgo(t *testing.T, vaultID uuid.UUID, ago string) {
	t.Helper()

	require.NoError(t, fixture.store.DeleteVault(t.Context(), vaultID))

	_, err := fixture.pool.Exec(t.Context(), `UPDATE vaults SET deleted_at = now() - $2::interval WHERE id = $1`, vaultID, ago)
	require.NoError(t, err)
}

// rows counts vaultID's rows in each vault table that has any.
func (fixture *fixture) rows(t *testing.T, vaultID uuid.UUID) map[string]int {
	t.Helper()

	counts := map[string]int{}

	for _, table := range vaultTables {
		column := "vault_id"
		if table == "vaults" {
			column = "id"
		}

		var count int
		require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table+` WHERE `+column+` = $1`, vaultID).Scan(&count))

		if count > 0 {
			counts[table] = count
		}
	}

	return counts
}

// objectCount counts vaultID's objects.
func (fixture *fixture) objectCount(t *testing.T, vaultID uuid.UUID) int {
	t.Helper()

	listed, err := fixture.objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
		Bucket: aws.String(fixture.objects.Bucket()),
		Prefix: aws.String(blobstore.VaultPrefix(vaultID)),
	})
	require.NoError(t, err)

	return len(listed.Contents)
}

func TestVaultDeletedMoreThanThirtyDaysAgoIsPurged(t *testing.T) {
	fixture := newFixture(t)

	expired := fixture.vault.VaultID()
	fixture.fill(t, expired, "expired")

	recent, err := fixture.store.CreateVault(t.Context(), fixture.user, store.NewVault{Name: "Recent", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)
	fixture.fill(t, recent.ID, "recent")

	live, err := fixture.store.CreateVault(t.Context(), fixture.user, store.NewVault{Name: "Live", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)
	fixture.fill(t, live.ID, "live")

	kept := fixture.rows(t, recent.ID)
	liveRows := fixture.rows(t, live.ID)

	fixture.deletedAgo(t, expired, "30 days 1 second")
	fixture.deletedAgo(t, recent.ID, "29 days 23 hours 59 minutes")

	result, err := fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{VaultsPurged: 1}, result)

	assert.Empty(t, fixture.rows(t, expired), "every row of the expired vault is gone")
	assert.Zero(t, fixture.objectCount(t, expired), "every object of the expired vault is gone")

	assert.Equal(t, kept, fixture.rows(t, recent.ID), "a vault deleted less than 30 days ago is kept")
	assert.Equal(t, 2, fixture.objectCount(t, recent.ID))

	assert.Equal(t, liveRows, fixture.rows(t, live.ID), "a live vault is untouched")
	assert.Equal(t, 2, fixture.objectCount(t, live.ID))

	result, err = fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)

	// Even named directly, a vault deleted less than 30 days ago (or one
	// undeleted since it was listed) is not purged.
	purging, err := fixture.store.PurgeVaultRows(t.Context(), recent.ID, retention.DefaultVaultPurgeAge)
	require.NoError(t, err)
	assert.False(t, purging)

	purging, err = fixture.store.PurgeVaultRows(t.Context(), live.ID, retention.DefaultVaultPurgeAge)
	require.NoError(t, err)
	assert.False(t, purging)
	assert.Equal(t, kept, fixture.rows(t, recent.ID))
}

func TestInterruptedVaultPurgeIsFinishedAndCannotBeUndeleted(t *testing.T) {
	fixture := newFixture(t)

	vaultID := fixture.vault.VaultID()
	fixture.fill(t, vaultID, "content")
	fixture.deletedAgo(t, vaultID, "31 days")

	job := fixture.job()
	job.VaultObjectsPerRun = 1

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result, "objects remain: the purge is not finished")
	assert.Equal(t, map[string]int{"vaults": 1}, fixture.rows(t, vaultID), "the rows went first")
	assert.Equal(t, 1, fixture.objectCount(t, vaultID))

	require.ErrorIs(t, fixture.store.UndeleteVault(t.Context(), vaultID), store.ErrVaultNotFound,
		"a vault whose purge started cannot be undeleted")

	job.VaultObjectsPerRun = 0

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{VaultsPurged: 1}, result)
	assert.Empty(t, fixture.rows(t, vaultID))
	assert.Zero(t, fixture.objectCount(t, vaultID))
}
