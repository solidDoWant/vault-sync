//go:build integration

package server_test

import (
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
)

func (fixture *syncFixture) getAnchorList(t *testing.T, replica int, token string) *vaultsyncv1.GetAnchorListResponse {
	t.Helper()

	response, err := fixture.userKeys(replica).GetAnchorList(t.Context(), authorized(&vaultsyncv1.GetAnchorListRequest{}, token))
	require.NoError(t, err)

	return response.Msg
}

func (fixture *syncFixture) putAnchorList(t *testing.T, replica int, token string, version uint64, sealed []byte) error {
	t.Helper()

	_, err := fixture.userKeys(replica).PutAnchorList(t.Context(), authorized(&vaultsyncv1.PutAnchorListRequest{
		Version: version, SealedList: sealed,
	}, token))

	return err
}

func requireAnchorList(t *testing.T, list *vaultsyncv1.GetAnchorListResponse, version uint64, sealed []byte) {
	t.Helper()

	assert.Equal(t, version, list.GetVersion())
	assert.Equal(t, sealed, list.GetSealedList())
}

// A write whose version is not the stored version plus one is refused and
// leaves the stored list as it was.
func TestPutAnchorListRefusesAStaleVersionAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	requireAnchorList(t, fixture.getAnchorList(t, 0, token), 0, nil)

	// Without a list, only version 1 is accepted.
	for _, version := range []uint64{2, 5} {
		err := fixture.putAnchorList(t, 0, token, version, randomBytes(t, 100))
		require.Error(t, err)
		assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
	}

	requireAnchorList(t, fixture.getAnchorList(t, 1, token), 0, nil)

	first := randomBytes(t, 100)
	require.NoError(t, fixture.putAnchorList(t, 0, token, 1, first))

	second := randomBytes(t, 120)
	require.NoError(t, fixture.putAnchorList(t, 1, token, 2, second))
	requireAnchorList(t, fixture.getAnchorList(t, 0, token), 2, second)

	// Rewriting a version already stored, an older one, or skipping ahead.
	for _, version := range []uint64{1, 2, 4} {
		err := fixture.putAnchorList(t, int(version%2), token, version, randomBytes(t, 100))
		require.Error(t, err, "version %d", version)
		assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
		requireAnchorList(t, fixture.getAnchorList(t, 0, token), 2, second)
	}
}

// Of writers of the same version on two replicas at once, exactly one
// succeeds and its list is the one stored.
func TestConcurrentPutAnchorListStoresOneListAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	for _, version := range []uint64{1, 2} {
		lists := [][]byte{randomBytes(t, 100), randomBytes(t, 100)}
		results := make([]error, len(lists))

		var group sync.WaitGroup
		for index, list := range lists {
			group.Go(func() { results[index] = fixture.putAnchorList(t, index, token, version, list) })
		}

		group.Wait()

		var winners []int

		for index, err := range results {
			if err == nil {
				winners = append(winners, index)

				continue
			}

			assert.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err), err)
		}

		require.Len(t, winners, 1, "version %d", version)
		requireAnchorList(t, fixture.getAnchorList(t, 0, token), version, lists[winners[0]])
	}
}

// Every procedure acts on the caller's own list: one user's writes never
// show in another's list, and neither can advance the other's version.
func TestAnchorListsAreEachUsersOwnAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	alice := fixture.token(t, "alice")
	bob := fixture.token(t, "bob")

	aliceList := randomBytes(t, 100)
	require.NoError(t, fixture.putAnchorList(t, 0, alice, 1, aliceList))

	requireAnchorList(t, fixture.getAnchorList(t, 0, bob), 0, nil)

	// Bob's version 1 is his own first list, not a stale write to Alice's.
	bobList := randomBytes(t, 100)
	require.NoError(t, fixture.putAnchorList(t, 1, bob, 1, bobList))

	bobNext := randomBytes(t, 100)
	require.NoError(t, fixture.putAnchorList(t, 1, bob, 2, bobNext))

	requireAnchorList(t, fixture.getAnchorList(t, 0, alice), 1, aliceList)
	requireAnchorList(t, fixture.getAnchorList(t, 1, bob), 2, bobNext)
}

// Empty lists and version 0 are refused through the server, and nothing is
// stored. The size bound is checked in the api package: the default request
// limit refuses a list that large before it reaches the handler.
func TestPutAnchorListRefusesOutOfBoundsInputAgainstPostgres(t *testing.T) {
	fixture := newSyncFixture(t, api.SyncLimits{})
	token := fixture.token(t, "alice")

	for _, request := range []struct {
		version uint64
		sealed  []byte
	}{{version: 1, sealed: nil}, {version: 0, sealed: randomBytes(t, 100)}} {
		err := fixture.putAnchorList(t, 0, token, request.version, request.sealed)
		require.Error(t, err)
		assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), err)
	}

	requireAnchorList(t, fixture.getAnchorList(t, 0, token), 0, nil)
}
