// Package config loads the server configuration from environment variables
// (SPEC.md §12). Every variable is documented in docs/configuration.md.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// Environment variable names.
const (
	ListenAddressEnv        = "VAULT_SYNC_LISTEN_ADDRESS"
	MetricsListenAddressEnv = "VAULT_SYNC_METRICS_LISTEN_ADDRESS"
	DatabaseURLEnv          = "VAULT_SYNC_DATABASE_URL"
	DatabaseTLSCertFileEnv  = "VAULT_SYNC_DATABASE_TLS_CERT_FILE"
	DatabaseTLSKeyFileEnv   = "VAULT_SYNC_DATABASE_TLS_KEY_FILE"
	DatabaseTLSCAFileEnv    = "VAULT_SYNC_DATABASE_TLS_CA_FILE"
	MaxRequestBytesEnv      = "VAULT_SYNC_MAX_REQUEST_BYTES"
	ShutdownTimeoutEnv      = "VAULT_SYNC_SHUTDOWN_TIMEOUT"
	LogLevelEnv             = "VAULT_SYNC_LOG_LEVEL"
)

// Defaults and bounds.
const (
	DefaultListenAddress        = ":8080"
	DefaultMetricsListenAddress = ":9090"
	// DefaultMaxRequestBytes matches the 1 MiB inspected-body limit of the
	// WAF in front of the server (SPEC.md §3).
	DefaultMaxRequestBytes = 1 << 20
	DefaultShutdownTimeout = 30 * time.Second

	MinMaxRequestBytes = 1 << 10
	MaxMaxRequestBytes = 64 << 20
)

// Config is the server configuration.
type Config struct {
	// ListenAddress is the host:port of the API listener.
	ListenAddress string
	// MetricsListenAddress is the host:port of the listener serving
	// /metrics, /healthz and /readyz. It is never the API listener.
	MetricsListenAddress string
	// Database is the PostgreSQL connection configuration.
	Database store.Config
	// MaxRequestBytes bounds every request body, after decompression.
	MaxRequestBytes int64
	// ShutdownTimeout bounds how long in-flight requests may drain after a
	// shutdown signal.
	ShutdownTimeout time.Duration
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
}

// Load reads the configuration through lookup (os.LookupEnv in production).
// An empty variable is treated as unset. All problems are reported together,
// each naming its variable; secret values are never echoed.
func Load(lookup func(string) (string, bool)) (Config, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	var problems []error

	cfg := Config{
		ListenAddress:        stringOr(get(ListenAddressEnv), DefaultListenAddress),
		MetricsListenAddress: stringOr(get(MetricsListenAddressEnv), DefaultMetricsListenAddress),
		Database: store.Config{
			DSN:         get(DatabaseURLEnv),
			TLSCertFile: get(DatabaseTLSCertFileEnv),
			TLSKeyFile:  get(DatabaseTLSKeyFileEnv),
			TLSCAFile:   get(DatabaseTLSCAFileEnv),
		},
		MaxRequestBytes: DefaultMaxRequestBytes,
		ShutdownTimeout: DefaultShutdownTimeout,
		LogLevel:        slog.LevelInfo,
	}

	problems = append(problems, checkListenAddress(ListenAddressEnv, cfg.ListenAddress))
	problems = append(problems, checkListenAddress(MetricsListenAddressEnv, cfg.MetricsListenAddress))

	if cfg.ListenAddress == cfg.MetricsListenAddress {
		problems = append(problems, fmt.Errorf("%s must differ from %s: metrics are served on a separate port", MetricsListenAddressEnv, ListenAddressEnv))
	}

	problems = append(problems, checkDatabase(cfg.Database))

	if raw := get(MaxRequestBytesEnv); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not an integer number of bytes", MaxRequestBytesEnv, raw))
		case value < MinMaxRequestBytes || value > MaxMaxRequestBytes:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range %d to %d bytes", MaxRequestBytesEnv, value, MinMaxRequestBytes, MaxMaxRequestBytes))
		default:
			cfg.MaxRequestBytes = value
		}
	}

	if raw := get(ShutdownTimeoutEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 30s)", ShutdownTimeoutEnv, raw))
		case value <= 0:
			problems = append(problems, fmt.Errorf("%s: must be positive, got %s", ShutdownTimeoutEnv, raw))
		default:
			cfg.ShutdownTimeout = value
		}
	}

	if raw := get(LogLevelEnv); raw != "" {
		if err := cfg.LogLevel.UnmarshalText([]byte(raw)); err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not one of debug, info, warn, error", LogLevelEnv, raw))
		}
	}

	if err := errors.Join(problems...); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func stringOr(value, fallback string) string {
	if value == "" {
		return fallback
	}

	return value
}

func checkListenAddress(name, address string) error {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%s: %q is not a host:port address", name, address)
	}

	if number, err := strconv.ParseUint(port, 10, 16); err != nil || (number == 0 && port != "0") {
		return fmt.Errorf("%s: %q does not have a numeric port", name, address)
	}

	return nil
}

func checkDatabase(database store.Config) error {
	if database.DSN == "" {
		return fmt.Errorf("%s is required", DatabaseURLEnv)
	}

	if (database.TLSCertFile == "") != (database.TLSKeyFile == "") {
		return fmt.Errorf("%s and %s must be set together", DatabaseTLSCertFileEnv, DatabaseTLSKeyFileEnv)
	}

	// The store validates the DSN and the TLS files; it never echoes the
	// password. Name the variables involved, since its errors cannot.
	if _, err := store.NewPoolConfig(database); err != nil {
		names := []string{DatabaseURLEnv}

		for _, setting := range []struct{ name, value string }{
			{DatabaseTLSCertFileEnv, database.TLSCertFile},
			{DatabaseTLSKeyFileEnv, database.TLSKeyFile},
			{DatabaseTLSCAFileEnv, database.TLSCAFile},
		} {
			if setting.value != "" {
				names = append(names, setting.name)
			}
		}

		return fmt.Errorf("%s: %w", strings.Join(names, ", "), err)
	}

	return nil
}
