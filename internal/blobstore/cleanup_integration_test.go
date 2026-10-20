//go:build integration

package blobstore_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

type cleanupFixture struct {
	pool          *pgxpool.Pool
	store         *store.Store
	objects       *blobstore.Objects
	objectsConfig blobstore.Config
	vault         *store.VaultStore
}

func newCleanupFixture(t *testing.T) *cleanupFixture {
	t.Helper()

	pool, err := store.Open(t.Context(), testinfra.PostgresConfig(t))
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	objectsConfig := testinfra.S3Bucket(t)

	objects, err := blobstore.New(objectsConfig)
	require.NoError(t, err)

	queries := store.New(pool)

	userID, err := queries.UpsertUser(t.Context(), "https://issuer.example", "alice")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), userID, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	return &cleanupFixture{pool: pool, store: queries, objects: objects, objectsConfig: objectsConfig, vault: queries.InVault(vault.ID)}
}

// startUpload opens an upload session with chunks staged chunks of 10 bytes
// and returns its id.
func (fixture *cleanupFixture) startUpload(t *testing.T, name string, chunks int) uuid.UUID {
	t.Helper()

	sum := sha256.Sum256([]byte(name))

	start, err := fixture.vault.BeginBlobUpload(t.Context(), sum[:], int64(10*chunks+10), 100, 0)
	require.NoError(t, err)

	upload := start.Upload

	for index := range chunks {
		chunk := store.BlobChunk{Offset: int64(10 * index), Length: 10, Token: uuid.New()}
		require.NoError(t, fixture.objects.Put(t.Context(),
			blobstore.ChunkKey(upload.VaultID, upload.ID, chunk.Offset, chunk.Token), []byte(fmt.Sprintf("%010d", index))))

		_, err := fixture.vault.AppendBlobChunk(t.Context(), upload.ID, chunk)
		require.NoError(t, err)
	}

	return upload.ID
}

// idle makes a session look idle for age.
func (fixture *cleanupFixture) idle(t *testing.T, uploadID uuid.UUID, age time.Duration) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE blob_uploads SET updated_at = now() - $2 * interval '1 second' WHERE id = $1`,
		uploadID, age.Seconds())
	require.NoError(t, err)
}

func (fixture *cleanupFixture) stagedObjects(t *testing.T, uploadID uuid.UUID) int {
	t.Helper()

	listed, err := fixture.objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
		Bucket: aws.String(fixture.objects.Bucket()),
		Prefix: aws.String(blobstore.UploadPrefix(fixture.vault.VaultID(), uploadID)),
	})
	require.NoError(t, err)

	return len(listed.Contents)
}

func (fixture *cleanupFixture) sessionExists(t *testing.T, uploadID uuid.UUID) bool {
	t.Helper()

	var exists bool

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM blob_uploads WHERE id = $1)`, uploadID).Scan(&exists))

	return exists
}

func (fixture *cleanupFixture) multipartUploads(t *testing.T) int {
	t.Helper()

	listed, err := fixture.objects.Client().ListMultipartUploads(t.Context(), &s3.ListMultipartUploadsInput{
		Bucket: aws.String(fixture.objects.Bucket()),
	})
	require.NoError(t, err)

	return len(listed.Uploads)
}

// Criterion 6: an upload abandoned past its TTL is removed, staged chunks
// and all, and so are S3 multipart uploads left behind by an interrupted
// commit. Active uploads are left alone.
func TestCleanerRemovesAbandonedUploads(t *testing.T) {
	fixture := newCleanupFixture(t)

	abandoned := fixture.startUpload(t, "abandoned", 3)
	fixture.idle(t, abandoned, 2*time.Hour)

	active := fixture.startUpload(t, "active", 2)
	fixture.idle(t, active, 30*time.Minute)

	// An interrupted commit's multipart upload.
	created, err := fixture.objects.Client().CreateMultipartUpload(t.Context(), &s3.CreateMultipartUploadInput{
		Bucket: aws.String(fixture.objects.Bucket()),
		Key:    aws.String(blobstore.BlobKey(fixture.vault.VaultID(), make([]byte, 32))),
	})
	require.NoError(t, err)
	require.NotEmpty(t, aws.ToString(created.UploadId))
	require.Equal(t, 1, fixture.multipartUploads(t))

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: fixture.objects, TTL: time.Hour}

	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)

	assert.Equal(t, blobstore.CleanupResult{SessionsRemoved: 1, ObjectsDeleted: 3}, result)
	assert.Zero(t, fixture.stagedObjects(t, abandoned))
	assert.False(t, fixture.sessionExists(t, abandoned))

	assert.Equal(t, 2, fixture.stagedObjects(t, active), "an active upload keeps its chunks")
	assert.True(t, fixture.sessionExists(t, active))
	assert.Equal(t, 1, fixture.multipartUploads(t), "a recent multipart upload may belong to a commit in progress")

	// Once the TTL has passed for everything, all of it goes.
	time.Sleep(10 * time.Millisecond)

	cleaner.TTL = time.Millisecond

	result, err = cleaner.RunOnce(t.Context())
	require.NoError(t, err)

	assert.Equal(t, blobstore.CleanupResult{SessionsRemoved: 1, ObjectsDeleted: 2, MultipartAborted: 1}, result)
	assert.False(t, fixture.sessionExists(t, active))
	assert.Zero(t, fixture.multipartUploads(t))

	// The blob can be uploaded again afterwards.
	sum := sha256.Sum256([]byte("abandoned"))
	start, err := fixture.vault.BeginBlobUpload(t.Context(), sum[:], 40, 100, 0)
	require.NoError(t, err)
	assert.NotEqual(t, abandoned, start.Upload.ID)
	assert.Zero(t, start.Upload.ReceivedSize)
}

