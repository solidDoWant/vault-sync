//go:build integration

package blobstore_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"log/slog"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// levelRecorder is a slog handler that remembers the messages logged at
// ERROR level or above.
type levelRecorder struct {
	mu     *sync.Mutex
	errors *[]string
}

func newLevelRecorder() levelRecorder {
	return levelRecorder{mu: &sync.Mutex{}, errors: &[]string{}}
}

func (recorder levelRecorder) Enabled(context.Context, slog.Level) bool { return true }

func (recorder levelRecorder) Handle(_ context.Context, record slog.Record) error {
	if record.Level >= slog.LevelError {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()

		*recorder.errors = append(*recorder.errors, record.Message)
	}

	return nil
}

func (recorder levelRecorder) WithAttrs([]slog.Attr) slog.Handler { return recorder }

func (recorder levelRecorder) WithGroup(string) slog.Handler { return recorder }

func (recorder levelRecorder) logged() []string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	return append([]string(nil), *recorder.errors...)
}

// smallChunkInstance returns a server process's blob service that accepts
// chunks of only blobstore.MinChunkBytes, so composing one part reads many
// staged objects, together with its object-store client and a recorder of
// its ERROR logs.
func (fixture *cleanupFixture) smallChunkInstance(t *testing.T) (*api.BlobService, *blobstore.Objects, levelRecorder) {
	t.Helper()

	objects, err := blobstore.New(fixture.objectsConfig)
	require.NoError(t, err)

	recorder := newLevelRecorder()

	return &api.BlobService{
		Store:   fixture.store,
		Objects: objects,
		Limits:  api.BlobLimits{MaxChunkBytes: blobstore.MinChunkBytes, MaxBlobBytes: 1 << 30, MaxUploadsPerVault: 10},
		Logger:  slog.New(recorder),
	}, objects, recorder
}

// sendSmallChunks begins an upload of content through service and sends it
// in chunks of blobstore.MinChunkBytes, returning the session's id.
func (fixture *cleanupFixture) sendSmallChunks(t *testing.T, service *api.BlobService, blobID, content []byte) uuid.UUID {
	t.Helper()

	ctx := fixture.authorized(t.Context())
	vaultID := fixture.vault.VaultID().String()

	_, err := service.BeginBlob(ctx, connect.NewRequest(&vaultsyncv1.BeginBlobRequest{
		VaultId: vaultID, BlobId: blobID, Size: uint64(len(content)),
	}))
	require.NoError(t, err)

	for offset := 0; offset < len(content); {
		end := min(offset+blobstore.MinChunkBytes, len(content))

		response, err := service.PutBlobChunk(ctx, connect.NewRequest(&vaultsyncv1.PutBlobChunkRequest{
			VaultId: vaultID, BlobId: blobID, Offset: uint64(offset), Data: content[offset:end],
		}))
		require.NoError(t, err)

		offset = int(response.Msg.GetReceivedSize())
	}

	var uploadID uuid.UUID

	require.NoError(t, fixture.pool.QueryRow(t.Context(),
		`SELECT id FROM blob_uploads WHERE vault_id = $1 AND blob_id = $2 AND state = 'uploading'`,
		fixture.vault.VaultID(), blobID).Scan(&uploadID))

	return uploadID
}

func randomContent(t *testing.T, size int) ([]byte, []byte) {
	t.Helper()

	content := make([]byte, size)
	_, err := rand.Read(content)
	require.NoError(t, err)

	sum := sha256.Sum256(content)

	return content, sum[:]
}

// requireNoBlob checks that blobID is neither complete nor stored.
func (fixture *cleanupFixture) requireNoBlob(t *testing.T, blobID []byte) {
	t.Helper()

	_, err := fixture.vault.CompleteBlob(t.Context(), blobID)
	require.ErrorIs(t, err, store.ErrNotFound)

	_, err = fixture.objects.Client().HeadObject(t.Context(), &s3.HeadObjectInput{
		Bucket: aws.String(fixture.objects.Bucket()),
		Key:    aws.String(blobstore.BlobKey(fixture.vault.VaultID(), blobID)),
	})
	require.Error(t, err, "an object is stored at the blob's key")
}

