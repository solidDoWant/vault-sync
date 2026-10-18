package authz_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const (
	readProcedure         = "/test.v1.Test/Read"
	writeProcedure        = "/test.v1.Test/Write"
	unclassifiedProcedure = "/test.v1.Test/Unclassified"
	unscopedProcedure     = "/test.v1.Test/Unscoped"
	streamProcedure       = "/test.v1.Test/Stream"
	unscopedStream        = "/test.v1.Test/UnscopedStream"
	userHeader            = "Test-User"
)

var procedures = map[string]authz.Access{
	readProcedure:   authz.Read,
	writeProcedure:  authz.Write,
	streamProcedure: authz.Read,
}

// memberships is an in-memory MembershipStore.
type memberships struct {
	roles   map[[2]uuid.UUID]store.Role
	err     error
	lookups atomic.Int64
}

func (memberships *memberships) VaultRole(_ context.Context, vaultID, userID uuid.UUID) (store.Role, error) {
	memberships.lookups.Add(1)

	if memberships.err != nil {
		return "", memberships.err
	}

	role, ok := memberships.roles[[2]uuid.UUID{vaultID, userID}]
	if !ok {
		return "", store.ErrVaultNotFound
	}

	return role, nil
}

// fakeAuthentication stands in for the authentication interceptor: it takes
// the caller's user id from a header.
func fakeAuthentication() connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			if id, err := uuid.Parse(request.Header().Get(userHeader)); err == nil {
				ctx = auth.WithUser(ctx, auth.User{ID: id})
			}

			return next(ctx, request)
		}
	}
}

// fixture serves test procedures behind the authz interceptor and records
// which memberships reached the handlers.
type fixture struct {
	url     string
	reached atomic.Int64
	last    atomic.Pointer[authz.Membership]
}

func newFixture(t *testing.T, members authz.MembershipStore) *fixture {
	t.Helper()

	fixture := &fixture{}
	options := connect.WithInterceptors(fakeAuthentication(), authz.NewInterceptor(members, procedures, nil))

	handle := func(ctx context.Context, _ *connect.Request[vaultsyncv1.GetRevisionRequest]) (*connect.Response[vaultsyncv1.GetRevisionResponse], error) {
		fixture.reached.Add(1)

		if membership, ok := authz.MembershipFromContext(ctx); ok {
			fixture.last.Store(&membership)
		}

		return connect.NewResponse(&vaultsyncv1.GetRevisionResponse{}), nil
	}

	unscoped := func(_ context.Context, _ *connect.Request[vaultsyncv1.ListVaultsRequest]) (*connect.Response[vaultsyncv1.ListVaultsResponse], error) {
		fixture.reached.Add(1)

		return connect.NewResponse(&vaultsyncv1.ListVaultsResponse{}), nil
	}

	mux := http.NewServeMux()
	for _, procedure := range []string{readProcedure, writeProcedure, unclassifiedProcedure} {
		mux.Handle(procedure, connect.NewUnaryHandler(procedure, handle, options))
	}

	mux.Handle(unscopedProcedure, connect.NewUnaryHandler(unscopedProcedure, unscoped, options))

	stream := func(_ context.Context, _ *connect.Request[vaultsyncv1.GetRevisionRequest], stream *connect.ServerStream[vaultsyncv1.GetRevisionResponse]) error {
		fixture.reached.Add(1)

		return stream.Send(&vaultsyncv1.GetRevisionResponse{})
	}

	for _, procedure := range []string{streamProcedure, unscopedStream} {
		mux.Handle(procedure, connect.NewServerStreamHandler(procedure, stream, options))
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	fixture.url = server.URL

	return fixture
}

func (fixture *fixture) call(t *testing.T, procedure string, user uuid.UUID, vaultID string) error {
	t.Helper()

	client := connect.NewClient[vaultsyncv1.GetRevisionRequest, vaultsyncv1.GetRevisionResponse](http.DefaultClient, fixture.url+procedure)
	request := connect.NewRequest(&vaultsyncv1.GetRevisionRequest{VaultId: vaultID})

	if user != uuid.Nil {
		request.Header().Set(userHeader, user.String())
	}

	_, err := client.CallUnary(t.Context(), request)

	return err
}

func TestInterceptorAuthorizesByRole(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	owner, editor, viewer, outsider := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	members := &memberships{roles: map[[2]uuid.UUID]store.Role{
		{vault, owner}:  store.RoleOwner,
		{vault, editor}: store.RoleEditor,
		{vault, viewer}: store.RoleViewer,
	}}
	fixture := newFixture(t, members)

	tests := []struct {
		name      string
		user      uuid.UUID
		procedure string
		wantCode  connect.Code
		wantRole  store.Role
	}{
		{name: "owner reads", user: owner, procedure: readProcedure, wantRole: "owner"},
		{name: "owner writes", user: owner, procedure: writeProcedure, wantRole: "owner"},
		{name: "editor reads", user: editor, procedure: readProcedure, wantRole: "editor"},
		{name: "editor writes", user: editor, procedure: writeProcedure, wantRole: "editor"},
		{name: "viewer reads", user: viewer, procedure: readProcedure, wantRole: "viewer"},
		{name: "viewer writes", user: viewer, procedure: writeProcedure, wantCode: connect.CodePermissionDenied},
		{name: "non-member reads", user: outsider, procedure: readProcedure, wantCode: connect.CodeNotFound},
		{name: "non-member writes", user: outsider, procedure: writeProcedure, wantCode: connect.CodeNotFound},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture.last.Store(nil)
			before := fixture.reached.Load()

			err := fixture.call(t, test.procedure, test.user, vault.String())

			if test.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, test.wantCode, connect.CodeOf(err))
				assert.Equal(t, before, fixture.reached.Load(), "the handler must not run")

				return
			}

			require.NoError(t, err)
			assert.Equal(t, before+1, fixture.reached.Load())

			membership := fixture.last.Load()
			require.NotNil(t, membership)
			assert.Equal(t, authz.Membership{VaultID: vault, Role: test.wantRole}, *membership)
		})
	}
}

