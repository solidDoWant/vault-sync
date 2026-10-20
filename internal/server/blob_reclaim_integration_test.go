//go:build integration

package server_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// reclaimLimits are the production defaults, reclaim threshold included.
var reclaimLimits = api.BlobLimits{
	MaxChunkBytes:      config.DefaultBlobMaxChunkBytes,
	MaxBlobBytes:       config.DefaultBlobMaxSizeBytes,
	MaxUploadsPerVault: config.DefaultBlobMaxUploadsPerVault,
	UploadReclaimIdle:  config.DefaultBlobUploadReclaimIdle,
}

// idleFor makes the session of blobID look idle for idle, by moving its last
// activity back in the database: no test waits on the clock.
func (fixture *blobFixture) idleFor(t *testing.T, vaultID string, blobID []byte, idle time.Duration) uuid.UUID {
	t.Helper()

	var uploadID uuid.UUID

	err := fixture.pool.QueryRow(t.Context(), `
		UPDATE blob_uploads SET updated_at = now() - $3 * interval '1 microsecond'
		WHERE vault_id = $1 AND blob_id = $2 AND state = 'uploading'
		RETURNING id`, vaultID, blobID, idle.Microseconds()).Scan(&uploadID)
	require.NoError(t, err)

	return uploadID
}

// stagedObjects counts the staged chunk objects of session uploadID.
func (fixture *blobFixture) stagedObjects(t *testing.T, vaultID string, uploadID uuid.UUID) int {
	t.Helper()

	listed, err := fixture.objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
		Bucket: aws.String(fixture.objects.Bucket()),
		Prefix: aws.String(blobstore.UploadPrefix(uuid.MustParse(vaultID), uploadID)),
	})
	require.NoError(t, err)

	return int(aws.ToInt32(listed.KeyCount))
}

// fillUploads opens limit sessions in the vault, each with one stored chunk
// of its blob's two, as interrupted uploads leave them; it returns the blobs.
func (fixture *blobFixture) fillUploads(t *testing.T, token, vaultID string, limit int) [][]byte {
	t.Helper()

	contents := make([][]byte, 0, limit)

	for upload := range limit {
		content := append(fmt.Appendf(nil, "abandoned draft %03d", upload), randomBytes(t, blobstore.MinChunkBytes)...)
		_, err := fixture.begin(t, token, vaultID, blobIDOf(content), len(content))
		require.NoError(t, err)
		_, err = fixture.put(t, token, vaultID, blobIDOf(content), 0, content[:blobstore.MinChunkBytes])
		require.NoError(t, err)

		contents = append(contents, content)
	}

	return contents
}

