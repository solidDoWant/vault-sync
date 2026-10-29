//go:build integration

package vaultcmd_test

import (
	"bytes"
	"crypto/sha256"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
	"github.com/solidDoWant/vault-sync/internal/vaultcmd"
)

const testIssuer = "https://issuer.example"

type fixture struct {
	pool    *pgxpool.Pool
	store   *store.Store
	objects *blobstore.Objects
	env     map[string]string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	cfg := testinfra.PostgresConfig(t)

	pool, err := store.Open(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	objects, err := blobstore.New(testinfra.S3Bucket(t))
	require.NoError(t, err)

	return &fixture{
		pool: pool, store: store.New(pool), objects: objects,
		env: map[string]string{config.DatabaseURLEnv: cfg.DSN},
	}
}

// run runs the subcommand with args and returns its exit code and output.
func (fixture *fixture) run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	lookup := func(name string) (string, bool) {
		value, ok := fixture.env[name]

		return value, ok
	}

	code := vaultcmd.Main(t.Context(), args, lookup, &stdout, &stderr)

	return code, stdout.String(), stderr.String()
}

// purge runs the retention job, which purges deleted vaults.
// It purges vaults deleted more than age ago (the default if zero).
func (fixture *fixture) purge(t *testing.T, age time.Duration) retention.Result {
	t.Helper()

	job := &retention.Job{
		Store: fixture.store, Objects: fixture.objects, VaultPurgeAge: age,
		Policy: store.RetentionPolicy{KeepAll: retention.DefaultKeepAll, KeepDaily: retention.DefaultKeepDaily},
		Grace:  retention.DefaultGrace,
	}

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)

	return result
}

// deletedAgo backdates vaultID's deletion by ago, a PostgreSQL interval.
func (fixture *fixture) deletedAgo(t *testing.T, vaultID uuid.UUID, ago string) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE vaults SET deleted_at = now() - $2::interval WHERE id = $1`, vaultID, ago)
	require.NoError(t, err)
}

func TestUndeleteRestoresADeletedVaultIntact(t *testing.T) {
	fixture := newFixture(t)
	ctx := t.Context()

	owner, err := fixture.store.UpsertUser(ctx, testIssuer, "owner", "")
	require.NoError(t, err)

	editor, err := fixture.store.UpsertUser(ctx, testIssuer, "editor", "")
	require.NoError(t, err)

	device, err := fixture.store.RegisterDevice(ctx, owner, "laptop", nil, 10)
	require.NoError(t, err)

	vault, err := fixture.store.CreateVault(ctx, owner, store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	codeHash := []byte("editor-code-hash-000000000000000")
	_, err = fixture.store.InVault(vault.ID).CreateInvitation(ctx, owner, store.RoleEditor, codeHash, time.Hour, 10)
	require.NoError(t, err)

	_, err = fixture.store.RedeemInvitation(ctx, editor, codeHash, 10)
	require.NoError(t, err)

	vaultStore := fixture.store.InVault(vault.ID)
	documentID := uuid.Must(uuid.NewV7())

	var (
		head  uuid.NullUUID
		blobs [][]byte
	)

	for _, content := range []string{"first", "second"} {
		sum := sha256.Sum256([]byte(content))
		require.NoError(t, fixture.objects.Put(ctx, blobstore.BlobKey(vault.ID, sum[:]), []byte(content)))
		require.NoError(t, vaultStore.RecordCompleteBlob(ctx, sum[:], int64(len(content))))

		committed, err := vaultStore.CommitRevision(ctx, store.NewRevision{
			ID: uuid.Must(uuid.NewV7()), DocumentID: documentID, BaseRevID: head, Kind: "text",
			ContentRef: sum[:], ContentSize: int64(len(content)), Path: "a.md", PathKey: "a.md",
			DeviceID: device.ID, UserID: owner,
		})
		require.NoError(t, err)

		blobs = append(blobs, sum[:])
		head = uuid.NullUUID{UUID: committed.ID, Valid: true}
	}

	before, err := vaultStore.DocumentHistory(ctx, documentID, 0, 10)
	require.NoError(t, err)

	require.NoError(t, fixture.store.DeleteVault(ctx, vault.ID))
	fixture.deletedAgo(t, vault.ID, "29 days 23 hours")

	_, err = fixture.store.VaultRole(ctx, vault.ID, editor)
	require.ErrorIs(t, err, store.ErrVaultDeleted)

	code, stdout, stderr := fixture.run(t, "undelete", vault.ID.String())
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, vault.ID.String())

	for member, role := range map[uuid.UUID]store.Role{owner: store.RoleOwner, editor: store.RoleEditor} {
		got, err := fixture.store.VaultRole(ctx, vault.ID, member)
		require.NoError(t, err, "members' requests succeed again")
		assert.Equal(t, role, got)
	}

	listed, err := fixture.store.ListVaults(ctx, editor, uuid.Nil, 10)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, vault.ID, listed[0].ID)

	// However long after the deletion the purge runs, it leaves the
	// undeleted vault alone.
	assert.Equal(t, retention.Result{}, fixture.purge(t, time.Microsecond))

	after, err := vaultStore.DocumentHistory(ctx, documentID, 0, 10)
	require.NoError(t, err)
	assert.Equal(t, before.Revisions, after.Revisions, "the history is intact")
	assert.Equal(t, before.Document, after.Document, "the document is intact")

	for index, content := range []string{"first", "second"} {
		reader, err := fixture.objects.Open(ctx, blobstore.BlobKey(vault.ID, blobs[index]))
		require.NoError(t, err)

		data, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.NoError(t, reader.Close())
		assert.Equal(t, content, string(data), "the blobs are intact")
	}
}

func TestUndeleteRefusesAVaultItCannotRestore(t *testing.T) {
	fixture := newFixture(t)
	ctx := t.Context()

	owner, err := fixture.store.UpsertUser(ctx, testIssuer, "owner", "")
	require.NoError(t, err)

	purged, err := fixture.store.CreateVault(ctx, owner, store.NewVault{Name: "Purged", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	require.NoError(t, fixture.store.DeleteVault(ctx, purged.ID))
	fixture.deletedAgo(t, purged.ID, "30 days 1 second")
	require.Equal(t, retention.Result{VaultsPurged: 1}, fixture.purge(t, 0))

	live, err := fixture.store.CreateVault(ctx, owner, store.NewVault{Name: "Live", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	tests := []struct {
		name    string
		vaultID uuid.UUID
		message string
	}{
		{name: "unknown vault", vaultID: uuid.Must(uuid.NewV7()), message: "does not exist or has been purged"},
		{name: "purged vault", vaultID: purged.ID, message: "does not exist or has been purged"},
		{name: "vault not deleted", vaultID: live.ID, message: "is not deleted"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := fixture.run(t, "undelete", test.vaultID.String())
			assert.Equal(t, 1, code)
			assert.Empty(t, stdout)
			assert.Contains(t, stderr, test.vaultID.String())
			assert.Contains(t, stderr, test.message)
		})
	}

	code, _, stderr := fixture.run(t, "undelete", "not-a-uuid")
	assert.Equal(t, 2, code)
	assert.Contains(t, stderr, "is not a vault ID")
}
