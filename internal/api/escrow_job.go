package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"

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

// escrowJobLogPage is how many log entries ReplaceEscrowSlot reads at once.
const escrowJobLogPage = 1000

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
	// VaultLogEntries returns up to limit of a vault's membership log
	// entries after seq after, live or deleted and not purged.
	VaultLogEntries(ctx context.Context, vaultID uuid.UUID, after int64, limit int) ([]store.LogEntry, error)
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

// escrowChain is the stored escrow chain, checked.
type escrowChain struct {
	// bundles are the encoded bundles by position: the root, then each
	// statement's new bundle.
	bundles [][]byte
	// statements are the parsed statements after the root.
	statements []e2ee.EscrowRotation
	head       e2ee.EscrowBundle
}

// contains reports whether encoded is a bundle of the chain.
func (chain escrowChain) contains(encoded []byte) bool {
	return slices.ContainsFunc(chain.bundles, func(bundle []byte) bool { return bytes.Equal(bundle, encoded) })
}

// headHash is the SHA-256 of the encoded head bundle.
func (chain escrowChain) headHash() []byte {
	hash := sha256.Sum256(chain.bundles[len(chain.bundles)-1])

	return hash[:]
}

// signedFrom reports whether signed rotations alone lead from encoded to the
// head: encoded is in the chain and no reset point follows its position.
func (chain escrowChain) signedFrom(encoded []byte) bool {
	position := slices.IndexFunc(chain.bundles, func(bundle []byte) bool { return bytes.Equal(bundle, encoded) })
	if position < 0 {
		return false
	}

	return !slices.ContainsFunc(chain.statements[position:], func(statement e2ee.EscrowRotation) bool { return statement.Reset })
}

// chain reads the stored escrow chain and checks that it links
// (e2ee.CheckEscrowChain).
func (service EscrowJobService) chain(ctx context.Context) (escrowChain, error) {
	stored, err := service.Store.EscrowChain(ctx, nil)
	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot read the escrow chain", "error", err)

		return escrowChain{}, connect.NewError(connect.CodeInternal, errors.New("cannot read the escrow chain"))
	}

	if stored.Root == nil {
		return escrowChain{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("the deployment has no escrow chain"))
	}

	root, err := e2ee.ParseEscrowBundle(stored.Root)
	if err != nil {
		return escrowChain{}, service.brokenChain(ctx, err)
	}

	chain := escrowChain{bundles: [][]byte{stored.Root}, statements: make([]e2ee.EscrowRotation, 0, len(stored.Rotations))}

	for _, statement := range stored.Rotations {
		bundle, err := e2ee.ParseEscrowBundle(statement.NewBundle)
		if err != nil {
			return escrowChain{}, service.brokenChain(ctx, err)
		}

		chain.bundles = append(chain.bundles, statement.NewBundle)
		chain.statements = append(chain.statements, e2ee.EscrowRotation{
			OldBundleHash: statement.OldBundleHash,
			NewBundle:     bundle,
			Signature:     statement.Signature,
			Reset:         statement.Reset,
		})
	}

	chain.head, err = e2ee.CheckEscrowChain(root, chain.statements)
	if err != nil {
		return escrowChain{}, service.brokenChain(ctx, err)
	}

	return chain, nil
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

	chain, err := service.chain(ctx)
	if err != nil {
		return nil, err
	}

	headKeyID, err := escrowBundleKeyID(chain.head)
	if err != nil {
		return nil, service.brokenChain(ctx, err)
	}

	if message.GetNewRecipientId() != headKeyID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_recipient_id must be the key id of the escrow chain's head"))
	}

	if err := service.checkAdopted(ctx, vaultID, chain); err != nil {
		return nil, err
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

	chain, err := service.chain(ctx)
	if err != nil {
		return nil, err
	}

	if statement.GetReset_() {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("a reset point is appended with ResetEscrowChain"))
	}

	rotation := e2ee.EscrowRotation{OldBundleHash: statement.GetOldBundleHash(), NewBundle: newBundle, Signature: statement.GetSignature()}
	if _, err := e2ee.VerifyEscrowChain(chain.head, []e2ee.EscrowRotation{rotation}); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("the statement does not verify against the escrow chain's head"))
	}

	if chain.contains(statement.GetNewBundle()) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle is already in the escrow chain"))
	}

	err = service.Store.AppendEscrowRotation(ctx, int32(len(chain.bundles)), store.EscrowRotationStatement{ //nolint:gosec // the chain is far shorter.
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

// ResetEscrowChain appends a reset point after the stored chain's head,
// only while the head still hashes to the expected one.
func (service EscrowJobService) ResetEscrowChain(ctx context.Context, request *connect.Request[vaultsyncv1.ResetEscrowChainRequest]) (*connect.Response[vaultsyncv1.ResetEscrowChainResponse], error) {
	message := request.Msg

	if len(message.GetExpectedHeadHash()) != sha256.Size {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("expected_head_hash must be %d bytes", sha256.Size))
	}

	newBundle, err := e2ee.ParseEscrowBundle(message.GetNewBundle())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle is not an escrow bundle"))
	}

	if _, err := escrowBundleKeyID(newBundle); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle's recipient is not an age hybrid post-quantum recipient"))
	}

	chain, err := service.chain(ctx)
	if err != nil {
		return nil, err
	}

	if !bytes.Equal(message.GetExpectedHeadHash(), chain.headHash()) {
		return nil, connect.NewError(connect.CodeAborted, errors.New("the escrow chain's head is not expected_head_hash; read the chain and try again"))
	}

	if chain.contains(message.GetNewBundle()) {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("new_bundle is already in the escrow chain"))
	}

	err = service.Store.AppendEscrowRotation(ctx, int32(len(chain.bundles)), store.EscrowRotationStatement{ //nolint:gosec // the chain is far shorter.
		OldBundleHash: message.GetExpectedHeadHash(),
		NewBundle:     message.GetNewBundle(),
		Reset:         true,
	})
	if errors.Is(err, store.ErrEscrowChainPosition) {
		return nil, connect.NewError(connect.CodeAborted, errors.New("the escrow chain changed; read it and try again"))
	}

	if err != nil {
		service.Logger.ErrorContext(ctx, "cannot append escrow reset point", "error", err)

		return nil, connect.NewError(connect.CodeInternal, errors.New("cannot append escrow reset point"))
	}

	return connect.NewResponse(&vaultsyncv1.ResetEscrowChainResponse{}), nil
}

