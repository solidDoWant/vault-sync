package escrowcmd_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/escrowcmd"
)

// escrowVector is one escrow bundle of the shared crypto vectors, with its
// fingerprint as displayed.
type escrowVector struct {
	Name               string `json:"name"`
	SignPub            string `json:"sign_pub"`
	Recipient          string `json:"recipient"`
	FingerprintDisplay string `json:"fingerprint_display"`
}

func loadEscrowVectors(t *testing.T) []escrowVector {
	t.Helper()

	raw, err := os.ReadFile("../../testdata/crypto/vectors.json")
	require.NoError(t, err)

	var file struct {
		IdentityKeys struct {
			EscrowBundles []escrowVector `json:"escrow_bundles"`
		} `json:"identity_keys"`
	}
	require.NoError(t, json.Unmarshal(raw, &file))
	require.NotEmpty(t, file.IdentityKeys.EscrowBundles)

	return file.IdentityKeys.EscrowBundles
}

func signingKey(t *testing.T, vector escrowVector) string {
	t.Helper()

	signPub, err := hex.DecodeString(vector.SignPub)
	require.NoError(t, err)

	return base64.StdEncoding.EncodeToString(signPub)
}

func run(args []string, env map[string]string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer

	lookup := func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}

	code = escrowcmd.Main(args, lookup, &out, &errOut)

	return code, out.String(), errOut.String()
}

func TestFingerprintPrintsTheEscrowFingerprintAsDisplayed(t *testing.T) {
	vectors := loadEscrowVectors(t)
	one, two := vectors[0], vectors[1]

	tests := []struct {
		name   string
		args   []string
		env    map[string]string
		vector escrowVector
	}{
		{
			name:   "from the flags",
			args:   []string{"fingerprint", "--recipient", one.Recipient, "--signing-key", signingKey(t, one)},
			vector: one,
		},
		{
			name:   "from the flags over the environment",
			args:   []string{"fingerprint", "-recipient", two.Recipient, "-signing-key", signingKey(t, two)},
			env:    map[string]string{"VAULT_SYNC_ESCROW_RECIPIENT": one.Recipient, "VAULT_SYNC_ESCROW_SIGNING_KEY": signingKey(t, one)},
			vector: two,
		},
		{
			name:   "from the environment",
			args:   []string{"fingerprint"},
			env:    map[string]string{"VAULT_SYNC_ESCROW_RECIPIENT": two.Recipient, "VAULT_SYNC_ESCROW_SIGNING_KEY": signingKey(t, two)},
			vector: two,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := run(test.args, test.env)
			require.Equal(t, 0, code, stderr)
			assert.Equal(t, test.vector.FingerprintDisplay+"\n", stdout)
		})
	}
}

func TestFingerprintCoversBothKeysOfThePair(t *testing.T) {
	vectors := loadEscrowVectors(t)
	one, two := vectors[0], vectors[1]

	_, sameRecipient, _ := run([]string{"fingerprint", "--recipient", one.Recipient, "--signing-key", signingKey(t, two)}, nil)
	_, sameSigningKey, _ := run([]string{"fingerprint", "--recipient", two.Recipient, "--signing-key", signingKey(t, one)}, nil)

	for _, output := range []string{sameRecipient, sameSigningKey} {
		require.NotEmpty(t, output)
		assert.NotEqual(t, one.FingerprintDisplay+"\n", output)
		assert.NotEqual(t, two.FingerprintDisplay+"\n", output)
	}
}

func TestFingerprintRejectsMalformedInputWithoutQuotingIt(t *testing.T) {
	vector := loadEscrowVectors(t)[0]
	key := signingKey(t, vector)
	shortKey := base64.StdEncoding.EncodeToString(make([]byte, 31))
	longKey := base64.StdEncoding.EncodeToString(make([]byte, 33))
	classicRecipient := "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"

	tests := []struct {
		name   string
		args   []string
		env    map[string]string
		secret string
		code   int
	}{
		{name: "no subcommand", args: nil, code: 2},
		{name: "unknown subcommand", args: []string{"rotate"}, code: 2},
		{name: "extra argument", args: []string{"fingerprint", "--recipient", vector.Recipient, "--signing-key", key, "extra"}, code: 2},
		{name: "nothing given", args: []string{"fingerprint"}, code: 2},
		{name: "recipient only", args: []string{"fingerprint", "--recipient", vector.Recipient}, code: 2},
		{name: "signing key only", env: map[string]string{"VAULT_SYNC_ESCROW_SIGNING_KEY": key}, args: []string{"fingerprint"}, code: 2},
		{name: "classic recipient", args: []string{"fingerprint", "--recipient", classicRecipient, "--signing-key", key}, secret: classicRecipient, code: 1},
		{name: "garbled recipient", args: []string{"fingerprint", "--recipient", vector.Recipient[:40] + "zz", "--signing-key", key}, secret: vector.Recipient[:40], code: 1},
		{name: "recipient in the environment", env: map[string]string{"VAULT_SYNC_ESCROW_RECIPIENT": "age1pq1notarecipient", "VAULT_SYNC_ESCROW_SIGNING_KEY": key}, args: []string{"fingerprint"}, secret: "notarecipient", code: 1},
		{name: "signing key not base64", args: []string{"fingerprint", "--recipient", vector.Recipient, "--signing-key", "not*base64"}, secret: "not*base64", code: 1},
		{name: "signing key of 31 bytes", args: []string{"fingerprint", "--recipient", vector.Recipient, "--signing-key", shortKey}, secret: shortKey, code: 1},
		{name: "signing key of 33 bytes", args: []string{"fingerprint", "--recipient", vector.Recipient, "--signing-key", longKey}, secret: longKey, code: 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := run(test.args, test.env)
			assert.Equal(t, test.code, code)
			assert.Empty(t, stdout)
			assert.NotEmpty(t, stderr)

			if test.secret != "" {
				assert.False(t, strings.Contains(stderr, test.secret), "the error quotes the input: %s", stderr)
			}
		})
	}
}
