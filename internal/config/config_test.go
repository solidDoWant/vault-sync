package config_test

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const testDSN = "postgres://vault_sync:secret-password@db.example:5432/vault_sync?sslmode=require"

func lookup(env map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := env[name]

		return value, ok
	}
}

const (
	testIssuer   = "https://auth.example/application/o/vault-sync/"
	testAudience = "vault-sync"
)

// withRequired adds every required variable to env.
func withRequired(env map[string]string) map[string]string {
	merged := map[string]string{
		config.DatabaseURLEnv:   testDSN,
		config.OIDCIssuerURLEnv: testIssuer,
		config.OIDCAudienceEnv:  testAudience,
	}
	for name, value := range env {
		merged[name] = value
	}

	return merged
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load(lookup(withRequired(nil)))
	require.NoError(t, err)

	assert.Equal(t, config.Config{
		ListenAddress:            ":8080",
		MetricsListenAddress:     ":9090",
		Database:                 store.Config{DSN: testDSN},
		OIDC:                     config.OIDCConfig{IssuerURL: testIssuer, Audience: testAudience},
		MaxRequestBytes:          1 << 20,
		WriteTimeout:             2 * time.Minute,
		MaxConcurrentRPCsPerUser: 32,
		ShutdownDelay:            5 * time.Second,
		ShutdownTimeout:          30 * time.Second,
		LogLevel:                 slog.LevelInfo,
		Blobs: config.BlobConfig{
			MaxChunkBytes:      768 << 10,
			MaxSizeBytes:       1 << 30,
			MaxUploadsPerVault: 32,
			UploadTTL:          24 * time.Hour,
		},
		Realtime: config.RealtimeConfig{MaxConnections: 10000, MaxConnectionsPerUser: 32, MaxSubscriptions: 128},
	}, cfg)
}

// writeFile writes content to a new file in a test directory.
func writeFile(t *testing.T, name, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), name)
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))

	return path
}

