//go:build integration

package retention_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

const (
	testIssuer = "https://issuer.example"
	grace      = time.Hour
)

var policy = store.RetentionPolicy{KeepAll: 90 * 24 * time.Hour, KeepDaily: 365 * 24 * time.Hour}

// The UTC day 100 days ago: in the default policy's daily zone, so of two
// revisions that day only the newer is kept.
const oldDay = `date_trunc('day', now() - interval '100 days', 'UTC')`

type fixture struct {
	cfg           store.Config
	pool          *pgxpool.Pool
	store         *store.Store
	objectsConfig blobstore.Config
	objects       *blobstore.Objects
	vault         *store.VaultStore
	user, device  uuid.UUID
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	cfg := testinfra.PostgresConfig(t)

	pool, err := store.Open(t.Context(), cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	objectsConfig := testinfra.S3Bucket(t)

	objects, err := blobstore.New(objectsConfig)
	require.NoError(t, err)

	queries := store.New(pool)

	user, err := queries.UpsertUser(t.Context(), testIssuer, "alice")
	require.NoError(t, err)

	device, err := queries.RegisterDevice(t.Context(), user, "laptop", nil, 10)
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), user, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	return &fixture{
		cfg: cfg, pool: pool, store: queries, objectsConfig: objectsConfig, objects: objects,
		vault: queries.InVault(vault.ID), user: user, device: device.ID,
	}
}

func (fixture *fixture) job() *retention.Job {
	return &retention.Job{Store: fixture.store, Objects: fixture.objects, Policy: policy, Grace: grace}
}

// blob stores content as a complete blob, object and row, as CommitBlob
// leaves it.
func (fixture *fixture) blob(t *testing.T, content string) []byte {
	t.Helper()

	sum := sha256.Sum256([]byte(content))
	require.NoError(t, fixture.objects.Put(t.Context(), blobstore.BlobKey(fixture.vault.VaultID(), sum[:]), []byte(content)))

	_, err := fixture.pool.Exec(t.Context(), `INSERT INTO blobs (vault_id, blob_id, size, state) VALUES ($1, $2, $3, 'complete')`,
		fixture.vault.VaultID(), sum[:], len(content))
	require.NoError(t, err)

	return sum[:]
}

// revision commits a revision with content blobID (size bytes) on top of
// head (a new document at path if head is nil) and sets its created_at to
// the SQL expression created.
func (fixture *fixture) revision(t *testing.T, head *store.Revision, path string, blobID []byte, size int, created string) store.Revision {
	t.Helper()

	revision := store.NewRevision{
		ID:          uuid.Must(uuid.NewV7()),
		DocumentID:  uuid.Must(uuid.NewV7()),
		Kind:        "text",
		ContentRef:  blobID,
		ContentSize: int64(size),
		Path:        path,
		PathKey:     path,
		DeviceID:    fixture.device,
		UserID:      fixture.user,
	}

	if head != nil {
		revision.DocumentID = head.DocumentID
		revision.BaseRevID = uuid.NullUUID{UUID: head.ID, Valid: true}
	}

	committed, err := fixture.vault.CommitRevision(t.Context(), revision)
	require.NoError(t, err)

	_, err = fixture.pool.Exec(t.Context(), `UPDATE revisions SET created_at = `+created+` WHERE id = $1`, committed.ID)
	require.NoError(t, err)

	return committed
}

// forgetScans forgets the retention job's complete scans, so its next run
// considers every document: revisions backdated past an age, as tests do,
// never crossed it since the last scan.
func (fixture *fixture) forgetScans(t *testing.T) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `DELETE FROM retention_scans`)
	require.NoError(t, err)
}

// releasedAgo sets every released blob's release to the SQL interval ago.
func (fixture *fixture) releasedAgo(t *testing.T, ago string) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE blobs SET released_at = now() - interval '`+ago+`' WHERE released_at IS NOT NULL`)
	require.NoError(t, err)
}

// markersPurgedAgo backdates every purge marker's purge by ago, a
// PostgreSQL interval.
func (fixture *fixture) markersPurgedAgo(t *testing.T, ago string) {
	t.Helper()

	_, err := fixture.pool.Exec(t.Context(), `UPDATE purged_revisions SET purged_at = now() - $1::interval`, ago)
	require.NoError(t, err)
}

// markerCount counts the purge markers.
func (fixture *fixture) markerCount(t *testing.T) int {
	t.Helper()

	var count int

	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM purged_revisions`).Scan(&count))

	return count
}

