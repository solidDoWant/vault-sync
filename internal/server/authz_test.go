package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/auth/authtest"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// memoryVaults is an in-memory vault and membership store for tests that are
// not about persistence.
type memoryVaults struct {
	mu      sync.Mutex
	vaults  map[uuid.UUID]store.Vault
	members map[uuid.UUID]map[uuid.UUID]store.Role
	deleted map[uuid.UUID]bool
}

func newMemoryVaults() *memoryVaults {
	return &memoryVaults{
		vaults:  map[uuid.UUID]store.Vault{},
		members: map[uuid.UUID]map[uuid.UUID]store.Role{},
		deleted: map[uuid.UUID]bool{},
	}
}

func (memory *memoryVaults) CreateVault(_ context.Context, ownerID uuid.UUID, vault store.NewVault, limit int) (store.Vault, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	owned := 0

	for id, roles := range memory.members {
		if roles[ownerID] == store.RoleOwner && !memory.deleted[id] {
			owned++
		}
	}

	if owned >= limit {
		return store.Vault{}, store.ErrVaultLimit
	}

	created := store.Vault{
		ID:         uuid.Must(uuid.NewV7()),
		Name:       vault.Name,
		Encryption: vault.Encryption,
		Escrow:     vault.Escrow,
		CreatedAt:  time.Now(),
	}
	memory.vaults[created.ID] = created
	memory.members[created.ID] = map[uuid.UUID]store.Role{ownerID: store.RoleOwner}
	created.Role = store.RoleOwner

	return created, nil
}

func (memory *memoryVaults) ListVaults(_ context.Context, userID, after uuid.UUID, limit int) ([]store.Vault, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	var vaults []store.Vault

	for id, roles := range memory.members {
		role, ok := roles[userID]
		if !ok || memory.deleted[id] || bytes.Compare(id[:], after[:]) <= 0 {
			continue
		}

		vault := memory.vaults[id]
		vault.Role = role
		vaults = append(vaults, vault)
	}

	slices.SortFunc(vaults, func(left, right store.Vault) int { return bytes.Compare(left.ID[:], right.ID[:]) })

	return vaults[:min(limit, len(vaults))], nil
}

func (memory *memoryVaults) VaultRole(_ context.Context, vaultID, userID uuid.UUID) (store.Role, error) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	role, ok := memory.members[vaultID][userID]
	if !ok {
		return "", store.ErrVaultNotFound
	}

	if memory.deleted[vaultID] {
		return "", store.ErrVaultDeleted
	}

	return role, nil
}

func (memory *memoryVaults) DeleteVault(_ context.Context, vaultID uuid.UUID) error {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	if _, ok := memory.vaults[vaultID]; !ok {
		return store.ErrVaultNotFound
	}

	if memory.deleted[vaultID] {
		return store.ErrVaultDeleted
	}

	memory.deleted[vaultID] = true

	return nil
}

// addMember seeds a membership; membership management is Phase 3.
func (memory *memoryVaults) addMember(vaultID, userID uuid.UUID, role store.Role) {
	memory.mu.Lock()
	defer memory.mu.Unlock()

	memory.members[vaultID][userID] = role
}

type vaultBackend interface {
	api.VaultStore
	authz.MembershipStore
}

// newVaultFixture is newAuthFixture with vault storage.
func newVaultFixture(t *testing.T, users authStore, vaults vaultBackend, database server.Pinger) *authFixture {
	t.Helper()

	return newVaultFixtureWithLimit(t, users, vaults, database, 0)
}