func TestLoadS3Settings(t *testing.T) {
	accessKey := writeFile(t, "access-key-id", "AKIAEXAMPLE\n")
	secretKey := writeFile(t, "secret-access-key", "super-secret-value")
	emptyFile := writeFile(t, "empty", "")

	complete := map[string]string{
		config.S3BucketEnv:              "vault-sync",
		config.S3AccessKeyIDFileEnv:     accessKey,
		config.S3SecretAccessKeyFileEnv: secretKey,
	}

	with := func(overrides map[string]string) map[string]string {
		env := withRequired(complete)
		for name, value := range overrides {
			env[name] = value
		}

		return env
	}

	tests := []struct {
		name string
		env  map[string]string
		want *blobstore.Config
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{name: "unset disables blob storage", env: withRequired(nil)},
		{
			name: "defaults",
			env:  withRequired(complete),
			want: &blobstore.Config{Region: "us-east-1", Bucket: "vault-sync", AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey, ForcePathStyle: true},
		},
		{
			name: "everything set",
			env: with(map[string]string{
				config.S3EndpointEnv:       "https://rgw.example:8443",
				config.S3RegionEnv:         "eu-west-1",
				config.S3ForcePathStyleEnv: "false",
			}),
			want: &blobstore.Config{
				Endpoint: "https://rgw.example:8443", Region: "eu-west-1", Bucket: "vault-sync",
				AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey,
			},
		},
		{
			name:         "any S3 variable requires the bucket and credentials",
			env:          withRequired(map[string]string{config.S3EndpointEnv: "https://rgw.example"}),
			wantProblems: []string{config.S3BucketEnv, config.S3AccessKeyIDFileEnv, config.S3SecretAccessKeyFileEnv},
		},
		{
			name:         "endpoint is not a URL",
			env:          with(map[string]string{config.S3EndpointEnv: "rgw.example"}),
			wantProblems: []string{config.S3EndpointEnv},
		},
		{
			name:         "endpoint with credentials",
			env:          with(map[string]string{config.S3EndpointEnv: "https://user:pw@rgw.example"}),
			wantProblems: []string{config.S3EndpointEnv},
		},
		{
			name:         "unreadable credentials file",
			env:          with(map[string]string{config.S3AccessKeyIDFileEnv: "/nonexistent/key"}),
			wantProblems: []string{config.S3AccessKeyIDFileEnv},
		},
		{
			name:         "empty credentials file",
			env:          with(map[string]string{config.S3SecretAccessKeyFileEnv: emptyFile}),
			wantProblems: []string{config.S3SecretAccessKeyFileEnv},
		},
		{
			name:         "unreadable CA file",
			env:          with(map[string]string{config.S3TLSCAFileEnv: "/nonexistent/ca.crt"}),
			wantProblems: []string{config.S3TLSCAFileEnv},
		},
		{
			name:         "path style not a boolean",
			env:          with(map[string]string{config.S3ForcePathStyleEnv: "sometimes"}),
			wantProblems: []string{config.S3ForcePathStyleEnv},
		},
		{
			name: "shortest idle timeout",
			env:  with(map[string]string{config.S3IdleTimeoutEnv: "1s"}),
			want: &blobstore.Config{Region: "us-east-1", Bucket: "vault-sync", AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey, ForcePathStyle: true, IdleTimeout: time.Second},
		},
		{
			name: "longest idle timeout",
			env:  with(map[string]string{config.S3IdleTimeoutEnv: "1h"}),
			want: &blobstore.Config{Region: "us-east-1", Bucket: "vault-sync", AccessKeyIDFile: accessKey, SecretAccessKeyFile: secretKey, ForcePathStyle: true, IdleTimeout: time.Hour},
		},
		{
			name:         "idle timeout alone requires the bucket and credentials",
			env:          withRequired(map[string]string{config.S3IdleTimeoutEnv: "1m"}),
			wantProblems: []string{config.S3BucketEnv},
		},
		{
			name:         "idle timeout not a duration",
			env:          with(map[string]string{config.S3IdleTimeoutEnv: "120"}),
			wantProblems: []string{config.S3IdleTimeoutEnv},
		},
		{
			name:         "idle timeout too short",
			env:          with(map[string]string{config.S3IdleTimeoutEnv: "999ms"}),
			wantProblems: []string{config.S3IdleTimeoutEnv},
		},
		{
			name:         "idle timeout too long",
			env:          with(map[string]string{config.S3IdleTimeoutEnv: "1h0m0.001s"}),
			wantProblems: []string{config.S3IdleTimeoutEnv},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.Load(lookup(test.env))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				assert.NotContains(t, err.Error(), "super-secret-value")

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg.S3)
		})
	}
}

func TestLoadBlobSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want config.BlobConfig
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{
			name: "overrides",
			env: map[string]string{
				config.BlobMaxChunkBytesEnv:      "524288",
				config.BlobMaxSizeBytesEnv:       "104857600",
				config.BlobMaxUploadsPerVaultEnv: "8",
				config.BlobUploadTTLEnv:          "6h",
			},
			want: config.BlobConfig{MaxChunkBytes: 512 << 10, MaxSizeBytes: 100 << 20, MaxUploadsPerVault: 8, UploadTTL: 6 * time.Hour},
		},
		{
			name: "the largest chunk that fits the default request limit",
			env:  map[string]string{config.BlobMaxChunkBytesEnv: "1047552"},
			want: config.BlobConfig{MaxChunkBytes: 1<<20 - config.ChunkRequestOverheadBytes, MaxSizeBytes: 1 << 30, MaxUploadsPerVault: 32, UploadTTL: 24 * time.Hour},
		},
		{
			name: "larger chunks with a larger request limit",
			env:  map[string]string{config.BlobMaxChunkBytesEnv: "2097152", config.MaxRequestBytesEnv: "3145728"},
			want: config.BlobConfig{MaxChunkBytes: 2 << 20, MaxSizeBytes: 1 << 30, MaxUploadsPerVault: 32, UploadTTL: 24 * time.Hour},
		},
		{
			name:         "chunk plus framing above the default request limit",
			env:          map[string]string{config.BlobMaxChunkBytesEnv: "1047553"},
			wantProblems: []string{config.BlobMaxChunkBytesEnv, config.MaxRequestBytesEnv},
		},
		{
			name:         "request limit lowered below the default chunk",
			env:          map[string]string{config.MaxRequestBytesEnv: "524288"},
			wantProblems: []string{config.BlobMaxChunkBytesEnv, config.MaxRequestBytesEnv},
		},
		{
			name:         "chunk too small",
			env:          map[string]string{config.BlobMaxChunkBytesEnv: "1024"},
			wantProblems: []string{config.BlobMaxChunkBytesEnv},
		},
		{
			name:         "chunk not a number",
			env:          map[string]string{config.BlobMaxChunkBytesEnv: "768KiB"},
			wantProblems: []string{config.BlobMaxChunkBytesEnv},
		},
		{
			name:         "blob size zero",
			env:          map[string]string{config.BlobMaxSizeBytesEnv: "0"},
			wantProblems: []string{config.BlobMaxSizeBytesEnv},
		},
		{
			name:         "blob size beyond what can be composed",
			env:          map[string]string{config.BlobMaxSizeBytesEnv: "1099511627776"},
			wantProblems: []string{config.BlobMaxSizeBytesEnv},
		},
		{
			name:         "no uploads allowed",
			env:          map[string]string{config.BlobMaxUploadsPerVaultEnv: "0"},
			wantProblems: []string{config.BlobMaxUploadsPerVaultEnv},
		},
		{
			name:         "TTL too short",
			env:          map[string]string{config.BlobUploadTTLEnv: "1m"},
			wantProblems: []string{config.BlobUploadTTLEnv},
		},
		{
			name:         "TTL not a duration",
			env:          map[string]string{config.BlobUploadTTLEnv: "1 day"},
			wantProblems: []string{config.BlobUploadTTLEnv},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.Load(lookup(withRequired(test.env)))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg.Blobs)
		})
	}
}

