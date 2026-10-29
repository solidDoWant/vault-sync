package config_test

import (
	"log/slog"
	"testing"

	"filippo.io/age"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
)

func TestLoadExport(t *testing.T) {
	accessKey := writeFile(t, "access-key-id", "AKIAEXAMPLE\n")
	secretKey := writeFile(t, "secret-access-key", "super-secret-value")

	complete := map[string]string{
		config.DatabaseURLEnv:           testDSN,
		config.S3BucketEnv:              "vault-sync",
		config.S3AccessKeyIDFileEnv:     accessKey,
		config.S3SecretAccessKeyFileEnv: secretKey,
	}

	with := func(overrides map[string]string, removed ...string) map[string]string {
		env := map[string]string{}
		for name, value := range complete {
			env[name] = value
		}

		for name, value := range overrides {
			env[name] = value
		}

		for _, name := range removed {
			delete(env, name)
		}

		return env
	}

	tests := []struct {
		name string
		env  map[string]string
		want config.ExportConfig
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{
			name: "database and S3 only; the database pool is read-only",
			env:  complete,
			want: config.ExportConfig{
				Database: store.Config{DSN: testDSN, ReadOnly: true},
				S3:       blobstore.Config{Region: "us-east-1", Bucket: "vault-sync", AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey, ForcePathStyle: true},
				LogLevel: slog.LevelInfo,
			},
		},
		{
			name: "server-only variables are ignored, even when invalid",
			env:  with(map[string]string{config.LogLevelEnv: "debug", config.OIDCIssuerURLEnv: "not a url", config.ListenAddressEnv: "nonsense"}),
			want: config.ExportConfig{
				Database: store.Config{DSN: testDSN, ReadOnly: true},
				S3:       blobstore.Config{Region: "us-east-1", Bucket: "vault-sync", AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey, ForcePathStyle: true},
				LogLevel: slog.LevelDebug,
			},
		},
		{
			name:         "the database is required",
			env:          with(nil, config.DatabaseURLEnv),
			wantProblems: []string{config.DatabaseURLEnv},
		},
		{
			name:         "S3 is required",
			env:          with(nil, config.S3BucketEnv, config.S3AccessKeyIDFileEnv, config.S3SecretAccessKeyFileEnv),
			wantProblems: []string{config.S3BucketEnv},
		},
		{
			name:         "incomplete S3 settings are reported",
			env:          with(nil, config.S3SecretAccessKeyFileEnv),
			wantProblems: []string{config.S3SecretAccessKeyFileEnv},
		},
		{
			name:         "invalid log level",
			env:          with(map[string]string{config.LogLevelEnv: "loud"}),
			wantProblems: []string{config.LogLevelEnv},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.LoadExport(lookup(test.env))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				assert.NotContains(t, err.Error(), "secret-password")

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg)
		})
	}
}

func TestLoadExportEscrowIdentities(t *testing.T) {
	accessKey := writeFile(t, "access-key-id", "AKIAEXAMPLE\n")
	secretKey := writeFile(t, "secret-access-key", "super-secret-value")

	first, err := age.GenerateHybridIdentity()
	require.NoError(t, err)

	second, err := age.GenerateHybridIdentity()
	require.NoError(t, err)

	classic, err := age.GenerateX25519Identity()
	require.NoError(t, err)

	keyOf := func(identity *age.HybridIdentity) []byte {
		key, err := e2ee.ParseAgeIdentity(identity.String())
		require.NoError(t, err)

		return key
	}

	tests := []struct {
		name string
		// content is the identity file's; empty for no file at all.
		content      string
		want         [][]byte
		wantProblems []string
	}{
		{
			name:    "an age-keygen file with comments",
			content: "# created: 2026-10-29T00:00:00Z\n# public key: " + first.Recipient().String() + "\n" + first.String() + "\n",
			want:    [][]byte{keyOf(first)},
		},
		{
			name:    "two identities during a rotation, in file order",
			content: second.String() + "\n\n" + first.String(),
			want:    [][]byte{keyOf(second), keyOf(first)},
		},
		{
			name:         "a classic age identity is refused without quoting it",
			content:      first.String() + "\n" + classic.String() + "\n",
			wantProblems: []string{config.EscrowIdentityFileEnv, "line 2"},
		},
		{
			name:         "a file without an identity is refused",
			content:      "# nothing here\n",
			wantProblems: []string{config.EscrowIdentityFileEnv, "no identity"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := map[string]string{
				config.DatabaseURLEnv:           testDSN,
				config.S3BucketEnv:              "vault-sync",
				config.S3AccessKeyIDFileEnv:     accessKey,
				config.S3SecretAccessKeyFileEnv: secretKey,
				config.EscrowIdentityFileEnv:    writeFile(t, "escrow.key", test.content),
			}

			cfg, err := config.LoadExport(lookup(env))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				assert.NotContains(t, err.Error(), first.String()[:30])
				assert.NotContains(t, err.Error(), classic.String()[:20])

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg.EscrowIdentities)
		})
	}

	t.Run("a missing file is refused", func(t *testing.T) {
		_, err := config.LoadExport(lookup(map[string]string{
			config.DatabaseURLEnv:           testDSN,
			config.S3BucketEnv:              "vault-sync",
			config.S3AccessKeyIDFileEnv:     accessKey,
			config.S3SecretAccessKeyFileEnv: secretKey,
			config.EscrowIdentityFileEnv:    "/nonexistent/escrow.key",
		}))
		require.ErrorContains(t, err, config.EscrowIdentityFileEnv)
	})
}
