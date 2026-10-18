//go:build integration

package blobstore_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// These tests model several server processes ("instances") behind a load
// balancer: each has its own BlobService and object-store client, and they
// share only PostgreSQL and the bucket.

const commitTestChunkBytes = 4 << 20

// instance returns a new server process's blob service, its object-store
// client, and a context authorized for the fixture's vault.
func (fixture *cleanupFixture) instance(t *testing.T) (*api.BlobService, *blobstore.Objects) {
	t.Helper()

	objects, err := blobstore.New(fixture.objectsConfig)
	require.NoError(t, err)

	return &api.BlobService{
		Store:   fixture.store,
		Objects: objects,
		Limits:  api.BlobLimits{MaxChunkBytes: commitTestChunkBytes, MaxBlobBytes: 1 << 30, MaxUploadsPerVault: 10},
		Logger:  slog.New(slog.DiscardHandler),
	}, objects
}

func (fixture *cleanupFixture) authorized(ctx context.Context) context.Context {
	return authz.WithMembership(ctx, authz.Membership{VaultID: fixture.vault.VaultID(), Role: store.RoleOwner})
}

// multipartContent is a blob composed from four multipart parts.
func multipartContent(t *testing.T) ([]byte, []byte) {
	t.Helper()

	content := make([]byte, 3*blobstore.PartSize+1000)
	_, err := rand.Read(content)
	require.NoError(t, err)

	sum := sha256.Sum256(content)

	return content, sum[:]
}

// send begins an upload of content and sends all of its chunks, spreading
// them round-robin over services.
func (fixture *cleanupFixture) send(t *testing.T, blobID, content []byte, services ...*api.BlobService) {
	t.Helper()

	ctx := fixture.authorized(t.Context())

	_, err := services[0].BeginBlob(ctx, connect.NewRequest(&vaultsyncv1.BeginBlobRequest{
		VaultId: fixture.vault.VaultID().String(), BlobId: blobID, Size: uint64(len(content)),
	}))
	require.NoError(t, err)

	for index, offset := 0, 0; offset < len(content); index++ {
		end := min(offset+commitTestChunkBytes, len(content))

		response, err := services[index%len(services)].PutBlobChunk(ctx, connect.NewRequest(&vaultsyncv1.PutBlobChunkRequest{
			VaultId: fixture.vault.VaultID().String(), BlobId: blobID, Offset: uint64(offset), Data: content[offset:end],
		}))
		require.NoError(t, err)

		offset = int(response.Msg.GetReceivedSize())
	}
}

func (fixture *cleanupFixture) commit(ctx context.Context, service *api.BlobService, blobID []byte) error {
	_, err := service.CommitBlob(fixture.authorized(ctx), connect.NewRequest(&vaultsyncv1.CommitBlobRequest{
		VaultId: fixture.vault.VaultID().String(), BlobId: blobID,
	}))

	return err
}

// requireBlob downloads blobID through service and compares it to content.
func (fixture *cleanupFixture) requireBlob(t *testing.T, service *api.BlobService, blobID, content []byte) {
	t.Helper()

	ctx := fixture.authorized(t.Context())

	var downloaded []byte

	for len(downloaded) < len(content) {
		response, err := service.DownloadBlob(ctx, connect.NewRequest(&vaultsyncv1.DownloadBlobRequest{
			VaultId: fixture.vault.VaultID().String(), BlobId: blobID, Offset: uint64(len(downloaded)),
		}))
		require.NoError(t, err)
		require.NotEmpty(t, response.Msg.GetData())

		downloaded = append(downloaded, response.Msg.GetData()...)
	}

	require.True(t, bytes.Equal(content, downloaded), "downloaded content differs")
}

