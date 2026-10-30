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

// startEscrowJob serves the escrow job service on jobStore and returns its
// URL and the job's environment holding both escrow keys, from and to.
func startEscrowJob(t *testing.T, deployment *deployment, jobStore api.EscrowJobStore, from, to deploymentEscrowKey) (string, map[string]string) {
	t.Helper()

	token := strings.Repeat("j", 44)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	path, handler := vaultsyncv1connect.NewEscrowJobServiceHandler(
		api.EscrowJobService{Store: jobStore, Logger: logger},
		connect.WithInterceptors(auth.NewJobTokenInterceptor([]byte(token))))

	mux := http.NewServeMux()
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	env := deployment.env()
	env[config.EscrowIdentityFileEnv] = writeLines(t, "escrow.key", "# old", from.identity, "# new", to.identity)
	env[config.EscrowSigningKeyFileEnv] = writeLines(t, "escrow-signing.key", signingSeed(from.signing), signingSeed(to.signing))
	env[config.EscrowJobTokenFileEnv] = writeLines(t, "job.token", token)

	return server.URL, env
}

// createAdoptedVault creates an escrowed vault as a device creates it: its
// membership log starts with a genesis entry, signed by its creator, that
// names escrow as the vault's escrow bundle.
func (deployment *deployment) createAdoptedVault(t *testing.T, name string, escrow e2ee.EscrowBundle) *escrowedStoreVault {
	t.Helper()

	secret, err := e2ee.GenerateUserSecret()
	require.NoError(t, err)

	creator, err := secret.Bundle(deployment.user.String())
	require.NoError(t, err)

	payload, err := e2ee.GenesisPayload(creator, &escrow)
	require.NoError(t, err)

	vaultID := uuid.Must(uuid.NewV7())

	genesis, err := e2ee.Entry{
		VaultID: vaultID.String(), Seq: 1, PrevHash: make([]byte, e2ee.HashSize), Type: e2ee.EntryGenesis, Payload: payload,
	}.Sign(secret.SignKey())
	require.NoError(t, err)

	vault, err := deployment.store.CreateVault(t.Context(), deployment.user, store.NewVault{
		ID: vaultID, Name: name, Encryption: store.EncryptionE2EE, Escrow: true,
		Genesis: &store.LogEntry{Seq: 1, PrevHash: genesis.PrevHash, Type: byte(genesis.Type), Payload: genesis.Payload, Signatures: genesis.Signatures},
	}, 100)
	require.NoError(t, err)

	return &escrowedStoreVault{id: vault.ID, keys: map[int32][]byte{}}
}

func TestEscrowRotationAgainstPostgreSQL(t *testing.T) {
	t.Run("[P4-12] the export job re-wraps every escrow slot, deleted vaults included, catches a slot wrapped to the old key during the switch, and the age tool opens a slot with the new key", func(t *testing.T) {
		deployment := newDeployment(t)
		oldKey, newKey := newDeploymentEscrowKey(t), newDeploymentEscrowKey(t)

		root, err := oldKey.bundle.Encode()
		require.NoError(t, err)

		_, err = deployment.store.EscrowChain(t.Context(), root)
		require.NoError(t, err)

		live := deployment.createAdoptedVault(t, "Live", oldKey.bundle)
		deployment.rotate(t, live, oldKey.public, nil)
		deployment.rotate(t, live, oldKey.public, nil)

		deleted := deployment.createAdoptedVault(t, "Deleted last week", oldKey.bundle)
		deployment.rotate(t, deleted, oldKey.public, nil)
		require.NoError(t, deployment.store.DeleteVault(t.Context(), deleted.id))

		job := &switchingJobStore{Store: deployment.store, vaultID: live.id}
		job.hook = func() { deployment.rotate(t, live, oldKey.public, nil) }

		serverURL, env := startEscrowJob(t, deployment, job, oldKey, newKey)

		code, first := runRotateEscrow(t, env, serverURL, newKey)
		assert.Equal(t, 1, code, "a slot left on the old key fails the run")
		assert.Equal(t, export.StatusFailed, first.Status, first.Error)
		assert.True(t, first.AppendedStatement)
		assert.Equal(t, 3, first.Rewrapped, "both of the live vault's slots and the deleted vault's")
		assert.Equal(t, 1, first.OldKeySlots, "the slot a device wrapped to the old key during the run is caught")
		assert.Equal(t, 2, first.Vaults)

		code, second := runRotateEscrow(t, env, serverURL, newKey)
		assert.Equal(t, 0, code)
		assert.Equal(t, export.StatusOK, second.Status, second.Error)
		assert.False(t, second.AppendedStatement)
		assert.Equal(t, 1, second.Rewrapped)
		assert.Equal(t, 0, second.OldKeySlots)

		// The old key retired: the operator drops its identity and signing key.
		env[config.EscrowIdentityFileEnv] = writeLines(t, "escrow.key", newKey.identity)
		env[config.EscrowSigningKeyFileEnv] = writeLines(t, "escrow-signing.key", signingSeed(newKey.signing))

		code, retired := runRotateEscrow(t, env, serverURL, newKey)
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

	t.Run("[P4-22] the export job's escrow rotation writes a rotation statement signed by the previous escrow key, which chains only from that key", func(t *testing.T) {
		deployment := newDeployment(t)
		oldKey, newKey := newDeploymentEscrowKey(t), newDeploymentEscrowKey(t)

		root, err := oldKey.bundle.Encode()
		require.NoError(t, err)

		_, err = deployment.store.EscrowChain(t.Context(), root)
		require.NoError(t, err)

		deployment.createEscrowedVault(t, "Escrowed")

		serverURL, env := startEscrowJob(t, deployment, deployment.store, oldKey, newKey)

		code, summary := runRotateEscrow(t, env, serverURL, newKey)
		require.Equal(t, 0, code, summary.Error)
		require.True(t, summary.AppendedStatement)

		chain, err := deployment.store.EscrowChain(t.Context(), nil)
		require.NoError(t, err)
		assert.Equal(t, root, chain.Root)
		require.Len(t, chain.Rotations, 1)

		rotations := make([]e2ee.EscrowRotation, 0, len(chain.Rotations))
		for _, stored := range chain.Rotations {
			bundle, err := e2ee.ParseEscrowBundle(stored.NewBundle)
			require.NoError(t, err)

			rotations = append(rotations, e2ee.EscrowRotation{OldBundleHash: stored.OldBundleHash, NewBundle: bundle, Signature: stored.Signature})
		}

		head, err := e2ee.VerifyEscrowChain(oldKey.bundle, rotations)
		require.NoError(t, err, "a device that pinned the previous escrow key accepts the new one")
		assert.Equal(t, newKey.bundle, head)

		_, err = e2ee.VerifyEscrowChain(newDeploymentEscrowKey(t).bundle, rotations)
		require.ErrorIs(t, err, e2ee.ErrSignature, "a device that pinned another escrow key refuses it")
	})
}
