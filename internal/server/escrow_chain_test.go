package server_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"filippo.io/age"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// escrowKey is one escrow key: its bundle and signing private key.
type escrowKey struct {
	bundle  e2ee.EscrowBundle
	encoded []byte
	sign    ed25519.PrivateKey
}

func newEscrowKey(t *testing.T) escrowKey {
	t.Helper()

	identity, err := age.GenerateHybridIdentity()
	require.NoError(t, err)

	signPub, sign, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	bundle := e2ee.EscrowBundle{SignPub: signPub, Recipient: identity.Recipient().String()}

	encoded, err := bundle.Encode()
	require.NoError(t, err)

	return escrowKey{bundle: bundle, encoded: encoded, sign: sign}
}

// escrowFor returns the server's escrow configuration for key.
func escrowFor(t *testing.T, key escrowKey) api.Escrow {
	t.Helper()

	publicKey, err := e2ee.ParseAgeRecipient(key.bundle.Recipient)
	require.NoError(t, err)

	keyID, err := e2ee.EscrowKeyID(publicKey)
	require.NoError(t, err)

	bundle := key.bundle

	return api.Escrow{PublicKey: publicKey, KeyID: keyID, Default: true, Bundle: &bundle}
}

// rotate returns the statement moving from one key to the next, signed by
// signer.
func rotate(t *testing.T, signer ed25519.PrivateKey, from, to escrowKey) store.EscrowRotationStatement {
	t.Helper()

	rotation, err := e2ee.SignEscrowRotation(signer, from.bundle, to.bundle)
	require.NoError(t, err)

	return store.EscrowRotationStatement{OldBundleHash: rotation.OldBundleHash, NewBundle: to.encoded, Signature: rotation.Signature}
}

// memoryEscrowChains is an in-memory escrow chain store with the store's
// seeding rule: the first root offered to an empty chain becomes its root.
type memoryEscrowChains struct {
	chain store.EscrowChain
	reads int
}

func (chains *memoryEscrowChains) EscrowChain(_ context.Context, root []byte) (store.EscrowChain, error) {
	chains.reads++

	if chains.chain.Root == nil && root != nil {
		chains.chain.Root = root
	}

	return chains.chain, nil
}

func publishedStatements(statements []store.EscrowRotationStatement) []*vaultsyncv1.EscrowRotationStatement {
	published := make([]*vaultsyncv1.EscrowRotationStatement, 0, len(statements))
	for _, statement := range statements {
		published = append(published, &vaultsyncv1.EscrowRotationStatement{
			OldBundleHash: statement.OldBundleHash,
			NewBundle:     statement.NewBundle,
			Signature:     statement.Signature,
		})
	}

	return published
}

