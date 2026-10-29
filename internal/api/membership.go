package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Membership bounds (SPEC.md §9.2).
const (
	// MaxMembersPerVault bounds a vault's members, so ListMembers needs no
	// pagination.
	MaxMembersPerVault = 100
	// MaxPendingInvitationsPerVault bounds a vault's pending invitations.
	MaxPendingInvitationsPerVault = 100
	// DefaultInvitationTTL is how long an invitation stays redeemable when
	// the request names no ttl.
	DefaultInvitationTTL = 7 * 24 * time.Hour
	// MaxInvitationTTL caps an invitation's lifetime.
	MaxInvitationTTL = 30 * 24 * time.Hour
	// inviteCodeBytes is the entropy of an invite code.
	inviteCodeBytes = 32
)

// inviteCodeEncoding encodes invite codes.
var inviteCodeEncoding = base64.RawURLEncoding

// errInvitationNotFound is the single error every failed redemption gets,
// whatever the reason, so it reveals nothing about any vault.
var errInvitationNotFound = errors.New("invitation not found or no longer valid")

// MembershipService implements vaultsync.v1.MembershipService. Every
// procedure but RedeemInvitation is vault-scoped and authorized by the authz
// interceptor before it runs: owners only, except LeaveVault (any member).
type MembershipService struct {
	Store *store.Store
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.MembershipServiceHandler = MembershipService{}

func (service MembershipService) vault(ctx context.Context) (*store.VaultStore, error) {
	membership, ok := authz.MembershipFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "membership procedure reached without an authorized vault")

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	return service.Store.InVault(membership.VaultID), nil
}

func (service MembershipService) internal(ctx context.Context, message string, err error) error {
	service.Logger.ErrorContext(ctx, message, "error", err)

	return connect.NewError(connect.CodeInternal, errors.New(message))
}

// hashInviteCode returns the stored hash of an invite code, or false for a
// code that cannot have been issued. An E2EE vault's code is
// `<id>.<secret>`, of which only <id> is hashed.
func hashInviteCode(code string) ([]byte, bool) {
	if id, secret, found := strings.Cut(code, "."); found {
		if _, ok := decodeInvitationPart(secret); !ok {
			return nil, false
		}

		return hashInvitationID(id)
	}

	if len(code) != inviteCodeEncoding.EncodedLen(inviteCodeBytes) {
		return nil, false
	}

	raw, err := inviteCodeEncoding.DecodeString(code)
	if err != nil || len(raw) != inviteCodeBytes {
		return nil, false
	}

	sum := sha256.Sum256(raw)

	return sum[:], true
}

func invitationMessage(invitation store.Invitation) *vaultsyncv1.Invitation {
	return &vaultsyncv1.Invitation{
		Id:            invitation.ID.String(),
		Role:          roleMessage(invitation.Role),
		CreatorUserId: invitation.CreatedBy.String(),
		CreateTime:    timestamppb.New(invitation.CreatedAt),
		ExpireTime:    timestamppb.New(invitation.ExpiresAt),
	}
}

func memberMessage(member store.Member) *vaultsyncv1.Member {
	return &vaultsyncv1.Member{
		UserId:      member.UserID.String(),
		DisplayName: member.DisplayName,
		Role:        roleMessage(member.Role),
		JoinTime:    timestamppb.New(member.JoinedAt),
		PublicKey:   member.PublicKey,
	}
}

