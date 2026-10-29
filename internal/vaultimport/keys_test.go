package vaultimport_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

func writeSecret(t *testing.T, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "secret")
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))

	return path
}

func TestReadPassphraseFile(t *testing.T) {
	for _, test := range []struct {
		name     string
		content  string
		expected string
		errorFn  require.ErrorAssertionFunc
	}{
		{name: "the whole file", content: "  two words  ", expected: "  two words  "},
		{name: "without one trailing newline", content: "passphrase\n", expected: "passphrase"},
		{name: "without one trailing CRLF", content: "passphrase\r\n", expected: "passphrase"},
		{name: "an empty file is refused", content: "\n", errorFn: require.Error},
	} {
		t.Run(test.name, func(t *testing.T) {
			errorFn := test.errorFn
			if errorFn == nil {
				errorFn = require.NoError
			}

			passphrase, err := vaultimport.ReadPassphraseFile(writeSecret(t, test.content))
			errorFn(t, err)
			assert.Equal(t, test.expected, passphrase)
		})
	}

	t.Run("a file over 64 KiB is refused", func(t *testing.T) {
		_, err := vaultimport.ReadPassphraseFile(writeSecret(t, string(bytes.Repeat([]byte("a"), 64<<10+1))))
		require.Error(t, err)

		_, err = vaultimport.ReadPassphraseFile(writeSecret(t, string(bytes.Repeat([]byte("a"), 64<<10))))
		require.NoError(t, err)
	})
}

func TestReadPrivateKeyFile(t *testing.T) {
	privateKey, _, err := e2ee.GenerateKeyPair()
	require.NoError(t, err)

	identity, err := e2ee.AgeIdentity(privateKey)
	require.NoError(t, err)

	t.Run("an age identity with comments", func(t *testing.T) {
		read, err := vaultimport.ReadPrivateKeyFile(writeSecret(t, "# created: today\n\n"+identity+"\n"))
		require.NoError(t, err)
		assert.Equal(t, privateKey, read)
	})

	for _, test := range []struct {
		name    string
		content string
	}{
		{name: "no key", content: "# nothing\n"},
		{name: "two keys", content: identity + "\n" + identity + "\n"},
		{name: "not an identity", content: "hunter2 is not a key\n"},
	} {
		t.Run(test.name+" is refused without quoting the file", func(t *testing.T) {
			_, err := vaultimport.ReadPrivateKeyFile(writeSecret(t, test.content))
			require.Error(t, err)
			assert.NotContains(t, err.Error(), "hunter2")
			assert.NotContains(t, err.Error(), identity)
		})
	}
}

func TestMainRefusesMoreThanOneSecret(t *testing.T) {
	for _, flags := range [][]string{
		{"-passphrase-file", "a", "-private-key-file", "b"},
		{"-passphrase-file", "a", "-escrow-identity-file", "b"},
		{"-private-key-file", "a", "-escrow"},
		{"-escrow-identity-file", "a", "-escrow"},
	} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			code := vaultimport.Main(t.Context(), append(flags, "https://sync.example.com", "0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12", t.TempDir()),
				func(string) (string, bool) { return "", false }, &stdout, &stderr)

			assert.Equal(t, 2, code)
			assert.Contains(t, stderr.String(), "at most one")
		})
	}
}

func TestReadEscrowIdentityFile(t *testing.T) {
	var (
		identities []string
		keyIDs     []string
	)

	for range 2 {
		privateKey, publicKey, err := e2ee.GenerateKeyPair()
		require.NoError(t, err)

		identity, err := e2ee.AgeIdentity(privateKey)
		require.NoError(t, err)

		keyID, err := e2ee.EscrowKeyID(publicKey)
		require.NoError(t, err)

		identities = append(identities, identity)
		keyIDs = append(keyIDs, keyID)
	}

	t.Run("every identity of an age identity file, with comments", func(t *testing.T) {
		read, err := vaultimport.ReadEscrowIdentityFile(writeSecret(t, "# created: today\n"+identities[0]+"\n\n# retiring\n"+identities[1]+"\n"))
		require.NoError(t, err)
		require.Len(t, read, 2)

		for index, identity := range read {
			assert.Equal(t, keyIDs[index], identity.KeyID, "identity %d is named by its public key's id", index)

			parsed, err := e2ee.ParseAgeIdentity(identities[index])
			require.NoError(t, err)
			assert.Equal(t, parsed, identity.PrivateKey)
		}
	})

	for _, test := range []struct {
		name    string
		content string
	}{
		{name: "no identity", content: "# nothing\n"},
		{name: "not an identity", content: identities[0] + "\nhunter2 is not a key\n"},
	} {
		t.Run(test.name+" is refused without quoting the file", func(t *testing.T) {
			_, err := vaultimport.ReadEscrowIdentityFile(writeSecret(t, test.content))
			require.Error(t, err)
			assert.NotContains(t, err.Error(), "hunter2")
			assert.NotContains(t, err.Error(), identities[0])
		})
	}
}