// TestNonMemberAndMissingVaultAreIndistinguishable checks that both cases give
// the same error and take the same path: one membership lookup each.
func TestNonMemberAndMissingVaultAreIndistinguishable(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	owner, outsider := uuid.New(), uuid.New()
	members := &memberships{roles: map[[2]uuid.UUID]store.Role{{vault, owner}: store.RoleOwner}}
	fixture := newFixture(t, members)

	for _, procedure := range []string{readProcedure, writeProcedure} {
		before := members.lookups.Load()
		notMember := fixture.call(t, procedure, outsider, vault.String())
		assert.Equal(t, before+1, members.lookups.Load())

		before = members.lookups.Load()
		missing := fixture.call(t, procedure, owner, uuid.Must(uuid.NewV7()).String())
		assert.Equal(t, before+1, members.lookups.Load())

		var notMemberErr, missingErr *connect.Error

		require.ErrorAs(t, notMember, &notMemberErr)
		require.ErrorAs(t, missing, &missingErr)
		assert.Equal(t, connect.CodeNotFound, notMemberErr.Code())
		assert.Equal(t, missingErr.Code(), notMemberErr.Code())
		assert.Equal(t, missingErr.Message(), notMemberErr.Message())
		assert.Equal(t, missingErr.Meta(), notMemberErr.Meta())
		assert.Equal(t, authz.ErrVaultNotFound.Error(), notMemberErr.Message())
	}
}

