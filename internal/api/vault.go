package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Vault bounds.
const (
	// MaxVaultNameBytes bounds a vault name (UTF-8 bytes).
	MaxVaultNameBytes = 256
	// MaxOwnedVaultsPerUser bounds how many vaults one user may own.
	MaxOwnedVaultsPerUser = 100
	// DefaultVaultPageSize is the ListVaults page size when none is given.
	DefaultVaultPageSize = 100
	// MaxVaultPageSize caps the ListVaults page size.
	MaxVaultPageSize = 1000
)

// pageTokenEncoding encodes ListVaults page tokens: the id of the last vault
// on the previous page.
var pageTokenEncoding = base64.RawURLEncoding

// VaultStore persists vaults. *store.Store implements it.
type VaultStore interface {
	CreateVault(ctx context.Context, ownerID uuid.UUID, vault store.NewVault, limit int) (store.Vault, error)
	ListVaults(ctx context.Context, userID, after uuid.UUID, limit int) ([]store.Vault, error)
}

// VaultService implements vaultsync.v1.VaultService for the authenticated
// caller. Its procedures are not vault-scoped: CreateVault makes the caller
// the new vault's owner, and ListVaults only returns the caller's vaults.
type VaultService struct {
	Vaults VaultStore
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.VaultServiceHandler = VaultService{}

// CreateVault creates a vault owned by the caller.
func (service VaultService) CreateVault(ctx context.Context, request *connect.Request[vaultsyncv1.CreateVaultRequest]) (*connect.Response[vaultsyncv1.CreateVaultResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	name := request.Msg.GetName()
	if strings.TrimSpace(name) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must not be empty"))
	}

	if len(name) > MaxVaultNameBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("name must be at most %d bytes", MaxVaultNameBytes))
	}

	var encryption store.Encryption

	switch request.Msg.GetEncryption() {
	case vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE:
		encryption = store.EncryptionNone
	case vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE:
		encryption = store.EncryptionE2EE
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("encryption must be VAULT_ENCRYPTION_NONE or VAULT_ENCRYPTION_E2EE"))
	}

	if request.Msg.GetEscrow() && encryption != store.EncryptionE2EE {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("escrow requires VAULT_ENCRYPTION_E2EE"))
	}

	vault, err := service.Vaults.CreateVault(ctx, user.ID, store.NewVault{
		Name:       name,
		Encryption: encryption,
		Escrow:     request.Msg.GetEscrow(),
	}, MaxOwnedVaultsPerUser)
	if err != nil {
		if errors.Is(err, store.ErrVaultLimit) {
			return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("at most %d vaults may be owned by one user", MaxOwnedVaultsPerUser))
		}

		service.Logger.ErrorContext(ctx, "cannot create vault", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot create vault"))
	}

	return connect.NewResponse(&vaultsyncv1.CreateVaultResponse{Vault: vaultMessage(vault)}), nil
}

// ListVaults lists the caller's vaults.
func (service VaultService) ListVaults(ctx context.Context, request *connect.Request[vaultsyncv1.ListVaultsRequest]) (*connect.Response[vaultsyncv1.ListVaultsResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	pageSize := int(request.Msg.GetPageSize())
	if pageSize == 0 {
		pageSize = DefaultVaultPageSize
	}

	pageSize = min(pageSize, MaxVaultPageSize)

	after, err := decodePageToken(request.Msg.GetPageToken())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	// One extra row tells whether another page exists.
	vaults, err := service.Vaults.ListVaults(ctx, user.ID, after, pageSize+1)
	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot list vaults", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot list vaults"))
	}

	response := &vaultsyncv1.ListVaultsResponse{}

	if len(vaults) > pageSize {
		vaults = vaults[:pageSize]
		response.NextPageToken = pageTokenEncoding.EncodeToString(vaults[pageSize-1].ID[:])
	}

	for _, vault := range vaults {
		response.Vaults = append(response.Vaults, vaultMessage(vault))
	}

	return connect.NewResponse(response), nil
}

func decodePageToken(token string) (uuid.UUID, error) {
	if token == "" {
		return uuid.Nil, nil
	}

	invalid := errors.New("page_token is not a token returned by ListVaults")

	if len(token) > pageTokenEncoding.EncodedLen(len(uuid.UUID{})) {
		return uuid.Nil, invalid
	}

	decoded, err := pageTokenEncoding.DecodeString(token)
	if err != nil {
		return uuid.Nil, invalid
	}

	after, err := uuid.FromBytes(decoded)
	if err != nil {
		return uuid.Nil, invalid
	}

	return after, nil
}

func vaultMessage(vault store.Vault) *vaultsyncv1.Vault {
	message := &vaultsyncv1.Vault{
		Id:         vault.ID.String(),
		Name:       vault.Name,
		Escrow:     vault.Escrow,
		HeadSeq:    uint64(max(vault.HeadSeq, 0)),
		CreateTime: timestamppb.New(vault.CreatedAt),
	}

	switch vault.Encryption {
	case store.EncryptionNone:
		message.Encryption = vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_NONE
	case store.EncryptionE2EE:
		message.Encryption = vaultsyncv1.VaultEncryption_VAULT_ENCRYPTION_E2EE
	}

	switch vault.Role {
	case store.RoleOwner:
		message.Role = vaultsyncv1.VaultRole_VAULT_ROLE_OWNER
	case store.RoleEditor:
		message.Role = vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR
	case store.RoleViewer:
		message.Role = vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER
	}

	return message
}
