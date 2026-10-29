package vaultimport

import (
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

// EscrowIdentity is an escrow private key (SPEC.md §9.4) the import opens
// an escrowed vault's escrow slots with. It never appears in a log or an
// error.
type EscrowIdentity struct {
	// PrivateKey is the 32-byte hybrid private key.
	PrivateKey []byte
	// KeyID names the key in escrow slots (e2ee.EscrowKeyID of its public
	// key).
	KeyID string
}

// ParseEscrowIdentities parses age hybrid identities (AGE-SECRET-KEY-PQ-1…),
// one per line, with blank lines and lines starting with "#" ignored, as
// age identity files are written. Errors never quote the content.
func ParseEscrowIdentities(content string) ([]EscrowIdentity, error) {
	var identities []EscrowIdentity

	for number, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		privateKey, err := e2ee.ParseAgeIdentity(line)
		if err != nil {
			return nil, fmt.Errorf("line %d is not an age hybrid post-quantum identity (AGE-SECRET-KEY-PQ-1…)", number+1)
		}

		publicKey, err := e2ee.PublicKey(privateKey)
		if err != nil {
			return nil, fmt.Errorf("line %d is not a usable escrow identity", number+1)
		}

		keyID, err := e2ee.EscrowKeyID(publicKey)
		if err != nil {
			return nil, fmt.Errorf("line %d is not a usable escrow identity", number+1)
		}

		identities = append(identities, EscrowIdentity{PrivateKey: privateKey, KeyID: keyID})
	}

	if len(identities) == 0 {
		return nil, errors.New("no escrow identity given")
	}

	return identities, nil
}

// ReadEscrowIdentityFile reads the escrow identities in the age identity
// file at path (ParseEscrowIdentities).
func ReadEscrowIdentityFile(path string) ([]EscrowIdentity, error) {
	content, err := readSecretFile(path)
	if err != nil {
		return nil, err
	}

	identities, err := ParseEscrowIdentities(string(content))
	if err != nil {
		return nil, fmt.Errorf("the escrow identity file %s: %w", path, err)
	}

	return identities, nil
}

// escrowSlots opens the vault's escrow slots with whichever identity the
// slot names: during an escrow key rotation an epoch's slot may still be
// wrapped to the retiring key.
func escrowSlots(identities []EscrowIdentity, genesisHash []byte) slotOpener {
	return slotOpener{
		genesisHash: genesisHash,
		kind:        vaultsyncv1.KeyRecipientKind_KEY_RECIPIENT_KIND_ESCROW,
		whose:       "the escrow",
		missing:     "the vault has no escrow slot for epoch %d: is escrow on for this vault?",
		open: func(vaultID uuid.UUID, slot *vaultsyncv1.KeySlot) ([]byte, error) {
			for _, identity := range identities {
				if identity.KeyID != slot.GetRecipientId() {
					continue
				}

				key, err := e2ee.OpenKeySlot(identity.PrivateKey, slot.GetWrappedKey(), e2ee.KeySlot{
					VaultID: vaultID.String(), Epoch: uint64(slot.GetEpoch()), RecipientKind: e2ee.RecipientEscrow, RecipientID: identity.KeyID,
				})
				if err != nil {
					return nil, fmt.Errorf("the escrow slot for epoch %d does not open with the escrow identity", slot.GetEpoch())
				}

				return key, nil
			}

			return nil, fmt.Errorf("the escrow slot for epoch %d is wrapped to escrow key %s, which the escrow identity file does not hold", slot.GetEpoch(), slot.GetRecipientId())
		},
	}
}
