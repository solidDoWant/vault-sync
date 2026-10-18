package config_test

import (
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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

func withDatabase(env map[string]string) map[string]string {
	merged := map[string]string{config.DatabaseURLEnv: testDSN}
	for name, value := range env {
		merged[name] = value
	}

	return merged
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load(lookup(withDatabase(nil)))
	require.NoError(t, err)

	assert.Equal(t, config.Config{
		ListenAddress:        ":8080",
		MetricsListenAddress: ":9090",
		Database:             store.Config{DSN: testDSN},
		MaxRequestBytes:      1 << 20,
		ShutdownTimeout:      30 * time.Second,
		LogLevel:             slog.LevelInfo,
	}, cfg)
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := config.Load(lookup(withDatabase(map[string]string{
		config.ListenAddressEnv:        "127.0.0.1:8443",
		config.MetricsListenAddressEnv: "127.0.0.1:9443",
		config.MaxRequestBytesEnv:      "2097152",
		config.ShutdownTimeoutEnv:      "45s",
		config.LogLevelEnv:             "DEBUG",
	})))
	require.NoError(t, err)

	assert.Equal(t, "127.0.0.1:8443", cfg.ListenAddress)
	assert.Equal(t, "127.0.0.1:9443", cfg.MetricsListenAddress)
	assert.Equal(t, int64(2<<20), cfg.MaxRequestBytes)
	assert.Equal(t, 45*time.Second, cfg.ShutdownTimeout)
	assert.Equal(t, slog.LevelDebug, cfg.LogLevel)
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
			env: withDatabase(map[string]string{
				config.DatabaseTLSCertFileEnv: "/nonexistent/tls.crt",
			}),
			wantProblems: []string{config.DatabaseTLSCertFileEnv, config.DatabaseTLSKeyFileEnv},
		},
		{
			name: "unreadable CA file",
			env: withDatabase(map[string]string{
				config.DatabaseTLSCAFileEnv: "/nonexistent/ca.crt",
			}),
			wantProblems: []string{config.DatabaseTLSCAFileEnv},
		},
		{
			name:         "listen address without port",
			env:          withDatabase(map[string]string{config.ListenAddressEnv: "localhost"}),
			wantProblems: []string{config.ListenAddressEnv},
		},
		{
			name:         "metrics listen address with bad port",
			env:          withDatabase(map[string]string{config.MetricsListenAddressEnv: ":http-alt"}),
			wantProblems: []string{config.MetricsListenAddressEnv},
		},
		{
			name: "metrics port equals API port",
			env: withDatabase(map[string]string{
				config.ListenAddressEnv:        ":8080",
				config.MetricsListenAddressEnv: ":8080",
			}),
			wantProblems: []string{config.MetricsListenAddressEnv + " must differ from " + config.ListenAddressEnv},
		},
		{
			name:         "max request bytes not a number",
			env:          withDatabase(map[string]string{config.MaxRequestBytesEnv: "1MiB"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "max request bytes too small",
			env:          withDatabase(map[string]string{config.MaxRequestBytesEnv: "100"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "max request bytes too large",
			env:          withDatabase(map[string]string{config.MaxRequestBytesEnv: "1073741824"}),
			wantProblems: []string{config.MaxRequestBytesEnv},
		},
		{
			name:         "shutdown timeout not a duration",
			env:          withDatabase(map[string]string{config.ShutdownTimeoutEnv: "30"}),
			wantProblems: []string{config.ShutdownTimeoutEnv},
		},
		{
			name:         "shutdown timeout not positive",
			env:          withDatabase(map[string]string{config.ShutdownTimeoutEnv: "0s"}),
			wantProblems: []string{config.ShutdownTimeoutEnv},
		},
		{
			name:         "unknown log level",
			env:          withDatabase(map[string]string{config.LogLevelEnv: "verbose"}),
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
