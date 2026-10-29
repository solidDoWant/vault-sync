package authz_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const (
	invitationProcedure     = "/test.v1.Test/ReadOrInvitation"
	readOnlyLogProcedure    = "/test.v1.Test/ReadLog"
	invitationErrorMessage  = "invitation not found or no longer valid"
	invitationIDEncodedSize = 22
)

// invitationFixture serves ReadOrInvitation and Read procedures whose
// requests carry an invitation_id behind the authz interceptor.
type invitationFixture struct {
	url     string
	reached atomic.Int64
	last    atomic.Pointer[authz.Membership]
}

func newInvitationFixture(t *testing.T, members authz.MembershipStore) *invitationFixture {
	t.Helper()

	fixture := &invitationFixture{}
	options := connect.WithInterceptors(fakeAuthentication(), authz.NewInterceptor(members, map[string]authz.Access{
		invitationProcedure:  authz.ReadOrInvitation,
		readOnlyLogProcedure: authz.Read,
	}, nil))

	handle := func(ctx context.Context, _ *connect.Request[vaultsyncv1.ListLogEntriesRequest]) (*connect.Response[vaultsyncv1.ListLogEntriesResponse], error) {
		fixture.reached.Add(1)

		if membership, ok := authz.MembershipFromContext(ctx); ok {
			fixture.last.Store(&membership)
		}

		return connect.NewResponse(&vaultsyncv1.ListLogEntriesResponse{}), nil
	}

	mux := http.NewServeMux()
	for _, procedure := range []string{invitationProcedure, readOnlyLogProcedure} {
		mux.Handle(procedure, connect.NewUnaryHandler(procedure, handle, options))
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	fixture.url = server.URL

	return fixture
}

func (fixture *invitationFixture) call(t *testing.T, procedure string, user uuid.UUID, vaultID uuid.UUID, invitationID string) error {
	t.Helper()

	client := connect.NewClient[vaultsyncv1.ListLogEntriesRequest, vaultsyncv1.ListLogEntriesResponse](http.DefaultClient, fixture.url+procedure)
	request := connect.NewRequest(&vaultsyncv1.ListLogEntriesRequest{VaultId: vaultID.String(), InvitationId: invitationID})

	if user != uuid.Nil {
		request.Header().Set(userHeader, user.String())
	}

	_, err := client.CallUnary(t.Context(), request)

	return err
}

// invitationID returns a fresh invite code <id> and the hash the server
// stores for it: SHA-256 of its 16 raw bytes.
func invitationID(t *testing.T, seed byte) (string, string) {
	t.Helper()

	raw := make([]byte, 16)
	raw[0], raw[15] = seed, seed

	id := base64.RawURLEncoding.EncodeToString(raw)
	require.Len(t, id, invitationIDEncodedSize)

	sum := sha256.Sum256(raw)

	return id, string(sum[:])
}

func TestTheHolderOfAPendingInvitationIDIsAuthorizedForAReadOrInvitationProcedure(t *testing.T) {
	vault, otherVault := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	viewer, outsider := uuid.New(), uuid.New()

	pending, pendingHash := invitationID(t, 1)
	elsewhere, elsewhereHash := invitationID(t, 2)
	unknown, _ := invitationID(t, 3)

	members := &memberships{
		roles:       map[[2]uuid.UUID]store.Role{{vault, viewer}: store.RoleViewer},
		invitations: map[string]uuid.UUID{pendingHash: vault, elsewhereHash: otherVault},
	}
	fixture := newInvitationFixture(t, members)

	tests := []struct {
		name         string
		user         uuid.UUID
		procedure    string
		invitationID string
		want         *authz.Membership
		wantCode     connect.Code
		wantMessage  string
	}{
		{name: "holder of a pending invitation to the vault", user: outsider, procedure: invitationProcedure, invitationID: pending, want: &authz.Membership{VaultID: vault, Invited: true}},
		{name: "unknown id", user: outsider, procedure: invitationProcedure, invitationID: unknown, wantCode: connect.CodeNotFound, wantMessage: invitationErrorMessage},
		{name: "invitation to another vault", user: outsider, procedure: invitationProcedure, invitationID: elsewhere, wantCode: connect.CodeNotFound, wantMessage: invitationErrorMessage},
		{name: "malformed id", user: outsider, procedure: invitationProcedure, invitationID: "not-an-id", wantCode: connect.CodeNotFound, wantMessage: invitationErrorMessage},
		{name: "id one character too long", user: outsider, procedure: invitationProcedure, invitationID: pending + "A", wantCode: connect.CodeNotFound, wantMessage: invitationErrorMessage},
		{name: "id one character too short", user: outsider, procedure: invitationProcedure, invitationID: pending[:invitationIDEncodedSize-1], wantCode: connect.CodeNotFound, wantMessage: invitationErrorMessage},
		{name: "non-member without an id", user: outsider, procedure: invitationProcedure, wantCode: connect.CodeNotFound, wantMessage: authz.ErrVaultNotFound.Error()},
		{name: "member without an id", user: viewer, procedure: invitationProcedure, want: &authz.Membership{VaultID: vault, Role: store.RoleViewer}},
		{name: "member with an unknown id", user: viewer, procedure: invitationProcedure, invitationID: unknown, want: &authz.Membership{VaultID: vault, Role: store.RoleViewer}},
		{name: "anonymous holder", procedure: invitationProcedure, invitationID: pending, wantCode: connect.CodeUnauthenticated},
		{name: "holder on a member-only read", user: outsider, procedure: readOnlyLogProcedure, invitationID: pending, wantCode: connect.CodeNotFound, wantMessage: authz.ErrVaultNotFound.Error()},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture.last.Store(nil)
			before := fixture.reached.Load()

			err := fixture.call(t, test.procedure, test.user, vault, test.invitationID)

			if test.wantCode != 0 {
				require.Error(t, err)
				assert.Equal(t, test.wantCode, connect.CodeOf(err), err)
				assert.Equal(t, before, fixture.reached.Load(), "the handler must not run")

				if test.wantMessage != "" {
					var connectErr *connect.Error
					require.ErrorAs(t, err, &connectErr)
					assert.Equal(t, test.wantMessage, connectErr.Message())
				}

				return
			}

			require.NoError(t, err)
			assert.Equal(t, before+1, fixture.reached.Load())
			assert.Equal(t, test.want, fixture.last.Load())
		})
	}
}

func TestAFailingInvitationLookupIsAnInternalError(t *testing.T) {
	vault := uuid.Must(uuid.NewV7())
	pending, _ := invitationID(t, 1)

	members := &failingInvitations{}
	fixture := newInvitationFixture(t, members)

	err := fixture.call(t, invitationProcedure, uuid.New(), vault, pending)
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err), err)
	assert.Zero(t, fixture.reached.Load())
}

// failingInvitations is a membership store in which nobody is a member and
// every invitation lookup fails.
type failingInvitations struct{}

func (failingInvitations) VaultRole(context.Context, uuid.UUID, uuid.UUID) (store.Role, error) {
	return "", store.ErrVaultNotFound
}

func (failingInvitations) InvitationVault(context.Context, []byte) (uuid.UUID, error) {
	return uuid.Nil, errors.New("database unavailable")
}
