package e2ee_test

import (
	"bytes"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

func newKey(t *testing.T) []byte {
	t.Helper()

	key, err := e2ee.GenerateKey()
	require.NoError(t, err)
	require.Len(t, key, e2ee.KeySize)

	return key
}

func TestSealOpensOnlyWithItsKeyAndAAD(t *testing.T) {
	key := newKey(t)
	plaintext := []byte("# Note\n")
	aad := []byte("document 1, epoch 1")

	sealed, err := e2ee.Seal(key, plaintext, aad)
	require.NoError(t, err)
	assert.Equal(t, e2ee.SuiteV1, sealed[0])
	assert.Len(t, sealed, 1+e2ee.NonceSize+len(plaintext)+e2ee.TagSize)

	opened, err := e2ee.Open(key, sealed, aad)
	require.NoError(t, err)
	assert.Equal(t, plaintext, opened)

	_, err = e2ee.Open(newKey(t), sealed, aad)
	require.ErrorIs(t, err, e2ee.ErrDecrypt)

	_, err = e2ee.Open(key, sealed, []byte("document 2, epoch 1"))
	require.ErrorIs(t, err, e2ee.ErrDecrypt)
}

// construction seals a fixed plaintext and opens a (possibly tampered)
// ciphertext with the right key; header is the size of its header.
type construction struct {
	name   string
	header int
	seal   func(t *testing.T, aad []byte) []byte
	open   func(sealed, aad []byte) ([]byte, error)
}

func constructions(t *testing.T) []construction {
	t.Helper()

	key := newKey(t)

	private, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	const passphrase = "correct horse battery staple"

	plaintext := []byte("k")

	return []construction{
		{
			name:   "aead",
			header: 1,
			seal: func(t *testing.T, aad []byte) []byte {
				t.Helper()

				sealed, err := e2ee.Seal(key, plaintext, aad)
				require.NoError(t, err)

				return sealed
			},
			open: func(sealed, aad []byte) ([]byte, error) { return e2ee.Open(key, sealed, aad) },
		},
		{
			name:   "sealed box",
			header: 1 + e2ee.KeySize,
			seal: func(t *testing.T, aad []byte) []byte {
				t.Helper()

				sealed, err := e2ee.SealTo(public, plaintext, aad)
				require.NoError(t, err)

				return sealed
			},
			open: func(sealed, aad []byte) ([]byte, error) { return e2ee.OpenFrom(private, sealed, aad) },
		},
		{
			name:   "passphrase",
			header: 1 + 4 + 4 + 1 + e2ee.SaltSize,
			seal: func(t *testing.T, aad []byte) []byte {
				t.Helper()

				// The minimum parameters keep the many derivations below cheap.
				params := e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}
				sealed, err := e2ee.WrapWithPassphraseParams(passphrase, params, plaintext, aad)
				require.NoError(t, err)

				return sealed
			},
			open: func(sealed, aad []byte) ([]byte, error) { return e2ee.UnwrapWithPassphrase(passphrase, sealed, aad) },
		},
	}
}

func TestOpenFailsClosed(t *testing.T) {
	for _, construction := range constructions(t) {
		t.Run(construction.name, func(t *testing.T) {
			t.Parallel()

			aad := []byte("vault 1, epoch 3")
			sealed := construction.seal(t, aad)

			opened, err := construction.open(sealed, aad)
			require.NoError(t, err)
			require.NotEmpty(t, opened)

			t.Run("unknown suite version", func(t *testing.T) {
				for _, version := range []byte{0x00, 0x02, 0x80, 0xff} {
					tampered := slices.Clone(sealed)
					tampered[0] = version

					_, err := construction.open(tampered, aad)
					require.ErrorIs(t, err, e2ee.ErrDecrypt, "version %#x", version)
				}
			})

			t.Run("modified aad", func(t *testing.T) {
				for _, other := range [][]byte{nil, []byte("vault 1, epoch 4"), append(slices.Clone(aad), 0)} {
					_, err := construction.open(sealed, other)
					require.ErrorIs(t, err, e2ee.ErrDecrypt, "aad %q", other)
				}
			})

			t.Run("truncated", func(t *testing.T) {
				for length := range len(sealed) {
					_, err := construction.open(sealed[:length], aad)
					require.ErrorIs(t, err, e2ee.ErrDecrypt, "length %d of %d", length, len(sealed))
				}
			})

			t.Run("any flipped header or tag bit", func(t *testing.T) {
				positions := []int{len(sealed) - 1, len(sealed) - e2ee.TagSize}
				for index := range construction.header + e2ee.NonceSize {
					positions = append(positions, index)
				}

				for _, index := range positions {
					tampered := slices.Clone(sealed)
					tampered[index] ^= 0x01

					_, err := construction.open(tampered, aad)
					require.ErrorIs(t, err, e2ee.ErrDecrypt, "byte %d", index)
				}
			})
		})
	}
}

