package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// EscrowChainStore reads the deployment's stored escrow chain
// (store.Store.EscrowChain).
type EscrowChainStore interface {
	// EscrowChain returns the stored chain, first storing root as its root
	// when no chain is stored and root is not nil.
	EscrowChain(ctx context.Context, root []byte) (store.EscrowChain, error)
}

// ErrEscrowChain is returned by LoadEscrowChain when the stored escrow chain
// does not link, or does not end at the configured escrow bundle.
var ErrEscrowChain = errors.New("escrow chain")

// LoadEscrowChain reads the deployment's escrow chain for publishing in
// GetServerInfo (docs/design/encryption.md, "Where the escrow chain lives").
// With no chain stored yet, the configured bundle becomes its root. Every
// rotation statement must be signed by the escrow signing key of the bundle
// before it, and the chain's head must equal the configured bundle;
// otherwise it fails with ErrEscrowChain and the server must not start.
// Without a configured escrow bundle the chain is neither read nor
// published.
func LoadEscrowChain(ctx context.Context, chains EscrowChainStore, escrow api.Escrow) (api.Escrow, error) {
	if escrow.Bundle == nil {
		return escrow, nil
	}

	configured, err := escrow.Bundle.Encode()
	if err != nil {
		return api.Escrow{}, fmt.Errorf("%w: configured bundle: %w", ErrEscrowChain, err)
	}

	stored, err := chains.EscrowChain(ctx, configured)
	if err != nil {
		return api.Escrow{}, err
	}

	root, err := e2ee.ParseEscrowBundle(stored.Root)
	if err != nil {
		return api.Escrow{}, fmt.Errorf("%w: the stored root bundle is malformed: %w", ErrEscrowChain, err)
	}

	rotations := make([]e2ee.EscrowRotation, 0, len(stored.Rotations))
	published := make([]*vaultsyncv1.EscrowRotationStatement, 0, len(stored.Rotations))

	for index, statement := range stored.Rotations {
		newBundle, err := e2ee.ParseEscrowBundle(statement.NewBundle)
		if err != nil {
			return api.Escrow{}, fmt.Errorf("%w: rotation statement %d has a malformed bundle: %w", ErrEscrowChain, index+1, err)
		}

		rotations = append(rotations, e2ee.EscrowRotation{OldBundleHash: statement.OldBundleHash, NewBundle: newBundle, Signature: statement.Signature})
		published = append(published, &vaultsyncv1.EscrowRotationStatement{
			OldBundleHash: statement.OldBundleHash,
			NewBundle:     statement.NewBundle,
			Signature:     statement.Signature,
		})
	}

	head, err := e2ee.VerifyEscrowChain(root, rotations)
	if err != nil {
		return api.Escrow{}, fmt.Errorf("%w: the stored chain does not link: %w", ErrEscrowChain, err)
	}

	headEncoded, err := head.Encode()
	if err != nil || !bytes.Equal(headEncoded, configured) {
		return api.Escrow{}, fmt.Errorf("%w: the configured escrow recipient and signing key are not the chain's head; rotate the escrow key with the export job first", ErrEscrowChain)
	}

	escrow.Chain = api.EscrowChain{Root: stored.Root, Rotations: published}

	return escrow, nil
}