// CreateInvitation creates a single-use invitation and returns its code.
func (service MembershipService) CreateInvitation(ctx context.Context, request *connect.Request[vaultsyncv1.CreateInvitationRequest]) (*connect.Response[vaultsyncv1.CreateInvitationResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	role, ok := roleFromMessage(request.Msg.GetRole())
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role must be VAULT_ROLE_OWNER, VAULT_ROLE_EDITOR or VAULT_ROLE_VIEWER"))
	}

	ttl := DefaultInvitationTTL
	if seconds := request.Msg.GetTtlSeconds(); seconds != 0 {
		ttl = time.Duration(seconds) * time.Second
	}

	if ttl > MaxInvitationTTL {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("ttl_seconds must be at most %d", int64(MaxInvitationTTL/time.Second)))
	}

	keys, err := parseInvitationKeys(request.Msg)
	if err != nil {
		return nil, err
	}

	// An E2EE invitation's code was generated by the inviting device; the
	// server sees only the hash of its <id>.
	var code string

	hash := request.Msg.GetIdHash()

	if keys == nil {
		raw := make([]byte, inviteCodeBytes)
		_, _ = rand.Read(raw) // crypto/rand.Read never fails.

		code = inviteCodeEncoding.EncodeToString(raw)
		sum := sha256.Sum256(raw)
		hash = sum[:]
	}

	// In an E2EE vault the invitation's id is the one its invite entry names.
	invitationID, err := inviteEntryID(request.Msg.GetLogEntry())
	if err != nil {
		return nil, err
	}

	entry, err := logAppend(request.Msg.GetLogEntry(), recordsInvite(invitationID, role))
	if err != nil {
		return nil, err
	}

	invitation, err := vault.CreateInvitation(ctx, user.ID, invitationID, role, hash, ttl, MaxPendingInvitationsPerVault, entry, keys)
	if errors.Is(err, store.ErrInvitationLimit) {
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("a vault may have at most %d pending invitations", MaxPendingInvitationsPerVault))
	}

	if mapped := LogError(err); mapped != nil {
		return nil, mapped
	}

	if mapped := invitationKeyError(err); mapped != nil {
		return nil, mapped
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot create invitation", err)
	}

	return connect.NewResponse(&vaultsyncv1.CreateInvitationResponse{Invitation: invitationMessage(invitation), Code: code}), nil
}

// ListInvitations lists the vault's pending invitations.
func (service MembershipService) ListInvitations(ctx context.Context, _ *connect.Request[vaultsyncv1.ListInvitationsRequest]) (*connect.Response[vaultsyncv1.ListInvitationsResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	invitations, err := vault.ListInvitations(ctx)
	if err != nil {
		return nil, service.internal(ctx, "cannot list invitations", err)
	}

	response := &vaultsyncv1.ListInvitationsResponse{Invitations: make([]*vaultsyncv1.Invitation, 0, len(invitations))}
	for _, invitation := range invitations {
		response.Invitations = append(response.Invitations, invitationMessage(invitation))
	}

	return connect.NewResponse(response), nil
}

// RevokeInvitation revokes a pending invitation.
func (service MembershipService) RevokeInvitation(ctx context.Context, request *connect.Request[vaultsyncv1.RevokeInvitationRequest]) (*connect.Response[vaultsyncv1.RevokeInvitationResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	invitationID, err := authz.ParseID(request.Msg.GetInvitationId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invitation_id: %w", err))
	}

	payload, _ := e2ee.IDPayload(invitationID.String()) // a parsed id is canonical.

	entry, err := logAppend(request.Msg.GetLogEntry(), records(e2ee.EntryRevokeInvitation, payload))
	if err != nil {
		return nil, err
	}

	err = vault.RevokeInvitation(ctx, invitationID, entry)
	if errors.Is(err, store.ErrInvitationNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("invitation not found"))
	}

	if mapped := LogError(err); mapped != nil {
		return nil, mapped
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot revoke invitation", err)
	}

	return connect.NewResponse(&vaultsyncv1.RevokeInvitationResponse{}), nil
}

// RedeemInvitation makes the caller a member of the invitation's vault.
func (service MembershipService) RedeemInvitation(ctx context.Context, request *connect.Request[vaultsyncv1.RedeemInvitationRequest]) (*connect.Response[vaultsyncv1.RedeemInvitationResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	hash, ok := hashInviteCode(request.Msg.GetCode())
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, errInvitationNotFound)
	}

	slots, err := parseInvitationSlots("slots", request.Msg.GetSlots())
	if err != nil {
		return nil, err
	}

	entry, err := logAppend(request.Msg.GetLogEntry(), recordsRedeem(user.ID))
	if err != nil {
		return nil, err
	}

	vault, err := service.Store.RedeemInvitation(ctx, user.ID, hash, MaxMembersPerVault, entry, slots)
	if mapped := LogError(err); mapped != nil {
		return nil, mapped
	}

	if mapped := invitationKeyError(err); mapped != nil {
		return nil, mapped
	}

	switch {
	case errors.Is(err, store.ErrInvitationNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errInvitationNotFound)
	case errors.Is(err, store.ErrAlreadyMember):
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("already a member of this vault"))
	case errors.Is(err, store.ErrMemberLimit):
		return nil, connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("a vault may have at most %d members", MaxMembersPerVault))
	case err != nil:
		return nil, service.internal(ctx, "cannot redeem invitation", err)
	}

	return connect.NewResponse(&vaultsyncv1.RedeemInvitationResponse{Vault: vaultMessage(vault)}), nil
}

