package api

import (
	"context"
	"crypto/sha256"
	"errors"

	"connectrpc.com/connect"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Invitations to E2EE vaults carry key slots (docs/design/encryption.md,
// "Invitations"; docs/design/crypto.md, "Invitation keys").

const (
	// invitationPartBytes is the size of each part of an E2EE invite code,
	// `<id>.<secret>`: 128 random bits, base64url without padding.
	invitationPartBytes = 16
	// InviteAnchorBytes is the size of an invite anchor: genesis hash,
	// inviter fingerprint and HMAC-SHA256.
	InviteAnchorBytes = 96
	// MaxInvitationSlots bounds the slots an invitation or a redemption
	// carries, one per epoch.
	MaxInvitationSlots = MaxAddKeySlots
)

// decodeInvitationPart decodes one part of an E2EE invite code.
func decodeInvitationPart(part string) ([]byte, bool) {
	if len(part) != inviteCodeEncoding.EncodedLen(invitationPartBytes) {
		return nil, false
	}

	raw, err := inviteCodeEncoding.DecodeString(part)
	if err != nil || len(raw) != invitationPartBytes {
		return nil, false
	}

	return raw, true
}

// parseInvitationSlots bounds and parses an invitation's or a redemption's
// key slots, each naming its epoch; whom they are for is the store's to
// check. Neither ever holds an escrow slot, so no escrow key id is
// accepted.
func parseInvitationSlots(field string, messages []*vaultsyncv1.KeySlot) ([]store.KeySlot, error) {
	if len(messages) > MaxInvitationSlots {
		return nil, invalidArgument("%s must hold at most %d slots", field, MaxInvitationSlots)
	}

	return parseKeySlots(field, messages, true, Escrow{})
}

// parseInvitationKeys returns the key slots and invite anchor of an E2EE
// CreateInvitation, or nil when the request carries none of id_hash, slots
// and invite_anchor (a plaintext vault's invitation).
func parseInvitationKeys(request *vaultsyncv1.CreateInvitationRequest) (*store.InvitationKeys, error) {
	if len(request.GetIdHash()) == 0 && len(request.GetSlots()) == 0 && len(request.GetInviteAnchor()) == 0 {
		return nil, nil //nolint:nilnil // no keys is a plaintext invitation.
	}

	if len(request.GetIdHash()) != sha256.Size {
		return nil, invalidArgument("id_hash must be exactly %d bytes", sha256.Size)
	}

	if len(request.GetInviteAnchor()) != InviteAnchorBytes {
		return nil, invalidArgument("invite_anchor must be exactly %d bytes", InviteAnchorBytes)
	}

	slots, err := parseInvitationSlots("slots", request.GetSlots())
	if err != nil {
		return nil, err
	}

	return &store.InvitationKeys{Slots: slots, Anchor: request.GetInviteAnchor()}, nil
}

// invitationKeyError maps the store errors of an invitation's or a
// redemption's key slots, or returns nil for any other error.
func invitationKeyError(err error) error {
	switch {
	case errors.Is(err, store.ErrInvitationKeysRequired),
		errors.Is(err, store.ErrUnexpectedInvitationKeys),
		errors.Is(err, store.ErrNoUserKey):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, store.ErrInvitationIDTaken):
		return connect.NewError(connect.CodeAlreadyExists, store.ErrInvitationIDTaken)
	default:
		return KeyError(err)
	}
}

// GetInvitationSlots returns a pending E2EE invitation's key slots to the
// holder of its code's <id>.
func (service MembershipService) GetInvitationSlots(ctx context.Context, request *connect.Request[vaultsyncv1.GetInvitationSlotsRequest]) (*connect.Response[vaultsyncv1.GetInvitationSlotsResponse], error) {
	if _, ok := auth.UserFromContext(ctx); !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	hash, ok := authz.HashInvitationID(request.Msg.GetId())
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, errInvitationNotFound)
	}

	found, err := service.Store.GetInvitationSlots(ctx, hash)
	if errors.Is(err, store.ErrInvitationNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errInvitationNotFound)
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot read invitation", err)
	}

	response := &vaultsyncv1.GetInvitationSlotsResponse{
		InvitationId: found.Invitation.ID.String(),
		VaultId:      found.Invitation.VaultID.String(),
		Role:         roleMessage(found.Invitation.Role),
		Slots:        make([]*vaultsyncv1.KeySlot, 0, len(found.Slots)),
		Epochs:       make([]*vaultsyncv1.KeyEpoch, 0, len(found.Epochs)),
		InviteAnchor: found.Anchor,
	}

	for _, slot := range found.Slots {
		response.Slots = append(response.Slots, keySlotMessage(slot))
	}

	for _, epoch := range found.Epochs {
		response.Epochs = append(response.Epochs, epochMessage(epoch))
	}

	return connect.NewResponse(response), nil
}