// #370: abandoned upload sessions filling the vault's session limit must not
// block every later upload until the upload TTL; a BeginBlob at the limit
// reclaims sessions idle for longer than VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE.
func TestBlobUploadReclaim(t *testing.T) {
	fixture := newBlobFixture(t, reclaimLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")
	vaultID := vault.GetId()
	limit := reclaimLimits.MaxUploadsPerVault
	idle := reclaimLimits.UploadReclaimIdle

	abandoned := fixture.fillUploads(t, token, vaultID, limit)
	fresh := []byte("a later upload")

	// Every session saw activity within the threshold: nothing is reclaimed.
	recent := fixture.idleFor(t, vaultID, blobIDOf(abandoned[1]), idle-time.Minute)
	_, err := fixture.begin(t, token, vaultID, blobIDOf(fresh), len(fresh))
	requireCode(t, connect.CodeResourceExhausted, err)

	// One session has been idle past the threshold: it is reclaimed and the
	// new upload takes its place, the whole way through.
	reclaimed := fixture.idleFor(t, vaultID, blobIDOf(abandoned[0]), idle+time.Second)
	require.Equal(t, 1, fixture.stagedObjects(t, vaultID, reclaimed))

	begun, err := fixture.begin(t, token, vaultID, blobIDOf(fresh), len(fresh))
	require.NoError(t, err)
	assert.Zero(t, begun.GetReceivedSize())
	_, err = fixture.put(t, token, vaultID, blobIDOf(fresh), 0, fresh)
	require.NoError(t, err)

	// Exactly one slot was freed: the session idle for less is kept.
	other := []byte("yet another upload")
	_, err = fixture.begin(t, token, vaultID, blobIDOf(other), len(other))
	requireCode(t, connect.CodeResourceExhausted, err)

	_, err = fixture.put(t, token, vaultID, blobIDOf(abandoned[1]), blobstore.MinChunkBytes, abandoned[1][blobstore.MinChunkBytes:])
	require.NoError(t, err, "the session idle for less than the threshold still accepts chunks")

	var state string

	err = fixture.pool.QueryRow(t.Context(), `SELECT state FROM blob_uploads WHERE id = $1`, recent).Scan(&state)
	require.NoError(t, err)
	assert.Equal(t, "uploading", state)

	// The reclaimed session refuses its chunks and its commit, with the
	// codes on which a client starts the upload again.
	_, err = fixture.put(t, token, vaultID, blobIDOf(abandoned[0]), blobstore.MinChunkBytes, abandoned[0][blobstore.MinChunkBytes:])
	requireCode(t, connect.CodeFailedPrecondition, err)
	_, err = fixture.commit(t, token, vaultID, blobIDOf(abandoned[0]))
	requireCode(t, connect.CodeNotFound, err)

	// The existing cleanup routine removes its staged chunks and its row.
	cleaner := &blobstore.Cleaner{Store: store.New(fixture.pool), Objects: fixture.objects, TTL: config.DefaultBlobUploadTTL}
	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, result.SessionsRemoved)
	assert.Equal(t, 1, result.ObjectsDeleted)
	assert.Zero(t, fixture.stagedObjects(t, vaultID, reclaimed))

	var rows int

	err = fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM blob_uploads WHERE id = $1`, reclaimed).Scan(&rows)
	require.NoError(t, err)
	assert.Zero(t, rows)

	// The completed upload frees its slot; the reclaimed blob then uploads
	// again from the start in a new session.
	committed, err := fixture.commit(t, token, vaultID, blobIDOf(fresh))
	require.NoError(t, err)
	assert.Equal(t, uint64(len(fresh)), committed.GetSize())

	restarted, err := fixture.begin(t, token, vaultID, blobIDOf(abandoned[0]), len(abandoned[0]))
	require.NoError(t, err)
	assert.Zero(t, restarted.GetReceivedSize())
	_, err = fixture.put(t, token, vaultID, blobIDOf(abandoned[0]), 0, abandoned[0][:blobstore.MinChunkBytes])
	require.NoError(t, err)
	_, err = fixture.put(t, token, vaultID, blobIDOf(abandoned[0]), blobstore.MinChunkBytes, abandoned[0][blobstore.MinChunkBytes:])
	require.NoError(t, err)
	_, err = fixture.commit(t, token, vaultID, blobIDOf(abandoned[0]))
	require.NoError(t, err)

	downloaded, err := fixture.download(t, token, vaultID, blobIDOf(abandoned[0]), 0, 0)
	require.NoError(t, err)
	assert.Equal(t, abandoned[0], downloaded.GetData())
}

// Concurrent BeginBlobs at the limit, on any replica, reclaim each idle
// session once: with one session reclaimable, exactly one new upload starts.
func TestBlobUploadReclaimConcurrent(t *testing.T) {
	fixture := newBlobFixture(t, reclaimLimits)
	token := fixture.token(t, "alice")
	vault := fixture.createVault(t, token, "Notes")
	vaultID := vault.GetId()

	abandoned := fixture.fillUploads(t, token, vaultID, reclaimLimits.MaxUploadsPerVault)
	fixture.idleFor(t, vaultID, blobIDOf(abandoned[0]), reclaimLimits.UploadReclaimIdle+time.Second)

	const callers = 8

	var (
		wait    sync.WaitGroup
		results = make([]error, callers)
	)

	for caller := range callers {
		wait.Go(func() {
			content := fmt.Appendf(nil, "concurrent upload %d", caller)
			_, results[caller] = fixture.begin(t, token, vaultID, blobIDOf(content), len(content))
		})
	}

	wait.Wait()

	started := 0

	for _, err := range results {
		if err == nil {
			started++

			continue
		}

		requireCode(t, connect.CodeResourceExhausted, err)
	}

	assert.Equal(t, 1, started)

	var active int

	err := fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM blob_uploads WHERE vault_id = $1 AND state = 'uploading'`,
		vaultID).Scan(&active)
	require.NoError(t, err)
	assert.Equal(t, reclaimLimits.MaxUploadsPerVault, active)
}
