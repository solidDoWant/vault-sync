//go:build integration

package store_test

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

func execAll(t *testing.T, pool *pgxpool.Pool, statements ...string) {
	t.Helper()

	for _, statement := range statements {
		_, err := pool.Exec(t.Context(), statement)
		require.NoError(t, err, statement)
	}
}

const (
	metricsUserA = "00000000-0000-7000-8000-00000000000a"
	metricsUserB = "00000000-0000-7000-8000-00000000000b"
	metricsUserC = "00000000-0000-7000-8000-00000000000c"
	metricsVault = "00000000-0000-7000-8000-0000000000"
)

func insertMetricsUsers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	execAll(t, pool, `INSERT INTO users (id, oidc_issuer, oidc_subject) VALUES
		('`+metricsUserA+`', 'https://idp.example', 'a'),
		('`+metricsUserB+`', 'https://idp.example', 'b'),
		('`+metricsUserC+`', 'https://idp.example', 'c')`)
}

func TestCountDevicesCountsDevicesNotRemoved(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsUsers(t, pool)

	// User A: one device active an hour ago, one active 10 days ago, one
	// removed (though active). User B: one device never seen, one active
	// 40 days ago. User C: only a removed device.
	execAll(t, pool, `INSERT INTO devices (id, user_id, name, last_seen, removed_at) VALUES
		(gen_random_uuid(), '`+metricsUserA+`', 'a1', now() - interval '1 hour', NULL),
		(gen_random_uuid(), '`+metricsUserA+`', 'a2', now() - interval '10 days', NULL),
		(gen_random_uuid(), '`+metricsUserA+`', 'a3', now(), now()),
		(gen_random_uuid(), '`+metricsUserB+`', 'b1', NULL, NULL),
		(gen_random_uuid(), '`+metricsUserB+`', 'b2', now() - interval '40 days', NULL),
		(gen_random_uuid(), '`+metricsUserC+`', 'c1', now(), now())`)

	counts, err := store.New(pool).CountDevices(t.Context())
	require.NoError(t, err)

	assert.Equal(t, store.DeviceCounts{Devices: 4, Users: 2, ActiveDay: 1, ActiveMonth: 2}, counts)
}

func TestCountVaultsGroupsByEncryptionAndSharing(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsUsers(t, pool)

	// 01, 02: plaintext with one member; 03: plaintext with two members;
	// 04: e2ee with three members; 05: e2ee without members; 06: deleted
	// plaintext vault with two members, not counted.
	execAll(t, pool,
		`INSERT INTO vaults (id, name, encryption, deleted_at) VALUES
			('`+metricsVault+`01', 'v', 'none', NULL),
			('`+metricsVault+`02', 'v', 'none', NULL),
			('`+metricsVault+`03', 'v', 'none', NULL),
			('`+metricsVault+`04', 'v', 'e2ee', NULL),
			('`+metricsVault+`05', 'v', 'e2ee', NULL),
			('`+metricsVault+`06', 'v', 'none', now())`,
		`INSERT INTO vault_members (vault_id, user_id, role) VALUES
			('`+metricsVault+`01', '`+metricsUserA+`', 'owner'),
			('`+metricsVault+`02', '`+metricsUserB+`', 'owner'),
			('`+metricsVault+`03', '`+metricsUserA+`', 'owner'),
			('`+metricsVault+`03', '`+metricsUserB+`', 'viewer'),
			('`+metricsVault+`04', '`+metricsUserA+`', 'owner'),
			('`+metricsVault+`04', '`+metricsUserB+`', 'editor'),
			('`+metricsVault+`04', '`+metricsUserC+`', 'viewer'),
			('`+metricsVault+`06', '`+metricsUserA+`', 'owner'),
			('`+metricsVault+`06', '`+metricsUserB+`', 'owner')`)

	counts, err := store.New(pool).CountVaults(t.Context())
	require.NoError(t, err)

	assert.ElementsMatch(t, []store.VaultCount{
		{Encryption: "none", Shared: false, Count: 2},
		{Encryption: "none", Shared: true, Count: 1},
		{Encryption: "e2ee", Shared: false, Count: 1},
		{Encryption: "e2ee", Shared: true, Count: 1},
	}, counts)
}