// When another process's cleanup routine reaps a commit's session while the
// commit is reading a part's staged chunks (as when reading a part takes
// longer than the upload TTL), the commit tells the client to start the
// upload again rather than reporting a server error, makes nothing visible,
// and a new upload of the blob succeeds.
func TestCommitOfASessionReapedWhileReadingChunksFailsPrecondition(t *testing.T) {
	tests := []struct {
		name string
		size int
		// reapAt is the index of the staged chunk read before which the
		// session is reaped.
		reapAt int
	}{
		{
			// Part 1 is chunks 0-127 and has been uploaded and reported;
			// the session is reaped part-way through reading part 2.
			name:   "multipart",
			size:   2*blobstore.PartSize + 1000,
			reapAt: blobstore.PartSize/blobstore.MinChunkBytes + 2,
		},
		{
			name:   "single part",
			size:   5*blobstore.MinChunkBytes + 100,
			reapAt: 2,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCleanupFixture(t)
			content, blobID := randomContent(t, test.size)

			committer, objects, recorder := fixture.smallChunkInstance(t)
			uploadID := fixture.sendSmallChunks(t, committer, blobID, content)

			// The reaper is another process: its own object-store client,
			// sharing only PostgreSQL and the bucket.
			reaper := &blobstore.Cleaner{Store: fixture.store, Objects: fixture.objects, TTL: 10 * time.Minute}

			var (
				reads  int
				reaped blobstore.CleanupResult
			)

			blobstore.SetBeforeSourceRead(objects, func(ctx context.Context, _ string) {
				if reads == test.reapAt {
					// Let the TTL "pass" since the last progress report.
					fixture.idle(t, uploadID, time.Hour)

					result, err := reaper.RunOnce(context.WithoutCancel(ctx))
					assert.NoError(t, err)

					reaped = result
				}

				reads++
			})

			err := fixture.commit(t.Context(), committer, blobID)
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "%v", err)

			require.Equal(t, 1, reaped.SessionsRemoved, "the reaper did not remove the session")
			assert.Empty(t, recorder.logged(), "the commit logged an error")
			fixture.requireNoBlob(t, blobID)

			blobstore.SetBeforeSourceRead(objects, nil)

			fixture.sendSmallChunks(t, committer, blobID, content)
			require.NoError(t, fixture.commit(t.Context(), committer, blobID))
			fixture.requireBlob(t, committer, blobID, content)
		})
	}
}

// A staged chunk missing from an upload session that is still active is
// corruption, not a reap: the commit reports a server error.
func TestCommitWithAStagedChunkMissingFromAnActiveSessionFailsInternal(t *testing.T) {
	tests := []struct {
		name string
		size int
	}{
		{name: "multipart", size: blobstore.PartSize + 1000},
		{name: "single part", size: 5*blobstore.MinChunkBytes + 100},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCleanupFixture(t)
			content, blobID := randomContent(t, test.size)

			committer, _, recorder := fixture.smallChunkInstance(t)
			uploadID := fixture.sendSmallChunks(t, committer, blobID, content)

			listed, err := fixture.objects.Client().ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{
				Bucket: aws.String(fixture.objects.Bucket()),
				Prefix: aws.String(blobstore.UploadPrefix(fixture.vault.VaultID(), uploadID)),
			})
			require.NoError(t, err)
			require.Len(t, listed.Contents, (test.size+blobstore.MinChunkBytes-1)/blobstore.MinChunkBytes)

			// Lose one staged chunk.
			require.NoError(t, fixture.objects.Delete(t.Context(), aws.ToString(listed.Contents[len(listed.Contents)-1].Key)))

			err = fixture.commit(t.Context(), committer, blobID)
			require.Equal(t, connect.CodeInternal, connect.CodeOf(err), "%v", err)

			assert.NotEmpty(t, recorder.logged(), "the commit logged no error")
			assert.True(t, fixture.sessionExists(t, uploadID), "the session was removed")
			fixture.requireNoBlob(t, blobID)
		})
	}
}
