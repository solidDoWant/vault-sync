package api

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/authz"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Vault key bounds (SPEC.md §9.3).
const (
	// KeyCommitmentBytes is the size of an epoch's key commitment
	// (HMAC-SHA256).
	KeyCommitmentBytes = 32
	// MaxWrappedKeyBytes bounds a key slot's wrapped key: an age file to a
	// hybrid recipient, about 1750 bytes for a user slot.
	MaxWrappedKeyBytes = e2ee.MaxSealedSize
	// MaxEscrowRecipientIDBytes bounds an escrow slot's recipient id, as
	// the key-slot format does (docs/design/crypto.md).
	MaxEscrowRecipientIDBytes = 255
	// MaxNextEpochSlots bounds the slots of a new epoch: one per member,
	// one per pending invitation and one escrow slot.
	MaxNextEpochSlots = MaxMembersPerVault + MaxPendingInvitationsPerVault + 1
	// MaxAddKeySlots bounds the slots of one AddKeySlots call.
	MaxAddKeySlots = 1000
	// DefaultKeyPageSize is the page size of the VaultKeyService lists when
	// none is given.
	DefaultKeyPageSize = 100
	// MaxKeyPageSize caps the page size of the VaultKeyService lists.
	MaxKeyPageSize = 1000
)

// keyTokenEncoding encodes VaultKeyService page tokens: the last epoch on
// the previous page (4 bytes, big-endian), followed for ListMissingSlots by
// the last user id (16 bytes).
var keyTokenEncoding = base64.RawURLEncoding

// VaultKeyLimits bounds VaultKeyService responses.
type VaultKeyLimits struct {
	// MaxResponseBytes bounds the encoded size of a list response (see
	// pageBudget). The server sets it to its send limit. Zero leaves pages
	// bounded by entry count only.
	MaxResponseBytes int
}

// VaultKeyStore stores one vault's key epochs and slots.
// *store.VaultStore implements it.
type VaultKeyStore interface {
	KeyState(ctx context.Context) (store.KeyState, error)
	ListEpochs(ctx context.Context, after int32, limit int) ([]store.Epoch, error)
	ListKeySlots(ctx context.Context, kind store.RecipientKind, recipientID string, after int32, limit int) ([]store.KeySlot, error)
	ListEscrowSlots(ctx context.Context, after int32, limit int) ([]store.KeySlot, error)
	ListMissingSlots(ctx context.Context, afterEpoch int32, afterUser uuid.UUID, limit int) ([]store.MissingSlot, error)
	RotateEpoch(ctx context.Context, creatorID uuid.UUID, next store.NextEpoch) (store.Epoch, error)
	AddKeySlots(ctx context.Context, creatorID uuid.UUID, slots []store.KeySlot) (int, error)
	ListLogEntries(ctx context.Context, after int64, limit int) ([]store.LogEntry, error)
	ListStaleRevisions(ctx context.Context, after int64, limit int) (store.StaleRevisions, error)
	ReplaceRevisionCiphertext(ctx context.Context, replacement store.RevisionCiphertext) (bool, error)
	RetireEpoch(ctx context.Context, epoch int32) error
	ConvertVault(ctx context.Context, creatorID uuid.UUID, conversion store.Conversion) (store.Epoch, int64, error)
}

// KeysOf returns the VaultKeyService.Keys of a store.
func KeysOf(queries *store.Store) func(vaultID uuid.UUID) VaultKeyStore {
	return func(vaultID uuid.UUID) VaultKeyStore { return queries.InVault(vaultID) }
}

// VaultKeyService implements vaultsync.v1.VaultKeyService. Every procedure
// is vault-scoped and authorized by the authz interceptor before it runs:
// ListKeySlots, ListEpochs and ListLogEntries for every member, the others
// for owners only.
type VaultKeyService struct {
	// Keys returns the key store of the vault the interceptor authorized
	// (KeysOf).
	Keys   func(vaultID uuid.UUID) VaultKeyStore
	Limits VaultKeyLimits
	// Escrow is the deployment's escrow key, which every escrow slot must
	// name (Escrow.AcceptsSlot).
	Escrow Escrow
	// Logger receives internal errors, which are not returned to callers.
	Logger *slog.Logger
}

var _ vaultsyncv1connect.VaultKeyServiceHandler = VaultKeyService{}

