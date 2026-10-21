package e2ee

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKeySlotRoundTrip(t *testing.T) {
	privateKey, publicKey, err := GenerateKeyPair()
	require.NoError(t, err)

	epochKey, err := GenerateKey()
	require.NoError(t, err)

	slot := KeySlot{VaultID: vectorVaultID, Epoch: 7, RecipientKind: RecipientUser, RecipientID: vectorUserID}

	wrapped, err := SealKeySlot(publicKey, epochKey, slot)
	require.NoError(t, err)

	again, err := SealKeySlot(publicKey, epochKey, slot)
	require.NoError(t, err)
	assert.NotEqual(t, wrapped, again, "every seal draws a fresh ephemeral key and nonce")

	opened, err := OpenKeySlot(privateKey, wrapped, slot)
	require.NoError(t, err)
	assert.Equal(t, epochKey, opened)

	commitment, err := KeyCommitment(epochKey, slot.VaultID, slot.Epoch)
	require.NoError(t, err)
	require.NoError(t, VerifyKeyCommitment(opened, commitment, slot.VaultID, slot.Epoch))
}

func TestKeySlotAD(t *testing.T) {
	tests := []struct {
		name        string
		slot        KeySlot
		size        int
		errorAssert require.ErrorAssertionFunc
	}{
		{name: "user", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}, size: 22 + 16 + 8 + 1 + 1 + 16},
		{name: "epoch zero", slot: KeySlot{VaultID: vectorVaultID, Epoch: 0, RecipientKind: RecipientUser, RecipientID: vectorUserID}, size: 64},
		{name: "escrow, 1-byte id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientEscrow, RecipientID: "e"}, size: 22 + 16 + 8 + 1 + 1 + 1},
		{name: "escrow, 255-byte id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientEscrow, RecipientID: strings.Repeat("e", 255)}, size: 22 + 16 + 8 + 1 + 1 + 255},
		{name: "escrow, 256-byte id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientEscrow, RecipientID: strings.Repeat("e", 256)}, errorAssert: require.Error},
		{name: "escrow, empty id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientEscrow}, errorAssert: require.Error},
		{name: "escrow, invalid UTF-8 id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientEscrow, RecipientID: "e\xff"}, errorAssert: require.Error},
		{name: "unknown kind", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: "device", RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "empty kind", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "uppercase vault id", slot: KeySlot{VaultID: strings.ToUpper(vectorVaultID), Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "vault id without hyphens", slot: KeySlot{VaultID: strings.ReplaceAll(vectorVaultID, "-", ""), Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "braced vault id", slot: KeySlot{VaultID: "{" + vectorVaultID + "}", Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "empty vault id", slot: KeySlot{Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}, errorAssert: require.Error},
		{name: "uppercase user id", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: strings.ToUpper(vectorUserID)}, errorAssert: require.Error},
		{name: "user id not a UUID", slot: KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorEscrowID}, errorAssert: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			errorAssert := test.errorAssert
			if errorAssert == nil {
				errorAssert = require.NoError
			}

			ad, err := test.slot.AD()
			errorAssert(t, err)

			if err == nil {
				assert.Len(t, ad, test.size)
				assert.True(t, strings.HasPrefix(string(ad), "vault-sync/v1/key-slot"))
			}

			// Sealing and opening refuse the same slots.
			_, publicKey, keyErr := GenerateKeyPair()
			require.NoError(t, keyErr)

			_, err = SealKeySlot(publicKey, make([]byte, KeySize), test.slot)
			errorAssert(t, err)
		})
	}
}

func TestOpenKeySlotRefusesAnInvalidSlot(t *testing.T) {
	privateKey, publicKey, err := GenerateKeyPair()
	require.NoError(t, err)

	slot := KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}
	wrapped, err := SealKeySlot(publicKey, make([]byte, KeySize), slot)
	require.NoError(t, err)

	slot.VaultID = strings.ToUpper(slot.VaultID)
	_, err = OpenKeySlot(privateKey, wrapped, slot)
	require.Error(t, err)
}

func TestSealKeySlotRefusesAKeyOfTheWrongSize(t *testing.T) {
	_, publicKey, err := GenerateKeyPair()
	require.NoError(t, err)

	slot := KeySlot{VaultID: vectorVaultID, Epoch: 1, RecipientKind: RecipientUser, RecipientID: vectorUserID}

	for _, size := range []int{0, KeySize - 1, KeySize + 1} {
		_, err := SealKeySlot(publicKey, make([]byte, size), slot)
		require.Error(t, err, size)
	}
}

func TestKeyCommitment(t *testing.T) {
	epochKey := fixed("commitment test key", KeySize)
	commitment, err := KeyCommitment(epochKey, vectorVaultID, 1)
	require.NoError(t, err)
	assert.Len(t, commitment, MACSize)

	tests := []struct {
		name        string
		epochKey    []byte
		vaultID     string
		epoch       uint64
		commitment  []byte
		errorAssert require.ErrorAssertionFunc
	}{
		{name: "matching key", epochKey: epochKey, vaultID: vectorVaultID, epoch: 1, commitment: commitment},
		{name: "other key", epochKey: fixed("other", KeySize), vaultID: vectorVaultID, epoch: 1, commitment: commitment, errorAssert: errorIs(ErrKeyCommitment)},
		{name: "31-byte key", epochKey: epochKey[:KeySize-1], vaultID: vectorVaultID, epoch: 1, commitment: commitment, errorAssert: errorIs(ErrKeyCommitment)},
		{name: "other vault", epochKey: epochKey, vaultID: vectorOtherVaultID, epoch: 1, commitment: commitment, errorAssert: errorIs(ErrKeyCommitment)},
		{name: "other epoch", epochKey: epochKey, vaultID: vectorVaultID, epoch: 2, commitment: commitment, errorAssert: errorIs(ErrKeyCommitment)},
		{name: "non-canonical vault id", epochKey: epochKey, vaultID: strings.ToUpper(vectorVaultID), epoch: 1, commitment: commitment, errorAssert: require.Error},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			errorAssert := test.errorAssert
			if errorAssert == nil {
				errorAssert = require.NoError
			}

			errorAssert(t, VerifyKeyCommitment(test.epochKey, test.commitment, test.vaultID, test.epoch))
		})
	}

	_, err = KeyCommitment(epochKey[:KeySize-1], vectorVaultID, 1)
	require.Error(t, err)
}

func errorIs(target error) require.ErrorAssertionFunc {
	return func(t require.TestingT, err error, _ ...any) {
		require.ErrorIs(t, err, target)
	}
}
