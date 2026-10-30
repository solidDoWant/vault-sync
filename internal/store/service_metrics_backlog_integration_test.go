//go:build integration

package store_test

import (
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

const metricsDevice = "00000000-0000-7000-8000-0000000000d0"

// insertMetricsDevice inserts users A, B and C and a device of user A.
func insertMetricsDevice(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	insertMetricsUsers(t, pool)
	execAll(t, pool, `INSERT INTO devices (id, user_id, name) VALUES ('`+metricsDevice+`', '`+metricsUserA+`', 'd')`)
}

// insertTombstones inserts, for each epoch, a deleted document of vault
// whose only revision is a tombstone under that epoch.
func insertTombstones(t *testing.T, pool *pgxpool.Pool, vault string, epochs ...int) {
	t.Helper()

	for _, epoch := range epochs {
		document, revision := newID(), newID()

		err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
			_, err := tx.Exec(t.Context(), `INSERT INTO documents (id, vault_id, kind, head_rev_id, path_key, deleted)
				VALUES ($1, $2, 'text', $3, $4, true)`, document, vault, revision, document)
			if err != nil {
				return err
			}

			_, err = tx.Exec(t.Context(), `INSERT INTO revisions (id, document_id, vault_id, seq, path, deleted, device_id, epoch)
				VALUES ($1, $2, $3, (SELECT coalesce(max(seq), 0) + 1 FROM revisions WHERE vault_id = $3), 'p', true, $4, $5)`,
				revision, document, vault, metricsDevice, epoch)

			return err
		})
		require.NoError(t, err)
	}
}

func insertBlob(t *testing.T, pool *pgxpool.Pool, vault, content string, size int, releasedAt string) {
	t.Helper()

	execAll(t, pool, `INSERT INTO blobs (vault_id, blob_id, size, state, released_at)
		VALUES ('`+vault+`', sha256('`+content+`'), `+strconv.Itoa(size)+`, 'complete', `+releasedAt+`)`)
}

func TestEstimateBlobsCountsExactlyBelowTheThreshold(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)

	execAll(t, pool, `INSERT INTO vaults (id, name, encryption, deleted_at) VALUES
		('`+metricsVault+`01', 'v', 'none', NULL),
		('`+metricsVault+`02', 'v', 'e2ee', now())`)
	insertBlob(t, pool, metricsVault+"01", "a", 10, "NULL")
	insertBlob(t, pool, metricsVault+"01", "b", 20, "now()")
	insertBlob(t, pool, metricsVault+"02", "c", 30, "NULL")

	// Never analyzed: the estimate is 0, below any positive threshold.
	estimate, err := queries.EstimateBlobs(t.Context(), store.DefaultBlobSampling)
	require.NoError(t, err)
	assert.Equal(t, store.BlobEstimate{Blobs: 3, Bytes: 60}, estimate)

	// The planner now estimates 3 blobs; a fourth is added after.
	execAll(t, pool, `ANALYZE blobs`)
	insertBlob(t, pool, metricsVault+"01", "d", 40, "NULL")

	// An estimate of 3 is below a threshold of 4: counted exactly.
	estimate, err = queries.EstimateBlobs(t.Context(), store.BlobSampling{ExactBelow: 4, SamplePercent: 100})
	require.NoError(t, err)
	assert.Equal(t, store.BlobEstimate{Blobs: 4, Bytes: 100}, estimate)
}