func (service VaultKeyService) vault(ctx context.Context) (VaultKeyStore, auth.User, error) {
	user, ok := auth.UserFromContext(ctx)
	if !ok {
		return nil, auth.User{}, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}

	membership, ok := authz.MembershipFromContext(ctx)
	if !ok {
		service.Logger.ErrorContext(ctx, "vault key procedure reached without an authorized vault")

		return nil, auth.User{}, connect.NewError(connect.CodeInternal, errors.New("cannot authorize request"))
	}

	return service.Keys(membership.VaultID), user, nil
}

func (service VaultKeyService) internal(ctx context.Context, message string, err error) error {
	service.Logger.ErrorContext(ctx, message, "error", err)

	return connect.NewError(connect.CodeInternal, errors.New(message))
}

// KeyError maps the store errors of a key operation (an epoch change or a
// slot grant) to Connect errors, or returns nil for any other error.
func KeyError(err error) error {
	switch {
	case errors.Is(err, store.ErrEpochNotCurrent):
		return ReasonError(connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_EPOCH_NOT_CURRENT,
			errors.New("expected_epoch is not the vault's current epoch; list the vault's epochs and adopt the current one"))
	case errors.Is(err, store.ErrNotEncrypted):
		return connect.NewError(connect.CodeFailedPrecondition, store.ErrNotEncrypted)
	case errors.Is(err, store.ErrSelfRemoval):
		return connect.NewError(connect.CodeFailedPrecondition, store.ErrSelfRemoval)
	case errors.Is(err, store.ErrFirstEpochKept), errors.Is(err, store.ErrEpochInUse):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, store.ErrNextEpochRequired),
		errors.Is(err, store.ErrUnexpectedNextEpoch),
		errors.Is(err, store.ErrInvalidRecipients),
		errors.Is(err, store.ErrEpochRecord),
		errors.Is(err, store.ErrEpochNotFound):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return nil
	}
}

// ListKeySlots lists the caller's own key slots, or, for an editor or
// owner who asks for them, the vault's escrow slots.
func (service VaultKeyService) ListKeySlots(ctx context.Context, request *connect.Request[vaultsyncv1.ListKeySlotsRequest]) (*connect.Response[vaultsyncv1.ListKeySlotsResponse], error) {
	vault, user, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	kind := request.Msg.GetRecipientKind()

	switch kind {
	case vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_UNSPECIFIED, vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER:
	case vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW:
		// The membership is present: service.vault checked it.
		if membership, _ := authz.MembershipFromContext(ctx); membership.Role != store.RoleOwner && membership.Role != store.RoleEditor {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("escrow slots are listed to editors and owners only"))
		}
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("recipient_kind must be unspecified, KEY_RECIPIENT_KIND_USER or KEY_RECIPIENT_KIND_ESCROW"))
	}

	after, _, err := decodeKeyToken(request.Msg.GetPageToken(), false)
	if err != nil {
		return nil, err
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultKeyPageSize, MaxKeyPageSize)

	var slots []store.KeySlot
	if kind == vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW {
		slots, err = vault.ListEscrowSlots(ctx, after, limit)
	} else {
		slots, err = vault.ListKeySlots(ctx, store.RecipientUser, user.ID.String(), after, limit)
	}

	if err != nil {
		return nil, service.internal(ctx, "cannot list key slots", err)
	}

	response := &vaultsyncv1.ListKeySlotsResponse{}
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for index, slot := range slots {
		message := keySlotMessage(slot)
		if !budget.admit(message) {
			response.NextPageToken = encodeKeyToken(slots[index-1].Epoch, uuid.NullUUID{})

			break
		}

		response.Slots = append(response.Slots, message)

		if index == limit-1 {
			response.NextPageToken = encodeKeyToken(slot.Epoch, uuid.NullUUID{})
		}
	}

	return connect.NewResponse(response), nil
}

