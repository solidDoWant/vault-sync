package store

import (
	"context"
	"errors"
	"fmt"
)

// ErrEscrowChainPosition is returned by AppendEscrowRotation when the
// position is not the one after the chain's head.
var ErrEscrowChainPosition = errors.New("escrow chain position is not the next one")

// EscrowRotationStatement is one stored escrow rotation statement: the hash
// of the bundle before it, the encoded new bundle, and the signature of the
// previous escrow signing key, as signed.
type EscrowRotationStatement struct {
	OldBundleHash []byte
	NewBundle     []byte
	Signature     []byte
}

// EscrowChain is the deployment's stored escrow chain: the encoded root
// bundle and the rotation statements after it, in order. Root is nil when
// no chain is stored.
type EscrowChain struct {
	Root      []byte
	Rotations []EscrowRotationStatement
}

// EscrowChain returns the stored escrow chain. When no chain is stored and
// root is not nil, it first stores root as the chain's root, so the first of
// concurrently starting servers decides it and every one returns the same
// chain.
func (store *Store) EscrowChain(ctx context.Context, root []byte) (EscrowChain, error) {
	if root != nil {
		if _, err := store.pool.Exec(ctx, `
			INSERT INTO escrow_chain (position, bundle) VALUES (0, $1)
			ON CONFLICT (position) DO NOTHING`, root); err != nil {
			return EscrowChain{}, fmt.Errorf("store escrow chain root: %w", err)
		}
	}

	rows, err := store.pool.Query(ctx, `SELECT position, bundle, old_bundle_hash, signature FROM escrow_chain ORDER BY position`)
	if err != nil {
		return EscrowChain{}, fmt.Errorf("read escrow chain: %w", err)
	}
	defer rows.Close()

	var chain EscrowChain

	expected := int32(0)

	for rows.Next() {
		var (
			position  int32
			statement EscrowRotationStatement
		)

		if err := rows.Scan(&position, &statement.NewBundle, &statement.OldBundleHash, &statement.Signature); err != nil {
			return EscrowChain{}, fmt.Errorf("read escrow chain: %w", err)
		}

		// A gap would hide statements; the chain is read whole or not at all.
		if position != expected {
			return EscrowChain{}, fmt.Errorf("read escrow chain: position %d is missing", expected)
		}

		expected++

		if position == 0 {
			chain.Root = statement.NewBundle

			continue
		}

		chain.Rotations = append(chain.Rotations, statement)
	}

	if err := rows.Err(); err != nil {
		return EscrowChain{}, fmt.Errorf("read escrow chain: %w", err)
	}

	return chain, nil
}

// AppendEscrowRotation stores statement at position, which must be the one
// after the chain's head; otherwise it fails with ErrEscrowChainPosition.
// The server does not check the statement's signature here.
func (store *Store) AppendEscrowRotation(ctx context.Context, position int32, statement EscrowRotationStatement) error {
	tag, err := store.pool.Exec(ctx, `
		INSERT INTO escrow_chain (position, bundle, old_bundle_hash, signature)
		SELECT $1, $2, $3, $4
		WHERE $1 = (SELECT coalesce(max(position), -1) + 1 FROM escrow_chain) AND $1 >= 1
		ON CONFLICT (position) DO NOTHING`,
		position, statement.NewBundle, statement.OldBundleHash, statement.Signature)
	if err != nil {
		return fmt.Errorf("append escrow rotation: %w", err)
	}

	if tag.RowsAffected() != 1 {
		return ErrEscrowChainPosition
	}

	return nil
}
