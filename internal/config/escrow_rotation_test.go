package config_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"

	"filippo.io/age"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
)

func TestLoadEscrowRotation(t *testing.T) {
	identity, err := age.GenerateHybridIdentity()
	require.NoError(t, err)

	identityFile := writeFile(t, "escrow.key", identity.String()+"\n")
	tokenFile := writeFile(t, "job-token", strings.Repeat("t", 44)+"\n")

	seed := func() []byte {
		value := make([]byte, ed25519.SeedSize)
		_, err := rand.Read(value)
		require.NoError(t, err)

		return value
	}

	first, second := seed(), seed()
	encode := base64.StdEncoding.EncodeToString

	tests := []struct {
		name string
		// signingKeys is the signing key file's content.
		signingKeys  string
		omit         string
		want         []ed25519.PrivateKey
		wantProblems []string
	}{
		{
			name:        "two seeds with a comment, in file order",
			signingKeys: "# escrow signing keys\n" + encode(second) + "\n\n" + encode(first) + "\n",
			want:        []ed25519.PrivateKey{ed25519.NewKeyFromSeed(second), ed25519.NewKeyFromSeed(first)},
		},
		{
			name:         "a seed of 31 bytes is refused without quoting it",
			signingKeys:  encode(first) + "\n" + encode(second[:31]) + "\n",
			wantProblems: []string{config.EscrowSigningKeyFileEnv, "line 2"},
		},
		{
			name:         "a seed of 33 bytes is refused",
			signingKeys:  encode(append(first, 0)),
			wantProblems: []string{config.EscrowSigningKeyFileEnv, "line 1"},
		},
		{
			name:         "a file without a seed is refused",
			signingKeys:  "# nothing\n",
			wantProblems: []string{config.EscrowSigningKeyFileEnv, "no signing key"},
		},
		{name: "the signing key file is required", omit: config.EscrowSigningKeyFileEnv, wantProblems: []string{config.EscrowSigningKeyFileEnv, "required"}},
		{name: "the identity file is required", omit: config.EscrowIdentityFileEnv, wantProblems: []string{config.EscrowIdentityFileEnv, "required"}},
		{name: "the job token file is required", omit: config.EscrowJobTokenFileEnv, wantProblems: []string{config.EscrowJobTokenFileEnv, "required"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signingKeys := test.signingKeys
			if signingKeys == "" {
				signingKeys = encode(first)
			}

			env := map[string]string{
				config.DatabaseURLEnv:          testDSN,
				config.EscrowIdentityFileEnv:   identityFile,
				config.EscrowJobTokenFileEnv:   tokenFile,
				config.EscrowSigningKeyFileEnv: writeFile(t, "signing.keys", signingKeys),
			}
			delete(env, test.omit)

			cfg, err := config.LoadEscrowRotation(lookup(env))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				assert.NotContains(t, err.Error(), encode(first)[:20])
				assert.NotContains(t, err.Error(), encode(second)[:20])

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg.EscrowSigningKeys)
			assert.Len(t, cfg.EscrowIdentities, 1)
			assert.Equal(t, []byte(strings.Repeat("t", 44)), cfg.EscrowJobToken)
			assert.True(t, cfg.Database.ReadOnly)
		})
	}
}