func TestSealDrawsAFreshNonceEveryTime(t *testing.T) {
	const samples = 200_000

	key := newKey(t)
	seen := make(map[[e2ee.NonceSize]byte]struct{}, samples)

	for range samples {
		sealed, err := e2ee.Seal(key, nil, nil)
		require.NoError(t, err)

		nonce := [e2ee.NonceSize]byte(sealed[1 : 1+e2ee.NonceSize])
		_, reused := seen[nonce]
		require.False(t, reused, "nonce reused after %d seals", len(seen))

		seen[nonce] = struct{}{}
	}
}

func TestSealToDrawsAFreshEphemeralKeyAndNonceEveryTime(t *testing.T) {
	const samples = 2_000

	_, public, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	ephemeralKeys := make(map[[e2ee.KeySize]byte]struct{}, samples)
	nonces := make(map[[e2ee.NonceSize]byte]struct{}, samples)

	for range samples {
		sealed, err := e2ee.SealTo(public, nil, nil)
		require.NoError(t, err)

		ephemeralKeys[[e2ee.KeySize]byte(sealed[1:1+e2ee.KeySize])] = struct{}{}
		nonces[[e2ee.NonceSize]byte(sealed[1+e2ee.KeySize:1+e2ee.KeySize+e2ee.NonceSize])] = struct{}{}
	}

	assert.Len(t, ephemeralKeys, samples)
	assert.Len(t, nonces, samples)
}

func TestSealToRefusesALowOrderRecipient(t *testing.T) {
	_, err := e2ee.SealTo(make([]byte, e2ee.KeySize), []byte("epoch key"), nil)
	require.Error(t, err)
}

func TestWrapWithPassphraseUsesTheDefaultParametersAndAFreshSalt(t *testing.T) {
	first, err := e2ee.WrapWithPassphrase("passphrase", []byte("secret"), nil)
	require.NoError(t, err)

	second, err := e2ee.WrapWithPassphrase("passphrase", []byte("secret"), nil)
	require.NoError(t, err)

	// memory 65536 KiB, 3 iterations, 1 lane.
	assert.Equal(t, []byte{e2ee.SuiteV1, 0, 1, 0, 0, 0, 0, 0, 3, 1}, first[:10])
	assert.NotEqual(t, first[10:10+e2ee.SaltSize], second[10:10+e2ee.SaltSize])

	_, err = e2ee.WrapWithPassphrase("", []byte("secret"), nil)
	require.Error(t, err)
}

func TestDeriveSubkey(t *testing.T) {
	epochKey := bytes.Repeat([]byte{7}, e2ee.KeySize)

	subkeys := map[string]struct{}{}

	for _, label := range []e2ee.Label{e2ee.LabelContent, e2ee.LabelPath, e2ee.LabelPathKeySecret, e2ee.LabelBlobIDSecret} {
		subkey, err := e2ee.DeriveSubkey(epochKey, label)
		require.NoError(t, err)
		require.Len(t, subkey, e2ee.KeySize)

		subkeys[string(subkey)] = struct{}{}
	}

	assert.Len(t, subkeys, 4, "every label derives a different key")

	tests := []struct {
		name     string
		epochKey []byte
		label    e2ee.Label
	}{
		{name: "unknown label", epochKey: epochKey, label: "contents"},
		{name: "empty label", epochKey: epochKey, label: ""},
		{name: "short epoch key", epochKey: epochKey[:31], label: e2ee.LabelContent},
		{name: "long epoch key", epochKey: append(slices.Clone(epochKey), 0), label: e2ee.LabelContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := e2ee.DeriveSubkey(test.epochKey, test.label)
			require.Error(t, err)
		})
	}
}

func TestPathKeyIgnoresCaseAndNormalization(t *testing.T) {
	secret := newKey(t)

	upper, err := e2ee.PathKey(secret, "Notes/CAFÉ.md")
	require.NoError(t, err)

	lower, err := e2ee.PathKey(secret, "notes/café.md")
	require.NoError(t, err)

	other, err := e2ee.PathKey(newKey(t), "notes/café.md")
	require.NoError(t, err)

	assert.Equal(t, upper, lower)
	assert.NotEqual(t, lower, other)
	assert.Len(t, lower, e2ee.MACSize)
}