// ListEpochs lists the vault's epochs and returns its key state.
func (service VaultKeyService) ListEpochs(ctx context.Context, request *connect.Request[vaultsyncv1.ListEpochsRequest]) (*connect.Response[vaultsyncv1.ListEpochsResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	after, _, err := decodeKeyToken(request.Msg.GetPageToken(), false)
	if err != nil {
		return nil, err
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultKeyPageSize, MaxKeyPageSize)

	// The state is read first: epochs only ever grow, so the page never
	// lacks the current epoch's predecessors.
	state, err := vault.KeyState(ctx)
	if err != nil {
		return nil, service.internal(ctx, "cannot list epochs", err)
	}

	epochs, err := vault.ListEpochs(ctx, after, limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list epochs", err)
	}

	response := &vaultsyncv1.ListEpochsResponse{
		CurrentEpoch:    uint32(max(state.CurrentEpoch, 0)),
		RotationPending: state.RotationPending,
		ConversionSeq:   uint64(max(state.ConversionSeq, 0)),
	}
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for index, epoch := range epochs {
		message := epochMessage(epoch)
		if !budget.admit(message) {
			response.NextPageToken = encodeKeyToken(epochs[index-1].Epoch, uuid.NullUUID{})

			break
		}

		response.Epochs = append(response.Epochs, message)

		if index == limit-1 {
			response.NextPageToken = encodeKeyToken(epoch.Epoch, uuid.NullUUID{})
		}
	}

	return connect.NewResponse(response), nil
}

// ListMissingSlots lists the slots the vault's members with a user key lack.
func (service VaultKeyService) ListMissingSlots(ctx context.Context, request *connect.Request[vaultsyncv1.ListMissingSlotsRequest]) (*connect.Response[vaultsyncv1.ListMissingSlotsResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	afterEpoch, afterUser, err := decodeKeyToken(request.Msg.GetPageToken(), true)
	if err != nil {
		return nil, err
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultKeyPageSize, MaxKeyPageSize)

	missing, err := vault.ListMissingSlots(ctx, afterEpoch, afterUser, limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list missing slots", err)
	}

	response := &vaultsyncv1.ListMissingSlotsResponse{}
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for index, slot := range missing {
		message := &vaultsyncv1.MissingSlot{Epoch: uint32(max(slot.Epoch, 0)), UserId: slot.UserID.String(), PublicKey: slot.PublicKey}
		if !budget.admit(message) {
			previous := missing[index-1]
			response.NextPageToken = encodeKeyToken(previous.Epoch, uuid.NullUUID{UUID: previous.UserID, Valid: true})

			break
		}

		response.MissingSlots = append(response.MissingSlots, message)

		if index == limit-1 {
			response.NextPageToken = encodeKeyToken(slot.Epoch, uuid.NullUUID{UUID: slot.UserID, Valid: true})
		}
	}

	return connect.NewResponse(response), nil
}

// RotateEpoch creates the vault's next epoch.
func (service VaultKeyService) RotateEpoch(ctx context.Context, request *connect.Request[vaultsyncv1.RotateEpochRequest]) (*connect.Response[vaultsyncv1.RotateEpochResponse], error) {
	vault, user, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	next, err := ParseNextEpoch(request.Msg.GetNextEpoch(), service.Escrow)
	if err != nil {
		return nil, err
	}

	membership, _ := authz.MembershipFromContext(ctx)

	signed, err := parseSignedEpoch(membership.VaultID, request.Msg.GetRecord(), request.Msg.GetEscrowEntry())
	if err != nil {
		return nil, err
	}

	if next.Record, err = encodeEpochRecord(signed.record); err != nil {
		return nil, service.internal(ctx, "cannot rotate epoch", err)
	}

	next.EscrowEntry = signed.escrowEntry
	next.Check = signed.check(next)

	epoch, err := vault.RotateEpoch(ctx, user.ID, next)
	if err != nil {
		if mapped := KeyError(err); mapped != nil {
			return nil, mapped
		}

		return nil, service.internal(ctx, "cannot rotate epoch", err)
	}

	return connect.NewResponse(&vaultsyncv1.RotateEpochResponse{Epoch: epochMessage(epoch)}), nil
}

// AddKeySlots grants key slots for existing epochs.
func (service VaultKeyService) AddKeySlots(ctx context.Context, request *connect.Request[vaultsyncv1.AddKeySlotsRequest]) (*connect.Response[vaultsyncv1.AddKeySlotsResponse], error) {
	vault, user, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	messages := request.Msg.GetSlots()
	if len(messages) == 0 || len(messages) > MaxAddKeySlots {
		return nil, invalidArgument("slots must hold 1 to %d slots", MaxAddKeySlots)
	}

	slots, err := parseKeySlots("slots", messages, true, service.Escrow)
	if err != nil {
		return nil, err
	}

	added, err := vault.AddKeySlots(ctx, user.ID, slots)
	if err != nil {
		if mapped := KeyError(err); mapped != nil {
			return nil, mapped
		}

		return nil, service.internal(ctx, "cannot add key slots", err)
	}

	return connect.NewResponse(&vaultsyncv1.AddKeySlotsResponse{Added: uint32(max(added, 0))}), nil //nolint:gosec // bounded by MaxAddKeySlots.
}

// ListStaleRevisions lists the vault's revisions not on the current epoch,
// for an owner's re-key job.
func (service VaultKeyService) ListStaleRevisions(ctx context.Context, request *connect.Request[vaultsyncv1.ListStaleRevisionsRequest]) (*connect.Response[vaultsyncv1.ListStaleRevisionsResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	// Tokens are the seq of the last revision returned, as for
	// GetDocumentHistory.
	after, err := decodeHistoryToken(request.Msg.GetPageToken())
	if err != nil {
		return nil, invalidArgument("page_token is malformed")
	}

	limit := pageSize(request.Msg.GetPageSize(), DefaultKeyPageSize, MaxKeyPageSize)

	page, err := vault.ListStaleRevisions(ctx, after, limit)
	if err != nil {
		return nil, service.internal(ctx, "cannot list stale revisions", err)
	}

	response := &vaultsyncv1.ListStaleRevisionsResponse{CurrentEpoch: uint32(max(page.CurrentEpoch, 0))}
	budget := newPageBudget(request.Header(), service.Limits.MaxResponseBytes)

	for index, revision := range page.Revisions {
		message := revisionMessage(revision)
		if !budget.admit(message) {
			response.NextPageToken = encodeHistoryToken(page.Revisions[index-1].Seq)

			break
		}

		response.Revisions = append(response.Revisions, message)

		if index == limit-1 {
			response.NextPageToken = encodeHistoryToken(revision.Seq)
		}
	}

	return connect.NewResponse(response), nil
}

// ReplaceRevisionCiphertext moves one stored revision's path and content
// to a newer epoch, if it is still at from_epoch and to_epoch is current.
func (service VaultKeyService) ReplaceRevisionCiphertext(ctx context.Context, request *connect.Request[vaultsyncv1.ReplaceRevisionCiphertextRequest]) (*connect.Response[vaultsyncv1.ReplaceRevisionCiphertextResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	replacement, err := parseRevisionCiphertext(request.Msg)
	if err != nil {
		return nil, err
	}

	replaced, err := vault.ReplaceRevisionCiphertext(ctx, replacement)

	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotEncrypted):
		return nil, connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, store.ErrNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errors.New("the vault has no such revision"))
	case errors.Is(err, store.ErrBlobNotComplete):
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("content_ref is not a complete blob in this vault; upload it first"))
	case errors.Is(err, store.ErrCiphertextShape), errors.Is(err, store.ErrBlobSizeMismatch):
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return nil, service.internal(ctx, "cannot replace revision ciphertext", err)
	}

	return connect.NewResponse(&vaultsyncv1.ReplaceRevisionCiphertextResponse{Replaced: replaced}), nil
}