// stored reports whether blobID has a row and whether it has an object.
func (fixture *fixture) stored(t *testing.T, blobID []byte) (bool, bool) {
	t.Helper()

	var row bool
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM blobs WHERE vault_id = $1 AND blob_id = $2)`,
		fixture.vault.VaultID(), blobID).Scan(&row))

	reader, err := fixture.objects.Open(t.Context(), blobstore.BlobKey(fixture.vault.VaultID(), blobID))
	if err == nil {
		require.NoError(t, reader.Close())

		return row, true
	}

	require.ErrorIs(t, err, blobstore.ErrNoObject)

	return row, false
}

func (fixture *fixture) pendingDeletions(t *testing.T) int {
	t.Helper()

	var count int
	require.NoError(t, fixture.pool.QueryRow(t.Context(), `SELECT count(*) FROM blob_deletions`).Scan(&count))

	return count
}

// releasedBlob purges the only revision referencing a new blob and returns
// the blob, released just now.
func (fixture *fixture) releasedBlob(t *testing.T, content string) []byte {
	t.Helper()

	blobID := fixture.blob(t, content)
	kept := fixture.blob(t, "kept "+content)

	first := fixture.revision(t, nil, content+".md", blobID, len(content), oldDay+` + interval '1 hour'`)
	fixture.revision(t, &first, content+".md", kept, len("kept "+content), oldDay+` + interval '2 hours'`)
	fixture.forgetScans(t)

	result, err := fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	require.Equal(t, retention.Result{RevisionsPurged: 1}, result, "the first revision is purged; its blob is within its grace period")

	return blobID
}

// Issue #26 criterion 4: once a purged revision was the last reference to
// a blob, the blob (its row and its object) is deleted after the grace
// period, and not before. Blobs still referenced are never deleted.
func TestBlobIsDeletedAfterTheGracePeriodAndNotBefore(t *testing.T) {
	fixture := newFixture(t)

	released := fixture.blob(t, "version 1")
	shared := fixture.blob(t, "version 2")

	first := fixture.revision(t, nil, "a.md", released, len("version 1"), oldDay+` + interval '1 hour'`)
	second := fixture.revision(t, &first, "a.md", shared, len("version 2"), oldDay+` + interval '2 hours'`)
	head := fixture.revision(t, &second, "a.md", shared, len("version 2"), `now()`)

	job := fixture.job()

	result, err := job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{RevisionsPurged: 1}, result)

	row, object := fixture.stored(t, released)
	assert.True(t, row && object, "just released: kept")

	// Just inside the grace period.
	fixture.releasedAgo(t, "59 minutes")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)

	row, object = fixture.stored(t, released)
	assert.True(t, row && object, "within the grace period: kept")

	// Just past it.
	fixture.releasedAgo(t, "1 hour 1 second")

	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{BlobsCollected: 1, ObjectsDeleted: 1}, result)

	row, object = fixture.stored(t, released)
	assert.False(t, row, "the row is deleted")
	assert.False(t, object, "the object is deleted")
	assert.Zero(t, fixture.pendingDeletions(t))

	row, object = fixture.stored(t, shared)
	assert.True(t, row && object, "a blob still referenced is kept")

	// The content can no longer be referenced without uploading it again.
	_, err = fixture.vault.CommitRevision(t.Context(), store.NewRevision{
		ID: uuid.Must(uuid.NewV7()), DocumentID: head.DocumentID, BaseRevID: uuid.NullUUID{UUID: head.ID, Valid: true},
		Kind: "text", ContentRef: released, ContentSize: int64(len("version 1")), Path: "a.md",
		PathKey: "a.md", DeviceID: fixture.device, UserID: fixture.user,
	})
	require.ErrorIs(t, err, store.ErrBlobNotComplete)

	// Running again changes nothing.
	result, err = job.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)
}

// A blob uploaded again after the collector deleted its row is never left
// without its object: the object deletion waits while an upload of the blob
// is in progress, and is dropped once the blob is complete again.
func TestReuploadedBlobKeepsItsObject(t *testing.T) {
	fixture := newFixture(t)
	blobID := fixture.releasedBlob(t, "content")
	fixture.releasedAgo(t, "2 hours")

	collected, err := fixture.vault.CollectBlob(t.Context(), blobID, grace)
	require.NoError(t, err)
	require.True(t, collected)

	start, err := fixture.vault.BeginBlobUpload(t.Context(), blobID, int64(len("content")), 10, 0)
	require.NoError(t, err)
	require.False(t, start.Complete, "the blob is gone, so it is uploaded again")

	result, err := fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result, "an upload is in progress: the object is left alone")
	assert.Equal(t, 1, fixture.pendingDeletions(t))

	require.NoError(t, fixture.vault.CompleteBlobUpload(t.Context(), start.Upload.ID, blobID, int64(len("content"))))

	result, err = fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{}, result)
	assert.Zero(t, fixture.pendingDeletions(t), "the deletion is dropped")

	row, object := fixture.stored(t, blobID)
	assert.True(t, row && object, "the re-uploaded blob is complete")

	// Without an upload, the pending deletion deletes the object.
	other := fixture.releasedBlob(t, "other")

	// Only other: the re-uploaded blob, which no revision references, is
	// within its own grace period.
	_, err = fixture.pool.Exec(t.Context(), `UPDATE blobs SET released_at = now() - interval '2 hours' WHERE blob_id = $1`, other)
	require.NoError(t, err)

	collected, err = fixture.vault.CollectBlob(t.Context(), other, grace)
	require.NoError(t, err)
	require.True(t, collected)

	result, err = fixture.job().RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, retention.Result{ObjectsDeleted: 1}, result)

	row, object = fixture.stored(t, other)
	assert.False(t, row || object)
}

// An upload about to write a blob's object waits for a deletion of that
// object in progress, so the deletion can never remove the new object.
func TestAwaitBlobDeletionWaitsForADeletionInProgress(t *testing.T) {
	fixture := newFixture(t)
	blobID := fixture.releasedBlob(t, "content")
	fixture.releasedAgo(t, "2 hours")

	collected, err := fixture.vault.CollectBlob(t.Context(), blobID, grace)
	require.NoError(t, err)
	require.True(t, collected)

	deleting, release := make(chan struct{}), make(chan struct{})
	deleted := make(chan bool, 1)

	go func() {
		ok, err := fixture.vault.DeleteBlobObject(t.Context(), blobID, func(ctx context.Context) error {
			close(deleting)
			<-release

			return fixture.objects.Delete(ctx, blobstore.BlobKey(fixture.vault.VaultID(), blobID))
		})
		assert.NoError(t, err)

		deleted <- ok
	}()

	<-deleting

	awaited := make(chan error, 1)

	go func() { awaited <- fixture.vault.AwaitBlobDeletion(t.Context(), blobID) }()

	assert.Never(t, func() bool { return len(awaited) > 0 }, 200*time.Millisecond, 10*time.Millisecond,
		"the upload waits while the object is being deleted")

	close(release)

	require.NoError(t, <-awaited)
	assert.True(t, <-deleted)

	// With no deletion in progress, it returns at once.
	require.NoError(t, fixture.vault.AwaitBlobDeletion(t.Context(), blobID))
}

// HA (SPEC.md §12, #96): every replica runs the retention job, at the same
// time. Concurrent runs have the combined effect of one: each revision is
// purged, and each blob collected and its object deleted, exactly once, and
// no run fails because another got there first.
func TestRetentionJobsOnEveryInstanceActAsOne(t *testing.T) {
	fixture := newFixture(t)

	const documents = 12

	// Every document's oldest revision shares one blob, so concurrent
	// purges release the same blob.
	shared := fixture.blob(t, "template")

	var unique, heads [][]byte

	for index := range documents {
		path := fmt.Sprintf("note %d.md", index)
		own := fixture.blob(t, "draft "+path)
		final := fixture.blob(t, "final "+path)

		unique = append(unique, own)
		heads = append(heads, final)

		first := fixture.revision(t, nil, path, shared, len("template"), oldDay+` + interval '1 hour'`)
		second := fixture.revision(t, &first, path, own, len("draft "+path), oldDay+` + interval '2 hours'`)
		third := fixture.revision(t, &second, path, final, len("final "+path), oldDay+` + interval '3 hours'`)
		fixture.revision(t, &third, path, final, len("final "+path), `now()`)
	}

	const instances = 4

	jobs := make([]*retention.Job, instances)

	for index := range jobs {
		pool, err := store.Open(t.Context(), fixture.cfg)
		require.NoError(t, err)
		t.Cleanup(pool.Close)

		objects, err := blobstore.New(fixture.objectsConfig)
		require.NoError(t, err)

		// Small batches, so the instances interleave.
		jobs[index] = &retention.Job{
			Store: store.New(pool), Objects: objects, Policy: policy, Grace: grace,
			DocumentsPerRun: 3, RevisionsPerDocument: 1, BlobsPerRun: 2,
			MarkersPerBatch: 2, MarkersPerRun: 3,
		}
	}

	runAll := func() retention.Result {
		var (
			mutex sync.Mutex
			total retention.Result
			group sync.WaitGroup
		)

		for _, job := range jobs {
			group.Go(func() {
				for range 20 {
					result, err := job.RunOnce(t.Context())
					assert.NoError(t, err, "a run never fails because another instance got there first")

					mutex.Lock()
					total.RevisionsPurged += result.RevisionsPurged
					total.BlobsCollected += result.BlobsCollected
					total.ObjectsDeleted += result.ObjectsDeleted
					total.MarkersPruned += result.MarkersPruned
					mutex.Unlock()
				}
			})
		}

		group.Wait()

		return total
	}

	assert.Equal(t, retention.Result{RevisionsPurged: 2 * documents}, runAll(), "each purgeable revision is purged once")
	assert.Equal(t, 2*documents, fixture.markerCount(t), "each purge leaves one marker")

	fixture.markersPurgedAgo(t, "366 days")

	assert.Equal(t, retention.Result{MarkersPruned: 2 * documents}, runAll(), "each marker past the horizon is pruned once")
	assert.Zero(t, fixture.markerCount(t))

	fixture.releasedAgo(t, "2 hours")

	assert.Equal(t, retention.Result{BlobsCollected: documents + 1, ObjectsDeleted: documents + 1}, runAll(),
		"each released blob is collected, and its object deleted, once")

	for _, blobID := range append(unique, shared) {
		row, object := fixture.stored(t, blobID)
		assert.False(t, row || object)
	}

	for _, blobID := range heads {
		row, object := fixture.stored(t, blobID)
		assert.True(t, row && object, "the heads' content is kept")
	}

	assert.Zero(t, fixture.pendingDeletions(t))
}
