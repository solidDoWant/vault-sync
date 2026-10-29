package export

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// ErrEscrowSlotGone is returned by RotationWriter.ReplaceEscrowSlot when the
// old slot is no longer there: another run replaced it first.
var ErrEscrowSlotGone = errors.New("the escrow slot was already replaced")

// RotationSource is what an escrow rotation reads (store.Store).
type RotationSource interface {
	// EscrowChain returns the stored escrow chain.
	EscrowChain(ctx context.Context) (store.EscrowChain, error)
	// Vaults returns up to limit vaults after the given id, in id order,
	// including deleted vaults that are not purged yet.
	Vaults(ctx context.Context, after uuid.UUID, limit int) ([]store.Vault, error)
	// Epochs returns up to limit of the vault's epochs after the given one.
	Epochs(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.Epoch, error)
	// AllEscrowSlots returns up to limit of the vault's escrow slots, to any
	// escrow key, for epochs after the given one, in epoch order.
	AllEscrowSlots(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.KeySlot, error)
}

// RotationWriter is the server's job-only endpoint an escrow rotation writes
// through.
type RotationWriter interface {
	// AppendEscrowRotation appends the next escrow rotation statement.
	AppendEscrowRotation(ctx context.Context, statement e2ee.EscrowRotation) error
	// ReplaceEscrowSlot replaces an escrow slot only if the old one is still
	// there, or fails with ErrEscrowSlotGone.
	ReplaceEscrowSlot(ctx context.Context, replacement store.EscrowSlotReplacement) error
}

// RotationOptions configure one escrow key rotation run.
type RotationOptions struct {
	Source RotationSource
	Writer RotationWriter
	Logger *slog.Logger
	// Target is the escrow bundle the run rotates to.
	Target e2ee.EscrowBundle
	// Identities are the escrow identities: the target's and the old ones.
	Identities []EscrowIdentity
	// SigningKeys are the escrow signing keys, matched to bundles by their
	// public keys.
	SigningKeys []ed25519.PrivateKey
	// PageSize is how many rows each read returns; DefaultPageSize when 0.
	PageSize int
}

// SlotFailure is an escrow slot the run left in place. It names the slot,
// never its content.
type SlotFailure struct {
	VaultID     uuid.UUID `json:"vault_id"`
	Epoch       int32     `json:"epoch"`
	RecipientID string    `json:"recipient_id"`
	Reason      string    `json:"reason"`
}

// RotationSummary reports one escrow rotation run.
type RotationSummary struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// TargetKeyID is the key id of the target escrow key.
	TargetKeyID string `json:"target_key_id"`
	// AppendedStatement is true when this run appended the escrow rotation
	// statement to the target.
	AppendedStatement bool `json:"appended_statement"`
	// Vaults is how many vaults (deleted ones not yet purged included) the
	// run looked at.
	Vaults int `json:"vaults"`
	// Rewrapped is how many escrow slots this run moved to the target key.
	Rewrapped int `json:"rewrapped"`
	// OldKeySlots is how many escrow slots were still not on the target key
	// when the run finished; the old identity can be destroyed only at 0.
	OldKeySlots int `json:"old_key_slots"`
	// FailedSlots is how many slots failed their check and were left in
	// place.
	FailedSlots int `json:"failed_slots"`
	// Failures lists the first maxListedSlotFailures of them.
	Failures []SlotFailure `json:"failures"`
}

// maxListedSlotFailures bounds the failures a summary lists; all are
// counted.
const maxListedSlotFailures = 100

// signingKeyFor returns the signing key whose public key is the bundle's.
func signingKeyFor(keys []ed25519.PrivateKey, bundle e2ee.EscrowBundle) (ed25519.PrivateKey, bool) {
	for _, key := range keys {
		public, ok := key.Public().(ed25519.PublicKey)
		if ok && bytes.Equal(public, bundle.SignPub) {
			return key, true
		}
	}

	return nil, false
}

func bundleKeyID(bundle e2ee.EscrowBundle) (publicKey []byte, keyID string, err error) {
	publicKey, err = e2ee.ParseAgeRecipient(bundle.Recipient)
	if err != nil {
		return nil, "", err
	}

	keyID, err = e2ee.EscrowKeyID(publicKey)

	return publicKey, keyID, err
}

func escrowBundlesEqual(left, right e2ee.EscrowBundle) bool {
	return bytes.Equal(left.SignPub, right.SignPub) && left.Recipient == right.Recipient
}