// newVaultFixtureWithLimit is newVaultFixture with a request and send
// limit of maxRequestBytes (zero: the test default).
func newVaultFixtureWithLimit(t *testing.T, users authStore, vaults vaultBackend, database server.Pinger, maxRequestBytes int64) *authFixture {
	t.Helper()

	issuer := authtest.NewIssuer(t)
	fixture := &authFixture{issuer: issuer, key: issuer.AddKey(t, jose.RS256), logs: &syncBuffer{}}
	logger := slog.New(slog.NewJSONHandler(fixture.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))

	verifier := auth.NewVerifier(auth.VerifierOptions{
		IssuerURL: issuer.URL,
		Audience:  authtest.DefaultAudience,
		Logger:    logger,
	})

	fixture.running = startServer(t, server.Options{
		MaxRequestBytes: maxRequestBytes,
		Database:        database,
		Authenticator:   auth.NewAuthenticator(verifier, users),
		Devices:         users,
		Vaults:          vaults,
		Memberships:     vaults,
		Logger:          logger,
	})

	return fixture
}

func (fixture *authFixture) vaultClient() vaultsyncv1connect.VaultServiceClient {
	return vaultsyncv1connect.NewVaultServiceClient(http.DefaultClient, fixture.running.apiURL())
}

func authorized[T any](message *T, token string) *connect.Request[T] {
	request := connect.NewRequest(message)
	request.Header().Set("Authorization", "Bearer "+token)

	return request
}

func (fixture *authFixture) createVault(t *testing.T, token, name string) *vaultsyncv1.Vault {
	t.Helper()

	response, err := fixture.vaultClient().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name:       name,
		Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE,
	}, token))
	require.NoError(t, err)

	return response.Msg.GetVault()
}

func (fixture *authFixture) listVaults(t *testing.T, token string) []*vaultsyncv1.Vault {
	t.Helper()

	var vaults []*vaultsyncv1.Vault

	pageToken := ""

	for {
		response, err := fixture.vaultClient().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{PageToken: pageToken}, token))
		require.NoError(t, err)

		vaults = append(vaults, response.Msg.GetVaults()...)

		pageToken = response.Msg.GetNextPageToken()
		if pageToken == "" {
			return vaults
		}
	}
}

// rawResponse is an RPC response as seen on the wire.
type rawResponse struct {
	status int
	header http.Header
	body   []byte
	code   string
}

// callJSON calls procedure with a JSON body, so every procedure in the schema
// can be called the same way regardless of its message types.
func (fixture *authFixture) callJSON(t *testing.T, procedure, token string, body any) rawResponse {
	t.Helper()

	encoded, err := json.Marshal(body)
	require.NoError(t, err)

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, fixture.running.apiURL()+procedure, bytes.NewReader(encoded))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)

	defer func() { _ = response.Body.Close() }()

	raw := rawResponse{status: response.StatusCode, header: response.Header}

	raw.body, err = io.ReadAll(response.Body)
	require.NoError(t, err)

	if response.StatusCode != http.StatusOK {
		var connectError struct {
			Code string `json:"code"`
		}

		require.NoError(t, json.Unmarshal(raw.body, &connectError), "%s: %s", procedure, raw.body)

		raw.code = connectError.Code
	}

	return raw
}

// deniedAsNonMember reports whether response is the authorization layer's
// non-member rejection.
func (raw rawResponse) deniedAsNonMember() bool {
	return raw.code == "not_found" && strings.Contains(string(raw.body), authz.ErrVaultNotFound.Error())
}

// vaultScopedProcedures lists, from the schema descriptors, every procedure
// whose request message carries a vault_id field.
func vaultScopedProcedures(t *testing.T) []string {
	t.Helper()

	var scoped []string

	protoregistry.GlobalFiles.RangeFilesByPackage("vaultsync.v1", func(file protoreflect.FileDescriptor) bool {
		for serviceIndex := range file.Services().Len() {
			service := file.Services().Get(serviceIndex)
			for methodIndex := range service.Methods().Len() {
				method := service.Methods().Get(methodIndex)
				if method.Input().Fields().ByName("vault_id") != nil {
					scoped = append(scoped, "/"+string(service.FullName())+"/"+string(method.Name()))
				}
			}
		}

		return true
	})

	require.NotEmpty(t, scoped)
	slices.Sort(scoped)

	return scoped
}

