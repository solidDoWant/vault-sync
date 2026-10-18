package config_test

import (
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
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