func TestCleanerBoundsTheWorkOfOneRun(t *testing.T) {
	fixture := newCleanupFixture(t)

	var uploads []uuid.UUID

	for index := range 3 {
		upload := fixture.startUpload(t, fmt.Sprintf("upload %d", index), 5)
		fixture.idle(t, upload, 2*time.Hour)
		uploads = append(uploads, upload)
	}

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: fixture.objects, TTL: time.Hour, SessionsPerRun: 2, ObjectsPerRun: 7}

	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, blobstore.CleanupResult{SessionsRemoved: 1, ObjectsDeleted: 7}, result)

	// Later runs finish the job.
	removed, deleted := result.SessionsRemoved, result.ObjectsDeleted

	for range 5 {
		result, err := cleaner.RunOnce(t.Context())
		require.NoError(t, err)
		assert.LessOrEqual(t, result.ObjectsDeleted, 7)

		removed += result.SessionsRemoved
		deleted += result.ObjectsDeleted
	}

	assert.Equal(t, 3, removed)
	assert.Equal(t, 15, deleted)

	for _, upload := range uploads {
		assert.False(t, fixture.sessionExists(t, upload))
		assert.Zero(t, fixture.stagedObjects(t, upload))
	}
}

// A chunk write or commit that has just read an idle session counts as
// activity, so the cleaner cannot remove the session (and its staged
// objects) while that request is still writing.
func TestCleanerSparesASessionARequestJustRead(t *testing.T) {
	fixture := newCleanupFixture(t)

	upload := fixture.startUpload(t, "resumed", 2)
	fixture.idle(t, upload, 2*time.Hour)

	sum := sha256.Sum256([]byte("resumed"))
	active, err := fixture.vault.ActiveBlobUpload(t.Context(), sum[:])
	require.NoError(t, err)
	require.Equal(t, upload, active.ID)

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: fixture.objects, TTL: time.Hour}

	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, blobstore.CleanupResult{}, result)
	assert.True(t, fixture.sessionExists(t, upload))
	assert.Equal(t, 2, fixture.stagedObjects(t, upload))
}

// A finished session (after a commit or a failed hash) whose staged chunks
// could not be removed right away is removed by the next run, whatever its
// age.
func TestCleanerRemovesFinishedUploadsLeftBehind(t *testing.T) {
	fixture := newCleanupFixture(t)

	upload := fixture.startUpload(t, "finished", 2)
	require.NoError(t, fixture.vault.FinishBlobUpload(t.Context(), upload))

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: fixture.objects, TTL: time.Hour}

	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, blobstore.CleanupResult{SessionsRemoved: 1, ObjectsDeleted: 2}, result)
	assert.False(t, fixture.sessionExists(t, upload))
}

// Credentials are read from their files again after the refresh interval,
// so rotated credentials take effect without a restart.
func TestCredentialsAreReReadFromTheirFiles(t *testing.T) {
	cfg := testinfra.S3Bucket(t)
	cfg.CredentialsRefreshInterval = 50 * time.Millisecond

	secret, err := os.ReadFile(cfg.SecretAccessKeyFile)
	require.NoError(t, err)

	objects, err := blobstore.New(cfg)
	require.NoError(t, err)
	require.NoError(t, objects.Check(t.Context()))

	// Rotated to a secret the store does not accept: requests fail...
	require.NoError(t, os.WriteFile(cfg.SecretAccessKeyFile, []byte("rotated-but-wrong"), 0o600))
	assert.Eventually(t, func() bool { return objects.Check(t.Context()) != nil }, 5*time.Second, 20*time.Millisecond)

	// ...and rotated back, they succeed, with the same client.
	require.NoError(t, os.WriteFile(cfg.SecretAccessKeyFile, secret, 0o600))
	assert.Eventually(t, func() bool { return objects.Check(t.Context()) == nil }, 5*time.Second, 20*time.Millisecond)
}

