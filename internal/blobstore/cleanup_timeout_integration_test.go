//go:build integration

package blobstore_test

import (
	"context"
	"crypto/sha256"
	"log/slog"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

// The reproducer of issue #141: a cleanup run against a store that accepts
// connections and never answers used to block forever.
func TestCleanerRunFailsWhenTheStoreStopsAnswering(t *testing.T) {
	fixture := newCleanupFixture(t)
	fixture.idle(t, fixture.startUpload(t, "stale", 2), time.Hour)

	cfg := fixture.objectsConfig
	cfg.Endpoint = unresponsiveEndpoint(t, true)
	cfg.IdleTimeout = testIdleTimeout

	objects, err := blobstore.New(cfg)
	require.NoError(t, err)

	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: objects, TTL: 10 * time.Minute}

	err = returnsWithin(t, func() error {
		_, err := cleaner.RunOnce(t.Context())

		return err
	})
	require.ErrorIs(t, err, os.ErrDeadlineExceeded)
}

// warnings sends a message for every warning logged through it.
type warnings chan string

func (warnings) Enabled(_ context.Context, level slog.Level) bool { return level >= slog.LevelWarn }

func (channel warnings) Handle(_ context.Context, record slog.Record) error {
	select {
	case channel <- record.Message:
	default:
	}

	return nil
}

func (channel warnings) WithAttrs([]slog.Attr) slog.Handler { return channel }

func (channel warnings) WithGroup(string) slog.Handler { return channel }

func TestCleanerStartsTheNextRunOnTimeWhenOneIsStuck(t *testing.T) {
	fixture := newCleanupFixture(t)
	fixture.idle(t, fixture.startUpload(t, "stale", 2), time.Hour)

	// An idle timeout far longer than the test: only the bound on each run
	// can end a stuck one.
	cfg := fixture.objectsConfig
	cfg.Endpoint = unresponsiveEndpoint(t, true)
	cfg.IdleTimeout = time.Hour

	objects, err := blobstore.New(cfg)
	require.NoError(t, err)

	logged := make(warnings, 10)
	cleaner := &blobstore.Cleaner{Store: fixture.store, Objects: objects, TTL: 10 * time.Minute, Logger: slog.New(logged)}

	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan struct{})

	go func() {
		defer close(stopped)

		cleaner.Run(ctx, 200*time.Millisecond)
	}()

	t.Cleanup(func() {
		cancel()
		<-stopped
	})

	for run := range 2 {
		select {
		case message := <-logged:
			require.Contains(t, message, "cleanup failed", "run %d", run)
		case <-time.After(hangGuard):
			require.FailNow(t, "a stuck cleanup run held up the next one", "run %d", run)
		}
	}
}

// stalledInstance returns a server process's blob service whose object store
// accepts connections and never answers.
func (fixture *cleanupFixture) stalledInstance(t *testing.T) *api.BlobService {
	t.Helper()

	cfg := fixture.objectsConfig
	cfg.Endpoint = unresponsiveEndpoint(t, true)
	cfg.IdleTimeout = testIdleTimeout

	objects, err := blobstore.New(cfg)
	require.NoError(t, err)

	return &api.BlobService{
		Store:   fixture.store,
		Objects: objects,
		Limits:  api.BlobLimits{MaxChunkBytes: commitTestChunkBytes, MaxBlobBytes: 1 << 30, MaxUploadsPerVault: 10},
		Logger:  slog.New(slog.DiscardHandler),
	}
}

// Blob RPCs on an instance whose object store stopped answering fail, with
// a caller that would wait forever, instead of hanging; the upload is left
// intact for a retry on a healthy instance.
func TestBlobRPCsFailWhenTheStoreStopsAnswering(t *testing.T) {
	fixture := newCleanupFixture(t)
	healthy, _ := fixture.instance(t)
	stalled := fixture.stalledInstance(t)
	ctx := fixture.authorized(t.Context())
	vaultID := fixture.vault.VaultID().String()

	content, blobID := multipartContent(t)
	fixture.send(t, blobID, content, healthy)

	t.Run("CommitBlob", func(t *testing.T) {
		err := returnsWithin(t, func() error { return fixture.commit(t.Context(), stalled, blobID) })
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err), "%v", err)

		// The acknowledged chunks are intact: the commit succeeds elsewhere.
		require.NoError(t, fixture.commit(t.Context(), healthy, blobID))
		fixture.requireBlob(t, healthy, blobID, content)
	})

	t.Run("DownloadBlob", func(t *testing.T) {
		err := returnsWithin(t, func() error {
			_, err := stalled.DownloadBlob(ctx, connect.NewRequest(&vaultsyncv1.DownloadBlobRequest{VaultId: vaultID, BlobId: blobID}))

			return err
		})
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err), "%v", err)
	})

	t.Run("PutBlobChunk", func(t *testing.T) {
		other := []byte("another blob")
		otherID := sha256.Sum256(other)

		_, err := healthy.BeginBlob(ctx, connect.NewRequest(&vaultsyncv1.BeginBlobRequest{VaultId: vaultID, BlobId: otherID[:], Size: uint64(len(other))}))
		require.NoError(t, err)

		err = returnsWithin(t, func() error {
			_, err := stalled.PutBlobChunk(ctx, connect.NewRequest(&vaultsyncv1.PutBlobChunkRequest{VaultId: vaultID, BlobId: otherID[:], Data: other}))

			return err
		})
		require.Equal(t, connect.CodeInternal, connect.CodeOf(err), "%v", err)

		// Nothing was accepted, so the upload resumes from the start elsewhere.
		response, err := healthy.PutBlobChunk(ctx, connect.NewRequest(&vaultsyncv1.PutBlobChunkRequest{VaultId: vaultID, BlobId: otherID[:], Data: other}))
		require.NoError(t, err)
		assert.Equal(t, uint64(len(other)), response.Msg.GetReceivedSize())
	})
}

// The idle timeout bounds each object-store operation, not a whole commit:
// a multipart commit that pauses between parts for longer than the timeout,
// and so takes many timeouts in all, still completes.
func TestCommitLongerThanTheIdleTimeoutCompletes(t *testing.T) {
	const idleTimeout = 2 * time.Second

	fixture := newCleanupFixture(t)
	fixture.objectsConfig.IdleTimeout = idleTimeout

	committer, objects := fixture.instance(t)
	content, blobID := multipartContent(t)
	fixture.send(t, blobID, content, committer)

	paused := 0

	blobstore.SetAfterPart(objects, func(context.Context, int32) {
		paused++

		time.Sleep(2 * idleTimeout)
	})

	require.NoError(t, fixture.commit(t.Context(), committer, blobID))
	require.Positive(t, paused)
	fixture.requireBlob(t, committer, blobID, content)
}
