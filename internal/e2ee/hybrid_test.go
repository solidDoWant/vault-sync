package e2ee_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"

	"filippo.io/age"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

func TestHybridKeyPairIsAnAgeHybridIdentity(t *testing.T) {
	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)
	require.Len(t, private, e2ee.PrivateKeySize)
	require.Len(t, public, e2ee.PublicKeySize)

	derived, err := e2ee.PublicKey(private)
	require.NoError(t, err)
	assert.Equal(t, public, derived)

	identityString, err := e2ee.AgeIdentity(private)
	require.NoError(t, err)

	identity, err := age.ParseHybridIdentity(identityString)
	require.NoError(t, err)

	recipientString, err := e2ee.AgeRecipient(public)
	require.NoError(t, err)
	assert.Equal(t, identity.Recipient().String(), recipientString)
}

func TestSealToRoundTripsThroughAge(t *testing.T) {
	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	plaintext := []byte("epoch key")

	sealed, err := e2ee.SealTo(public, plaintext)
	require.NoError(t, err)
	assert.True(t, bytes.HasPrefix(sealed, []byte("age-encryption.org/v1\n-> mlkem768x25519 ")), "a binary age file to a hybrid recipient")

	again, err := e2ee.SealTo(public, plaintext)
	require.NoError(t, err)
	assert.NotEqual(t, sealed, again, "every seal draws fresh randomness")

	opened, err := e2ee.OpenFrom(private, sealed)
	require.NoError(t, err)
	assert.Equal(t, plaintext, opened)

	other, _, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	_, err = e2ee.OpenFrom(other, sealed)
	require.ErrorIs(t, err, e2ee.ErrDecrypt)
}

func TestOpenFromBoundsTheInput(t *testing.T) {
	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	empty, err := e2ee.SealTo(public, nil)
	require.NoError(t, err)

	// The payload grows byte for byte with the plaintext, so these files are
	// exactly at and one byte over the bound.
	atBound, err := e2ee.SealTo(public, make([]byte, e2ee.MaxSealedSize-len(empty)))
	require.NoError(t, err)
	require.Len(t, atBound, e2ee.MaxSealedSize)

	overBound, err := e2ee.SealTo(public, make([]byte, e2ee.MaxSealedSize-len(empty)+1))
	require.NoError(t, err)
	require.Len(t, overBound, e2ee.MaxSealedSize+1)

	_, err = e2ee.OpenFrom(private, atBound)
	require.NoError(t, err)

	_, err = e2ee.OpenFrom(private, overBound)
	require.ErrorIs(t, err, e2ee.ErrDecrypt)
}

func TestHybridRefusesKeysOfTheWrongSize(t *testing.T) {
	_, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	_, err = e2ee.SealTo(public[:len(public)-1], []byte("k"))
	require.Error(t, err)

	_, err = e2ee.SealTo(append(slices.Clone(public), 0), []byte("k"))
	require.Error(t, err)

	_, err = e2ee.PublicKey(make([]byte, e2ee.PrivateKeySize-1))
	require.Error(t, err)

	_, err = e2ee.OpenFrom(make([]byte, e2ee.PrivateKeySize+1), []byte("age-encryption.org/v1\n"))
	require.Error(t, err)
}

// TestTheAgeToolOpensAnEscrowSlot runs the standard age command (built from
// filippo.io/age, a tool of this module) on an escrow slot with the escrow
// identity: it prints the epoch key followed by the slot's associated data.
func TestTheAgeToolOpensAnEscrowSlot(t *testing.T) {
	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	epochKey, err := e2ee.GenerateKey()
	require.NoError(t, err)

	slot := e2ee.KeySlot{VaultID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e", Epoch: 3, RecipientKind: e2ee.RecipientEscrow, RecipientID: "escrow-2026"}

	wrapped, err := e2ee.SealKeySlot(public, epochKey, slot)
	require.NoError(t, err)

	identity, err := e2ee.AgeIdentity(private)
	require.NoError(t, err)

	directory := t.TempDir()
	identityPath := filepath.Join(directory, "escrow.key")
	slotPath := filepath.Join(directory, "slot.age")

	require.NoError(t, os.WriteFile(identityPath, []byte(identity+"\n"), 0o600))
	require.NoError(t, os.WriteFile(slotPath, wrapped, 0o600))

	command := exec.CommandContext(t.Context(), "go", "tool", "age", "--decrypt", "--identity", identityPath, slotPath)

	var stderr bytes.Buffer

	command.Stderr = &stderr

	output, err := command.Output()
	require.NoError(t, err, stderr.String())

	ad, err := slot.AD()
	require.NoError(t, err)
	assert.Equal(t, slices.Concat(epochKey, ad), output)
	assert.Equal(t, epochKey, output[:e2ee.KeySize])
}