// ListMembers lists the vault's members.
func (service MembershipService) ListMembers(ctx context.Context, _ *connect.Request[vaultsyncv1.ListMembersRequest]) (*connect.Response[vaultsyncv1.ListMembersResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	members, err := vault.ListMembers(ctx)
	if err != nil {
		return nil, service.internal(ctx, "cannot list members", err)
	}

	response := &vaultsyncv1.ListMembersResponse{Members: make([]*vaultsyncv1.Member, 0, len(members))}
	for _, member := range members {
		response.Members = append(response.Members, memberMessage(member))
	}

	return connect.NewResponse(response), nil
}

// memberChangeError maps the store errors of a membership change.
func (service MembershipService) memberChangeError(ctx context.Context, message string, err error) error {
	switch {
	case errors.Is(err, store.ErrMemberNotFound):
		return connect.NewError(connect.CodeNotFound, errors.New("member not found"))
	case errors.Is(err, store.ErrLastOwner):
		return connect.NewError(connect.CodeFailedPrecondition, store.ErrLastOwner)
	default:
		if mapped := LogError(err); mapped != nil {
			return mapped
		}

		if mapped := KeyError(err); mapped != nil {
			return mapped
		}

		return service.internal(ctx, message, err)
	}
}

// UpdateMemberRole changes a member's role.
func (service MembershipService) UpdateMemberRole(ctx context.Context, request *connect.Request[vaultsyncv1.UpdateMemberRoleRequest]) (*connect.Response[vaultsyncv1.UpdateMemberRoleResponse], error) {
	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	userID, err := authz.ParseID(request.Msg.GetUserId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("user_id: %w", err))
	}

	role, ok := roleFromMessage(request.Msg.GetRole())
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("role must be VAULT_ROLE_OWNER, VAULT_ROLE_EDITOR or VAULT_ROLE_VIEWER"))
	}

	payload, _ := e2ee.SetRolePayload(userID.String(), logRole(role)) // a parsed id and a known role.

	entry, err := logAppend(request.Msg.GetLogEntry(), records(e2ee.EntrySetRole, payload))
	if err != nil {
		return nil, err
	}

	member, err := vault.UpdateMemberRole(ctx, userID, role, entry)
	if err != nil {
		return nil, service.memberChangeError(ctx, "cannot update member role", err)
	}

	return connect.NewResponse(&vaultsyncv1.UpdateMemberRoleResponse{Member: memberMessage(member)}), nil
}

// RemoveMember removes a member from the vault and, in an E2EE vault,
// creates the next epoch with it.
func (service MembershipService) RemoveMember(ctx context.Context, request *connect.Request[vaultsyncv1.RemoveMemberRequest]) (*connect.Response[vaultsyncv1.RemoveMemberResponse], error) {
	owner, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	userID, err := authz.ParseID(request.Msg.GetUserId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("user_id: %w", err))
	}

	// Bounded before the database is touched; whether the vault needs one
	// is the store's to decide, under the vault row lock.
	var next *store.NextEpoch

	if request.Msg.GetNextEpoch() != nil {
		parsed, err := ParseNextEpoch(request.Msg.GetNextEpoch())
		if err != nil {
			return nil, err
		}

		next = &parsed
	}

	payload, _ := e2ee.IDPayload(userID.String()) // a parsed id is canonical.

	entry, err := logAppend(request.Msg.GetLogEntry(), records(e2ee.EntryRemoveMember, payload))
	if err != nil {
		return nil, err
	}

	if err := vault.RemoveMember(ctx, owner.ID, userID, next, entry); err != nil {
		return nil, service.memberChangeError(ctx, "cannot remove member", err)
	}

	return connect.NewResponse(&vaultsyncv1.RemoveMemberResponse{}), nil
}

// LeaveVault removes the caller from the vault.
func (service MembershipService) LeaveVault(ctx context.Context, request *connect.Request[vaultsyncv1.LeaveVaultRequest]) (*connect.Response[vaultsyncv1.LeaveVaultResponse], error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	vault, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	payload, _ := e2ee.IDPayload(user.ID.String()) // a user id is canonical.

	entry, err := logAppend(request.Msg.GetLogEntry(), records(e2ee.EntryLeave, payload))
	if err != nil {
		return nil, err
	}

	if err := vault.LeaveVault(ctx, user.ID, entry); err != nil {
		return nil, service.memberChangeError(ctx, "cannot leave vault", err)
	}

	return connect.NewResponse(&vaultsyncv1.LeaveVaultResponse{}), nil
}
