//go:build integration && linux

package export_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// deploymentEscrowKey is one of the deployment's escrow keys as an operator
// holds it: the age identity line, the hybrid public key, the bundle the
// server publishes and the Ed25519 signing key.
type deploymentEscrowKey struct {
	identity string
	public   []byte
	keyID    string
	bundle   e2ee.EscrowBundle
	signing  ed25519.PrivateKey
}

func newDeploymentEscrowKey(t *testing.T) deploymentEscrowKey {
	t.Helper()

	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	identity, err := e2ee.AgeIdentity(private)
	require.NoError(t, err)

	recipient, err := e2ee.AgeRecipient(public)
	require.NoError(t, err)

	keyID, err := e2ee.EscrowKeyID(public)
	require.NoError(t, err)

	signPub, signing, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	return deploymentEscrowKey{identity: identity, public: public, keyID: keyID, bundle: e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}, signing: signing}
}

// switchingJobStore is the server's escrow job storage, the store itself,
// with a hook run before the first slot replacement in one vault: a device
// that still sees the old escrow key creating an epoch while the rotation
// goes.
type switchingJobStore struct {
	*store.Store

	vaultID uuid.UUID
	once    sync.Once
	hook    func()
}

func (job *switchingJobStore) ReplaceEscrowSlot(ctx context.Context, replacement store.EscrowSlotReplacement) error {
	if replacement.VaultID == job.vaultID && job.hook != nil {
		job.once.Do(job.hook)
	}

	return job.Store.ReplaceEscrowSlot(ctx, replacement)
}

func writeLines(t *testing.T, name string, lines ...string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), name)
	require.NoError(t, os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600))

	return path
}

func signingSeed(key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.Seed())
}

// runRotateEscrow runs `export rotate-escrow` to target through serverURL
// and returns its exit code and summary.
func runRotateEscrow(t *testing.T, env map[string]string, serverURL string, target deploymentEscrowKey) (int, export.RotationSummary) {
	t.Helper()

	var stdout, stderr bytes.Buffer

	args := []string{"-server", serverURL, "-recipient", target.bundle.Recipient, "-signing-public-key", base64.StdEncoding.EncodeToString(target.bundle.SignPub)}
	code := export.RotateMain(t.Context(), args, func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}, &stdout, &stderr)

	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	require.Len(t, lines, 1, "stdout is one JSON summary line; stderr: %s", stderr.String())

	var summary export.RotationSummary
	require.NoError(t, json.Unmarshal([]byte(lines[0]), &summary))

	return code, summary
}

func TestEscrowRotationAgainstPostgreSQL(t *testing.T) {
	t.Run("[P4-12] the export job re-wraps every escrow slot, deleted vaults included, catches a slot wrapped to the old key during the switch, and the age tool opens a slot with the new key", func(t *testing.T) {
		deployment := newDeployment(t)
		oldKey, newKey := newDeploymentEscrowKey(t), newDeploymentEscrowKey(t)

		root, err := oldKey.bundle.Encode()
		require.NoError(t, err)

		_, err = deployment.store.EscrowChain(t.Context(), root)
		require.NoError(t, err)

		live := deployment.createEscrowedVault(t, "Live")
		deployment.rotate(t, live, oldKey.public, nil)
		deployment.rotate(t, live, oldKey.public, nil)

		deleted := deployment.createEscrowedVault(t, "Deleted last week")
		deployment.rotate(t, deleted, oldKey.public, nil)
		require.NoError(t, deployment.store.DeleteVault(t.Context(), deleted.id))

		token := strings.Repeat("j", 44)
		job := &switchingJobStore{Store: deployment.store, vaultID: live.id}
		job.hook = func() { deployment.rotate(t, live, oldKey.public, nil) }

		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		path, handler := vaultsyncv1connect.NewEscrowJobServiceHandler(
			api.EscrowJobService{Store: job, Logger: logger},
			connect.WithInterceptors(auth.NewJobTokenInterceptor([]byte(token))))

		mux := http.NewServeMux()
		mux.Handle(path, handler)

		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)

		env := deployment.env()
		env[config.EscrowIdentityFileEnv] = writeLines(t, "escrow.key", "# old", oldKey.identity, "# new", newKey.identity)
		env[config.EscrowSigningKeyFileEnv] = writeLines(t, "escrow-signing.key", signingSeed(oldKey.signing), signingSeed(newKey.signing))
		env[config.EscrowJobTokenFileEnv] = writeLines(t, "job.token", token)

		code, first := runRotateEscrow(t, env, server.URL, newKey)
		assert.Equal(t, 1, code, "a slot left on the old key fails the run")
		assert.Equal(t, export.StatusFailed, first.Status, first.Error)
		assert.True(t, first.AppendedStatement)
		assert.Equal(t, 3, first.Rewrapped, "both of the live vault's slots and the deleted vault's")
		assert.Equal(t, 1, first.OldKeySlots, "the slot a device wrapped to the old key during the run is caught")
		assert.Equal(t, 2, first.Vaults)

		code, second := runRotateEscrow(t, env, server.URL, newKey)
		assert.Equal(t, 0, code)
		assert.Equal(t, export.StatusOK, second.Status, second.Error)
		assert.False(t, second.AppendedStatement)
		assert.Equal(t, 1, second.Rewrapped)
		assert.Equal(t, 0, second.OldKeySlots)

		// The old key retired: the operator drops its identity and signing key.
		env[config.EscrowIdentityFileEnv] = writeLines(t, "escrow.key", newKey.identity)
		env[config.EscrowSigningKeyFileEnv] = writeLines(t, "escrow-signing.key", signingSeed(newKey.signing))

		code, retired := runRotateEscrow(t, env, server.URL, newKey)
		assert.Equal(t, 0, code)
		assert.Equal(t, export.StatusOK, retired.Status, retired.Error)
		assert.Equal(t, 0, retired.Rewrapped)

		chain, err := deployment.store.EscrowChain(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, chain.Rotations, 1)

		head, err := e2ee.ParseEscrowBundle(chain.Rotations[0].NewBundle)
		require.NoError(t, err)
		assert.Equal(t, newKey.bundle, head)

		identityPath := writeLines(t, "new-escrow.key", newKey.identity)

		for _, vault := range []*escrowedStoreVault{live, deleted} {
			slots, err := deployment.store.InVault(vault.id).ListEscrowSlots(t.Context(), 0, 100)
			require.NoError(t, err)
			require.Len(t, slots, len(vault.keys))

			for _, slot := range slots {
				assert.Equal(t, newKey.keyID, slot.RecipientID, "vault %s epoch %d", vault.id, slot.Epoch)

				slotPath := filepath.Join(t.TempDir(), "slot.age")
				require.NoError(t, os.WriteFile(slotPath, slot.WrappedKey, 0o600))

				command := exec.CommandContext(t.Context(), "go", "tool", "age", "--decrypt", "--identity", identityPath, slotPath)

				var stderr bytes.Buffer

				command.Stderr = &stderr

				output, err := command.Output()
				require.NoError(t, err, stderr.String())
				require.GreaterOrEqual(t, len(output), e2ee.KeySize)
				assert.Equal(t, vault.keys[slot.Epoch], output[:e2ee.KeySize], "vault %s epoch %d", vault.id, slot.Epoch)
			}
		}
	})
}
