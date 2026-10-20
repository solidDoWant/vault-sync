//go:build integration

package blobstore_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// fairnessFixture is a replica serving two users, alice (the cleanup
// fixture's vault) and bob (a vault of his own), with alice's compositions
// blocked until released.
type fairnessFixture struct {
	alice, bob     *cleanupFixture
	aliceID, bobID uuid.UUID

	// composing receives the staged key of every composition of alice's
	// vault once it holds a compose slot; they block until release closes.
	composing chan string
	release   chan struct{}
	once      sync.Once
	// reads counts the staged objects of alice's vault read by compositions.
	reads atomic.Int64
}

func newFairnessFixture(t *testing.T) (*fairnessFixture, *cleanupFixture) {
	t.Helper()

	alice := newCleanupFixture(t)

	aliceID, err := alice.store.UpsertUser(t.Context(), "https://issuer.example", "alice")
	require.NoError(t, err)

	bobID, err := alice.store.UpsertUser(t.Context(), "https://issuer.example", "bob")
	require.NoError(t, err)

	bobVault, err := alice.store.CreateVault(t.Context(), bobID, store.NewVault{Name: "Bob", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	bob := &cleanupFixture{pool: alice.pool, store: alice.store, objects: alice.objects, objectsConfig: alice.objectsConfig, vault: alice.store.InVault(bobVault.ID)}

	fixture := &fairnessFixture{alice: alice, bob: bob, aliceID: aliceID, bobID: bobID, composing: make(chan string, 64), release: make(chan struct{})}
	t.Cleanup(fixture.open)

	return fixture, alice
}

func (fixture *fairnessFixture) open() {
	fixture.once.Do(func() { close(fixture.release) })
}

// block makes objects block alice's compositions once they hold a slot.
func (fixture *fairnessFixture) block(objects *blobstore.Objects) {
	alicePrefix := "vaults/" + fixture.alice.vault.VaultID().String() + "/"

	var mu sync.Mutex

	seen := map[string]bool{}

	blobstore.SetBeforeSourceRead(objects, func(ctx context.Context, key string) {
		if !strings.HasPrefix(key, alicePrefix) {
			return
		}

		fixture.reads.Add(1)

		// Report each composition once: its first staged object.
		upload := key[:strings.LastIndex(key, "/")]

		mu.Lock()
		first := !seen[upload]
		seen[upload] = true
		mu.Unlock()

		if first {
			fixture.composing <- upload
		}

		select {
		case <-fixture.release:
		case <-ctx.Done():
		}
	})
}

func as(ctx context.Context, userID uuid.UUID) context.Context {
	return auth.WithUser(ctx, auth.User{ID: userID})
}

// Regression for #369: duplicate CommitBlob calls of one upload session
// compose the blob once and hold one compose slot between them, so another
// user's small commit on the same replica goes ahead while the first is
// still composing, and every duplicate returns the first one's result.
func TestDuplicateCommitsOfOneSessionComposeOnce(t *testing.T) {
	fixture, alice := newFairnessFixture(t)
	service, objects := alice.instance(t)

	content, blobID := multipartContent(t)
	alice.send(t, blobID, content, service)

	bobContent := []byte("bob's small note")
	bobSum := sha256.Sum256(bobContent)
	fixture.bob.send(t, bobSum[:], bobContent, service)

	fixture.block(objects)

	// The same client sends as many commits of the session as there are
	// compose slots.
	results := make(chan error, blobstore.ComposeSlots)

	var group sync.WaitGroup

	for range blobstore.ComposeSlots {
		group.Go(func() { results <- alice.commit(as(t.Context(), fixture.aliceID), service, blobID) })
	}

	receive(t, fixture.composing, "the first commit to compose")

	// Every duplicate waits for the first commit, holding no replica
	// compose slot: for its claim, or (once the user's own compose slots
	// are taken by the first two) for one of those.
	deadline := time.Now().Add(hangGuard)
	for blobstore.ClaimWaiting(objects)+blobstore.ComposeWaiting(objects) < blobstore.ComposeSlots-1 {
		require.True(t, time.Now().Before(deadline), "the duplicate commits never waited for the first")
		time.Sleep(time.Millisecond)
	}

	assert.Equal(t, 1, blobstore.ComposeSlotsHeld(objects), "compose slots held by commits of one session")

	// Another user's commit is not kept waiting.
	bobDone := make(chan error, 1)

	go func() { bobDone <- fixture.bob.commit(as(t.Context(), fixture.bobID), service, bobSum[:]) }()

	require.NoError(t, receive(t, bobDone, "bob's commit"))

	// Once the first commit completes, every duplicate returns its result.
	fixture.open()
	group.Wait()
	close(results)

	for err := range results {
		require.NoError(t, err)
	}

	stagedObjects := (len(content) + commitTestChunkBytes - 1) / commitTestChunkBytes
	assert.Equal(t, int64(stagedObjects), fixture.reads.Load(), "the session was composed exactly once")

	// A retry finds the blob complete.
	require.NoError(t, alice.commit(as(t.Context(), fixture.aliceID), service, blobID))
	alice.requireBlob(t, service, blobID, content)
	fixture.bob.requireBlob(t, service, bobSum[:], bobContent)
}

// One user committing as many blobs as there are compose slots cannot keep
// another user's commit on the same replica waiting.
func TestOneUsersCommitsLeaveAComposeSlotForOthers(t *testing.T) {
	fixture, alice := newFairnessFixture(t)
	service, objects := alice.instance(t)

	blobIDs := make([][]byte, blobstore.ComposeSlots)
	contents := make([][]byte, blobstore.ComposeSlots)

	for index := range blobstore.ComposeSlots {
		contents[index] = fmt.Appendf(nil, "alice's note %d", index)
		sum := sha256.Sum256(contents[index])
		blobIDs[index] = sum[:]
		alice.send(t, blobIDs[index], contents[index], service)
	}

	bobContent := []byte("bob's small note")
	bobSum := sha256.Sum256(bobContent)
	fixture.bob.send(t, bobSum[:], bobContent, service)

	fixture.block(objects)

	var group sync.WaitGroup

	results := make(chan error, blobstore.ComposeSlots)

	for _, blobID := range blobIDs {
		group.Go(func() { results <- alice.commit(as(t.Context(), fixture.aliceID), service, blobID) })
	}

	// Wait until each of alice's commits holds a slot or waits for one.
	held := 0

	deadline := time.Now().Add(hangGuard)

	for held+blobstore.ComposeWaiting(objects) < blobstore.ComposeSlots {
		select {
		case <-fixture.composing:
			held++
		case <-time.After(time.Millisecond):
		}

		require.True(t, time.Now().Before(deadline), "alice's commits never settled")
	}

	assert.Less(t, held, blobstore.ComposeSlots, "alice holds every compose slot")

	bobDone := make(chan error, 1)

	go func() { bobDone <- fixture.bob.commit(as(t.Context(), fixture.bobID), service, bobSum[:]) }()

	require.NoError(t, receive(t, bobDone, "bob's commit"))

	fixture.open()
	group.Wait()
	close(results)

	for err := range results {
		require.NoError(t, err)
	}

	for index, blobID := range blobIDs {
		alice.requireBlob(t, service, blobID, contents[index])
	}
}