// chainHead reads and verifies the stored escrow chain and returns its head.
func chainHead(ctx context.Context, source RotationSource) (e2ee.EscrowBundle, error) {
	stored, err := source.EscrowChain(ctx)
	if err != nil {
		return e2ee.EscrowBundle{}, fmt.Errorf("read the escrow chain: %w", err)
	}

	if stored.Root == nil {
		return e2ee.EscrowBundle{}, errors.New("the deployment has no escrow chain")
	}

	root, err := e2ee.ParseEscrowBundle(stored.Root)
	if err != nil {
		return e2ee.EscrowBundle{}, fmt.Errorf("the escrow chain's root: %w", err)
	}

	rotations := make([]e2ee.EscrowRotation, 0, len(stored.Rotations))

	for _, statement := range stored.Rotations {
		bundle, err := e2ee.ParseEscrowBundle(statement.NewBundle)
		if err != nil {
			return e2ee.EscrowBundle{}, fmt.Errorf("the escrow chain: %w", err)
		}

		rotations = append(rotations, e2ee.EscrowRotation{OldBundleHash: statement.OldBundleHash, NewBundle: bundle, Signature: statement.Signature})
	}

	head, err := e2ee.VerifyEscrowChain(root, rotations)
	if err != nil {
		return e2ee.EscrowBundle{}, fmt.Errorf("the escrow chain does not verify: %w", err)
	}

	return head, nil
}

// Rotate runs one escrow key rotation (docs/design/encryption.md, "Escrow"):
// it appends the escrow rotation statement to Target when the chain's head
// is not Target yet, signed by the head's signing key, then re-wraps every
// escrow slot that is not on Target's key, in every vault including deleted
// ones that are not purged, after checking each one against its epoch's key
// commitment. A slot that fails the check is reported and left in place.
// The summary's status is ok only when no slot failed and no slot is left
// on an old key. An error means the run could not start or could not read
// or write; the summary then reports how far it got.
func Rotate(ctx context.Context, options RotationOptions) (RotationSummary, error) {
	if options.PageSize <= 0 {
		options.PageSize = DefaultPageSize
	}

	summary := RotationSummary{Failures: []SlotFailure{}}

	fail := func(err error) (RotationSummary, error) {
		summary.Status = StatusFailed
		summary.Error = err.Error()

		return summary, err
	}

	targetPublicKey, targetKeyID, err := bundleKeyID(options.Target)
	if err != nil {
		return fail(errors.New("the target recipient is not an age hybrid post-quantum recipient (age1pq1…)"))
	}

	summary.TargetKeyID = targetKeyID

	if _, err := options.Target.Encode(); err != nil {
		return fail(errors.New("the target escrow bundle is malformed"))
	}

	identities := map[string]EscrowIdentity{}
	for _, identity := range options.Identities {
		identities[identity.KeyID] = identity
	}

	if _, ok := identities[targetKeyID]; !ok {
		return fail(errors.New("the escrow identity file does not hold the target's identity"))
	}

	if _, ok := signingKeyFor(options.SigningKeys, options.Target); !ok {
		return fail(errors.New("the escrow signing key file does not hold the target's signing key"))
	}

	head, err := chainHead(ctx, options.Source)
	if err != nil {
		return fail(err)
	}

	if !escrowBundlesEqual(head, options.Target) {
		headKey, ok := signingKeyFor(options.SigningKeys, head)
		if !ok {
			return fail(errors.New("the escrow signing key file does not hold the signing key of the escrow chain's head"))
		}

		statement, err := e2ee.SignEscrowRotation(headKey, head, options.Target)
		if err != nil {
			return fail(fmt.Errorf("sign the escrow rotation statement: %w", err))
		}

		if err := options.Writer.AppendEscrowRotation(ctx, statement); err != nil {
			return fail(fmt.Errorf("append the escrow rotation statement: %w", err))
		}

		summary.AppendedStatement = true

		options.Logger.InfoContext(ctx, "appended the escrow rotation statement", "target_key_id", targetKeyID)
	}

	rotation := rotationRun{options: options, targetPublicKey: targetPublicKey, targetKeyID: targetKeyID, identities: identities, summary: &summary}

	if err := rotation.eachVault(ctx, rotation.rewrapVault); err != nil {
		return fail(err)
	}

	// Count what is left on an old key, after this run's replacements: a
	// slot wrapped to the old key while the run went is caught here and by
	// the next run.
	summary.Vaults = 0

	if err := rotation.eachVault(ctx, rotation.countVault); err != nil {
		return fail(err)
	}

	summary.Status = StatusOK
	if summary.OldKeySlots > 0 || summary.FailedSlots > 0 {
		summary.Status = StatusFailed
		summary.Error = fmt.Sprintf("%d escrow slots are not on the target key, %d failed their check", summary.OldKeySlots, summary.FailedSlots)
	}

	return summary, nil
}

type rotationRun struct {
	options         RotationOptions
	targetPublicKey []byte
	targetKeyID     string
	identities      map[string]EscrowIdentity
	summary         *RotationSummary
}