// A commit that takes longer than the upload TTL is never reaped by the
// cleaners every instance runs: neither its session, with its acknowledged
// chunks, nor its multipart upload.
func TestCommitSurvivesCleanersRunningPastTheTTL(t *testing.T) {
	const ttl = 2 * time.Second

	fixture := newCleanupFixture(t)
	content, blobID := multipartContent(t)

	committer, objects := fixture.instance(t)
	other, otherObjects := fixture.instance(t)
	fixture.send(t, blobID, content, committer, other)

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: otherObjects, TTL: ttl}

	// AWS S3 reports a multipart upload's creation time as its Initiated
	// time, but some stores (versitygw, used here) report its last
	// modification. Run this cleaner's clock a TTL ahead, as on an instance
	// whose clock is ahead of the store's, so the commit's multipart upload
	// looks stale by its Initiated time alone, whatever the store reports.
	blobstore.SetClock(cleaner, func() time.Time { return time.Now().Add(ttl) })

	var (
		runs        int
		runsPastTTL int
		cleanErrs   []error
	)

	started := time.Now()

	// Each part takes a while, and another instance's cleaner runs during
	// every one of them.
	blobstore.SetAfterPart(objects, func(ctx context.Context, _ int32) {
		time.Sleep(ttl * 2 / 5)

		result, err := cleaner.RunOnce(ctx)
		if err != nil {
			cleanErrs = append(cleanErrs, err)
		}

		assert.Equal(t, blobstore.CleanupResult{}, result, "the cleaner removed something")

		runs++

		if time.Since(started) > ttl {
			runsPastTTL++
		}
	})

	require.NoError(t, fixture.commit(t.Context(), committer, blobID))

	assert.Empty(t, cleanErrs)
	assert.Equal(t, 4, runs)
	assert.Positive(t, runsPastTTL, "no cleaner ran after the commit had taken longer than the TTL")

	fixture.requireBlob(t, other, blobID, content)
}

// Upload sessions keep no per-instance state: the chunks of one upload may
// go to different instances and the commit to yet another.
func TestChunksAndCommitMayGoToDifferentInstances(t *testing.T) {
	fixture := newCleanupFixture(t)
	content, blobID := multipartContent(t)

	first, _ := fixture.instance(t)
	second, _ := fixture.instance(t)
	third, _ := fixture.instance(t)

	fixture.send(t, blobID, content, first, second)
	require.NoError(t, fixture.commit(t.Context(), third, blobID))

	fixture.requireBlob(t, first, blobID, content)
}

// An instance that dies part-way through composing a commit (without
// aborting its multipart upload) leaves a state the client can retry to
// success on another instance; the cleaners later remove what the dead
// instance left behind, and nothing the dead instance does afterwards can
// change the blob.
func TestCommitRetriedAfterAnInstanceDiesMidCommit(t *testing.T) {
	fixture := newCleanupFixture(t)
	content, blobID := multipartContent(t)

	dying, dyingObjects := fixture.instance(t)
	survivor, survivorObjects := fixture.instance(t)

	fixture.send(t, blobID, content, dying)

	// The dying instance stops after its first part, as if killed: it
	// never aborts its multipart upload, and never records activity again.
	stopped := make(chan struct{})
	release := make(chan struct{})

	var stopOnce sync.Once

	blobstore.SetAfterPart(dyingObjects, func(context.Context, int32) {
		stopOnce.Do(func() {
			close(stopped)
			<-release
		})
	})

	var (
		group     sync.WaitGroup
		deadError error
	)

	group.Go(func() { deadError = fixture.commit(t.Context(), dying, blobID) })

	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}

		group.Wait()
	})

	<-stopped
	require.Equal(t, 1, fixture.multipartUploads(t), "the dying instance's multipart upload")

	// The client's retry goes to another instance and succeeds.
	require.NoError(t, fixture.commit(t.Context(), survivor, blobID))
	fixture.requireBlob(t, survivor, blobID, content)

	// Past the TTL, a cleaner aborts the dead instance's multipart upload:
	// the blob's upload session is gone.
	time.Sleep(50 * time.Millisecond)

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: survivorObjects, TTL: 10 * time.Millisecond}

	result, err := cleaner.RunOnce(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 1, result.MultipartAborted)
	assert.Zero(t, fixture.multipartUploads(t))

	// If the dead instance comes back to life, it notices its session is
	// gone and stops; the blob is unaffected.
	close(release)
	group.Wait()

	require.NoError(t, deadError, "the blob is complete, so the late commit reports success")
	assert.Zero(t, fixture.multipartUploads(t))
	fixture.requireBlob(t, survivor, blobID, content)
}
