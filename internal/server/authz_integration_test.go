//go:build integration

package server_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/server"
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
		access := server.VaultProcedures[procedure]
		body := map[string]string{"vault_id": created.GetId()}

		t.Run(procedure, func(t *testing.T) {
			for _, subject := range []string{"alice", "bob"} {
				response := fixture.callJSON(t, procedure, tokens[subject], body)
				assert.NotEqual(t, "permission_denied", response.code, subject)
				assert.False(t, response.deniedAsNonMember(), subject)
			}

			viewer := fixture.callJSON(t, procedure, tokens["carol"], body)
			if access == authz.Write {
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
		})
	}
}