// parseRevisionCiphertext validates a ReplaceRevisionCiphertextRequest's
// bounds.
func parseRevisionCiphertext(message *vaultsyncv1.ReplaceRevisionCiphertextRequest) (store.RevisionCiphertext, error) {
	revisionID, err := authz.ParseID(message.GetRevisionId())
	if err != nil {
		return store.RevisionCiphertext{}, invalidArgument("revision_id: %w", err)
	}

	if message.GetToEpoch() > math.MaxInt32 || message.GetFromEpoch() >= message.GetToEpoch() {
		return store.RevisionCiphertext{}, invalidArgument("from_epoch must be below to_epoch, and to_epoch at most %d", math.MaxInt32)
	}

	path := message.GetPath()
	if len(path) == 0 || len(path) > MaxEncryptedPathBytes {
		return store.RevisionCiphertext{}, invalidArgument("path must be 1 to %d bytes of ciphertext", MaxEncryptedPathBytes)
	}

	replacement := store.RevisionCiphertext{
		RevisionID: revisionID,
		FromEpoch:  int32(message.GetFromEpoch()), //nolint:gosec // below to_epoch, checked against MaxInt32 above.
		ToEpoch:    int32(message.GetToEpoch()),   //nolint:gosec // checked against MaxInt32 above.
		Path:       string(path),
	}

	if content := message.GetContentRef(); content != nil {
		if err := checkBlobID(content.GetBlobId()); err != nil {
			return store.RevisionCiphertext{}, err
		}

		if content.GetSize() > math.MaxInt64 {
			return store.RevisionCiphertext{}, invalidArgument("content_ref.size is out of range")
		}

		replacement.ContentRef = content.GetBlobId()
		replacement.ContentSize = int64(content.GetSize())
	}

	return replacement, nil
}

