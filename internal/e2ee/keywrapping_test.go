package e2ee

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// hybridStanzaType is age's recipient stanza type of the hybrid X25519 +
// ML-KEM-768 recipient (age's C2SP specification).
const hybridStanzaType = "mlkem768x25519"

// stanzaTypes returns the type of each recipient stanza in the header of
// the binary age file sealed, read from the documented age format: the
// version line, then one `-> TYPE args` line per stanza, up to the `---`
// MAC line.
func stanzaTypes(t *testing.T, sealed []byte) []string {
	t.Helper()

	end := bytes.Index(sealed, []byte("\n--- "))
	require.Positive(t, end, "an age header ends with its MAC line")

	lines := strings.Split(string(sealed[:end]), "\n")
	require.Equal(t, "age-encryption.org/v1", lines[0])

	types := []string{}

	for _, line := range lines[1:] {
		if arguments, ok := strings.CutPrefix(line, "-> "); ok {
			types = append(types, strings.Fields(arguments)[0])
		}
	}

	return types
}

func TestKeyWrappingIsHybridPostQuantum(t *testing.T) {
	t.Run("[P4-17] every key slot, for a member, an invitation and the escrow, is wrapped to the hybrid X25519 + ML-KEM-768 recipient alone", func(t *testing.T) {
		slots := []KeySlot{
			{VaultID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e", Epoch: 1, RecipientKind: RecipientUser, RecipientID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0f"},
			{VaultID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e", Epoch: 2, RecipientKind: RecipientInvitation, RecipientID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d10"},
			{VaultID: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e", Epoch: 3, RecipientKind: RecipientEscrow, RecipientID: "escrow-2026"},
		}

		for _, slot := range slots {
			private, public, err := GenerateKeyPair()
			require.NoError(t, err)

			epochKey, err := GenerateKey()
			require.NoError(t, err)

			wrapped, err := SealKeySlot(public, epochKey, slot)
			require.NoError(t, err)
			assert.Equal(t, []string{hybridStanzaType}, stanzaTypes(t, wrapped), string(slot.RecipientKind))

			opened, err := OpenKeySlot(private, wrapped, slot)
			require.NoError(t, err)
			assert.Equal(t, epochKey, opened)
		}

		file := loadVectorFile(t)
		require.NotEmpty(t, file.KeySlot)
		require.NotEmpty(t, file.Hybrid)

		for _, vector := range file.KeySlot {
			sealed, err := hex.DecodeString(vector.Sealed)
			require.NoError(t, err)
			assert.Equal(t, []string{hybridStanzaType}, stanzaTypes(t, sealed), vector.Name)
		}

		for _, vector := range file.Hybrid {
			sealed, err := hex.DecodeString(vector.Sealed)
			require.NoError(t, err)
			assert.Equal(t, []string{hybridStanzaType}, stanzaTypes(t, sealed), vector.Name)
		}
	})
}