// expectedAccess is this test suite's own read/write classification of every
// vault-scoped procedure. It is deliberately independent of
// server.VaultProcedures (the table under test): the role tests derive their
// expected outcomes from it, so misclassifying a write as a read in the
// server table fails them. A new vault-scoped procedure must be added here
// too.
var expectedAccess = map[string]authz.Access{
	"/vaultsync.v1.SyncService/ListChanges":        authz.Read,
	"/vaultsync.v1.SyncService/GetRevision":        authz.Read,
	"/vaultsync.v1.SyncService/GetDocumentHistory": authz.Read,
	"/vaultsync.v1.BlobService/DownloadBlob":       authz.Read,
	"/vaultsync.v1.SyncService/CommitRevision":     authz.Write,
	"/vaultsync.v1.BlobService/BeginBlob":          authz.Write,
	"/vaultsync.v1.BlobService/PutBlobChunk":       authz.Write,
	"/vaultsync.v1.BlobService/CommitBlob":         authz.Write,
	// Membership management is owner-only (#33).
	"/vaultsync.v1.MembershipService/CreateInvitation": authz.Manage,
	"/vaultsync.v1.MembershipService/ListInvitations":  authz.Manage,
	"/vaultsync.v1.MembershipService/RevokeInvitation": authz.Manage,
	"/vaultsync.v1.MembershipService/ListMembers":      authz.Manage,
	"/vaultsync.v1.MembershipService/UpdateMemberRole": authz.Manage,
	"/vaultsync.v1.MembershipService/RemoveMember":     authz.Manage,
	// Any member may leave a vault.
	"/vaultsync.v1.MembershipService/LeaveVault": authz.Read,
	// Every member, viewers included, reads the epochs and their own key
	// slots; only owners wrap and grant keys (#694).
	"/vaultsync.v1.VaultKeyService/ListKeySlots":     authz.Read,
	"/vaultsync.v1.VaultKeyService/ListEpochs":       authz.Read,
	"/vaultsync.v1.VaultKeyService/ListMissingSlots": authz.Manage,
	"/vaultsync.v1.VaultKeyService/RotateEpoch":      authz.Manage,
	"/vaultsync.v1.VaultKeyService/AddKeySlots":      authz.Manage,
	// Only owners delete a vault.
	"/vaultsync.v1.VaultService/DeleteVault": authz.Manage,
}

// deniedByRole reports whether a member with role must get
// PERMISSION_DENIED from a procedure classified as access: viewers cannot
// write, and only owners may manage.
func deniedByRole(role store.Role, access authz.Access) bool {
	switch access {
	case authz.Write:
		return role == store.RoleViewer
	case authz.Manage:
		return role == store.RoleEditor || role == store.RoleViewer
	default:
		return false
	}
}

// expectedAccessOf returns the independent expected classification of
// procedure.
func expectedAccessOf(t *testing.T, procedure string) authz.Access {
	t.Helper()

	access, ok := expectedAccess[procedure]
	require.True(t, ok, "%s is vault-scoped: add its expected access to expectedAccess", procedure)

	return access
}

func TestVaultProceduresMatchTheExpectedClassification(t *testing.T) {
	assert.Equal(t, expectedAccess, server.VaultProcedures)
}

// TestEveryVaultScopedProcedureIsClassified fails when a procedure whose
// request carries a vault_id is added to the schema without being classified
// as a read or a write.
func TestEveryVaultScopedProcedureIsClassified(t *testing.T) {
	scoped := vaultScopedProcedures(t)

	for _, procedure := range scoped {
		access, ok := server.VaultProcedures[procedure]
		if assert.True(t, ok, "%s carries vault_id and must be classified in server.VaultProcedures", procedure) {
			assert.Contains(t, []authz.Access{authz.Read, authz.Write, authz.Manage}, access, procedure)
		}
	}

	for procedure := range server.VaultProcedures {
		assert.Contains(t, scoped, procedure, "classified procedure %s must exist and carry vault_id", procedure)
	}

	for _, procedure := range server.PublicProcedures {
		assert.NotContains(t, scoped, procedure, "a vault-scoped procedure cannot be public")
	}
}

