//go:build integration

package server_test

import (
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestVaultAuthorizationAgainstPostgres(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := newVaultFixture(t, queries, queries, pool)

	tokens := map[string]string{}
	for _, subject := range []string{"alice", "bob", "carol", "mallory"} {
		tokens[subject] = fixture.token(t, subject)
	}

	// Criterion 1: the creator owns the vault and only they list it.
	created := fixture.createVault(t, tokens["alice"], "Household")
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, created.GetRole())

	aliceVaults := fixture.listVaults(t, tokens["alice"])
	require.Len(t, aliceVaults, 1)
	assert.Equal(t, created.GetId(), aliceVaults[0].GetId())

	// Provision the other users (JIT) and seed memberships directly;
	// membership management is Phase 3.
	for _, subject := range []string{"bob", "carol", "mallory"} {
		assert.Empty(t, fixture.listVaults(t, tokens[subject]))
	}

	_, err := pool.Exec(t.Context(), `INSERT INTO vault_members (vault_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')`,
		created.GetId(), userID(t, pool, fixture.issuer.URL, "bob"), userID(t, pool, fixture.issuer.URL, "carol"))
	require.NoError(t, err)

	carolVaults := fixture.listVaults(t, tokens["carol"])
	require.Len(t, carolVaults, 1)
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER, carolVaults[0].GetRole())
	assert.Empty(t, fixture.listVaults(t, tokens["mallory"]))

	missing := uuid.Must(uuid.NewV7()).String()

	for _, procedure := range vaultScopedProcedures(t) {
		access := expectedAccessOf(t, procedure)
		body := map[string]string{"vault_id": created.GetId()}

		t.Run(procedure, func(t *testing.T) {
			editor := fixture.callJSON(t, procedure, tokens["bob"], body)
			if deniedByRole(store.RoleEditor, access) {
				assert.Equal(t, "permission_denied", editor.code)
			} else {
				assert.NotEqual(t, "permission_denied", editor.code)
				assert.False(t, editor.deniedAsNonMember())
			}

			viewer := fixture.callJSON(t, procedure, tokens["carol"], body)
			if deniedByRole(store.RoleViewer, access) {
				assert.Equal(t, "permission_denied", viewer.code)
			} else {
				assert.NotEqual(t, "permission_denied", viewer.code)
				assert.False(t, viewer.deniedAsNonMember())
			}

			notMember := fixture.callJSON(t, procedure, tokens["mallory"], body)
			nonexistent := fixture.callJSON(t, procedure, tokens["mallory"], map[string]string{"vault_id": missing})

			assert.Equal(t, http.StatusNotFound, notMember.status)
			assert.True(t, notMember.deniedAsNonMember(), "%s", notMember.body)
			assert.Equal(t, nonexistent.status, notMember.status)
			assert.Equal(t, string(nonexistent.body), string(notMember.body))

			// The owner calls last, so the other calls see the vault
			// before an owner-only procedure (DeleteVault) changes it;
			// it is the last procedure in the matrix.
			owner := fixture.callJSON(t, procedure, tokens["alice"], body)
			assert.NotEqual(t, "permission_denied", owner.code)
			assert.False(t, owner.deniedAsNonMember())
		})
	}
}

// TestCreateVaultRejectsControlCharactersAgainstPostgres covers issue #86:
// PostgreSQL text cannot hold U+0000, so such names must be rejected as bad
// input before they reach the database.
func TestCreateVaultRejectsControlCharactersAgainstPostgres(t *testing.T) {
	pool := migratedPool(t)
	queries := store.New(pool)
	fixture := newVaultFixture(t, queries, queries, pool)
	token := fixture.token(t, "alice")

	for _, name := range []string{"a\x00b", "\x00", "Notes\x1b", "Notes\u0085"} {
		_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
			Name: name, Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE,
		}, token))
		require.Error(t, err, "%q", name)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "%q", name)
	}

	var vaults int

	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM vaults`).Scan(&vaults))
	assert.Zero(t, vaults, "no vault is created")
	assert.NotContains(t, fixture.logs.String(), `"level":"ERROR"`, "bad input is not an internal error")
}
