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
	assert.Equal(t, e2ee.SuiteV2, sealed[0])
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
			name:   "passphrase",
			header: 1 + 4 + 4 + 1 + e2ee.SaltSize,
			seal: func(t *testing.T, aad []byte) []byte {
				t.Helper()

				// The minimum parameters keep the many derivations below cheap.
				params := e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}
				sealed, _, err := e2ee.WrapWithPassphraseParams(passphrase, params, plaintext, aad)
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
				for _, version := range []byte{0x00, 0x01, 0x03, 0x80, 0xff} {
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

func TestWrapWithPassphraseUsesTheDefaultParametersAndAFreshSalt(t *testing.T) {
	first, firstAuthKey, err := e2ee.WrapWithPassphrase("passphrase", []byte("secret"), nil)
	require.NoError(t, err)

	second, secondAuthKey, err := e2ee.WrapWithPassphrase("passphrase", []byte("secret"), nil)
	require.NoError(t, err)

	// memory 65536 KiB, 3 iterations, 1 lane.
	assert.Equal(t, []byte{e2ee.SuiteV2, 0, 1, 0, 0, 0, 0, 0, 3, 1}, first[:10])
	assert.NotEqual(t, first[10:10+e2ee.SaltSize], second[10:10+e2ee.SaltSize])
	assert.NotEqual(t, firstAuthKey, secondAuthKey, "a fresh salt gives a fresh verifier")

	_, _, err = e2ee.WrapWithPassphrase("", []byte("secret"), nil)
	require.Error(t, err)
}

// An unlock derives once: it reads the parameters and salt, derives both
// keys, presents the auth key to the server and opens the wrapped secret with
// the wrap key. The auth key, which the server sees, opens nothing.
func TestPassphraseAuthKeyDoesNotOpenTheWrappedSecret(t *testing.T) {
	params := e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}
	secret := []byte("user private key")
	aad := []byte("user 1")

	wrapped, authKey, err := e2ee.WrapWithPassphraseParams("passphrase", params, secret, aad)
	require.NoError(t, err)
	require.Len(t, authKey, e2ee.KeySize)

	parsedParams, salt, err := e2ee.ParsePassphraseHeader(wrapped[:1+4+4+1+e2ee.SaltSize])
	require.NoError(t, err)
	assert.Equal(t, params, parsedParams)

	keys, err := e2ee.DerivePassphraseKeys("passphrase", parsedParams, salt)
	require.NoError(t, err)
	assert.Equal(t, authKey, keys.AuthKey)
	assert.NotEqual(t, keys.WrapKey, keys.AuthKey)

	opened, err := e2ee.UnwrapWithKey(keys.WrapKey, wrapped, aad)
	require.NoError(t, err)
	assert.Equal(t, secret, opened)

	_, err = e2ee.UnwrapWithKey(keys.AuthKey, wrapped, aad)
	require.ErrorIs(t, err, e2ee.ErrDecrypt)

	assert.NotContains(t, string(wrapped), string(authKey))
}

func TestDerivePassphraseKeysRefusesBadInput(t *testing.T) {
	params := e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}
	salt := bytes.Repeat([]byte{1}, e2ee.SaltSize)

	tests := []struct {
		name       string
		passphrase string
		params     e2ee.Argon2Params
		salt       []byte
	}{
		{name: "empty passphrase", passphrase: "", params: params, salt: salt},
		{name: "short salt", passphrase: "passphrase", params: params, salt: salt[1:]},
		{name: "memory below minimum", passphrase: "passphrase", params: e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory - 1, Iterations: 2, Parallelism: 1}, salt: salt},
		{name: "iterations above maximum", passphrase: "passphrase", params: e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MaxArgon2Iterations + 1, Parallelism: 1}, salt: salt},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := e2ee.DerivePassphraseKeys(test.passphrase, test.params, test.salt)
			require.Error(t, err)
		})
	}
}

func TestParsePassphraseHeaderRefusesBadHeaders(t *testing.T) {
	wrapped, _, err := e2ee.WrapWithPassphraseParams("passphrase",
		e2ee.Argon2Params{Memory: e2ee.MinArgon2Memory, Iterations: e2ee.MinArgon2Iterations, Parallelism: 1}, []byte("secret"), nil)
	require.NoError(t, err)

	header := wrapped[:1+4+4+1+e2ee.SaltSize]

	otherSuite := slices.Clone(header)
	otherSuite[0] = 0x01

	zeroLanes := slices.Clone(header)
	zeroLanes[9] = 0

	for name, input := range map[string][]byte{"short": header[:len(header)-1], "other suite": otherSuite, "zero lanes": zeroLanes} {
		t.Run(name, func(t *testing.T) {
			_, _, err := e2ee.ParsePassphraseHeader(input)
			require.ErrorIs(t, err, e2ee.ErrDecrypt)

			_, err = e2ee.UnwrapWithKey(bytes.Repeat([]byte{1}, e2ee.KeySize), slices.Concat(input, wrapped[len(header):]), nil)
			require.ErrorIs(t, err, e2ee.ErrDecrypt)
		})
	}
}

func TestDeriveSubkey(t *testing.T) {
	epochKey := bytes.Repeat([]byte{7}, e2ee.KeySize)

	subkeys := map[string]struct{}{}

	for _, label := range []e2ee.Label{e2ee.LabelContent, e2ee.LabelPath, e2ee.LabelPathKeySecret} {
		subkey, err := e2ee.DeriveSubkey(epochKey, label)
		require.NoError(t, err)
		require.Len(t, subkey, e2ee.KeySize)

		subkeys[string(subkey)] = struct{}{}
	}

	assert.Len(t, subkeys, 3, "every label derives a different key")

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

func TestPathADAndContentADFollowTheDocumentedLayout(t *testing.T) {
	const (
		vaultID    = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e"
		documentID = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0f"
	)

	vault := []byte{0x01, 0x90, 0xd6, 0xe4, 0x8c, 0x1e, 0x7a, 0x3b, 0x9d, 0x2f, 0x5e, 0x6a, 0x7b, 0x8c, 0x9d, 0x0e}
	document := []byte{0x01, 0x90, 0xd6, 0xe4, 0x8c, 0x1e, 0x7a, 0x3b, 0x9d, 0x2f, 0x5e, 0x6a, 0x7b, 0x8c, 0x9d, 0x0f}
	epoch := []byte{0, 0, 0, 0, 0, 0, 0x01, 0x02}

	pathAD, err := e2ee.PathAD(vaultID, documentID, 0x0102)
	require.NoError(t, err)
	assert.Equal(t, slices.Concat([]byte("vault-sync/v1/path"), vault, document, epoch), pathAD)

	contentAD, err := e2ee.ContentAD(vaultID, 0x0102)
	require.NoError(t, err)
	assert.Equal(t, slices.Concat([]byte("vault-sync/v1/content"), vault, epoch), contentAD)

	_, err = e2ee.PathAD("0190D6E4-8C1E-7A3B-9D2F-5E6A7B8C9D0E", documentID, 1)
	require.Error(t, err)

	_, err = e2ee.PathAD(vaultID, "not-a-uuid", 1)
	require.Error(t, err)

	_, err = e2ee.ContentAD("", 1)
	require.Error(t, err)
}
