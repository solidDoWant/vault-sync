package server_test

import (
	"math/rand/v2"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/store"
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

// Issue #200: with vaults of mixed sizes, a page that cannot fit the next
// vault ends there, even if a later, smaller one would fit: every vault
// appears exactly once, in order.
func TestVaultPagesOfMixedSizesStayInOrder(t *testing.T) {
	fixture := newVaultFixtureWithLimit(t, newMemoryStore(), newMemoryVaults(), reachableDatabase{}, api.MinResponseLimitBytes)
	full := &fullVaultsFixture{fixture: fixture, token: fixture.token(t, "alice")}
	random := rand.New(rand.NewChaCha8([32]byte{200})) //nolint:gosec // Test data, not secrets.

	// Long names, each followed by short ones that fit where it does not.
	for index := range api.MaxOwnedVaultsPerUser {
		length := 1
		if index%2 == 0 {
			length = api.MaxVaultNameBytes
		}

		name := make([]byte, length)
		for position := range name {
			name[position] = byte('a' + random.IntN(26))
		}

		full.ids = append(full.ids, fixture.createVault(t, full.token, string(name)).GetId())
	}

	for name, options := range vaultPageCodecs {
		t.Run(name, func(t *testing.T) {
			got, lengths := full.pageVaults(t, options, ^uint32(0))
			assert.Equal(t, full.ids, got)
			assert.Greater(t, len(lengths), 1, "pages %v", lengths)
		})
	}
}

// Issue #200: at the default send limit, one page holds MaxVaultPageSize
// vaults with MaxVaultNameBytes names, in binary and JSON, compressed or
// not, so a member of that many shared vaults lists them in one request.
func TestAFullPageOfTheLargestVaultsFitsTheDefaultSendLimit(t *testing.T) {
	vaults := newMemoryVaults()
	fixture := newVaultFixtureWithLimit(t, newMemoryStore(), vaults, reachableDatabase{}, 1<<20)
	full := &fullVaultsFixture{fixture: fixture, token: fixture.token(t, "alice")}
	random := rand.New(rand.NewChaCha8([32]byte{100})) //nolint:gosec // Test data, not secrets.

	largestName := func() string {
		name := make([]byte, api.MaxVaultNameBytes)
		for position := range name {
			name[position] = byte('a' + random.IntN(26))
		}

		return string(name)
	}

	owned := fixture.createVault(t, full.token, largestName())
	aliceID := ownerOf(t, vaults, owned.GetId())
	full.ids = append(full.ids, owned.GetId())

	for range api.MaxVaultPageSize - 1 {
		other, err := vaults.CreateVault(t.Context(), uuid.New(), store.NewVault{Name: largestName(), Encryption: store.EncryptionNone}, 1)
		require.NoError(t, err)
		vaults.addMember(other.ID, aliceID, store.RoleViewer)
		full.ids = append(full.ids, other.ID.String())
	}

	for name, options := range vaultPageCodecs {
		t.Run(name, func(t *testing.T) {
			got, lengths := full.pageVaults(t, options, api.MaxVaultPageSize)
			assert.ElementsMatch(t, full.ids, got)
			assert.Equal(t, []int{api.MaxVaultPageSize}, lengths)
		})
	}
}
