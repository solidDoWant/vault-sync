package export

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Reasons an encrypted document's path or content cannot be decrypted. They
// name the problem without the path or content, which are user data.
var (
	errNoEpochKey       = errors.New("no escrow key opens the revision's epoch")
	errPathDecrypt      = errors.New("path does not decrypt with the revision's epoch key")
	errContentDecrypt   = errors.New("stored content does not decrypt with the revision's epoch key")
	errContentNotBlobID = errors.New("decrypted content does not match its blob id")
)

// EscrowIdentity is an escrow private key the export decrypts escrowed
// vaults with (SPEC.md §9.4).
type EscrowIdentity struct {
	// PrivateKey is the 32-byte hybrid private key.
	PrivateKey []byte
	// KeyID names the key in escrow slots (e2ee.EscrowKeyID of its public
	// key).
	KeyID string
}

// NewEscrowIdentity returns the escrow identity of a hybrid private key.
func NewEscrowIdentity(privateKey []byte) (EscrowIdentity, error) {
	publicKey, err := e2ee.PublicKey(privateKey)
	if err != nil {
		return EscrowIdentity{}, err
	}

	keyID, err := e2ee.EscrowKeyID(publicKey)
	if err != nil {
		return EscrowIdentity{}, err
	}

	return EscrowIdentity{PrivateKey: privateKey, KeyID: keyID}, nil
}

// vaultFailure is a problem with a vault's keys: the vault is reported as
// failed and left out, and the export continues with the other vaults.
type vaultFailure struct {
	reason string
}

func (failure *vaultFailure) Error() string { return failure.reason }

// epochKeys are the sub-keys of one epoch a reader needs.
type epochKeys struct {
	content []byte
	path    []byte
	blobID  []byte
}

// escrowKeys opens every escrow slot of the vault that one of the
// configured identities can open, and checks each key against its epoch's
// key commitment before it is used. It returns a *vaultFailure for a slot
// that does not open or does not match the commitment, so no document is
// ever decrypted, or left undecrypted, with a wrong key.
func (run *run) escrowKeys(ctx context.Context, vaultID uuid.UUID) (map[int32]epochKeys, error) {
	commitments := map[int32][]byte{}
	after := int32(0)

	for {
		epochs, err := run.options.Source.Epochs(ctx, vaultID, after, run.options.PageSize)
		if err != nil {
			return nil, fmt.Errorf("list epochs: %w", err)
		}

		for _, epoch := range epochs {
			commitments[epoch.Epoch] = epoch.Commitment
		}

		if len(epochs) < run.options.PageSize {
			break
		}

		after = epochs[len(epochs)-1].Epoch
	}

	keys := map[int32]epochKeys{}

	for _, identity := range run.options.EscrowIdentities {
		after := int32(0)

		for {
			slots, err := run.options.Source.EscrowSlots(ctx, vaultID, identity.KeyID, after, run.options.PageSize)
			if err != nil {
				return nil, fmt.Errorf("list escrow slots: %w", err)
			}

			for _, slot := range slots {
				if _, done := keys[slot.Epoch]; done {
					continue
				}

				epochKey, err := openEscrowSlot(identity, vaultID, slot, commitments)
				if err != nil {
					return nil, err
				}

				if keys[slot.Epoch], err = deriveEpochKeys(epochKey); err != nil {
					return nil, err
				}
			}

			if len(slots) < run.options.PageSize {
				break
			}

			after = slots[len(slots)-1].Epoch
		}
	}

	return keys, nil
}

func openEscrowSlot(identity EscrowIdentity, vaultID uuid.UUID, slot store.KeySlot, commitments map[int32][]byte) ([]byte, error) {
	if slot.Epoch < 1 {
		return nil, &vaultFailure{reason: fmt.Sprintf("escrow slot for invalid epoch %d", slot.Epoch)}
	}

	epoch := uint64(slot.Epoch)

	commitment, ok := commitments[slot.Epoch]
	if !ok {
		return nil, &vaultFailure{reason: fmt.Sprintf("epoch %d has no key commitment", slot.Epoch)}
	}

	epochKey, err := e2ee.OpenKeySlot(identity.PrivateKey, slot.WrappedKey, e2ee.KeySlot{
		VaultID: vaultID.String(), Epoch: epoch, RecipientKind: e2ee.RecipientEscrow, RecipientID: identity.KeyID,
	})
	if err != nil {
		return nil, &vaultFailure{reason: fmt.Sprintf("the escrow slot of epoch %d does not open with the escrow identity", slot.Epoch)}
	}

	if err := e2ee.VerifyKeyCommitment(epochKey, commitment, vaultID.String(), epoch); err != nil {
		return nil, &vaultFailure{reason: fmt.Sprintf("the escrow slot of epoch %d fails its key commitment", slot.Epoch)}
	}

	return epochKey, nil
}