// TestVaultScopedProceduresEnforceRoles calls every vault-scoped procedure in
// the schema as an owner, an editor, a viewer and a non-member.
func TestVaultScopedProceduresEnforceRoles(t *testing.T) {
	users := newMemoryStore()
	vaults := newMemoryVaults()
	fixture := newVaultFixture(t, users, vaults, nil)

	tokens := map[store.Role]string{}
	for _, role := range []store.Role{store.RoleOwner, store.RoleEditor, store.RoleViewer, "non-member"} {
		tokens[role] = fixture.token(t, string(role))
	}

	memberIDs := map[store.Role]uuid.UUID{}

	for _, role := range []store.Role{store.RoleEditor, store.RoleViewer} {
		userID, err := users.UpsertUser(t.Context(), fixture.issuer.URL, string(role), "")
		require.NoError(t, err)

		memberIDs[role] = userID
	}

	for _, procedure := range vaultScopedProcedures(t) {
		access := expectedAccessOf(t, procedure)

		// A vault per procedure, so one that changes the vault (an
		// owner's DeleteVault) does not change the others' outcomes.
		vault := fixture.createVault(t, tokens[store.RoleOwner], "Shared")
		for role, userID := range memberIDs {
			vaults.addMember(uuid.MustParse(vault.GetId()), userID, role)
		}

		// The owner calls last, so the members' calls see the vault
		// before an owner-only procedure changes it.
		for _, role := range []store.Role{store.RoleEditor, store.RoleViewer, "non-member", store.RoleOwner} {
			t.Run(procedure+" as "+string(role), func(t *testing.T) {
				response := fixture.callJSON(t, procedure, tokens[role], map[string]string{"vault_id": vault.GetId()})

				switch {
				case role == "non-member":
					assert.Equal(t, "not_found", response.code)
					assert.True(t, response.deniedAsNonMember(), "%s", response.body)
				case deniedByRole(role, access):
					assert.Equal(t, "permission_denied", response.code)
				default:
					// Authorized: the call reached the handler (whatever
					// it answers, it is not an authorization rejection).
					assert.NotEqual(t, "permission_denied", response.code, "%s", response.body)
					assert.False(t, response.deniedAsNonMember(), "%s", response.body)
					assert.NotEqual(t, "unauthenticated", response.code, "%s", response.body)
				}
			})
		}
	}
}

// TestNonMemberCannotTellWhetherAVaultExists compares, for every vault-scoped
// procedure, the response for a vault the caller is not a member of with the
// response for a vault that does not exist.
func TestNonMemberCannotTellWhetherAVaultExists(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	existing := fixture.createVault(t, fixture.token(t, "owner"), "Private")
	missing := uuid.Must(uuid.NewV7()).String()
	outsider := fixture.token(t, "outsider")

	comparableHeader := func(header http.Header) http.Header {
		header = header.Clone()
		header.Del("Date")

		return header
	}

	for _, procedure := range vaultScopedProcedures(t) {
		t.Run(procedure, func(t *testing.T) {
			notMember := fixture.callJSON(t, procedure, outsider, map[string]string{"vault_id": existing.GetId()})
			nonexistent := fixture.callJSON(t, procedure, outsider, map[string]string{"vault_id": missing})

			assert.Equal(t, "not_found", notMember.code)
			assert.Equal(t, nonexistent.status, notMember.status)
			assert.Equal(t, string(nonexistent.body), string(notMember.body))
			assert.Equal(t, comparableHeader(nonexistent.header), comparableHeader(notMember.header))
		})
	}
}

func TestVaultScopedProceduresValidateVaultID(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	token := fixture.token(t, "owner")
	vault := fixture.createVault(t, token, "Notes")

	for _, procedure := range vaultScopedProcedures(t) {
		for _, vaultID := range []string{"", "not-a-uuid", strings.ToUpper(vault.GetId()), "{" + vault.GetId() + "}", strings.Repeat("a", 10000)} {
			response := fixture.callJSON(t, procedure, token, map[string]string{"vault_id": vaultID})
			assert.Equal(t, "invalid_argument", response.code, "%s with vault_id %.40q", procedure, vaultID)
		}
	}
}

