package blobstore_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

// hangGuard is how long a test waits for a call that must return on its own
// (after the short configured request timeout) before declaring it hung. It
// only catches a hang; nothing asserts how quickly the call returned.
const hangGuard = time.Minute

// testIdleTimeout is the idle timeout of the objects under test: short, so
// tests finish quickly, but the assertions never depend on it.
const testIdleTimeout = 100 * time.Millisecond

// unresponsiveEndpoint returns the URL of an "object store" that accepts
// connections and then never answers. If read is true it reads (and
// discards) the requests; otherwise it never reads them either, so a large
// request body fills the connection's buffers.
func unresponsiveEndpoint(t *testing.T, read bool) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	done := make(chan struct{})

	t.Cleanup(func() {
		close(done)

		_ = listener.Close()
	})

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}

			go func() {
				defer func() { _ = conn.Close() }()

				if read {
					_, _ = io.Copy(io.Discard, conn)
				}

				<-done
			}()
		}
	}()

	return "http://" + listener.Addr().String()
}

// stalledBodyEndpoint returns the URL of an "object store" that answers every
// request with a successful response announcing a body of 1 MiB, sends 10
// bytes of it and then stalls.
func stalledBodyEndpoint(t *testing.T) string {
	t.Helper()

	release := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)

		writer.Header().Set("Content-Length", strconv.Itoa(1<<20))
		writer.Header().Set("Content-Type", "application/octet-stream")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("0123456789"))
		writer.(http.Flusher).Flush()

		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	// Cleanups run last-registered first: release the handlers, then close.
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })

	return server.URL
}

// objectsAt returns objects for the store at endpoint, with the idle timeout
// timeout and at most attempts attempts per call (0: the SDK's default).
func objectsAt(t *testing.T, endpoint string, timeout time.Duration, attempts int) *blobstore.Objects {
	t.Helper()

	directory := t.TempDir()
	keyFile := filepath.Join(directory, "key")
	require.NoError(t, os.WriteFile(keyFile, []byte("value"), 0o600))

	objects, err := blobstore.NewWithAttempts(blobstore.Config{
		Endpoint:            endpoint,
		Bucket:              "vault-sync",
		AccessKeyIDFile:     keyFile,
		SecretAccessKeyFile: keyFile,
		ForcePathStyle:      true,
		IdleTimeout:         timeout,
	}, attempts)
	require.NoError(t, err)

	return objects
}

// returnsWithin runs call and returns its error, failing the test if call is
// still running after hangGuard.
func returnsWithin(t *testing.T, call func() error) error {
	t.Helper()

	done := make(chan error, 1)

	go func() { done <- call() }()

	select {
	case err := <-done:
		return err
	case <-time.After(hangGuard):
		require.FailNow(t, "the object-store call is still blocked")

		return nil
	}
}

// objectOperations are every Objects operation, each run against the store
// under test with a context that has no deadline.
//
// readsBody marks the operations that read a response body; the others
// succeed as soon as a response starts.
var objectOperations = []struct {
	name      string
	readsBody bool
	call      func(ctx context.Context, objects *blobstore.Objects) error
}{
	{name: "check", call: func(ctx context.Context, objects *blobstore.Objects) error { return objects.Check(ctx) }},
	{name: "put", call: func(ctx context.Context, objects *blobstore.Objects) error {
		return objects.Put(ctx, "vaults/x/uploads/y/z", []byte("hello"))
	}},
	{name: "put of a full part", call: func(ctx context.Context, objects *blobstore.Objects) error {
		return objects.Put(ctx, "vaults/x/uploads/y/z", make([]byte, blobstore.PartSize))
	}},
	{name: "delete", call: func(ctx context.Context, objects *blobstore.Objects) error {
		return objects.Delete(ctx, "vaults/x/uploads/y/z")
	}},
	{name: "read range", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		_, err := objects.ReadRange(ctx, "vaults/x/blobs/00", 0, 100)

		return err
	}},
	{name: "open and read", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		body, err := objects.Open(ctx, "vaults/x/blobs/00")
		if err != nil {
			return err
		}

		defer func() { _ = body.Close() }()

		_, err = io.ReadAll(body)

		return err
	}},
	{name: "delete prefix", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		_, _, err := objects.DeletePrefix(ctx, "vaults/x/uploads/y/", 10)

		return err
	}},
	{name: "abort stale multipart uploads", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		_, err := blobstore.AbortStaleMultipartUploads(ctx, objects, time.Now(), 1, nil)

		return err
	}},
	{name: "compose a single object", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		return objects.Compose(ctx, "owner", "vaults/x/blobs/00", []blobstore.Part{{Key: "vaults/x/uploads/y/z", Length: 10}}, 10, nil, nil)
	}},
	{name: "compose a multipart object", readsBody: true, call: func(ctx context.Context, objects *blobstore.Objects) error {
		return objects.Compose(ctx, "owner", "vaults/x/blobs/00", []blobstore.Part{{Key: "vaults/x/uploads/y/z", Length: blobstore.PartSize + 1}}, blobstore.PartSize+1, nil, nil)
	}},
}