func TestLoadRealtimeSettings(t *testing.T) {
	defaults := config.RealtimeConfig{MaxConnections: 10000, MaxConnectionsPerUser: 32, MaxSubscriptions: 128}

	tests := []struct {
		name string
		env  map[string]string
		want config.RealtimeConfig
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{
			name: "overrides",
			env: map[string]string{
				config.RealtimeMaxConnectionsEnv:        "500",
				config.RealtimeMaxConnectionsPerUserEnv: "4",
				config.RealtimeMaxSubscriptionsEnv:      "16",
			},
			want: config.RealtimeConfig{MaxConnections: 500, MaxConnectionsPerUser: 4, MaxSubscriptions: 16},
		},
		{
			name: "upper bounds",
			env: map[string]string{
				config.RealtimeMaxConnectionsEnv:        "1000000",
				config.RealtimeMaxConnectionsPerUserEnv: "10000",
				config.RealtimeMaxSubscriptionsEnv:      "10000",
			},
			want: config.RealtimeConfig{MaxConnections: 1_000_000, MaxConnectionsPerUser: 10_000, MaxSubscriptions: 10_000},
		},
		{
			name: "lower bounds",
			env: map[string]string{
				config.RealtimeMaxConnectionsEnv:        "1",
				config.RealtimeMaxConnectionsPerUserEnv: "1",
				config.RealtimeMaxSubscriptionsEnv:      "1",
			},
			want: config.RealtimeConfig{MaxConnections: 1, MaxConnectionsPerUser: 1, MaxSubscriptions: 1},
		},
		{name: "defaults", want: defaults},
		{
			name:         "connections above the bound",
			env:          map[string]string{config.RealtimeMaxConnectionsEnv: "1000001"},
			wantProblems: []string{config.RealtimeMaxConnectionsEnv},
		},
		{
			name:         "connections per user above the bound",
			env:          map[string]string{config.RealtimeMaxConnectionsPerUserEnv: "10001"},
			wantProblems: []string{config.RealtimeMaxConnectionsPerUserEnv},
		},
		{
			name:         "subscriptions above the bound",
			env:          map[string]string{config.RealtimeMaxSubscriptionsEnv: "10001"},
			wantProblems: []string{config.RealtimeMaxSubscriptionsEnv},
		},
		{
			name: "zero",
			env: map[string]string{
				config.RealtimeMaxConnectionsEnv:        "0",
				config.RealtimeMaxConnectionsPerUserEnv: "0",
				config.RealtimeMaxSubscriptionsEnv:      "0",
			},
			wantProblems: []string{config.RealtimeMaxConnectionsEnv, config.RealtimeMaxConnectionsPerUserEnv, config.RealtimeMaxSubscriptionsEnv},
		},
		{
			name:         "not a number",
			env:          map[string]string{config.RealtimeMaxSubscriptionsEnv: "many"},
			wantProblems: []string{config.RealtimeMaxSubscriptionsEnv},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.Load(lookup(withRequired(test.env)))
			if len(test.wantProblems) > 0 {
				require.Error(t, err)

				for _, problem := range test.wantProblems {
					assert.Contains(t, err.Error(), problem)
				}

				return
			}

			require.NoError(t, err)
			assert.Equal(t, test.want, cfg.Realtime)
		})
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := config.Load(lookup(withRequired(map[string]string{
		config.ListenAddressEnv:        "127.0.0.1:8443",
		config.MetricsListenAddressEnv: "127.0.0.1:9443",
		config.MaxRequestBytesEnv:      "2097152",
		config.WriteTimeoutEnv:         "5m",
		config.ShutdownDelayEnv:        "10s",
		config.ShutdownTimeoutEnv:      "45s",
		config.LogLevelEnv:             "DEBUG",
	})))
	require.NoError(t, err)

	assert.Equal(t, "127.0.0.1:8443", cfg.ListenAddress)
	assert.Equal(t, "127.0.0.1:9443", cfg.MetricsListenAddress)
	assert.Equal(t, int64(2<<20), cfg.MaxRequestBytes)
	assert.Equal(t, 5*time.Minute, cfg.WriteTimeout)
	assert.Equal(t, 10*time.Second, cfg.ShutdownDelay)
	assert.Equal(t, 45*time.Second, cfg.ShutdownTimeout)
	assert.Equal(t, slog.LevelDebug, cfg.LogLevel)
}

func TestLoadAcceptsWriteTimeoutBounds(t *testing.T) {
	for _, timeout := range []time.Duration{time.Second, time.Hour} {
		t.Run(timeout.String(), func(t *testing.T) {
			cfg, err := config.Load(lookup(withRequired(map[string]string{config.WriteTimeoutEnv: timeout.String()})))
			require.NoError(t, err)

			assert.Equal(t, timeout, cfg.WriteTimeout)
		})
	}
}

func TestLoadAcceptsMaxConcurrentRPCsPerUserBounds(t *testing.T) {
	for _, limit := range []int{1, 10000} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			cfg, err := config.Load(lookup(withRequired(map[string]string{config.MaxConcurrentRPCsPerUserEnv: strconv.Itoa(limit)})))
			require.NoError(t, err)

			assert.Equal(t, limit, cfg.MaxConcurrentRPCsPerUser)
		})
	}
}

func TestLoadAllowsNoShutdownDelay(t *testing.T) {
	cfg, err := config.Load(lookup(withRequired(map[string]string{config.ShutdownDelayEnv: "0s"})))
	require.NoError(t, err)

	assert.Zero(t, cfg.ShutdownDelay)
}

func TestLoadRejectsInvalidSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		// wantProblems are substrings that must each appear in the error.
		wantProblems []string
	}{
		{
			name:         "missing database URL",
			env:          map[string]string{},
			wantProblems: []string{config.DatabaseURLEnv + " is required"},
		},
		{
			name:         "empty database URL",
			env:          map[string]string{config.DatabaseURLEnv: ""},
			wantProblems: []string{config.DatabaseURLEnv + " is required"},
		},
		{
			name:         "unparseable database URL",
			env:          map[string]string{config.DatabaseURLEnv: "postgres://user:pw@host:notaport/db"},
			wantProblems: []string{config.DatabaseURLEnv},
		},
		{
			name: "client certificate without key",
			env: withRequired(map[string]string{
				config.DatabaseTLSCertFileEnv: "/nonexistent/tls.crt",
			}),
			wantProblems: []string{config.DatabaseTLSCertFileEnv, config.DatabaseTLSKeyFileEnv},
		},
		{
			name: "unreadable CA file",
			env: withRequired(map[string]string{
				config.DatabaseTLSCAFileEnv: "/nonexistent/ca.crt",
			}),
			wantProblems: []string{config.DatabaseTLSCAFileEnv},
		},
		{
			name:         "listen address without port",
			env:          withRequired(map[string]string{config.ListenAddressEnv: "localhost"}),
			wantProblems: []string{config.ListenAddressEnv},
		},
		{
			name:         "metrics listen address with bad port",
			env:          withRequired(map[string]string{config.MetricsListenAddressEnv: ":http-alt"}),
			wantProblems: []string{config.MetricsListenAddressEnv},
		},
		{
			name: "metrics port equals API port",
			env: withRequired(map[string]string{
				config.ListenAddressEnv:        ":8080",
				config.MetricsListenAddressEnv: ":8080",
			}),
			wantProblems: []string{config.MetricsListenAddressEnv + " must differ from " + config.ListenAddressEnv},
		},
		{
			name:         "max request bytes not a number",
			env:          withRequired(map[string]string{config.MaxRequestBytesEnv: "1MiB"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "max request bytes too small",
			env:          withRequired(map[string]string{config.MaxRequestBytesEnv: "100"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "max request bytes too large",
			env:          withRequired(map[string]string{config.MaxRequestBytesEnv: "1073741824"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "write timeout not a duration",
			env:          withRequired(map[string]string{config.WriteTimeoutEnv: "120"}),
			wantProblems: []string{config.WriteTimeoutEnv},
		},
		{
			name:         "write timeout too short",
			env:          withRequired(map[string]string{config.WriteTimeoutEnv: "999ms"}),
			wantProblems: []string{config.WriteTimeoutEnv},
		},
		{
			name:         "write timeout too long",
			env:          withRequired(map[string]string{config.WriteTimeoutEnv: "1h0m0.001s"}),
			wantProblems: []string{config.WriteTimeoutEnv},
		},
		{
			name:         "max concurrent RPCs per user not a number",
			env:          withRequired(map[string]string{config.MaxConcurrentRPCsPerUserEnv: "many"}),
			wantProblems: []string{config.MaxConcurrentRPCsPerUserEnv},
		},
		{
			name:         "max concurrent RPCs per user zero",
			env:          withRequired(map[string]string{config.MaxConcurrentRPCsPerUserEnv: "0"}),
			wantProblems: []string{config.MaxConcurrentRPCsPerUserEnv},
		},
		{
			name:         "max concurrent RPCs per user too large",
			env:          withRequired(map[string]string{config.MaxConcurrentRPCsPerUserEnv: "10001"}),
			wantProblems: []string{config.MaxConcurrentRPCsPerUserEnv},
		},
		{
			name:         "shutdown timeout not a duration",
			env:          withRequired(map[string]string{config.ShutdownTimeoutEnv: "30"}),
			wantProblems: []string{config.ShutdownTimeoutEnv},
		},
		{
			name:         "shutdown timeout not positive",
			env:          withRequired(map[string]string{config.ShutdownTimeoutEnv: "0s"}),
			wantProblems: []string{config.ShutdownTimeoutEnv},
		},
		{
			name:         "shutdown delay not a duration",
			env:          withRequired(map[string]string{config.ShutdownDelayEnv: "5"}),
			wantProblems: []string{config.ShutdownDelayEnv},
		},
		{
			name:         "shutdown delay negative",
			env:          withRequired(map[string]string{config.ShutdownDelayEnv: "-1s"}),
			wantProblems: []string{config.ShutdownDelayEnv},
		},
		{
			name:         "shutdown delay too long",
			env:          withRequired(map[string]string{config.ShutdownDelayEnv: "6m"}),
			wantProblems: []string{config.ShutdownDelayEnv},
		},
		{
			name:         "unknown log level",
			env:          withRequired(map[string]string{config.LogLevelEnv: "verbose"}),
			wantProblems: []string{config.LogLevelEnv},
		},
		{
			name: "every problem is reported at once",
			env: map[string]string{
				config.ListenAddressEnv:   "nope",
				config.MaxRequestBytesEnv: "-1",
				config.ShutdownTimeoutEnv: "soon",
				config.LogLevelEnv:        "loud",
			},
			wantProblems: []string{
				config.DatabaseURLEnv,
				config.ListenAddressEnv,
				config.MaxRequestBytesEnv,
				config.ShutdownTimeoutEnv,
				config.LogLevelEnv,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := config.Load(lookup(test.env))
			require.Error(t, err)

			for _, problem := range test.wantProblems {
				assert.Contains(t, err.Error(), problem)
			}
		})
	}
}

func TestLoadNeverEchoesDatabasePassword(t *testing.T) {
	_, err := config.Load(lookup(map[string]string{
		config.DatabaseURLEnv: "postgres://user:hunter2-secret@host:notaport/db",
	}))
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "hunter2-secret")
}

func TestLoadOIDCSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		// wantProblems are substrings that must each appear in the error;
		// none means the configuration is valid.
		wantProblems []string
	}{
		{
			name:         "missing issuer and audience",
			env:          map[string]string{config.DatabaseURLEnv: testDSN},
			wantProblems: []string{config.OIDCIssuerURLEnv + " is required", config.OIDCAudienceEnv + " is required"},
		},
		{
			name:         "issuer is not a URL",
			env:          withRequired(map[string]string{config.OIDCIssuerURLEnv: "auth.example"}),
			wantProblems: []string{config.OIDCIssuerURLEnv},
		},
		{
			name:         "plain HTTP issuer",
			env:          withRequired(map[string]string{config.OIDCIssuerURLEnv: "http://auth.example/"}),
			wantProblems: []string{config.OIDCIssuerURLEnv + ": must use https"},
		},
		{
			name:         "issuer with a query",
			env:          withRequired(map[string]string{config.OIDCIssuerURLEnv: "https://auth.example/?tenant=a"}),
			wantProblems: []string{config.OIDCIssuerURLEnv},
		},
		{
			name: "plain HTTP issuer on loopback is allowed for development",
			env:  withRequired(map[string]string{config.OIDCIssuerURLEnv: "http://127.0.0.1:9000/"}),
		},
		{
			name: "localhost issuer is allowed for development",
			env:  withRequired(map[string]string{config.OIDCIssuerURLEnv: "http://localhost:9000/"}),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := config.Load(lookup(test.env))
			if len(test.wantProblems) == 0 {
				require.NoError(t, err)
				assert.Equal(t, test.env[config.OIDCIssuerURLEnv], cfg.OIDC.IssuerURL)

				return
			}

			require.Error(t, err)

			for _, problem := range test.wantProblems {
				assert.Contains(t, err.Error(), problem)
			}
		})
	}
}