func TestEstimateBlobsSamplesAtTheThreshold(t *testing.T) {
	pool := migratedPool(t)

	execAll(t, pool, `INSERT INTO vaults (id, name, encryption) VALUES ('`+metricsVault+`01', 'v', 'none')`)
	insertBlob(t, pool, metricsVault+"01", "a", 10, "NULL")
	insertBlob(t, pool, metricsVault+"01", "b", 20, "NULL")
	insertBlob(t, pool, metricsVault+"01", "c", 30, "NULL")
	execAll(t, pool, `ANALYZE blobs`)
	insertBlob(t, pool, metricsVault+"01", "d", 1000, "NULL")

	// An estimate of 3 reaches a threshold of 3: the count is the
	// estimate and the bytes are it times the sample's mean size. A 100%
	// sample reads all four blobs, mean 265.
	estimate, err := store.New(pool).EstimateBlobs(t.Context(), store.BlobSampling{ExactBelow: 3, SamplePercent: 100})
	require.NoError(t, err)
	assert.Equal(t, store.BlobEstimate{Blobs: 3, Bytes: 795}, estimate)
}

func TestCountUploadSessionsCountsOnlyOpenSessions(t *testing.T) {
	pool := migratedPool(t)

	execAll(t, pool,
		`INSERT INTO vaults (id, name, encryption) VALUES ('`+metricsVault+`01', 'v', 'none')`,
		`INSERT INTO blob_uploads (id, vault_id, blob_id, size, received_size, state, created_at) VALUES
			(gen_random_uuid(), '`+metricsVault+`01', sha256('a'), 100, 40, 'uploading', now() - interval '1 hour'),
			(gen_random_uuid(), '`+metricsVault+`01', sha256('b'), 50, 0, 'uploading', now() - interval '10 minutes'),
			(gen_random_uuid(), '`+metricsVault+`01', sha256('c'), 999, 999, 'finished', now() - interval '2 days')`)

	sessions, err := store.New(pool).CountUploadSessions(t.Context())
	require.NoError(t, err)

	assert.Equal(t, int64(2), sessions.Open)
	assert.Equal(t, int64(150), sessions.ReservedBytes)
	assert.WithinDuration(t, time.Now().Add(-time.Hour), sessions.OldestCreatedAt, 5*time.Minute)
}

func TestCountUploadSessionsWithoutOpenSessions(t *testing.T) {
	pool := migratedPool(t)

	sessions, err := store.New(pool).CountUploadSessions(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.UploadSessions{}, sessions)
}

func TestCountReleasedBlobsCountsBlobsAwaitingCollection(t *testing.T) {
	pool := migratedPool(t)

	execAll(t, pool, `INSERT INTO vaults (id, name, encryption) VALUES ('`+metricsVault+`01', 'v', 'none')`)
	insertBlob(t, pool, metricsVault+"01", "a", 5, "now()")
	insertBlob(t, pool, metricsVault+"01", "b", 7, "now() - interval '30 days'")
	insertBlob(t, pool, metricsVault+"01", "c", 11, "NULL")

	counts, err := store.New(pool).CountReleasedBlobs(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.ReleasedBlobCounts{Blobs: 2, Bytes: 12}, counts)
}

func TestCountDeletedVaultsCountsVaultsNotYetPurged(t *testing.T) {
	pool := migratedPool(t)

	execAll(t, pool, `INSERT INTO vaults (id, name, encryption, deleted_at, purged_at) VALUES
		('`+metricsVault+`01', 'v', 'none', NULL, NULL),
		('`+metricsVault+`02', 'v', 'e2ee', now(), NULL),
		('`+metricsVault+`03', 'v', 'none', now() - interval '40 days', now()),
		('`+metricsVault+`04', 'v', 'none', NULL, NULL)`)

	count, err := store.New(pool).CountDeletedVaults(t.Context())
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)
}

