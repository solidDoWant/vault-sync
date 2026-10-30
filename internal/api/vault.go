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
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/textcheck"
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
	DeleteVault(ctx context.Context, vaultID uuid.UUID) error
}

// VaultLimits bounds ListVaults responses.
type VaultLimits struct {
	// MaxResponseBytes bounds the encoded size of a ListVaults response
	// (see pageBudget). The server sets it to its send limit; tests lower
	// it. Zero leaves pages bounded by entry count only.
	MaxResponseBytes int
}

// VaultService implements vaultsync.v1.VaultService for the authenticated
// caller. CreateVault and ListVaults are not vault-scoped: CreateVault makes
// the caller the new vault's owner, and ListVaults only returns the caller's
// vaults. DeleteVault is vault-scoped and authorized (owners only) by the
// authz interceptor before it runs.
type VaultService struct {
	Vaults VaultStore
	Limits VaultLimits
	// Escrow is the deployment's escrow key; escrow vaults need one.
	Escrow Escrow
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

	if !textcheck.DisplayName(name) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be valid UTF-8 without control, format or line separator characters"))
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

	// Clients wrap every epoch key of an escrow vault to the escrow key,
	// which a deployment without one cannot offer.
	if request.Msg.GetEscrow() && !service.Escrow.Configured() {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("this server has no escrow key"))
	}

	// The genesis entry of an E2EE vault is signed over the vault id, so the
	// creator's device chooses it; the server chooses a plaintext vault's.
	var (
		vaultID uuid.UUID
		genesis *store.LogEntry
		err     error
	)

	switch {
	case encryption == store.EncryptionE2EE:
		vaultID, genesis, err = verifyGenesis(request.Msg.GetNewVaultId(), request.Msg.GetGenesis(), user.ID, request.Msg.GetEscrow(), service.Escrow)
		if err != nil {
			return nil, err
		}
	case request.Msg.GetNewVaultId() != "" || request.Msg.GetGenesis() != nil:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_vault_id and genesis are only for VAULT_ENCRYPTION_E2EE"))
	}

	vault, err := service.Vaults.CreateVault(ctx, user.ID, store.NewVault{
		ID:         vaultID,
		Name:       name,
		Encryption: encryption,
		Escrow:     request.Msg.GetEscrow(),
		Genesis:    genesis,
	}, MaxOwnedVaultsPerUser)
	if err != nil {
		if errors.Is(err, store.ErrVaultExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a vault with this new_vault_id exists"))
		}

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
	hasMore := len(vaults) > pageSize
	vaults = vaults[:min(len(vaults), pageSize)]

	// The page also ends where its encoding would exceed the response
	// limit; the token continues after the last vault returned.
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for _, vault := range vaults {
		message := vaultMessage(vault)
		if !budget.admit(message) {
			hasMore = true

			break
		}

		response.Vaults = append(response.Vaults, message)
	}

	if hasMore && len(response.Vaults) > 0 {
		last := vaults[len(response.Vaults)-1].ID
		response.NextPageToken = pageTokenEncoding.EncodeToString(last[:])
	}

	return connect.NewResponse(response), nil
}

// DeleteVault marks the authorized vault deleted.
func (service VaultService) DeleteVault(ctx context.Context, _ *connect.Request[vaultsyncv1.DeleteVaultRequest]) (*connect.Response[vaultsyncv1.DeleteVaultResponse], error) {
	membership, ok := authz.MembershipFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "DeleteVault reached without an authorized vault")

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	err := service.Vaults.DeleteVault(ctx, membership.VaultID)

	switch {
	case errors.Is(err, store.ErrVaultDeleted):
		// Deleted concurrently, after the authorization.
		return nil, authz.VaultDeletedError()
	case errors.Is(err, store.ErrVaultNotFound):
		return nil, connect.NewError(connect.CodeNotFound, authz.ErrVaultNotFound)
	case err != nil:
		service.Logger.ErrorContext(ctx, "cannot delete vault", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot delete vault"))
	}

	return connect.NewResponse(&vaultsyncv1.DeleteVaultResponse{}), nil
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

	message.Role = roleMessage(vault.Role)

	return message
}

// roleMessage converts a stored role to its API enum.
func roleMessage(role store.Role) vaultsyncv1.VaultRole {
	switch role {
	case store.RoleOwner:
		return vaultsyncv1.VaultRole_VAULT_ROLE_OWNER
	case store.RoleEditor:
		return vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR
	case store.RoleViewer:
		return vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER
	default:
		return vaultsyncv1.VaultRole_VAULT_ROLE_UNSPECIFIED
	}
}

// roleFromMessage converts an API role to a stored role; ok is false for an
// unspecified or unknown role.
func roleFromMessage(role vaultsyncv1.VaultRole) (store.Role, bool) {
	switch role {
	case vaultsyncv1.VaultRole_VAULT_ROLE_OWNER:
		return store.RoleOwner, true
	case vaultsyncv1.VaultRole_VAULT_ROLE_EDITOR:
		return store.RoleEditor, true
	case vaultsyncv1.VaultRole_VAULT_ROLE_VIEWER:
		return store.RoleViewer, true
	default:
		return "", false
	}
}