func TestLoadEscrowChain(t *testing.T) {
	first, second, third := newEscrowKey(t), newEscrowKey(t), newEscrowKey(t)

	firstToSecond := rotate(t, first.sign, first, second)
	secondToThird := rotate(t, second.sign, second, third)

	// Signed by the new key instead of the previous one.
	selfSigned := rotate(t, second.sign, first, second)

	// Names the hash of a bundle other than the one before it.
	wrongPredecessor := rotate(t, third.sign, third, second)
	wrongPredecessor.Signature = rotate(t, first.sign, third, second).Signature

	tests := []struct {
		name       string
		stored     store.EscrowChain
		configured escrowKey
		wantChain  api.EscrowChain
		assertErr  require.ErrorAssertionFunc
	}{
		{
			name:       "no chain yet: the configured bundle becomes the root",
			configured: first,
			wantChain:  api.EscrowChain{Root: first.encoded, Rotations: publishedStatements(nil)},
		},
		{
			name:       "only the root, configured",
			stored:     store.EscrowChain{Root: first.encoded},
			configured: first,
			wantChain:  api.EscrowChain{Root: first.encoded, Rotations: publishedStatements(nil)},
		},
		{
			name:       "one rotation, configured head",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{firstToSecond}},
			configured: second,
			wantChain:  api.EscrowChain{Root: first.encoded, Rotations: publishedStatements([]store.EscrowRotationStatement{firstToSecond})},
		},
		{
			name:       "two rotations, configured head",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{firstToSecond, secondToThird}},
			configured: third,
			wantChain:  api.EscrowChain{Root: first.encoded, Rotations: publishedStatements([]store.EscrowRotationStatement{firstToSecond, secondToThird})},
		},
		{
			name:       "a statement signed by the new key",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{selfSigned}},
			configured: second,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
		{
			name:       "a statement naming another predecessor",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{wrongPredecessor}},
			configured: second,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
		{
			name:       "a skipped rotation",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{secondToThird}},
			configured: third,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
		{
			name:       "the configuration names the previous key",
			stored:     store.EscrowChain{Root: first.encoded, Rotations: []store.EscrowRotationStatement{firstToSecond}},
			configured: first,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
		{
			name:       "the configuration names a key the chain never reached",
			stored:     store.EscrowChain{Root: first.encoded},
			configured: second,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
		{
			name:       "a malformed stored root",
			stored:     store.EscrowChain{Root: []byte("not a bundle")},
			configured: first,
			assertErr:  errorIs(server.ErrEscrowChain),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertErr := test.assertErr
			if assertErr == nil {
				assertErr = require.NoError
			}

			chains := &memoryEscrowChains{chain: test.stored}

			escrow, err := server.LoadEscrowChain(t.Context(), chains, escrowFor(t, test.configured))
			assertErr(t, err)

			if test.assertErr == nil {
				assert.Equal(t, test.wantChain.Root, escrow.Chain.Root)
				assert.Len(t, escrow.Chain.Rotations, len(test.wantChain.Rotations))

				for index, statement := range test.wantChain.Rotations {
					assert.True(t, proto.Equal(statement, escrow.Chain.Rotations[index]), "statement %d", index)
				}
			}
		})
	}
}

func TestLoadEscrowChainWithoutAnEscrowKeyReadsNothing(t *testing.T) {
	chains := &memoryEscrowChains{}

	escrow, err := server.LoadEscrowChain(t.Context(), chains, api.Escrow{Default: true})
	require.NoError(t, err)

	assert.Equal(t, api.Escrow{Default: true}, escrow)
	assert.Zero(t, chains.reads)
}

func TestGetServerInfoPublishesTheEscrowChain(t *testing.T) {
	first, second := newEscrowKey(t), newEscrowKey(t)
	statement := rotate(t, first.sign, first, second)

	escrow, err := server.LoadEscrowChain(t.Context(), &memoryEscrowChains{chain: store.EscrowChain{
		Root:      first.encoded,
		Rotations: []store.EscrowRotationStatement{statement},
	}}, escrowFor(t, second))
	require.NoError(t, err)

	running := startServer(t, server.Options{Escrow: escrow})

	client := vaultsyncv1connect.NewServerInfoServiceClient(http.DefaultClient, running.apiURL())

	response, err := client.GetServerInfo(t.Context(), connect.NewRequest(&vaultsyncv1.GetServerInfoRequest{}))
	require.NoError(t, err)

	assert.Equal(t, first.encoded, response.Msg.GetEscrowRootBundle())
	require.Len(t, response.Msg.GetEscrowRotations(), 1)
	assert.Equal(t, statement.OldBundleHash, response.Msg.GetEscrowRotations()[0].GetOldBundleHash())
	assert.Equal(t, statement.NewBundle, response.Msg.GetEscrowRotations()[0].GetNewBundle())
	assert.Equal(t, statement.Signature, response.Msg.GetEscrowRotations()[0].GetSignature())

	publicKey, err := e2ee.ParseAgeRecipient(second.bundle.Recipient)
	require.NoError(t, err)
	assert.Equal(t, publicKey, response.Msg.GetEscrowPublicKey(), "the published escrow key is the chain's head")
}

func errorIs(target error) require.ErrorAssertionFunc {
	return func(t require.TestingT, err error, _ ...any) {
		require.ErrorIs(t, err, target)
	}
}