func TestCountStaleEpochRevisionsCountsTheReencryptionBacklog(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsDevice(t, pool)

	// 01: e2ee on epoch 2, two revisions on epoch 1. 02: e2ee on epoch 2,
	// none stale. 03: deleted e2ee vault with a stale revision, not
	// counted. 04: plaintext. 05: e2ee on epoch 1 with a revision on
	// epoch 2.
	execAll(t, pool, `INSERT INTO vaults (id, name, encryption, current_epoch, deleted_at) VALUES
		('`+metricsVault+`01', 'v', 'e2ee', 2, NULL),
		('`+metricsVault+`02', 'v', 'e2ee', 2, NULL),
		('`+metricsVault+`03', 'v', 'e2ee', 2, now()),
		('`+metricsVault+`04', 'v', 'none', 0, NULL),
		('`+metricsVault+`05', 'v', 'e2ee', 1, NULL)`)
	insertTombstones(t, pool, metricsVault+"01", 1, 1, 2)
	insertTombstones(t, pool, metricsVault+"02", 2, 2)
	insertTombstones(t, pool, metricsVault+"03", 1)
	insertTombstones(t, pool, metricsVault+"04", 0)
	insertTombstones(t, pool, metricsVault+"05", 1, 2)

	counts, err := store.New(pool).CountStaleEpochRevisions(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.StaleEpochCounts{Vaults: 2, Revisions: 3}, counts)
}

func TestCountEscrowVaultsCountsEncryptedVaultsByEscrow(t *testing.T) {
	pool := migratedPool(t)

	execAll(t, pool, `INSERT INTO vaults (id, name, encryption, escrow, deleted_at) VALUES
		('`+metricsVault+`01', 'v', 'e2ee', true, NULL),
		('`+metricsVault+`02', 'v', 'e2ee', true, NULL),
		('`+metricsVault+`03', 'v', 'e2ee', true, now()),
		('`+metricsVault+`04', 'v', 'e2ee', false, NULL),
		('`+metricsVault+`05', 'v', 'none', false, NULL)`)

	counts, err := store.New(pool).CountEscrowVaults(t.Context())
	require.NoError(t, err)
	assert.Equal(t, store.EscrowCounts{On: 2, Off: 1}, counts)
}

func TestCountEscrowSlotsNamingKeysCountsTheRewrapBacklog(t *testing.T) {
	pool := migratedPool(t)
	insertMetricsUsers(t, pool)

	slot := func(vault string, epoch int, kind, recipient string) string {
		return `('` + metricsVault + vault + `', ` + strconv.Itoa(epoch) + `, '` + kind + `', '` + recipient + `', '\x01', '` + metricsUserA + `')`
	}

	// 01: escrow slots naming "old" (epoch 1), "new" and "older" (epoch
	// 2), and a user slot whose id is "old". 02: deleted, an escrow slot
	// naming "old".
	execAll(t, pool,
		`INSERT INTO vaults (id, name, encryption, escrow, deleted_at) VALUES
			('`+metricsVault+`01', 'v', 'e2ee', true, NULL),
			('`+metricsVault+`02', 'v', 'e2ee', true, now())`,
		`INSERT INTO vault_key_epochs (vault_id, epoch, commitment, created_by) VALUES
			('`+metricsVault+`01', 1, sha256('1'), '`+metricsUserA+`'),
			('`+metricsVault+`01', 2, sha256('2'), '`+metricsUserA+`'),
			('`+metricsVault+`02', 1, sha256('3'), '`+metricsUserA+`')`,
		`INSERT INTO key_slots (vault_id, epoch, recipient_kind, recipient_id, wrapped_key, created_by) VALUES `+
			slot("01", 1, "escrow", "old")+`, `+slot("01", 2, "escrow", "new")+`, `+slot("01", 2, "escrow", "older")+`, `+
			slot("01", 1, "user", "old")+`, `+slot("02", 1, "escrow", "old"))

	queries := store.New(pool)

	for _, test := range []struct {
		name   string
		keyIDs []string
		want   int64
	}{
		{name: "no retiring ids", keyIDs: nil, want: 0},
		{name: "one retiring id", keyIDs: []string{"old"}, want: 1},
		{name: "two retiring ids", keyIDs: []string{"old", "older"}, want: 2},
		{name: "an id no slot names", keyIDs: []string{"gone"}, want: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			count, err := queries.CountEscrowSlotsNamingKeys(t.Context(), test.keyIDs)
			require.NoError(t, err)
			assert.Equal(t, test.want, count)
		})
	}
}