func TestCountMembershipsSkipsDeletedVaults(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsUsers(t, pool)

	execAll(t, pool,
		`INSERT INTO vaults (id, name, encryption, deleted_at) VALUES
			('`+metricsVault+`01', 'v', 'none', NULL),
			('`+metricsVault+`02', 'v', 'e2ee', NULL),
			('`+metricsVault+`03', 'v', 'none', now())`,
		`INSERT INTO vault_members (vault_id, user_id, role) VALUES
			('`+metricsVault+`01', '`+metricsUserA+`', 'owner'),
			('`+metricsVault+`01', '`+metricsUserB+`', 'editor'),
			('`+metricsVault+`02', '`+metricsUserC+`', 'owner'),
			('`+metricsVault+`03', '`+metricsUserA+`', 'owner')`)

	count, err := store.New(pool).CountMemberships(t.Context())
	require.NoError(t, err)

	assert.Equal(t, int64(3), count)
}

func TestCountPendingInvitationsSkipsExpiredAndDeletedVaults(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsUsers(t, pool)

	execAll(t, pool,
		`INSERT INTO vaults (id, name, encryption, deleted_at) VALUES
			('`+metricsVault+`01', 'v', 'none', NULL),
			('`+metricsVault+`02', 'v', 'none', now())`,
		`INSERT INTO vault_invitations (id, vault_id, code_hash, role, created_by, expires_at) VALUES
			(gen_random_uuid(), '`+metricsVault+`01', sha256('1'), 'editor', '`+metricsUserA+`', now() + interval '1 day'),
			(gen_random_uuid(), '`+metricsVault+`01', sha256('2'), 'viewer', '`+metricsUserA+`', now() + interval '1 hour'),
			(gen_random_uuid(), '`+metricsVault+`01', sha256('3'), 'viewer', '`+metricsUserA+`', now() - interval '1 second'),
			(gen_random_uuid(), '`+metricsVault+`02', sha256('4'), 'viewer', '`+metricsUserA+`', now() + interval '1 day')`)

	count, err := store.New(pool).CountPendingInvitations(t.Context())
	require.NoError(t, err)

	assert.Equal(t, int64(2), count)
}

func TestEstimateRowsReadsPlannerStatistics(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	// Never analyzed: no estimate yet.
	estimates, err := queries.EstimateRows(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.RowEstimates{}, estimates)

	// The fixture holds one live document; add two live and one deleted
	// document, then a second revision of the deleted one: 3 live
	// documents and 5 revisions.
	f := newFixture(t, pool)
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, newID(), newID(), "two.md", false))
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault2, newID(), newID(), "three.md", false))

	deleted, tombstone := newID(), newID()
	require.NoError(t, f.createDocument(t.Context(), pool, f.vault, deleted, tombstone, "gone.md", true))
	execAll(t, pool, `INSERT INTO revisions (id, document_id, vault_id, seq, path, deleted, device_id, parent_rev_id)
		VALUES (gen_random_uuid(), '`+deleted+`', '`+f.vault+`', 100, 'gone.md', true, '`+f.device+`', '`+tombstone+`')`)
	execAll(t, pool, `ANALYZE documents`, `ANALYZE revisions`)

	estimates, err = queries.EstimateRows(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.RowEstimates{LiveDocuments: 3, Revisions: 5}, estimates)
}

func TestSchemaVersionIsTheHighestAppliedMigration(t *testing.T) {
	pool := migratedPool(t)

	var applied int64
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM schema_migrations`).Scan(&applied))

	version, err := store.New(pool).SchemaVersion(t.Context())
	require.NoError(t, err)
	// Migrations are numbered from 1 without gaps.
	assert.Equal(t, applied, version)

	execAll(t, pool, `INSERT INTO schema_migrations (version, name) VALUES (9999, 'future')`)

	version, err = store.New(pool).SchemaVersion(t.Context())
	require.NoError(t, err)
	assert.Equal(t, int64(9999), version)
}
