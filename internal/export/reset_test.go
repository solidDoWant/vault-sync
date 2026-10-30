package export_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// chainStore is an in-memory escrow chain behind the server's
// EscrowJobService, with the store's position rule.
type chainStore struct {
	mutex sync.Mutex
	chain store.EscrowChain
}

func (chains *chainStore) EscrowChain(context.Context, []byte) (store.EscrowChain, error) {
	chains.mutex.Lock()
	defer chains.mutex.Unlock()

	return store.EscrowChain{Root: chains.chain.Root, Rotations: append([]store.EscrowRotationStatement(nil), chains.chain.Rotations...)}, nil
}

func (chains *chainStore) AppendEscrowRotation(_ context.Context, position int32, statement store.EscrowRotationStatement) error {
	chains.mutex.Lock()
	defer chains.mutex.Unlock()

	if int(position) != len(chains.chain.Rotations)+1 {
		return store.ErrEscrowChainPosition
	}

	chains.chain.Rotations = append(chains.chain.Rotations, statement)

	return nil
}

func (*chainStore) ReplaceEscrowSlot(context.Context, store.EscrowSlotReplacement) error {
	return store.ErrNotFound
}

func (*chainStore) VaultLogEntries(context.Context, uuid.UUID, int64, int) ([]store.LogEntry, error) {
	return nil, nil
}

// readChain reads chains as export.ResetEscrow does, from the database.
type readChain struct{ chains *chainStore }

func (source readChain) EscrowChain(ctx context.Context) (store.EscrowChain, error) {
	return source.chains.EscrowChain(ctx, nil)
}

func encodeBundle(t *testing.T, bundle e2ee.EscrowBundle) []byte {
	t.Helper()

	encoded, err := bundle.Encode()
	require.NoError(t, err)

	return encoded
}

func TestResetEscrowAppendsAResetPointThroughTheJobEndpoint(t *testing.T) {
	t.Parallel()

	token := strings.Repeat("k", 44)
	first, second, third := newEscrowKey(t), newEscrowKey(t), newEscrowKey(t)

	chains := &chainStore{}

	path, handler := vaultsyncv1connect.NewEscrowJobServiceHandler(
		api.EscrowJobService{Store: chains, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		connect.WithInterceptors(auth.NewJobTokenInterceptor([]byte(token))))

	mux := http.NewServeMux()
	mux.Handle(path, handler)

	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	writer := export.NewEscrowJobWriter(httpServer.Client(), httpServer.URL, []byte(token))

	require.Error(t, export.ResetEscrow(t.Context(), readChain{chains}, writer, second.bundle), "no chain yet")

	chains.chain = store.EscrowChain{Root: encodeBundle(t, first.bundle)}

	wrongToken := export.NewEscrowJobWriter(httpServer.Client(), httpServer.URL, []byte(strings.Repeat("x", 44)))
	require.Error(t, export.ResetEscrow(t.Context(), readChain{chains}, wrongToken, second.bundle), "a wrong token is refused")
	assert.Empty(t, chains.chain.Rotations)

	require.NoError(t, export.ResetEscrow(t.Context(), readChain{chains}, writer, second.bundle))

	firstHash := sha256.Sum256(encodeBundle(t, first.bundle))
	assert.Equal(t, []store.EscrowRotationStatement{{OldBundleHash: firstHash[:], NewBundle: encodeBundle(t, second.bundle), Reset: true}}, chains.chain.Rotations)

	// The next reset follows the new head.
	require.NoError(t, export.ResetEscrow(t.Context(), readChain{chains}, writer, third.bundle))
	require.Len(t, chains.chain.Rotations, 2)

	secondHash := sha256.Sum256(encodeBundle(t, second.bundle))
	assert.Equal(t, secondHash[:], chains.chain.Rotations[1].OldBundleHash)

	require.Error(t, export.ResetEscrow(t.Context(), readChain{chains}, writer, first.bundle), "a bundle already in the chain")
	assert.Len(t, chains.chain.Rotations, 2)
}

func TestResetMainRefusesInvalidFlags(t *testing.T) {
	t.Parallel()

	key := newEscrowKey(t)
	signingKey := base64.StdEncoding.EncodeToString(key.bundle.SignPub)

	for name, args := range map[string][]string{
		"no flags":                {},
		"no server":               {"-recipient", key.bundle.Recipient, "-signing-public-key", signingKey},
		"no recipient":            {"-server", "http://localhost", "-signing-public-key", signingKey},
		"no signing key":          {"-server", "http://localhost", "-recipient", key.bundle.Recipient},
		"a short signing key":     {"-server", "http://localhost", "-recipient", key.bundle.Recipient, "-signing-public-key", base64.StdEncoding.EncodeToString(key.bundle.SignPub[1:])},
		"a server without scheme": {"-server", "localhost", "-recipient", key.bundle.Recipient, "-signing-public-key", signingKey},
		"an extra argument":       {"-server", "http://localhost", "-recipient", key.bundle.Recipient, "-signing-public-key", signingKey, "extra"},
	} {
		var stdout, stderr bytes.Buffer

		code := export.Main(t.Context(), append([]string{"reset-escrow"}, args...), func(string) (string, bool) { return "", false }, &stdout, &stderr)
		assert.Equal(t, 2, code, name)
		assert.Empty(t, stdout.String(), name)
	}
}
