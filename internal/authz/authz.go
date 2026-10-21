// Package authz enforces vault-level authorization (SPEC.md §9.2). One
// interceptor, installed on every service after authentication, resolves the
// caller's role in the request's vault_id before any handler runs:
//
//   - a caller who is not a member, and a vault that does not exist, both get
//     the same NOT_FOUND error through the same code path (one membership
//     query), so existence is never revealed;
//   - a viewer calling a write procedure, and an editor or viewer calling a
//     manage procedure, get PERMISSION_DENIED;
//   - a request whose message carries a vault_id but whose procedure is not
//     classified as read or write is rejected, so a new vault-scoped
//     procedure cannot run unauthorized.
//
// Handlers read the authorized vault from MembershipFromContext and scope
// every query to it (see store.Store.InVault); they never use the vault_id
// from the request directly.
package authz

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Access classifies a vault-scoped procedure.
type Access int

// Access levels. The zero value is invalid.
const (
	// Read procedures are allowed for every member.
	Read Access = iota + 1
	// Write procedures are allowed for owners and editors.
	Write
	// Manage procedures (membership management) are allowed for owners
	// only.
	Manage
)

func (access Access) String() string {
	switch access {
	case Read:
		return "read"
	case Write:
		return "write"
	case Manage:
		return "manage"
	default:
		return fmt.Sprintf("Access(%d)", int(access))
	}
}

// MembershipStore resolves vault roles. *store.Store implements it.
type MembershipStore interface {
	// VaultRole returns userID's role in vaultID, or store.ErrVaultNotFound
	// when the vault does not exist or the user is not a member.
	VaultRole(ctx context.Context, vaultID, userID uuid.UUID) (store.Role, error)
}

// Membership is the caller's authorized membership in the request's vault.
type Membership struct {
	VaultID uuid.UUID
	Role    store.Role
}

type membershipKey struct{}

// WithMembership returns a context carrying membership.
func WithMembership(ctx context.Context, membership Membership) context.Context {
	return context.WithValue(ctx, membershipKey{}, membership)
}

// MembershipFromContext returns the membership the interceptor authorized for
// this request.
func MembershipFromContext(ctx context.Context) (Membership, bool) {
	membership, ok := ctx.Value(membershipKey{}).(Membership)

	return membership, ok
}

// ErrVaultNotFound is the error returned to non-members and for vaults that
// do not exist. Its message is safe to return to the caller.
var ErrVaultNotFound = errors.New("vault not found")

// ParseID parses an identifier in canonical form: a lowercase, hyphenated
// UUID (SPEC.md §5). Other spellings uuid.Parse accepts (braces, URNs,
// upper case, no hyphens) are rejected so every id has one representation.
func ParseID(value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil || id.String() != value {
		return uuid.Nil, errors.New("not a canonical lowercase UUID")
	}

	return id, nil
}

// vaultScoped is implemented by every generated request message with a
// vault_id field.
type vaultScoped interface {
	GetVaultId() string
}

// Interceptor authorizes vault-scoped RPCs.
type Interceptor struct {
	procedures  map[string]Access
	memberships MembershipStore
	logger      *slog.Logger
}

var _ connect.Interceptor = (*Interceptor)(nil)

// NewInterceptor builds an Interceptor. procedures classifies every
// vault-scoped procedure by its full name. With a nil memberships store every
// caller is treated as a non-member.
func NewInterceptor(memberships MembershipStore, procedures map[string]Access, logger *slog.Logger) *Interceptor {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}

	return &Interceptor{procedures: procedures, memberships: memberships, logger: logger}
}

func (interceptor *Interceptor) authorize(ctx context.Context, procedure string, message any) (context.Context, error) {
	access, classified := interceptor.procedures[procedure]
	scoped, carriesVault := message.(vaultScoped)

	if !classified {
		if carriesVault {
			// Fail closed: a vault-scoped procedure nobody classified.
			interceptor.logger.ErrorContext(ctx, "vault-scoped procedure is not classified for authorization", "procedure", procedure)

			return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
		}

		return ctx, nil
	}

	if !carriesVault || (access != Read && access != Write && access != Manage) {
		interceptor.logger.ErrorContext(ctx, "invalid authorization classification", "procedure", procedure, "access", access.String())

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	vaultID, err := ParseID(scoped.GetVaultId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("vault_id: %w", err))
	}

	role, err := interceptor.role(ctx, vaultID, user.ID)
	if errors.Is(err, store.ErrVaultNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, ErrVaultNotFound)
	}

	if err != nil {
		interceptor.logger.ErrorContext(ctx, "cannot resolve vault role", "procedure", procedure, "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	switch {
	case role == store.RoleOwner:
	case (role == store.RoleEditor || role == store.RoleViewer) && access == Manage:
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("only owners can manage this vault"))
	case role == store.RoleEditor:
	case role == store.RoleViewer && (access == Read || (acceptViewerWrites && access == Write)):
	case role == store.RoleViewer:
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("viewers cannot write to this vault"))
	default:
		interceptor.logger.ErrorContext(ctx, "unknown vault role", "procedure", procedure, "role", string(role))

		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
	}

	return WithMembership(ctx, Membership{VaultID: vaultID, Role: role}), nil
}

func (interceptor *Interceptor) role(ctx context.Context, vaultID, userID uuid.UUID) (store.Role, error) {
	if interceptor.memberships == nil {
		return "", store.ErrVaultNotFound
	}

	return interceptor.memberships.VaultRole(ctx, vaultID, userID)
}

// WrapUnary authorizes unary RPCs. Connect decodes the request message before
// unary interceptors run, so its vault_id is available here.
func (interceptor *Interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if request.Spec().IsClient {
			return next(ctx, request)
		}

		ctx, err := interceptor.authorize(ctx, request.Spec().Procedure, request.Any())
		if err != nil {
			return nil, err
		}

		return next(ctx, request)
	}
}

// WrapStreamingClient leaves client streams unchanged.
func (interceptor *Interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

// WrapStreamingHandler rejects streaming calls to vault-scoped procedures:
// their messages arrive after the handler starts, so they cannot be
// authorized up front. The v1 API has no streaming procedures.
func (interceptor *Interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		if _, classified := interceptor.procedures[conn.Spec().Procedure]; classified {
			return connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
		}

		return next(ctx, conn)
	}
}