func deriveEpochKeys(epochKey []byte) (epochKeys, error) {
	var (
		keys epochKeys
		err  error
	)

	if keys.content, err = e2ee.DeriveSubkey(epochKey, e2ee.LabelContent); err != nil {
		return epochKeys{}, err
	}

	if keys.path, err = e2ee.DeriveSubkey(epochKey, e2ee.LabelPath); err != nil {
		return epochKeys{}, err
	}

	if keys.blobID, err = e2ee.DeriveSubkey(epochKey, e2ee.LabelBlobIDSecret); err != nil {
		return epochKeys{}, err
	}

	return keys, nil
}

// decryptDocument returns the plaintext form of an encrypted vault's
// document: its decrypted path, and its content decrypted, checked against
// its blob id and described by its plaintext size and SHA-256. A revision at
// epoch 0 (written before the vault was converted) is plaintext already. A
// path or content that cannot be decrypted is a document problem, never a
// failure of the export.
func (run *run) decryptDocument(ctx context.Context, vaultID uuid.UUID, keys map[int32]epochKeys, document store.LiveDocument) (exportedDocument, error) {
	if document.Epoch == 0 {
		return run.storedDocument(ctx, vaultID, document), nil
	}

	plain := document
	plain.Path = ""
	plain.ContentRef = nil

	keysOfEpoch, ok := keys[document.Epoch]
	if !ok {
		return exportedDocument{document: plain, contentProblem: errNoEpochKey}, nil
	}

	exported := exportedDocument{document: plain}

	if path, err := decryptPath(vaultID, keysOfEpoch, document); err != nil {
		exported.pathProblem = err
	} else {
		exported.document.Path = path
	}

	content, err := run.decryptContent(ctx, vaultID, keysOfEpoch, document)

	var refused *documentError

	switch {
	case errors.As(err, &refused):
		exported.contentProblem = refused.reason

		return exported, nil
	case err != nil:
		return exportedDocument{}, err
	}

	sum := sha256.Sum256(content)
	exported.document.ContentRef = sum[:]
	exported.document.Size = int64(len(content))
	exported.open = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(content)), nil }

	return exported, nil
}

func decryptPath(vaultID uuid.UUID, keys epochKeys, document store.LiveDocument) (string, error) {
	ad, err := e2ee.PathAD(vaultID.String(), document.ID.String(), uint64(document.Epoch)) //nolint:gosec // epoch is positive.
	if err != nil {
		return "", errPathDecrypt
	}

	path, err := e2ee.Open(keys.path, []byte(document.Path), ad)
	if err != nil {
		return "", errPathDecrypt
	}

	return string(path), nil
}

// decryptContent reads the document's sealed content, at most its stored
// size, and decrypts it. Problems with the content are *documentError.
func (run *run) decryptContent(ctx context.Context, vaultID uuid.UUID, keys epochKeys, document store.LiveDocument) ([]byte, error) {
	reader, err := run.options.Source.Content(ctx, vaultID, document.ContentRef)
	if errors.Is(err, ErrContentMissing) {
		return nil, refuse(errContentMissing)
	}

	if err != nil {
		return nil, err
	}

	defer func() { _ = reader.Close() }()

	// One byte more than expected reveals an over-long object.
	sealed, err := io.ReadAll(io.LimitReader(reader, document.Size+1))
	if err != nil {
		return nil, fmt.Errorf("read content: %w", err)
	}

	if int64(len(sealed)) != document.Size {
		return nil, refuse(errContentLength)
	}

	ad, err := e2ee.ContentAD(vaultID.String(), uint64(document.Epoch)) //nolint:gosec // epoch is positive.
	if err != nil {
		return nil, err
	}

	content, err := e2ee.Open(keys.content, sealed, ad)
	if err != nil {
		return nil, refuse(errContentDecrypt)
	}

	blobID, err := e2ee.BlobID(keys.blobID, content)
	if err != nil {
		return nil, err
	}

	if !hmac.Equal(blobID, document.ContentRef) {
		return nil, refuse(errContentNotBlobID)
	}

	return content, nil
}
