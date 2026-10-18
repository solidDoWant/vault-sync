package api_test

import (
	"bytes"
	"context"
	"log/slog"
	"slices"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// listedVaults serves ListVaults from a fixed set of vaults, ordered by id.
type listedVaults struct {
	vaults []store.Vault
}

func (listed *listedVaults) CreateVault(context.Context, uuid.UUID, store.NewVault, int) (store.Vault, error) {
	return store.Vault{}, nil
}

func (listed *listedVaults) ListVaults(_ context.Context, _, after uuid.UUID, limit int) ([]store.Vault, error) {
	var page []store.Vault

	for _, vault := range listed.vaults {
		if bytes.Compare(vault.ID[:], after[:]) > 0 && len(page) < limit {
			page = append(page, vault)
		}
	}

	return page, nil
}

// Issue #136: a ListVaults page holds at least one vault when one remains,
// even when that vault alone exceeds the response budget, so a client
// always makes progress; and paging still returns every vault once.
func TestVaultPagesAlwaysMakeProgress(t *testing.T) {
	listed := &listedVaults{}
	for index := range 5 {
		listed.vaults = append(listed.vaults, store.Vault{ID: uuid.Must(uuid.NewV7()), Name: string(rune('a' + index)), Role: store.RoleOwner})
	}

	slices.SortFunc(listed.vaults, func(left, right store.Vault) int { return bytes.Compare(left.ID[:], right.ID[:]) })

	var want []string
	for _, vault := range listed.vaults {
		want = append(want, vault.ID.String())
	}

	ctx := auth.WithUser(t.Context(), auth.User{ID: uuid.New(), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}})

	tests := []struct {
		name        string
		limit       int
		contentType string
		want        []int
	}{
		// A one-byte budget fits no vault at all.
		{name: "binary, one byte", limit: 1, contentType: "application/proto", want: []int{1, 1, 1, 1, 1}},
		{name: "JSON, one byte", limit: 1, contentType: "application/json", want: []int{1, 1, 1, 1, 1}},
		{name: "unbounded", limit: 0, contentType: "application/proto", want: []int{5}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := api.VaultService{Vaults: listed, Limits: api.VaultLimits{MaxResponseBytes: test.limit}, Logger: slog.New(slog.DiscardHandler)}

			var (
				got       []string
				lengths   []int
				pageToken string
			)

			for range len(listed.vaults) + 1 {
				request := connect.NewRequest(&vaultsyncv1.ListVaultsRequest{PageToken: pageToken})
				request.Header().Set("Content-Type", test.contentType)

				response, err := service.ListVaults(ctx, request)
				require.NoError(t, err)

				for _, vault := range response.Msg.GetVaults() {
					got = append(got, vault.GetId())
				}

				lengths = append(lengths, len(response.Msg.GetVaults()))

				pageToken = response.Msg.GetNextPageToken()
				if pageToken == "" {
					break
				}
			}

			assert.Empty(t, pageToken, "paging did not end")
			assert.Equal(t, want, got)
			assert.Equal(t, test.want, lengths)
		})
	}
}