// RetireEpoch retires an epoch that no stored revision uses.
func (service VaultKeyService) RetireEpoch(ctx context.Context, request *connect.Request[vaultsyncv1.RetireEpochRequest]) (*connect.Response[vaultsyncv1.RetireEpochResponse], error) {
	vault, _, err := service.vault(ctx)
	if err != nil {
		return nil, err
	}

	epoch := request.Msg.GetEpoch()
	if epoch < 1 || epoch > math.MaxInt32 {
		return nil, invalidArgument("epoch must be 1 to %d", math.MaxInt32)
	}

	if err := vault.RetireEpoch(ctx, int32(epoch)); err != nil { //nolint:gosec // checked against MaxInt32 above.
		if mapped := KeyError(err); mapped != nil {
			return nil, mapped
		}

		return nil, service.internal(ctx, "cannot retire epoch", err)
	}

	return connect.NewResponse(&vaultsyncv1.RetireEpochResponse{}), nil
}

// ParseNextEpoch validates a NextEpoch's bounds and that its escrow slot, if
// any, names an escrow key escrow accepts (not its other recipients, which
// the store checks against the vault's members).
func ParseNextEpoch(message *vaultsyncv1.NextEpoch, escrow Escrow) (store.NextEpoch, error) {
	if message == nil {
		return store.NextEpoch{}, invalidArgument("next_epoch is required")
	}

	if message.GetExpectedEpoch() >= math.MaxInt32 {
		return store.NextEpoch{}, invalidArgument("next_epoch.expected_epoch is out of range")
	}

	if len(message.GetCommitment()) != KeyCommitmentBytes {
		return store.NextEpoch{}, invalidArgument("next_epoch.commitment must be exactly %d bytes", KeyCommitmentBytes)
	}

	if len(message.GetSlots()) > MaxNextEpochSlots {
		return store.NextEpoch{}, invalidArgument("next_epoch.slots must hold at most %d slots", MaxNextEpochSlots)
	}

	slots, err := parseKeySlots("next_epoch.slots", message.GetSlots(), false, escrow)
	if err != nil {
		return store.NextEpoch{}, err
	}

	return store.NextEpoch{
		ExpectedEpoch: int32(message.GetExpectedEpoch()), //nolint:gosec // checked against MaxInt32 above.
		Commitment:    message.GetCommitment(),
		Slots:         slots,
	}, nil
}

// parseKeySlots validates slots; withEpoch requires each to name an epoch
// (1 to MaxInt32), otherwise their epochs are ignored. Two slots for the same
// epoch and recipient are refused, and so is an escrow slot naming a key
// escrow does not accept (docs/design/encryption.md, "Escrow").
func parseKeySlots(field string, messages []*vaultsyncv1.KeySlot, withEpoch bool, escrow Escrow) ([]store.KeySlot, error) {
	type slotKey struct {
		epoch int32
		kind  store.RecipientKind
		id    string
	}

	slots := make([]store.KeySlot, 0, len(messages))
	seen := make(map[slotKey]bool, len(messages))

	for index, message := range messages {
		slot, err := parseKeySlot(message, withEpoch)
		if err != nil {
			return nil, invalidArgument("%s[%d]: %w", field, index, err)
		}

		if slot.RecipientKind == store.RecipientEscrow && !escrow.AcceptsSlot(slot.RecipientID) {
			return nil, invalidArgument("%s[%d]: recipient_id is neither the current escrow key id nor a retiring one", field, index)
		}

		key := slotKey{epoch: slot.Epoch, kind: slot.RecipientKind, id: slot.RecipientID}
		if seen[key] {
			return nil, invalidArgument("%s[%d]: duplicate slot for the same epoch and recipient", field, index)
		}

		seen[key] = true

		slots = append(slots, slot)
	}

	return slots, nil
}

