package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// maxEscrowRecipientIDBytes bounds a key slot's recipient id, as the
// key_slots table does.
const maxEscrowRecipientIDBytes = 255

// EscrowJobStore is the storage EscrowJobService writes through
// (store.Store).
type EscrowJobStore interface {
	// EscrowChain returns the stored escrow chain; root is always nil here.
	EscrowChain(ctx context.Context, root []byte) (store.EscrowChain, error)
	// AppendEscrowRotation stores statement at position, the one after the
	// chain's head, or fails with store.ErrEscrowChainPosition.
	AppendEscrowRotation(ctx context.Context, position int32, statement store.EscrowRotationStatement) error
	// ReplaceEscrowSlot replaces an escrow slot only if the old one is still
	// there, or fails with store.ErrNotFound.
	ReplaceEscrowSlot(ctx context.Context, replacement store.EscrowSlotReplacement) error
}

// EscrowJobService implements vaultsync.v1.EscrowJobService, the export
// job's writes during an escrow key rotation (docs/design/encryption.md,
// "Escrow"). Its callers are authenticated by the job token alone (the
// server's job-token interceptor); it has no vault authorization of its own.
type EscrowJobService struct {
	vaultsyncv1connect.UnimplementedEscrowJobServiceHandler

	Store  EscrowJobStore
	Logger *slog.Logger
}

// chainHead reads the stored escrow chain and returns its head bundle and
// how many rotation statements it holds, after checking that it links.
func (service EscrowJobService) chainHead(ctx context.Context) (e2ee.EscrowBundle, int, error) {
	stored, err := service.Store.EscrowChain(ctx, nil)
	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot read the escrow chain", "error", err)

		return e2ee.EscrowBundle{}, 0, connect.NewError(connect.CodeInternal, errors.New("cannot read the escrow chain"))
	}

	if stored.Root == nil {
		return e2ee.EscrowBundle{}, 0, connect.NewError(connect.CodeFailedPrecondition, errors.New("the deployment has no escrow chain"))
	}

	root, err := e2ee.ParseEscrowBundle(stored.Root)
	if err != nil {
		return e2ee.EscrowBundle{}, 0, service.brokenChain(ctx, err)
	}

	rotations := make([]e2ee.EscrowRotation, 0, len(stored.Rotations))

	for _, statement := range stored.Rotations {
		bundle, err := e2ee.ParseEscrowBundle(statement.NewBundle)
		if err != nil {
			return e2ee.EscrowBundle{}, 0, service.brokenChain(ctx, err)
		}

		rotations = append(rotations, e2ee.EscrowRotation{OldBundleHash: statement.OldBundleHash, NewBundle: bundle, Signature: statement.Signature})
	}

	head, err := e2ee.VerifyEscrowChain(root, rotations)
	if err != nil {
		return e2ee.EscrowBundle{}, 0, service.brokenChain(ctx, err)
	}

	return head, len(rotations), nil
}

func (service EscrowJobService) brokenChain(ctx context.Context, err error) error {
	service.Logger.ErrorContext(ctx, "the stored escrow chain does not verify", "error", err)

	return connect.NewError(connect.CodeInternal, errors.New("the stored escrow chain does not verify"))
}

