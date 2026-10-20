//go:build integration

package blobstore_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// A commit waiting for its own user's compose slots holds no claim on its
// blob, so a co-member's commit of the same blob is not kept waiting behind
// that user's queue (#388 item 3).
func TestACommitQueuedBehindItsUsersSlotsDoesNotBlockAnotherUsersCommitOfTheBlob(t *testing.T) {
	fixture, alice := newFairnessFixture(t)
	service, objects := alice.instance(t)

	// Alice's two busy blobs, and the shared one both members commit.
	var busy [][]byte

	for index := range 2 {
		content := fmt.Appendf(nil, "alice's busy note %d", index)
		sum := sha256.Sum256(content)
		busy = append(busy, sum[:])
		alice.send(t, sum[:], content, service)
	}

	shared := []byte("the shared note")
	sharedSum := sha256.Sum256(shared)
	alice.send(t, sharedSum[:], shared, service)

	sharedUpload, err := alice.vault.ActiveBlobUpload(t.Context(), sharedSum[:])
	require.NoError(t, err)

	sharedPrefix := blobstore.UploadPrefix(alice.vault.VaultID(), sharedUpload.ID)

	// Every composition but the shared blob's blocks once it holds its
	// slots.
	composing := make(chan struct{}, 8)

	blobstore.SetBeforeSourceRead(objects, func(ctx context.Context, key string) {
		if strings.HasPrefix(key, sharedPrefix) {
			return
		}

		composing <- struct{}{}

		select {
		case <-fixture.release:
		case <-ctx.Done():
		}
	})

	var group sync.WaitGroup

	results := make(chan error, len(busy)+1)

	for _, blobID := range busy {
		group.Go(func() { results <- alice.commit(as(t.Context(), fixture.aliceID), service, blobID) })
	}

	receive(t, composing, "alice's first busy commit")
	receive(t, composing, "alice's second busy commit")

	// Alice's commit of the shared blob queues behind her own compositions.
	group.Go(func() { results <- alice.commit(as(t.Context(), fixture.aliceID), service, sharedSum[:]) })

	deadline := time.Now().Add(hangGuard)
	for blobstore.ComposeWaiting(objects) == 0 {
		require.True(t, time.Now().Before(deadline), "alice's third commit never queued")
		time.Sleep(time.Millisecond)
	}

	// Bob's commit of the same blob goes ahead.
	bobDone := make(chan error, 1)

	go func() { bobDone <- alice.commit(as(t.Context(), fixture.bobID), service, sharedSum[:]) }()

	require.NoError(t, receive(t, bobDone, "bob's commit of the shared blob"))
	alice.requireBlob(t, service, sharedSum[:], shared)

	fixture.open()
	group.Wait()
	close(results)

	for err := range results {
		require.NoError(t, err)
	}

	assert.Zero(t, blobstore.ComposeSlotsHeld(objects))
}

// A commit that reaches CommitBlob without an authenticated user is a
// wiring bug: it is refused with INTERNAL instead of composing in a shared
// bucket (#388 item 5).
func TestCommitWithoutAnAuthenticatedUserIsInternal(t *testing.T) {
	fixture := newCleanupFixture(t)
	service, _ := fixture.instance(t)

	content := []byte("a note")
	sum := sha256.Sum256(content)
	fixture.send(t, sum[:], content, service)

	ctx := authz.WithMembership(t.Context(), authz.Membership{VaultID: fixture.vault.VaultID(), Role: store.RoleOwner})

	_, err := service.CommitBlob(ctx, connect.NewRequest(&vaultsyncv1.CommitBlobRequest{
		VaultId: fixture.vault.VaultID().String(), BlobId: sum[:],
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))

	_, err = fixture.vault.CompleteBlob(t.Context(), sum[:])
	require.ErrorIs(t, err, store.ErrNotFound, "the blob was committed")
}