// createMultipart starts a multipart upload of the blob object for name, as
// an interrupted commit leaves behind, and returns its key.
func (fixture *cleanupFixture) createMultipart(t *testing.T, name string) string {
	t.Helper()

	sum := sha256.Sum256([]byte(name))
	key := blobstore.BlobKey(fixture.vault.VaultID(), sum[:])

	_, err := fixture.objects.Client().CreateMultipartUpload(t.Context(), &s3.CreateMultipartUploadInput{
		Bucket: aws.String(fixture.objects.Bucket()),
		Key:    aws.String(key),
	})
	require.NoError(t, err)

	return key
}

// abortAll aborts every multipart upload at key, as another server
// process's cleaner would.
func (fixture *cleanupFixture) abortAll(t *testing.T, key string) {
	t.Helper()

	listed, err := fixture.objects.Client().ListMultipartUploads(t.Context(), &s3.ListMultipartUploadsInput{
		Bucket: aws.String(fixture.objects.Bucket()),
		Prefix: aws.String(key),
	})
	require.NoError(t, err)

	for _, upload := range listed.Uploads {
		_, err := fixture.objects.Client().AbortMultipartUpload(t.Context(), &s3.AbortMultipartUploadInput{
			Bucket: aws.String(fixture.objects.Bucket()), Key: upload.Key, UploadId: upload.UploadId,
		})
		require.NoError(t, err)
	}
}

// Several server processes run the cleaner at the same time, so one often
// tries to abort a multipart upload another has just aborted. That is not a
// failure, and it does not stop the rest of the sweep.
func TestAbortingAMultipartUploadAnotherProcessAbortedSucceeds(t *testing.T) {
	fixture := newCleanupFixture(t)

	first := fixture.createMultipart(t, "first")
	fixture.createMultipart(t, "second")
	fixture.createMultipart(t, "third")

	var checked []string

	// Between this sweep's listing and its abort, another process aborts
	// the first upload.
	spare := func(_ context.Context, key string) (bool, error) {
		checked = append(checked, key)

		if key == first {
			fixture.abortAll(t, key)
		}

		return false, nil
	}

	aborted, err := blobstore.AbortStaleMultipartUploads(t.Context(), fixture.objects, time.Now().Add(time.Minute), 1, spare)
	require.NoError(t, err)

	assert.Len(t, checked, 3)
	assert.Equal(t, 2, aborted, "the upload the other process aborted is not counted")
	assert.Zero(t, fixture.multipartUploads(t))
}

// A failure on one upload does not stop the sweep from handling the others,
// and is reported.
func TestMultipartSweepContinuesPastAFailure(t *testing.T) {
	fixture := newCleanupFixture(t)

	failing := fixture.createMultipart(t, "first")
	fixture.createMultipart(t, "second")
	fixture.createMultipart(t, "third")

	problem := errors.New("cannot check upload")

	spare := func(_ context.Context, key string) (bool, error) {
		if key == failing {
			return false, problem
		}

		return false, nil
	}

	aborted, err := blobstore.AbortStaleMultipartUploads(t.Context(), fixture.objects, time.Now().Add(time.Minute), 1, spare)
	require.ErrorIs(t, err, problem)

	assert.Equal(t, 2, aborted)
	assert.Equal(t, 1, fixture.multipartUploads(t), "an upload whose status is unknown is kept")
}

// Cleaners running concurrently in several server processes over the same
// abandoned sessions and multipart uploads all succeed, and together leave
// the same end state as one cleaner would.
func TestConcurrentCleanersSucceedAndAgree(t *testing.T) {
	fixture := newCleanupFixture(t)

	var sessions []uuid.UUID

	for index := range 5 {
		upload := fixture.startUpload(t, fmt.Sprintf("abandoned %d", index), 3)
		fixture.idle(t, upload, 2*time.Hour)
		sessions = append(sessions, upload)
	}

	const multipartUploads = 20

	for index := range multipartUploads {
		fixture.createMultipart(t, fmt.Sprintf("interrupted %d", index))
	}

	time.Sleep(20 * time.Millisecond)

	const processes = 4

	results := make([]blobstore.CleanupResult, processes)
	errs := make([]error, processes)

	var group sync.WaitGroup

	start := make(chan struct{})

	for index := range processes {
		// Each process has its own object-store client.
		objects, err := blobstore.New(fixture.objectsConfig)
		require.NoError(t, err)

		cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: objects, TTL: 10 * time.Millisecond}

		group.Go(func() {
			<-start

			results[index], errs[index] = cleaner.RunOnce(t.Context())
		})
	}

	close(start)
	group.Wait()

	removed := 0
	abortedBy := make([]int, processes)

	for index := range processes {
		require.NoError(t, errs[index], "cleaner %d", index)

		removed += results[index].SessionsRemoved
		abortedBy[index] = results[index].MultipartAborted
	}

	assert.Equal(t, len(sessions), removed, "each abandoned session is removed exactly once")
	assertMultipartAbortCounts(t, abortedBy, multipartUploads)

	for _, upload := range sessions {
		assert.False(t, fixture.sessionExists(t, upload))
		assert.Zero(t, fixture.stagedObjects(t, upload))
	}

	assert.Zero(t, fixture.multipartUploads(t))
}