func TestObjectOperationsFailWhenTheStoreStopsAnswering(t *testing.T) {
	stores := []struct {
		name      string
		endpoint  func(t *testing.T) string
		bodyStall bool
	}{
		{name: "store reads requests but never answers", endpoint: func(t *testing.T) string { return unresponsiveEndpoint(t, true) }},
		{name: "store never reads requests", endpoint: func(t *testing.T) string { return unresponsiveEndpoint(t, false) }},
		{name: "store stalls in the response body", endpoint: stalledBodyEndpoint, bodyStall: true},
	}

	for _, store := range stores {
		t.Run(store.name, func(t *testing.T) {
			objects := objectsAt(t, store.endpoint(t), testIdleTimeout, 1)

			for _, operation := range objectOperations {
				if store.bodyStall && !operation.readsBody {
					continue
				}

				t.Run(operation.name, func(t *testing.T) {
					err := returnsWithin(t, func() error { return operation.call(t.Context(), objects) })
					require.Error(t, err)
					assert.ErrorIs(t, err, os.ErrDeadlineExceeded)
					require.NoError(t, t.Context().Err(), "the call ended on its own, not with the caller's context")
				})
			}
		})
	}
}

func TestStalledComposeReleasesItsSlot(t *testing.T) {
	objects := objectsAt(t, unresponsiveEndpoint(t, true), testIdleTimeout, 1)

	// More compositions than there are slots, one after another: each would
	// wait forever for a slot if a stalled one kept its slot.
	for attempt := range blobstore.ComposeSlots + 2 {
		slotAcquired := false
		progress := func(context.Context) error {
			slotAcquired = true

			return nil
		}

		err := returnsWithin(t, func() error {
			return objects.Compose(t.Context(), "owner", "vaults/x/blobs/00", []blobstore.Part{{Key: "vaults/x/uploads/y/z", Length: 10}}, 10, nil, progress)
		})
		require.ErrorIs(t, err, os.ErrDeadlineExceeded, "attempt %d", attempt)
		require.True(t, slotAcquired, "attempt %d got a compose slot", attempt)
	}
}

func TestConfigIdleTimeoutMustNotBeNegative(t *testing.T) {
	directory := t.TempDir()
	keyFile := filepath.Join(directory, "key")
	require.NoError(t, os.WriteFile(keyFile, []byte("value"), 0o600))

	tests := []struct {
		name    string
		timeout time.Duration
		wantErr require.ErrorAssertionFunc
	}{
		{name: "default", timeout: 0},
		{name: "positive", timeout: time.Second},
		{name: "negative", timeout: -time.Second, wantErr: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantErr == nil {
				test.wantErr = require.NoError
			}

			cfg := blobstore.Config{Bucket: "b", AccessKeyIDFile: keyFile, SecretAccessKeyFile: keyFile, IdleTimeout: test.timeout}
			test.wantErr(t, cfg.Validate())
		})
	}
}

func TestStalledCallFailsWithTheSDKsRetries(t *testing.T) {
	objects := objectsAt(t, unresponsiveEndpoint(t, true), testIdleTimeout, 0)

	err := returnsWithin(t, func() error { return objects.Put(t.Context(), "vaults/x/uploads/y/z", []byte("hello")) })
	require.ErrorIs(t, err, os.ErrDeadlineExceeded)
	require.ErrorContains(t, err, "made no progress for "+testIdleTimeout.String(), "the error names the idle timeout")
}

// progressTimeout is the idle timeout of the tests of transfers that keep
// making progress: far longer than any pause between their steps, so they
// pass however loaded the machine is.
const progressTimeout = 500 * time.Millisecond

// tricklingEndpoint returns the URL of an "object store" that answers every
// request with pieces bytes, one at a time with a short pause between them,
// taking several times progressTimeout in all.
func tricklingEndpoint(t *testing.T, pieces int) string {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)

		writer.Header().Set("Content-Length", strconv.Itoa(pieces))
		writer.WriteHeader(http.StatusOK)

		for range pieces {
			time.Sleep(progressTimeout / 100)

			if _, err := writer.Write([]byte("x")); err != nil {
				return
			}

			writer.(http.Flusher).Flush()
		}
	}))
	t.Cleanup(server.Close)

	return server.URL
}

func TestSlowTransferThatKeepsMovingIsNotCutShort(t *testing.T) {
	// Three idle timeouts' worth of pauses in all.
	const pieces = 300

	objects := objectsAt(t, tricklingEndpoint(t, pieces), progressTimeout, 1)

	data, err := objects.ReadRange(t.Context(), "vaults/x/blobs/00", 0, pieces)
	require.NoError(t, err)
	assert.Len(t, data, pieces)
}

func TestStreamedReadMayPauseLongerThanTheIdleTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", strconv.Itoa(2<<20))
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(make([]byte, 2<<20))
	}))
	t.Cleanup(server.Close)

	objects := objectsAt(t, server.URL, testIdleTimeout, 1)

	body, err := objects.Open(t.Context(), "vaults/x/blobs/00")
	require.NoError(t, err)

	defer func() { _ = body.Close() }()

	_, err = io.ReadFull(body, make([]byte, 1024))
	require.NoError(t, err)

	// The reader (an export writing to a slow destination) pauses; the
	// store has done nothing wrong.
	time.Sleep(3 * testIdleTimeout)

	rest, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Len(t, rest, 2<<20-1024)
}