// checkAdopted refuses with ESCROW_NOT_ADOPTED unless signed rotations alone
// lead from the escrow bundle the vault's log named last to the chain's
// head (docs/design/encryption.md, "Escrow reset on the server"). It reads
// the log of live vaults and of deleted vaults that are not purged yet. A
// vault without a log has no escrow slot to replace.
func (service EscrowJobService) checkAdopted(ctx context.Context, vaultID uuid.UUID, chain escrowChain) error {
	var entries []e2ee.Entry

	for after := int64(0); ; {
		page, err := service.Store.VaultLogEntries(ctx, vaultID, after, escrowJobLogPage)
		if err != nil {
			service.Logger.ErrorContext(ctx, "cannot read the vault's membership log", "error", err)

			return connect.NewError(connect.CodeInternal, errors.New("cannot read the vault's membership log"))
		}

		for _, entry := range page {
			entries = append(entries, e2eeEntry(vaultID, entry))
		}

		if len(page) < escrowJobLogPage {
			break
		}

		after = page[len(page)-1].Seq
	}

	if len(entries) == 0 {
		return connect.NewError(connect.CodeNotFound, errors.New("the vault has no membership log, so no escrow slot"))
	}

	states, err := e2ee.ReplayLog(vaultID.String(), entries, e2ee.ReplayOptions{EscrowRotations: chain.statements})
	if err != nil {
		service.Logger.ErrorContext(ctx, "the vault's membership log does not verify", "error", err)

		return connect.NewError(connect.CodeInternal, errors.New("the vault's membership log does not verify"))
	}

	notAdopted := ReasonError(connect.CodeFailedPrecondition, vaultsyncv1.ErrorReason_ERROR_REASON_ESCROW_NOT_ADOPTED,
		errors.New("the escrow chain's head is not reachable from the vault's escrow bundle through signed rotations; the vault waits for its owner"))

	last := states[len(states)-1].LastEscrow()
	if last == nil {
		return notAdopted
	}

	encoded, err := last.Encode()
	if err != nil || !chain.signedFrom(encoded) {
		return notAdopted
	}

	return nil
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
