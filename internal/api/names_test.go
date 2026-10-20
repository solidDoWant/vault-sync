package api_test

import (
	"context"
	"log/slog"
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

// recordingStore counts writes; the name checks must reject before any.
type recordingStore struct {
	writes int
}

func (recorder *recordingStore) CreateVault(_ context.Context, ownerID uuid.UUID, vault store.NewVault, _ int) (store.Vault, error) {
	recorder.writes++

	return store.Vault{ID: uuid.New(), Name: vault.Name, Encryption: vault.Encryption}, nil
}

func (recorder *recordingStore) ListVaults(context.Context, uuid.UUID, uuid.UUID, int) ([]store.Vault, error) {
	return nil, nil
}

func (recorder *recordingStore) RegisterDevice(_ context.Context, userID uuid.UUID, name string, publicKey []byte, _ int) (store.Device, error) {
	recorder.writes++

	return store.Device{ID: uuid.New(), UserID: userID, Name: name, PublicKey: publicKey}, nil
}

func (recorder *recordingStore) ListDevices(context.Context, uuid.UUID) ([]store.Device, error) {
	return nil, nil
}

func (recorder *recordingStore) RemoveDevice(context.Context, uuid.UUID, uuid.UUID) error {
	recorder.writes++

	return nil
}

// TestDisplayNamesRejectInvisibleCharactersAndInvalidUTF8 calls the handlers
// directly: the generated protobuf client refuses to marshal invalid UTF-8,
// so this is the only way to hand the handlers such a name. Format
// characters (bidi controls, zero-width characters) would let a name reorder
// or hide parts of the label other members see (#548).
func TestDisplayNamesRejectInvisibleCharactersAndInvalidUTF8(t *testing.T) {
	ctx := auth.WithUser(t.Context(), auth.User{ID: uuid.New(), Identity: auth.Identity{Issuer: "https://issuer.example", Subject: "alice"}})

	rpcs := map[string]func(*recordingStore, string) error{
		"CreateVault": func(recorder *recordingStore, name string) error {
			service := api.VaultService{Vaults: recorder, Logger: slog.New(slog.DiscardHandler)}
			_, err := service.CreateVault(ctx, connect.NewRequest(&vaultsyncv1.CreateVaultRequest{
				Name:       name,
				Encryption: vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE,
			}))

			return err
		},
		"RegisterDevice": func(recorder *recordingStore, name string) error {
			service := api.DeviceService{Devices: recorder, Logger: slog.New(slog.DiscardHandler)}
			_, err := service.RegisterDevice(ctx, connect.NewRequest(&vaultsyncv1.RegisterDeviceRequest{Name: name}))

			return err
		},
	}

	tests := []struct {
		name     string
		value    string
		wantCode connect.Code
	}{
		{name: "plain", value: "Notes"},
		{name: "multi-byte", value: "Zoë's 日本 notes 😀"},
		{name: "NUL", value: "No\x00tes", wantCode: connect.CodeInvalidArgument},
		{name: "escape", value: "Notes\x1b[2J", wantCode: connect.CodeInvalidArgument},
		{name: "C1 next line", value: "Notes\u0085", wantCode: connect.CodeInvalidArgument},
		{name: "invalid UTF-8", value: "Notes\xff", wantCode: connect.CodeInvalidArgument},
		{name: "truncated UTF-8", value: "Note\xc3", wantCode: connect.CodeInvalidArgument},
		{name: "quotes", value: "Fred’s “work” \"laptop\""},
		{name: "right-to-left override", value: "Notes\u202eecived siht", wantCode: connect.CodeInvalidArgument},
		{name: "first isolate", value: "\u2066Notes", wantCode: connect.CodeInvalidArgument},
		{name: "last isolate", value: "Notes\u2069", wantCode: connect.CodeInvalidArgument},
		{name: "zero-width space", value: "No\u200btes", wantCode: connect.CodeInvalidArgument},
		{name: "line separator", value: "No\u2028tes", wantCode: connect.CodeInvalidArgument},
	}

	for rpc, call := range rpcs {
		for _, test := range tests {
			t.Run(rpc+"/"+test.name, func(t *testing.T) {
				recorder := &recordingStore{}

				err := call(recorder, test.value)
				if test.wantCode == 0 {
					require.NoError(t, err)
					assert.Equal(t, 1, recorder.writes)

					return
				}

				require.Error(t, err)
				assert.Equal(t, test.wantCode, connect.CodeOf(err))
				assert.Zero(t, recorder.writes, "nothing is written for a rejected name")
			})
		}
	}
}
