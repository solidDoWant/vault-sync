package export_test

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// jobStore backs the server's EscrowJobService with a rotationServer.
type jobStore struct {
	server *rotationServer
}

func (job jobStore) EscrowChain(ctx context.Context, _ []byte) (store.EscrowChain, error) {
	return job.server.EscrowChain(ctx)
}

func (job jobStore) AppendEscrowRotation(ctx context.Context, position int32, statement store.EscrowRotationStatement) error {
	if int(position) != len(job.server.rotations)+1 {
		return store.ErrEscrowChainPosition
	}

	bundle, err := e2ee.ParseEscrowBundle(statement.NewBundle)
	if err != nil {
		return err
	}

	return job.server.AppendEscrowRotation(ctx, e2ee.EscrowRotation{OldBundleHash: statement.OldBundleHash, NewBundle: bundle, Signature: statement.Signature})
}

func (job jobStore) ReplaceEscrowSlot(ctx context.Context, replacement store.EscrowSlotReplacement) error {
	err := job.server.ReplaceEscrowSlot(ctx, replacement)
	if errors.Is(err, export.ErrEscrowSlotGone) {
		return store.ErrNotFound
	}

	return err
}

func TestRotateWritesThroughTheJobEndpoint(t *testing.T) {
	t.Parallel()

	token := strings.Repeat("k", 44)

	tests := []struct {
		name        string
		token       string
		wantErr     require.ErrorAssertionFunc
		wantRotated bool
	}{
		{name: "the job token", token: token, wantErr: require.NoError, wantRotated: true},
		{name: "a wrong token is refused", token: strings.Repeat("x", 44), wantErr: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			oldKey, newKey := newEscrowKey(t), newEscrowKey(t)
			deployment := newRotationServer(t, oldKey.bundle)
			deployment.addVault(oldKey, 2, true)

			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			path, handler := vaultsyncv1connect.NewEscrowJobServiceHandler(
				api.EscrowJobService{Store: jobStore{server: deployment}, Logger: logger},
				connect.WithInterceptors(auth.NewJobTokenInterceptor([]byte(token))))

			mux := http.NewServeMux()
			mux.Handle(path, handler)

			httpServer := httptest.NewServer(mux)
			t.Cleanup(httpServer.Close)

			summary, err := export.Rotate(t.Context(), export.RotationOptions{
				Source: deployment, Writer: export.NewEscrowJobWriter(httpServer.Client(), httpServer.URL, []byte(test.token)), Logger: logger,
				Target: newKey.bundle, Identities: []export.EscrowIdentity{oldKey.identity, newKey.identity},
				SigningKeys: []ed25519.PrivateKey{oldKey.signing, newKey.signing},
			})
			test.wantErr(t, err)

			if !test.wantRotated {
				assert.Empty(t, deployment.rotations)
				assert.Equal(t, export.StatusFailed, summary.Status)

				return
			}

			assert.Equal(t, export.StatusOK, summary.Status)
			assert.Equal(t, 2, summary.Rewrapped)
			requireOnKey(t, deployment, newKey)
		})
	}
}
