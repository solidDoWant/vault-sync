package server_test

import (
	"math/rand/v2"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
)

// vaultPageCodecs are the ways a client may encode ListVaults. Without
// gzip, the server's send limit applies to the uncompressed response.
var vaultPageCodecs = map[string][]connect.ClientOption{
	"binary":           {connect.WithAcceptCompression("gzip", nil, nil)},
	"JSON":             {connect.WithProtoJSON(), connect.WithAcceptCompression("gzip", nil, nil)},
	"binary with gzip": nil,
	"JSON with gzip":   {connect.WithProtoJSON()},
}

// fullVaultsFixture is a server with a send limit and a
// user, alice, owning api.MaxOwnedVaultsPerUser vaults with
// api.MaxVaultNameBytes names of pseudo-random letters (so that gzip does
// not shrink them much).
type fullVaultsFixture struct {
	fixture *authFixture
	token   string
	// ids are the ids of alice's vaults.
	ids []string
}

func newFullVaultsFixture(t *testing.T, maxRequestBytes int64) *fullVaultsFixture {
	t.Helper()

	fixture := newVaultFixtureWithLimit(t, newMemoryStore(), newMemoryVaults(), reachableDatabase{}, maxRequestBytes)

	full := &fullVaultsFixture{fixture: fixture, token: fixture.token(t, "alice")}
	random := rand.New(rand.NewChaCha8([32]byte{136})) //nolint:gosec // Test data, not secrets.

	for index := range api.MaxOwnedVaultsPerUser {
		name := make([]byte, api.MaxVaultNameBytes)
		for position := range name {
			name[position] = byte('a' + random.IntN(26))
		}

		name[0] = byte('A' + index%26)
		full.ids = append(full.ids, fixture.createVault(t, full.token, string(name)).GetId())
	}

	return full
}

// pageVaults pages through alice's vaults and returns every vault id and
// the length of each page.
func (full *fullVaultsFixture) pageVaults(t *testing.T, options []connect.ClientOption, pageSize uint32) ([]string, []int) {
	t.Helper()

	client := vaultsyncv1connect.NewVaultServiceClient(
		&http.Client{Transport: &http.Transport{DisableCompression: true}}, full.fixture.running.apiURL(), options...)

	var (
		got       []string
		lengths   []int
		pageToken string
	)

	for range len(full.ids) + 1 {
		response, err := client.ListVaults(t.Context(), authorized(&vaultsyncv1.ListVaultsRequest{
			PageSize: pageSize, PageToken: pageToken,
		}, full.token))
		require.NoError(t, err, "page after token %q", pageToken)

		page := response.Msg
		require.NotEmpty(t, page.GetVaults(), "page after token %q makes no progress", pageToken)

		for _, vault := range page.GetVaults() {
			got = append(got, vault.GetId())
		}

		lengths = append(lengths, len(page.GetVaults()))

		if page.GetNextPageToken() == "" {
			return got, lengths
		}

		pageToken = page.GetNextPageToken()
	}

	require.FailNow(t, "ListVaults did not end")

	return nil, nil
}

// Issue #136: at the smallest send limit the configuration accepts, a user
// owning the most vaults allowed, all with maximum-length names, can page
// through them with any page size in every encoding: every page fits, and
// the pages hold every vault exactly once.
func TestVaultPagesFitTheSmallestSendLimit(t *testing.T) {
	full := newFullVaultsFixture(t, api.MinResponseLimitBytes)

	for name, options := range vaultPageCodecs {
		t.Run(name, func(t *testing.T) {
			for _, pageSize := range []uint32{0, api.DefaultVaultPageSize, api.MaxVaultPageSize, ^uint32(0)} {
				got, lengths := full.pageVaults(t, options, pageSize)
				assert.ElementsMatch(t, full.ids, got, "page size %d", pageSize)
				assert.Len(t, got, len(full.ids), "page size %d", pageSize)
				assert.Greater(t, len(lengths), 1, "page size %d: pages %v", pageSize, lengths)
			}
		})
	}
}

// Issue #136: at the default send limit, pages are cut by count alone, as
// before.
func TestVaultPagesAtTheDefaultSendLimitAreCountCapped(t *testing.T) {
	full := newFullVaultsFixture(t, 1<<20)

	tests := []struct {
		name     string
		pageSize uint32
		want     []int
	}{
		{name: "default page size", pageSize: 0, want: []int{100}},
		{name: "maximum page size", pageSize: api.MaxVaultPageSize, want: []int{100}},
		{name: "small page size", pageSize: 30, want: []int{30, 30, 30, 10}},
	}

	for codec, options := range vaultPageCodecs {
		for _, test := range tests {
			t.Run(codec+"/"+test.name, func(t *testing.T) {
				got, lengths := full.pageVaults(t, options, test.pageSize)
				assert.ElementsMatch(t, full.ids, got)
				assert.Len(t, got, len(full.ids))
				assert.Equal(t, test.want, lengths)
			})
		}
	}
}