func TestCreatedVaultIsOwnedAndListedOnlyForItsCreator(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")

	created := fixture.createVault(t, alice, "Alice's notes")

	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, created.GetRole())
	assert.Equal(t, "Alice's notes", created.GetName())
	assert.Equal(t, vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE, created.GetEncryption())
	assert.NotEmpty(t, created.GetCreateTime())

	aliceVaults := fixture.listVaults(t, alice)
	require.Len(t, aliceVaults, 1)
	assert.Equal(t, created.GetId(), aliceVaults[0].GetId())
	assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, aliceVaults[0].GetRole())

	assert.Empty(t, fixture.listVaults(t, bob))
}

func TestCreateVaultValidatesInput(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	token := fixture.token(t, "alice")

	none := vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE
	e2ee := vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE

	tests := []struct {
		name      string
		request   *vaultsyncv1.CreateVaultRequest
		wantCode  connect.Code
		wantVault *vaultsyncv1.Vault
	}{
		{name: "plaintext", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes", Encryption: none}},
		// End-to-end encryption needs Phase 4 key management (SPEC.md §15).
		{name: "e2ee", request: &vaultsyncv1.CreateVaultRequest{Name: "Secret", Encryption: e2ee}, wantCode: connect.CodeFailedPrecondition},
		{name: "e2ee with escrow", request: &vaultsyncv1.CreateVaultRequest{Name: "Backed up", Encryption: e2ee, Escrow: true}, wantCode: connect.CodeFailedPrecondition},
		{name: "longest name", request: &vaultsyncv1.CreateVaultRequest{Name: strings.Repeat("n", api.MaxVaultNameBytes), Encryption: none}},
		{name: "empty name", request: &vaultsyncv1.CreateVaultRequest{Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "blank name", request: &vaultsyncv1.CreateVaultRequest{Name: " \t\n", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "over-long name", request: &vaultsyncv1.CreateVaultRequest{Name: strings.Repeat("n", api.MaxVaultNameBytes+1), Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "NUL in name", request: &vaultsyncv1.CreateVaultRequest{Name: "a\x00b", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "C0 control in name", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes\x1b", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "newline in name", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes\nmore", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "DEL in name", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes\x7f", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "C1 control in name", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes\u0085", Encryption: none}, wantCode: connect.CodeInvalidArgument},
		{name: "non-ASCII name", request: &vaultsyncv1.CreateVaultRequest{Name: "Notizen für Straße 📓", Encryption: none}},
		{name: "unspecified encryption", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes"}, wantCode: connect.CodeInvalidArgument},
		{name: "unknown encryption", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes", Encryption: 99}, wantCode: connect.CodeInvalidArgument},
		{name: "escrow without e2ee", request: &vaultsyncv1.CreateVaultRequest{Name: "Notes", Encryption: none, Escrow: true}, wantCode: connect.CodeInvalidArgument},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := fixture.vaultClient().CreateVault(t.Context(), authorized(test.request, token))
			if test.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, test.wantCode, connect.CodeOf(err))

				return
			}

			require.NoError(t, err)

			vault := response.Msg.GetVault()
			assert.Equal(t, test.request.GetName(), vault.GetName())
			assert.Equal(t, test.request.GetEncryption(), vault.GetEncryption())
			assert.Equal(t, test.request.GetEscrow(), vault.GetEscrow())
			assert.Equal(t, vaultsyncv1.VaultRole_VAULT_ROLE_OWNER, vault.GetRole())
		})
	}
}

// TestCreateVaultRejectsEndToEndEncryptionUntilPhase4 guards principle 1:
// without key management a client would store plaintext in a vault marked
// as encrypted.
func TestCreateVaultRejectsEndToEndEncryptionUntilPhase4(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	token := fixture.token(t, "alice")

	for _, escrow := range []bool{false, true} {
		_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
			Name: "Secret", Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE, Escrow: escrow,
		}, token))
		require.Error(t, err)
		assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), "escrow %t", escrow)

		var connectErr *connect.Error

		require.ErrorAs(t, err, &connectErr)
		assert.Equal(t, "end-to-end encrypted vaults are not supported yet", connectErr.Message())
	}

	assert.Empty(t, fixture.listVaults(t, token), "no vault is created")
}