func (rotation *rotationRun) eachVault(ctx context.Context, visit func(context.Context, uuid.UUID) error) error {
	after := uuid.Nil

	for {
		vaults, err := rotation.options.Source.Vaults(ctx, after, rotation.options.PageSize)
		if err != nil {
			return fmt.Errorf("list vaults: %w", err)
		}

		for _, vault := range vaults {
			rotation.summary.Vaults++

			if err := visit(ctx, vault.ID); err != nil {
				return err
			}
		}

		if len(vaults) < rotation.options.PageSize {
			return nil
		}

		after = vaults[len(vaults)-1].ID
	}
}

// eachOldSlot calls visit for every escrow slot of the vault not on the
// target key.
func (rotation *rotationRun) eachOldSlot(ctx context.Context, vaultID uuid.UUID, visit func(store.KeySlot) error) error {
	after := int32(0)

	for {
		slots, err := rotation.options.Source.AllEscrowSlots(ctx, vaultID, after, rotation.options.PageSize)
		if err != nil {
			return fmt.Errorf("list escrow slots: %w", err)
		}

		for _, slot := range slots {
			if slot.RecipientID == rotation.targetKeyID {
				continue
			}

			if err := visit(slot); err != nil {
				return err
			}
		}

		if len(slots) < rotation.options.PageSize {
			return nil
		}

		after = slots[len(slots)-1].Epoch
	}
}

func (rotation *rotationRun) countVault(ctx context.Context, vaultID uuid.UUID) error {
	return rotation.eachOldSlot(ctx, vaultID, func(store.KeySlot) error {
		rotation.summary.OldKeySlots++

		return nil
	})
}

func (rotation *rotationRun) rewrapVault(ctx context.Context, vaultID uuid.UUID) error {
	var commitments map[int32][]byte

	return rotation.eachOldSlot(ctx, vaultID, func(slot store.KeySlot) error {
		if commitments == nil {
			var err error
			if commitments, err = rotation.commitments(ctx, vaultID); err != nil {
				return err
			}
		}

		failed := func(reason string) error {
			rotation.summary.FailedSlots++
			if len(rotation.summary.Failures) < maxListedSlotFailures {
				rotation.summary.Failures = append(rotation.summary.Failures, SlotFailure{VaultID: vaultID, Epoch: slot.Epoch, RecipientID: slot.RecipientID, Reason: reason})
			}

			rotation.options.Logger.WarnContext(ctx, "escrow slot left in place", "vault_id", vaultID, "epoch", slot.Epoch, "recipient_id", slot.RecipientID, "reason", reason)

			return nil
		}

		identity, ok := rotation.identities[slot.RecipientID]
		if !ok {
			return failed("no escrow identity for the slot's key")
		}

		epochKey, err := openEscrowSlot(identity, vaultID, slot, commitments)

		var failure *vaultFailure
		if errors.As(err, &failure) {
			return failed(failure.reason)
		}

		if err != nil {
			return err
		}

		wrapped, err := e2ee.SealKeySlot(rotation.targetPublicKey, epochKey, e2ee.KeySlot{
			VaultID: vaultID.String(), Epoch: uint64(slot.Epoch), RecipientKind: e2ee.RecipientEscrow, RecipientID: rotation.targetKeyID, //nolint:gosec // openEscrowSlot checked the epoch is positive.
		})
		if err != nil {
			return fmt.Errorf("wrap the epoch key: %w", err)
		}

		err = rotation.options.Writer.ReplaceEscrowSlot(ctx, store.EscrowSlotReplacement{
			VaultID: vaultID, Epoch: slot.Epoch, OldRecipientID: slot.RecipientID, NewRecipientID: rotation.targetKeyID, WrappedKey: wrapped,
		})
		if errors.Is(err, ErrEscrowSlotGone) {
			return nil
		}

		if err != nil {
			return fmt.Errorf("replace the escrow slot of vault %s epoch %d: %w", vaultID, slot.Epoch, err)
		}

		rotation.summary.Rewrapped++

		return nil
	})
}

func (rotation *rotationRun) commitments(ctx context.Context, vaultID uuid.UUID) (map[int32][]byte, error) {
	commitments := map[int32][]byte{}
	after := int32(0)

	for {
		epochs, err := rotation.options.Source.Epochs(ctx, vaultID, after, rotation.options.PageSize)
		if err != nil {
			return nil, fmt.Errorf("list epochs: %w", err)
		}

		for _, epoch := range epochs {
			commitments[epoch.Epoch] = epoch.Commitment
		}

		if len(epochs) < rotation.options.PageSize {
			return commitments, nil
		}

		after = epochs[len(epochs)-1].Epoch
	}
}
