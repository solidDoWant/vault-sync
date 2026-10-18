package server_test

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// countingMemberships is a membership store in which nobody is a member.
// It counts the lookups that reach it.
type countingMemberships struct {
	lookups atomic.Int64
}

func (memberships *countingMemberships) VaultRole(context.Context, uuid.UUID, uuid.UUID) (store.Role, error) {
	memberships.lookups.Add(1)

	return "", store.ErrVaultNotFound
}

// panickingVaults is a vault store whose ListVaults panics, standing in for
// any handler that panics.
type panickingVaults struct{}

func (panickingVaults) CreateVault(context.Context, uuid.UUID, store.NewVault, int) (store.Vault, error) {
	return store.Vault{}, errors.New("not supported")
}

func (panickingVaults) ListVaults(context.Context, uuid.UUID, uuid.UUID, int) ([]store.Vault, error) {
	panic("handler panic")
}

// listChanges calls the vault-scoped ListChanges procedure, bounded so a
// call that is queued rather than answered fails the test instead of
// hanging it.
func listChanges(ctx context.Context, client vaultsyncv1connect.SyncServiceClient, token string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	_, err := client.ListChanges(ctx, authorized(&vaultsyncv1.ListChangesRequest{VaultId: uuid.NewString()}, token))

	return err
}

func TestConcurrentRPCLimitIsCheckedBeforeVaultAuthorization(t *testing.T) {
	vaults := newBlockingVaults(1)
	memberships := &countingMemberships{}
	fixture := newConcurrencyFixture(t, vaults, server.Options{
		MaxConcurrentRPCsPerUser: 1,
		Memberships:              memberships,
	})
	token := fixture.token(t, "greedy-user")

	// The user's only slot is held by a call waiting in its handler.
	results := fixture.startBlockedCalls(t, token, 1)
	vaults.waitEntered(t, 1)

	// A vault-scoped call is rejected by the limit without any membership
	// lookup: the limit runs before authorization, so a rejected call does
	// no database work.
	syncClient := vaultsyncv1connect.NewSyncServiceClient(http.DefaultClient, fixture.running.apiURL())
	requireResourceExhausted(t, listChanges(t.Context(), syncClient, token))
	assert.Zero(t, memberships.lookups.Load(), "a call rejected by the concurrency limit must not reach vault authorization")

	close(vaults.release)
	require.NoError(t, <-results)
}

func TestConcurrentRPCSlotIsReleasedOnAbnormalPaths(t *testing.T) {
	const calls = 3

	tests := []struct {
		name    string
		vaults  api.VaultStore
		call    func(ctx context.Context, httpClient *http.Client, apiURL, token string) error
		wantErr connect.Code
	}{
		{
			name:   "handler panics",
			vaults: panickingVaults{},
			call: func(ctx context.Context, httpClient *http.Client, apiURL, token string) error {
				client := vaultsyncv1connect.NewVaultServiceClient(httpClient, apiURL)
				_, err := client.ListVaults(ctx, authorized(&vaultsyncv1.ListVaultsRequest{}, token))

				return err
			},
			// The server aborts the connection; the client sees no status.
			wantErr: connect.CodeUnavailable,
		},
		{
			name:   "vault authorization rejects a non-member",
			vaults: newBlockingVaults(0),
			call: func(ctx context.Context, httpClient *http.Client, apiURL, token string) error {
				return listChanges(ctx, vaultsyncv1connect.NewSyncServiceClient(httpClient, apiURL), token)
			},
			wantErr: connect.CodeNotFound,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newConcurrencyFixture(t, test.vaults, server.Options{
				MaxConcurrentRPCsPerUser: 1,
				Memberships:              &countingMemberships{},
			})
			token := fixture.token(t, "unlucky-user")

			// One connection at most, so each call is read by the server only
			// once the previous request's handling, including releasing its
			// slot, has finished (or its connection was closed after that).
			// No call can then race the release of the one before it.
			httpClient := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 1}}
			t.Cleanup(httpClient.CloseIdleConnections)

			for call := range calls {
				ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
				err := test.call(ctx, httpClient, fixture.running.apiURL(), token)

				cancel()

				require.Error(t, err, "call %d", call)
				require.Equal(t, test.wantErr, connect.CodeOf(err), "call %d must not find its slot taken: %v", call, err)
			}

			// The last slot is released once its request ends, which the
			// client may observe slightly before the server finishes.
			require.Eventually(t, func() bool {
				return metricValue(t, fixture.running, "vault_sync_rpc_in_flight") == "0"
			}, 30*time.Second, 10*time.Millisecond, "every slot must be released")
		})
	}
}