func TestCreateVaultLimit(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	token := fixture.token(t, "alice")

	for range api.MaxOwnedVaultsPerUser {
		fixture.createVault(t, token, "Vault")
	}

	_, err := fixture.vaultClient().CreateVault(t.Context(), authorized(&vaultsyncv1.CreateVaultRequest{
		Name: "One too many", Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE,
	}, token))
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
}

func TestListVaultsPaginates(t *testing.T) {
	fixture := newVaultFixture(t, newMemoryStore(), newMemoryVaults(), nil)
	token := fixture.token(t, "alice")

	var created []string
	for range 5 {
		created = append(created, fixture.createVault(t, token, "Vault").GetId())
	}

	var (
		listed    []string
		pageSizes []int
	)

	pageToken := ""

	for {
		response, err := fixture.vaultClient().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{PageSize: 2, PageToken: pageToken}, token))
		require.NoError(t, err)

		pageSizes = append(pageSizes, len(response.Msg.GetVaults()))
		for _, vault := range response.Msg.GetVaults() {
			listed = append(listed, vault.GetId())
		}

		pageToken = response.Msg.GetNextPageToken()
		if pageToken == "" {
			break
		}
	}

	assert.Equal(t, []int{2, 2, 1}, pageSizes)
	assert.Equal(t, created, listed)

	for _, pageToken := range []string{"not a token", "AAAA", strings.Repeat("A", 1000)} {
		_, err := fixture.vaultClient().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{PageToken: pageToken}, token))
		require.Error(t, err, "page token %.20q", pageToken)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "page token %.20q", pageToken)
	}
}

func TestListVaultsCapsThePageSize(t *testing.T) {
	vaults := newMemoryVaults()
	// At the default send limit (1 MiB) a full page fits; smaller limits
	// cut pages shorter (TestVaultPagesFitTheSmallestSendLimit).
	fixture := newVaultFixtureWithLimit(t, newMemoryStore(), vaults, nil, 1<<20)
	token := fixture.token(t, "alice")
	owned := fixture.createVault(t, token, "First")
	aliceID := ownerOf(t, vaults, owned.GetId())

	// Seed more memberships than one page holds, beyond the owned limit.
	for range api.MaxVaultPageSize + 5 {
		other, err := vaults.CreateVault(t.Context(), uuid.New(), store.NewVault{Name: "Shared", Encryption: store.EncryptionNone}, 1)
		require.NoError(t, err)
		vaults.addMember(other.ID, aliceID, store.RoleViewer)
	}

	for _, pageSize := range []uint32{0, api.MaxVaultPageSize + 1, 1 << 31} {
		response, err := fixture.vaultClient().ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{PageSize: pageSize}, token))
		require.NoError(t, err)

		want := api.MaxVaultPageSize
		if pageSize == 0 {
			want = api.DefaultVaultPageSize
		}

		assert.Len(t, response.Msg.GetVaults(), want, "page size %d", pageSize)
		assert.NotEmpty(t, response.Msg.GetNextPageToken())
	}

	assert.Len(t, fixture.listVaults(t, token), api.MaxVaultPageSize+6)
}

func ownerOf(t *testing.T, vaults *memoryVaults, vaultID string) uuid.UUID {
	t.Helper()

	vaults.mu.Lock()
	defer vaults.mu.Unlock()

	for userID, role := range vaults.members[uuid.MustParse(vaultID)] {
		if role == store.RoleOwner {
			return userID
		}
	}

	require.FailNow(t, "vault has no owner")

	return uuid.Nil
}
