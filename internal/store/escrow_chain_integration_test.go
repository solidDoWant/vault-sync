//go:build integration

package store_test

import (
	"bytes"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestEscrowChainSeedsItsRootOnce(t *testing.T) {
	queries := store.New(migratedPool(t))

	empty, err := queries.EscrowChain(t.Context(), nil)
	require.NoError(t, err)
	assert.Equal(t, store.EscrowChain{}, empty, "without a root to seed, an empty chain stays empty")

	// Concurrently starting servers offer different roots; exactly one
	// becomes the root, and every one reads it.
	const servers = 4

	chains := make([]store.EscrowChain, servers)
	errs := make([]error, servers)

	var wait sync.WaitGroup

	for index := range servers {
		wait.Go(func() {
			chains[index], errs[index] = queries.EscrowChain(t.Context(), []byte{byte('a' + index)})
		})
	}

	wait.Wait()

	for index := range servers {
		require.NoError(t, errs[index])
		assert.Equal(t, chains[0], chains[index])
	}

	require.Len(t, chains[0].Root, 1)
	assert.Empty(t, chains[0].Rotations)

	again, err := queries.EscrowChain(t.Context(), []byte("another root"))
	require.NoError(t, err)
	assert.Equal(t, chains[0], again, "a stored root is never replaced")
}

func TestAppendEscrowRotationExtendsTheChainInOrder(t *testing.T) {
	queries := store.New(migratedPool(t))

	statement := func(fill byte) store.EscrowRotationStatement {
		return store.EscrowRotationStatement{
			OldBundleHash: bytes.Repeat([]byte{fill}, 32),
			NewBundle:     []byte{fill},
			Signature:     bytes.Repeat([]byte{fill}, 64),
		}
	}

	require.ErrorIs(t, queries.AppendEscrowRotation(t.Context(), 1, statement(1)), store.ErrEscrowChainPosition, "no statement before the root")

	_, err := queries.EscrowChain(t.Context(), []byte("root"))
	require.NoError(t, err)

	require.ErrorIs(t, queries.AppendEscrowRotation(t.Context(), 0, statement(1)), store.ErrEscrowChainPosition, "the root is not a statement")
	require.ErrorIs(t, queries.AppendEscrowRotation(t.Context(), 2, statement(1)), store.ErrEscrowChainPosition, "no gap")
	require.NoError(t, queries.AppendEscrowRotation(t.Context(), 1, statement(1)))
	require.ErrorIs(t, queries.AppendEscrowRotation(t.Context(), 1, statement(9)), store.ErrEscrowChainPosition, "a position is written once")
	require.NoError(t, queries.AppendEscrowRotation(t.Context(), 2, statement(2)))

	chain, err := queries.EscrowChain(t.Context(), nil)
	require.NoError(t, err)
	assert.Equal(t, store.EscrowChain{
		Root:      []byte("root"),
		Rotations: []store.EscrowRotationStatement{statement(1), statement(2)},
	}, chain)
}
