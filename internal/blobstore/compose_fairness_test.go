package blobstore_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
)

// stagedObjectBytes is the length of every staged object the answering store
// serves.
const stagedObjectBytes = 10

// answeringEndpoint returns the URL of an "object store" that answers every
// GET with stagedObjectBytes bytes and accepts every other request.
func answeringEndpoint(t *testing.T) string {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)

		if request.Method == http.MethodGet {
			writer.Header().Set("Content-Length", fmt.Sprint(stagedObjectBytes))
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(strings.Repeat("x", stagedObjectBytes)))

			return
		}

		writer.Header().Set("ETag", `"etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	return server.URL
}

// composeGate blocks every composition once it holds a compose slot (in the
// first read of a staged object) until it is released, and records which
// compositions got that far.
type composeGate struct {
	release chan struct{}
	entered chan string
	once    sync.Once

	mu      sync.Mutex
	holding map[string]bool
}

func newComposeGate(t *testing.T, objects *blobstore.Objects) *composeGate {
	t.Helper()

	gate := &composeGate{release: make(chan struct{}), entered: make(chan string, 64), holding: map[string]bool{}}

	blobstore.SetBeforeSourceRead(objects, func(ctx context.Context, key string) {
		gate.mu.Lock()
		gate.holding[key] = true
		gate.mu.Unlock()

		gate.entered <- key

		select {
		case <-gate.release:
		case <-ctx.Done():
		}
	})

	t.Cleanup(gate.open)

	return gate
}

// open lets every blocked composition, and every later one, go on.
func (gate *composeGate) open() {
	gate.once.Do(func() { close(gate.release) })
}

// awaitEntered waits for the composition reading key to hold a slot.
func (gate *composeGate) awaitEntered(t *testing.T, want map[string]bool) {
	t.Helper()

	timer := time.NewTimer(hangGuard)
	defer timer.Stop()

	for {
		gate.mu.Lock()
		done := true

		for key := range want {
			done = done && gate.holding[key]
		}
		gate.mu.Unlock()

		if done {
			return
		}

		select {
		case <-gate.entered:
		case <-timer.C:
			t.Fatalf("compositions %v never got a compose slot", want)
		}
	}
}

func (gate *composeGate) held() map[string]bool {
	gate.mu.Lock()
	defer gate.mu.Unlock()

	held := make(map[string]bool, len(gate.holding))
	for key := range gate.holding {
		held[key] = true
	}

	return held
}

// awaitSettled waits until each of total compositions holds a slot or waits
// for one, and returns those that hold one.
func awaitSettled(t *testing.T, objects *blobstore.Objects, gate *composeGate, total int) map[string]bool {
	t.Helper()

	deadline := time.Now().Add(hangGuard)

	for {
		held := gate.held()
		if len(held)+blobstore.ComposeWaiting(objects) == total {
			return held
		}

		require.True(t, time.Now().Before(deadline), "compositions never settled: %d hold a slot, %d wait", len(held), blobstore.ComposeWaiting(objects))
		time.Sleep(time.Millisecond)
	}
}

func source(name string) []blobstore.Part {
	return []blobstore.Part{{Key: "vaults/x/uploads/" + name, Length: stagedObjectBytes}}
}

func TestOneOwnerCannotHoldEveryComposeSlot(t *testing.T) {
	objects := objectsAt(t, answeringEndpoint(t), time.Minute, 1)
	gate := newComposeGate(t, objects)

	var group sync.WaitGroup

	errs := make(chan error, blobstore.ComposeSlots+1)

	// The first user starts as many compositions as the replica has slots,
	// and each takes every slot it can get.
	for index := range blobstore.ComposeSlots {
		group.Go(func() {
			name := fmt.Sprintf("first/%d", index)
			errs <- objects.Compose(t.Context(), "first", "vaults/x/blobs/"+name, source(name), stagedObjectBytes, nil, nil)
		})
	}

	held := awaitSettled(t, objects, gate, blobstore.ComposeSlots)
	assert.Less(t, len(held), blobstore.ComposeSlots, "one user holds every compose slot")
	assert.NotEmpty(t, held, "the first user holds no compose slot")

	// Another user gets a slot while every composition of the first one is
	// still blocked.
	group.Go(func() {
		errs <- objects.Compose(t.Context(), "second", "vaults/x/blobs/second", source("second/0"), stagedObjectBytes, nil, nil)
	})
	gate.awaitEntered(t, map[string]bool{"vaults/x/uploads/second/0": true})

	for key := range gate.held() {
		if strings.HasPrefix(key, "vaults/x/uploads/first/") {
			assert.True(t, held[key], "a further composition of the first user got a slot: %s", key)
		}
	}

	gate.open()
	group.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}

	assert.Len(t, gate.held(), blobstore.ComposeSlots+1, "every composition finished")
	assert.Zero(t, blobstore.ComposeWaiting(objects))
}

func TestOneOwnerCanComposeConcurrently(t *testing.T) {
	objects := objectsAt(t, answeringEndpoint(t), time.Minute, 1)
	gate := newComposeGate(t, objects)

	var group sync.WaitGroup

	// The cap still lets one user compose more than one blob at a time.
	for index := range 2 {
		group.Go(func() {
			name := fmt.Sprintf("only/%d", index)
			assert.NoError(t, objects.Compose(t.Context(), "only", "vaults/x/blobs/"+name, source(name), stagedObjectBytes, nil, nil))
		})
	}

	gate.awaitEntered(t, map[string]bool{"vaults/x/uploads/only/0": true, "vaults/x/uploads/only/1": true})
	gate.open()
	group.Wait()
}

func TestComposeWaitingForItsOwnersSlotStopsWithItsContext(t *testing.T) {
	objects := objectsAt(t, answeringEndpoint(t), time.Minute, 1)
	gate := newComposeGate(t, objects)

	var group sync.WaitGroup

	for index := range blobstore.ComposeSlots {
		group.Go(func() {
			name := fmt.Sprintf("first/%d", index)
			_ = objects.Compose(t.Context(), "first", "vaults/x/blobs/"+name, source(name), stagedObjectBytes, nil, nil)
		})
	}

	held := awaitSettled(t, objects, gate, blobstore.ComposeSlots)
	require.Less(t, len(held), blobstore.ComposeSlots)

	// A waiting composition that is cancelled stops waiting.
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)

	go func() {
		stopped <- objects.Compose(ctx, "first", "vaults/x/blobs/cancelled", source("cancelled"), stagedObjectBytes, nil, nil)
	}()

	awaitSettled(t, objects, gate, blobstore.ComposeSlots+1)
	cancel()
	require.ErrorIs(t, <-stopped, context.Canceled)

	gate.open()
	group.Wait()
	assert.False(t, gate.held()["vaults/x/uploads/cancelled"])
	assert.Zero(t, blobstore.ComposeWaiting(objects))
}

func TestClaimComposeAdmitsOneCommitPerKey(t *testing.T) {
	objects := objectsAt(t, answeringEndpoint(t), time.Minute, 1)

	release, err := objects.ClaimCompose(t.Context(), "vaults/x/blobs/a")
	require.NoError(t, err)

	// Another key is claimed at once.
	other, err := objects.ClaimCompose(t.Context(), "vaults/x/blobs/b")
	require.NoError(t, err)
	other()

	// A second claim of the key waits until the first is released.
	second := make(chan func(), 1)

	go func() {
		releaseSecond, err := objects.ClaimCompose(t.Context(), "vaults/x/blobs/a")
		assert.NoError(t, err)

		second <- releaseSecond
	}()

	deadline := time.Now().Add(hangGuard)
	for blobstore.ClaimWaiting(objects) == 0 {
		require.True(t, time.Now().Before(deadline), "the second claim never waited")
		time.Sleep(time.Millisecond)
	}

	select {
	case <-second:
		t.Fatal("a second claim of a claimed key")
	default:
	}

	release()
	receive(t, second, "the second claim")()

	// A waiting claim stops with its context.
	release, err = objects.ClaimCompose(t.Context(), "vaults/x/blobs/a")
	require.NoError(t, err)

	defer release()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err = objects.ClaimCompose(ctx, "vaults/x/blobs/a")
	require.ErrorIs(t, err, context.Canceled)
	assert.Zero(t, blobstore.ClaimWaiting(objects))
}

// receive returns the next value of channel, failing the test if it hangs.
func receive[T any](t *testing.T, channel <-chan T, what string) T {
	t.Helper()

	select {
	case value := <-channel:
		return value
	case <-time.After(hangGuard):
		t.Fatalf("hung waiting for %s", what)

		var zero T

		return zero
	}
}
