package server_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const deleteVaultProcedure = "/vaultsync.v1.VaultService/DeleteVault"

// errorReasons returns the reasons of the ErrorDetails a JSON error response
// carries.
func (raw rawResponse) errorReasons(t *testing.T) []vaultsyncv1.ErrorReason {
	t.Helper()

	var connectError struct {
		Details []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"details"`
	}

	require.NoError(t, json.Unmarshal(raw.body, &connectError), "%s", raw.body)

	var reasons []vaultsyncv1.ErrorReason

	for _, detail := range connectError.Details {
		if detail.Type != "vaultsync.v1.ErrorDetail" {
			continue
		}

		encoded, err := base64.RawStdEncoding.DecodeString(detail.Value)
		require.NoError(t, err)

		var message vaultsyncv1.ErrorDetail
		require.NoError(t, proto.Unmarshal(encoded, &message))

		reasons = append(reasons, message.GetReason())
	}

	return reasons
}

// sharedVault creates a vault owned by "owner" with an editor and a viewer,
// and returns it with every member's token.
func sharedVault(t *testing.T, fixture *authFixture, users *memoryStore, vaults *memoryVaults) (*vaultsyncv1.Vault, map[store.Role]string) {
	t.Helper()

	tokens := map[store.Role]string{store.RoleOwner: fixture.token(t, "owner")}
	vault := fixture.createVault(t, tokens[store.RoleOwner], "Shared")

	for _, role := range []store.Role{store.RoleEditor, store.RoleViewer} {
		tokens[role] = fixture.token(t, string(role))

		userID, err := users.UpsertUser(t.Context(), fixture.issuer.URL, string(role), "")
		require.NoError(t, err)
		vaults.addMember(uuid.MustParse(vault.GetId()), userID, role)
	}

	return vault, tokens
}

func TestOwnerDeletesVaultForEveryMember(t *testing.T) {
	users := newMemoryStore()
	vaults := newMemoryVaults()
	fixture := newVaultFixture(t, users, vaults, nil)
	vault, tokens := sharedVault(t, fixture, users, vaults)
	kept := fixture.createVault(t, tokens[store.RoleOwner], "Kept")

	response := fixture.callJSON(t, deleteVaultProcedure, tokens[store.RoleOwner], map[string]string{"vault_id": vault.GetId()})
	require.Empty(t, response.code, "%s", response.body)

	for role, token := range tokens {
		// Every vault-scoped procedure, DeleteVault included, is refused
		// NOT_FOUND with the deleted reason.
		for _, procedure := range vaultScopedProcedures(t) {
			refused := fixture.callJSON(t, procedure, token, map[string]string{"vault_id": vault.GetId()})
			assert.Equal(t, "not_found", refused.code, "%s as %s: %s", procedure, role, refused.body)
			assert.Equal(t, []vaultsyncv1.ErrorReason{vaultsyncv1.ErrorReason_ERROR_REASON_VAULT_DELETED}, refused.errorReasons(t),
				"%s as %s", procedure, role)
		}

		for _, listed := range fixture.listVaults(t, token) {
			assert.NotEqual(t, vault.GetId(), listed.GetId(), "%s still lists the deleted vault", role)
		}
	}

	// The owner's other vault is untouched.
	ownerVaults := fixture.listVaults(t, tokens[store.RoleOwner])
	require.Len(t, ownerVaults, 1)
	assert.Equal(t, kept.GetId(), ownerVaults[0].GetId())
}

func TestDeletedVaultLooksMissingToNonMembers(t *testing.T) {
	users := newMemoryStore()
	vaults := newMemoryVaults()
	fixture := newVaultFixture(t, users, vaults, nil)
	vault, tokens := sharedVault(t, fixture, users, vaults)
	outsider := fixture.token(t, "outsider")

	response := fixture.callJSON(t, deleteVaultProcedure, tokens[store.RoleOwner], map[string]string{"vault_id": vault.GetId()})
	require.Empty(t, response.code, "%s", response.body)

	deleted := fixture.callJSON(t, deleteVaultProcedure, outsider, map[string]string{"vault_id": vault.GetId()})
	missing := fixture.callJSON(t, deleteVaultProcedure, outsider, map[string]string{"vault_id": uuid.Must(uuid.NewV7()).String()})

	assert.True(t, deleted.deniedAsNonMember(), "%s", deleted.body)
	assert.Empty(t, deleted.errorReasons(t))
	assert.Equal(t, string(missing.body), string(deleted.body))
}

func TestOnlyOwnersDeleteAVault(t *testing.T) {
	users := newMemoryStore()
	vaults := newMemoryVaults()
	fixture := newVaultFixture(t, users, vaults, nil)
	vault, tokens := sharedVault(t, fixture, users, vaults)

	for _, role := range []store.Role{store.RoleEditor, store.RoleViewer} {
		response := fixture.callJSON(t, deleteVaultProcedure, tokens[role], map[string]string{"vault_id": vault.GetId()})
		assert.Equal(t, "permission_denied", response.code, "%s: %s", role, response.body)
	}

	// The vault is unchanged: every member still lists it and can read it.
	for role, token := range tokens {
		listed := fixture.listVaults(t, token)
		require.Len(t, listed, 1, "%s", role)
		assert.Equal(t, vault.GetId(), listed[0].GetId())

		response := fixture.callJSON(t, "/vaultsync.v1.SyncService/ListChanges", token, map[string]string{"vault_id": vault.GetId()})
		assert.NotEqual(t, "not_found", response.code, "%s: %s", role, response.body)
		assert.NotEqual(t, "permission_denied", response.code, "%s: %s", role, response.body)
	}
}