func parseKeySlot(message *vaultsyncv1.KeySlot, withEpoch bool) (store.KeySlot, error) {
	var slot store.KeySlot

	if withEpoch {
		if message.GetEpoch() < 1 || message.GetEpoch() > math.MaxInt32 {
			return store.KeySlot{}, errors.New("epoch must be at least 1")
		}

		slot.Epoch = int32(message.GetEpoch()) //nolint:gosec // checked against MaxInt32 above.
	}

	switch message.GetRecipientKind() {
	case vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER:
		id, err := authz.ParseID(message.GetRecipientId())
		if err != nil {
			return store.KeySlot{}, fmt.Errorf("recipient_id: %w", err)
		}

		slot.RecipientKind = store.RecipientUser
		slot.RecipientID = id.String()
	case vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_INVITATION:
		id, err := authz.ParseID(message.GetRecipientId())
		if err != nil {
			return store.KeySlot{}, fmt.Errorf("recipient_id: %w", err)
		}

		slot.RecipientKind = store.RecipientInvitation
		slot.RecipientID = id.String()
	case vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW:
		if !printableASCII(message.GetRecipientId(), MaxEscrowRecipientIDBytes) {
			return store.KeySlot{}, fmt.Errorf("recipient_id must be 1 to %d printable ASCII bytes", MaxEscrowRecipientIDBytes)
		}

		slot.RecipientKind = store.RecipientEscrow
		slot.RecipientID = message.GetRecipientId()
	default:
		return store.KeySlot{}, errors.New("recipient_kind must be KEY_RECIPIENT_KIND_USER, KEY_RECIPIENT_KIND_ESCROW or KEY_RECIPIENT_KIND_INVITATION")
	}

	if len(message.GetWrappedKey()) == 0 || len(message.GetWrappedKey()) > MaxWrappedKeyBytes {
		return store.KeySlot{}, fmt.Errorf("wrapped_key must be 1 to %d bytes", MaxWrappedKeyBytes)
	}

	slot.WrappedKey = message.GetWrappedKey()

	return slot, nil
}

// printableASCII reports whether value is 1 to limit bytes of printable
// ASCII (0x21 to 0x7e).
func printableASCII(value string, limit int) bool {
	if value == "" || len(value) > limit {
		return false
	}

	for index := range len(value) {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}

	return true
}

func encodeKeyToken(epoch int32, user uuid.NullUUID) string {
	token := binary.BigEndian.AppendUint32(nil, uint32(max(epoch, 0)))
	if user.Valid {
		token = append(token, user.UUID[:]...)
	}

	return keyTokenEncoding.EncodeToString(token)
}

// decodeKeyToken returns the position a page token encodes, or the start
// for no token. withUser tokens carry a user id after the epoch.
func decodeKeyToken(token string, withUser bool) (int32, uuid.UUID, error) {
	if token == "" {
		return 0, uuid.Nil, nil
	}

	size := 4
	if withUser {
		size += len(uuid.UUID{})
	}

	raw, err := keyTokenEncoding.DecodeString(token)
	if err != nil || len(raw) != size || binary.BigEndian.Uint32(raw) > math.MaxInt32 {
		return 0, uuid.Nil, invalidArgument("page_token is malformed")
	}

	var user uuid.UUID
	if withUser {
		user = uuid.UUID(raw[4:])
	}

	return int32(binary.BigEndian.Uint32(raw)), user, nil //nolint:gosec // checked against MaxInt32 above.
}

func keySlotMessage(slot store.KeySlot) *vaultsyncv1.KeySlot {
	message := &vaultsyncv1.KeySlot{
		Epoch:         uint32(max(slot.Epoch, 0)),
		RecipientId:   slot.RecipientID,
		WrappedKey:    slot.WrappedKey,
		CreatorUserId: slot.CreatedBy.String(),
		CreateTime:    timestamppb.New(slot.CreatedAt),
	}

	switch slot.RecipientKind {
	case store.RecipientUser:
		message.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_USER
	case store.RecipientEscrow:
		message.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW
	case store.RecipientInvitation:
		message.RecipientKind = vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_INVITATION
	}

	return message
}

func epochMessage(epoch store.Epoch) *vaultsyncv1.KeyEpoch {
	return &vaultsyncv1.KeyEpoch{
		Epoch:         uint32(max(epoch.Epoch, 0)),
		Commitment:    epoch.Commitment,
		CreatorUserId: epoch.CreatedBy.String(),
		CreateTime:    timestamppb.New(epoch.CreatedAt),
		Record:        decodeEpochRecord(epoch.Record),
		Retired:       epoch.Retired,
	}
}