func TestInterceptorRejectsMalformedVaultIDsBeforeLookup(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	owner := uuid.New()
	members := &memberships{roles: map[[2]uuid.UUID]store.Role{{vault, owner}: store.RoleOwner}}
	fixture := newFixture(t, members)

	for _, vaultID := range []string{
		"",
		"not-a-uuid",
		"VAULT",
		uuid.Nil.String()[:35],
		"{" + vault.String() + "}",
		"urn:uuid:" + vault.String(),
		"0" + vault.String(),
		vault.String() + " ",
		upper(vault.String()),
		vault.String()[:8] + vault.String()[9:13] + vault.String()[14:18] + vault.String()[19:23] + vault.String()[24:],
	} {
		t.Run(vaultID, func(t *testing.T) {
			err := fixture.call(t, readProcedure, owner, vaultID)
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}

	assert.Zero(t, members.lookups.Load())
	assert.Zero(t, fixture.reached.Load())
}

func upper(value string) string {
	out := []byte(value)
	for index, char := range out {
		if char >= 'a' && char <= 'f' {
			out[index] = char - 'a' + 'A'
		}
	}

	return string(out)
}

func TestInterceptorFailsClosed(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	owner := uuid.New()
	roles := map[[2]uuid.UUID]store.Role{{vault, owner}: store.RoleOwner}

	t.Run("unclassified procedure carrying vault_id", func(t *testing.T) {
		fixture := newFixture(t, &memberships{roles: roles})

		err := fixture.call(t, unclassifiedProcedure, owner, vault.String())
		require.Error(t, err)
		assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		assert.Zero(t, fixture.reached.Load())
	})

	t.Run("membership lookup fails", func(t *testing.T) {
		fixture := newFixture(t, &memberships{roles: roles, err: errors.New("database is down")})

		err := fixture.call(t, readProcedure, owner, vault.String())
		require.Error(t, err)
		assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
		assert.NotContains(t, err.Error(), "database is down")
		assert.Zero(t, fixture.reached.Load())
	})

	t.Run("unknown stored role", func(t *testing.T) {
		fixture := newFixture(t, &memberships{roles: map[[2]uuid.UUID]store.Role{{vault, owner}: "admin"}})

		for _, procedure := range []string{readProcedure, writeProcedure} {
			err := fixture.call(t, procedure, owner, vault.String())
			require.Error(t, err)
			assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
		}

		assert.Zero(t, fixture.reached.Load())
	})

	t.Run("no membership store", func(t *testing.T) {
		fixture := newFixture(t, nil)

		err := fixture.call(t, readProcedure, owner, vault.String())
		require.Error(t, err)
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		assert.Zero(t, fixture.reached.Load())
	})

	t.Run("no authenticated user", func(t *testing.T) {
		fixture := newFixture(t, &memberships{roles: roles})

		err := fixture.call(t, readProcedure, uuid.Nil, vault.String())
		require.Error(t, err)
		assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
		assert.Zero(t, fixture.reached.Load())
	})
}

// TestInterceptorRejectsStreamingVaultScopedProcedures checks that a
// classified procedure served as a stream never reaches its handler: its
// messages arrive after the handler starts, so it cannot be authorized first.
func TestInterceptorRejectsStreamingVaultScopedProcedures(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	owner := uuid.New()
	members := &memberships{roles: map[[2]uuid.UUID]store.Role{{vault, owner}: store.RoleOwner}}
	fixture := newFixture(t, members)

	callStream := func(procedure string) (int, error) {
		client := connect.NewClient[vaultsyncv1.GetRevisionRequest, vaultsyncv1.GetRevisionResponse](http.DefaultClient, fixture.url+procedure)
		request := connect.NewRequest(&vaultsyncv1.GetRevisionRequest{VaultId: vault.String()})
		request.Header().Set(userHeader, owner.String())

		stream, err := client.CallServerStream(t.Context(), request)
		require.NoError(t, err)

		defer func() { _ = stream.Close() }()

		received := 0
		for stream.Receive() {
			received++
		}

		return received, stream.Err()
	}

	received, err := callStream(streamProcedure)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	assert.Zero(t, received)
	assert.Zero(t, fixture.reached.Load(), "the handler must not run")
	assert.Zero(t, members.lookups.Load())

	// A stream that is not vault-scoped is left alone.
	received, err = callStream(unscopedStream)
	require.NoError(t, err)
	assert.Equal(t, 1, received)
	assert.Equal(t, int64(1), fixture.reached.Load())
}

func TestInterceptorPassesProceduresWithoutVault(t *testing.T) {
	members := &memberships{}
	fixture := newFixture(t, members)

	client := connect.NewClient[vaultsyncv1.ListVaultsRequest, vaultsyncv1.ListVaultsResponse](http.DefaultClient, fixture.url+unscopedProcedure)
	_, err := client.CallUnary(t.Context(), connect.NewRequest(&vaultsyncv1.ListVaultsRequest{}))
	require.NoError(t, err)

	assert.Equal(t, int64(1), fixture.reached.Load())
	assert.Zero(t, members.lookups.Load())
}

func TestParseID(t *testing.T) {
	id := uuid.Must(uuid.NewV7())

	parsed, err := authz.ParseID(id.String())
	require.NoError(t, err)
	assert.Equal(t, id, parsed)

	_, err = authz.ParseID(upper(id.String()))
	require.Error(t, err)
}