// ReplaceEscrowSlot replaces one escrow slot with one wrapped to the escrow
// chain head's key, only if the old slot is still there.
func (service EscrowJobService) ReplaceEscrowSlot(ctx context.Context, request *connect.Request[vaultsyncv1.ReplaceEscrowSlotRequest]) (*connect.Response[vaultsyncv1.ReplaceEscrowSlotResponse], error) {
	message := request.Msg

	vaultID, err := uuid.Parse(message.GetVaultId())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("vault_id must be a UUID"))
	}

	if message.GetEpoch() < 1 || message.GetEpoch() > math.MaxInt32 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("epoch must be positive"))
	}

	for name, id := range map[string]string{"old_recipient_id": message.GetOldRecipientId(), "new_recipient_id": message.GetNewRecipientId()} {
		if len(id) == 0 || len(id) > maxEscrowRecipientIDBytes {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s must be 1 to %d bytes", name, maxEscrowRecipientIDBytes))
		}
	}

	if message.GetOldRecipientId() == message.GetNewRecipientId() {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_recipient_id must differ from old_recipient_id"))
	}

	if len(message.GetWrappedKey()) == 0 || len(message.GetWrappedKey()) > MaxWrappedKeyBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("wrapped_key must be 1 to %d bytes", MaxWrappedKeyBytes))
	}

	head, _, err := service.chainHead(ctx)
	if err != nil {
		return nil, err
	}

	headKeyID, err := escrowBundleKeyID(head)
	if err != nil {
		return nil, service.brokenChain(ctx, err)
	}

	if message.GetNewRecipientId() != headKeyID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_recipient_id must be the key id of the escrow chain's head"))
	}

	err = service.Store.ReplaceEscrowSlot(ctx, store.EscrowSlotReplacement{
		VaultID:        vaultID,
		Epoch:          int32(message.GetEpoch()), //nolint:gosec // bounded above.
		OldRecipientID: message.GetOldRecipientId(),
		NewRecipientID: message.GetNewRecipientId(),
		WrappedKey:     message.GetWrappedKey(),
	})
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("the epoch has no escrow slot wrapped to old_recipient_id"))
	}

	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot replace escrow slot", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot replace escrow slot"))
	}

	return connect.NewResponse(&vaultsyncv1.ReplaceEscrowSlotResponse{}), nil
}

// AppendEscrowRotation appends the next escrow rotation statement after
// checking it against the stored chain's head.
func (service EscrowJobService) AppendEscrowRotation(ctx context.Context, request *connect.Request[vaultsyncv1.AppendEscrowRotationRequest]) (*connect.Response[vaultsyncv1.AppendEscrowRotationResponse], error) {
	statement := request.Msg.GetStatement()
	if statement == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("statement is required"))
	}

	newBundle, err := e2ee.ParseEscrowBundle(statement.GetNewBundle())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle is not an escrow bundle"))
	}

	// Slots are later wrapped to the new bundle's recipient, so it must be
	// an escrow public key.
	if _, err := escrowBundleKeyID(newBundle); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle's recipient is not an age hybrid post-quantum recipient"))
	}

	head, rotations, err := service.chainHead(ctx)
	if err != nil {
		return nil, err
	}

	rotation := e2ee.EscrowRotation{OldBundleHash: statement.GetOldBundleHash(), NewBundle: newBundle, Signature: statement.GetSignature()}
	if _, err := e2ee.VerifyEscrowChain(head, []e2ee.EscrowRotation{rotation}); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("the statement does not verify against the escrow chain's head"))
	}

	err = service.Store.AppendEscrowRotation(ctx, int32(rotations+1), store.EscrowRotationStatement{ //nolint:gosec // the chain is far shorter.
		OldBundleHash: statement.GetOldBundleHash(),
		NewBundle:     statement.GetNewBundle(),
		Signature:     statement.GetSignature(),
	})
	if errors.Is(err, store.ErrEscrowChainPosition) {
		return nil, connect.NewError(connect.CodeAborted, errors.New("the escrow chain changed; read it and try again"))
	}

	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot append escrow rotation", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot append escrow rotation"))
	}

	return connect.NewResponse(&vaultsyncv1.AppendEscrowRotationResponse{}), nil
}

// escrowBundleKeyID returns the key id escrow slots wrapped to bundle's
// recipient carry.
func escrowBundleKeyID(bundle e2ee.EscrowBundle) (string, error) {
	publicKey, err := e2ee.ParseAgeRecipient(bundle.Recipient)
	if err != nil {
		return "", err
	}

	return e2ee.EscrowKeyID(publicKey)
}
