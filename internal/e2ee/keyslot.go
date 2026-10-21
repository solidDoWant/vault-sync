package e2ee

import (
	"crypto/hmac"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/google/uuid"
)

// RecipientKind names who a key slot is wrapped to (SPEC.md §5 key_slots).
type RecipientKind string

// The recipients of a key slot.
const (
	RecipientUser   RecipientKind = "user"
	RecipientEscrow RecipientKind = "escrow"
)

const (
	keySlotLabel       = "vault-sync/v1/key-slot"
	keyCommitmentLabel = "vault-sync/v1/key-commitment"

	recipientKindUserByte   byte = 0x01
	recipientKindEscrowByte byte = 0x02

	// MaxRecipientIDSize bounds the encoded recipient id of a key slot, whose
	// length is one byte in the slot associated data.
	MaxRecipientIDSize = 255
)

// ErrKeyCommitment is returned when an epoch key does not match its epoch's
// key commitment.
var ErrKeyCommitment = errors.New("e2ee: epoch key does not match the key commitment")

// KeySlot identifies a key slot: the epoch key of vault VaultID at Epoch,
// wrapped to a recipient. VaultID is a canonical lowercase UUID; RecipientID
// is the user's id (a canonical lowercase UUID) for RecipientUser and the
// escrow key's id (1 to 255 bytes) for RecipientEscrow.
type KeySlot struct {
	VaultID       string
	Epoch         uint64
	RecipientKind RecipientKind
	RecipientID   string
}

// AD returns the associated data a key slot binds:
//
//	"vault-sync/v1/key-slot" || vault_id (16) || epoch (u64 BE) ||
//	recipient_kind (u8: 0x01 user, 0x02 escrow) || len(recipient_id) (u8) || recipient_id
//
// with vault_id and a user's recipient_id as their 16 UUID bytes and an
// escrow recipient_id as its UTF-8 bytes. It refuses ids that are not in
// canonical form, so one slot has exactly one encoding.
func (slot KeySlot) AD() ([]byte, error) {
	vaultID, err := canonicalUUID(slot.VaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	var (
		kind        byte
		recipientID []byte
	)

	switch slot.RecipientKind {
	case RecipientUser:
		kind = recipientKindUserByte

		userID, err := canonicalUUID(slot.RecipientID)
		if err != nil {
			return nil, fmt.Errorf("e2ee: recipient id: %w", err)
		}

		recipientID = userID
	case RecipientEscrow:
		kind = recipientKindEscrowByte
		recipientID = []byte(slot.RecipientID)

		if !utf8.ValidString(slot.RecipientID) || len(recipientID) == 0 || len(recipientID) > MaxRecipientIDSize {
			return nil, fmt.Errorf("e2ee: escrow recipient id must be 1 to %d bytes of UTF-8, got %d bytes", MaxRecipientIDSize, len(recipientID))
		}
	default:
		return nil, fmt.Errorf("e2ee: unknown recipient kind %q", slot.RecipientKind)
	}

	ad := make([]byte, 0, len(keySlotLabel)+len(vaultID)+8+1+1+len(recipientID))
	ad = append(ad, keySlotLabel...)
	ad = append(ad, vaultID...)
	ad = binary.BigEndian.AppendUint64(ad, slot.Epoch)
	ad = append(ad, kind, byte(len(recipientID)))

	return append(ad, recipientID...), nil
}

// SealKeySlot wraps a 32-byte epoch key to a recipient's X25519 public key
// with a sealed box (SealTo) binding the slot's associated data (KeySlot.AD).
func SealKeySlot(recipientPublicKey, epochKey []byte, slot KeySlot) ([]byte, error) {
	ephemeral, err := randomBytes(KeySize)
	if err != nil {
		return nil, err
	}

	nonce, err := randomBytes(NonceSize)
	if err != nil {
		return nil, err
	}

	return sealKeySlotWith(recipientPublicKey, ephemeral, nonce, epochKey, slot)
}

// sealKeySlotWith is SealKeySlot with fixed random inputs, for the vectors.
func sealKeySlotWith(recipientPublicKey, ephemeralPrivateKey, nonce, epochKey []byte, slot KeySlot) ([]byte, error) {
	if len(epochKey) != KeySize {
		return nil, fmt.Errorf("e2ee: epoch key must be %d bytes, got %d", KeySize, len(epochKey))
	}

	ad, err := slot.AD()
	if err != nil {
		return nil, err
	}

	return sealToWith(recipientPublicKey, ephemeralPrivateKey, nonce, epochKey, ad)
}

// OpenKeySlot reverses SealKeySlot with the recipient's X25519 private key.
// It returns ErrDecrypt unless wrapped is a sealed box to this key binding
// exactly this slot (vault, epoch, recipient kind and recipient id) and holds
// a 32-byte key. The caller then checks the key against the epoch's
// commitment (VerifyKeyCommitment).
func OpenKeySlot(recipientPrivateKey, wrapped []byte, slot KeySlot) ([]byte, error) {
	ad, err := slot.AD()
	if err != nil {
		return nil, err
	}

	epochKey, err := OpenFrom(recipientPrivateKey, wrapped, ad)
	if err != nil {
		return nil, err
	}

	if len(epochKey) != KeySize {
		return nil, ErrDecrypt
	}

	return epochKey, nil
}

// KeyCommitment returns the key commitment of an epoch:
// HMAC-SHA256(epoch_key, "vault-sync/v1/key-commitment" || vault_id (16) ||
// epoch (u64 BE)).
func KeyCommitment(epochKey []byte, vaultID string, epoch uint64) ([]byte, error) {
	id, err := canonicalUUID(vaultID)
	if err != nil {
		return nil, fmt.Errorf("e2ee: vault id: %w", err)
	}

	data := slices.Concat([]byte(keyCommitmentLabel), id)
	data = binary.BigEndian.AppendUint64(data, epoch)

	return mac(epochKey, data)
}

// VerifyKeyCommitment checks in constant time that epochKey is the key the
// commitment of vaultID's epoch was computed from, and returns
// ErrKeyCommitment otherwise (including for a key or commitment of the wrong
// size).
func VerifyKeyCommitment(epochKey, commitment []byte, vaultID string, epoch uint64) error {
	if len(epochKey) != KeySize {
		return ErrKeyCommitment
	}

	expected, err := KeyCommitment(epochKey, vaultID, epoch)
	if err != nil {
		return err
	}

	if !hmac.Equal(expected, commitment) {
		return ErrKeyCommitment
	}

	return nil
}

// canonicalUUID returns the 16 bytes of a canonical lowercase UUID string.
func canonicalUUID(value string) ([]byte, error) {
	parsed, err := uuid.Parse(value)
	if err != nil || parsed.String() != value {
		return nil, fmt.Errorf("%q is not a canonical lowercase UUID", value)
	}

	return parsed[:], nil
}
