// Package config loads the server configuration from environment variables
// (SPEC.md §12). Every variable is documented in docs/configuration.md.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/solidDoWant/vault-sync/internal/auth"
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
	OIDCIssuerURLEnv        = "VAULT_SYNC_OIDC_ISSUER_URL"
	OIDCAudienceEnv         = "VAULT_SYNC_OIDC_AUDIENCE"
)

// Defaults and bounds.
const (
	DefaultListenAddress        = ":8080"
	DefaultMetricsListenAddress = ":9090"
	// DefaultMaxRequestBytes matches the 1 MiB inspected-body limit of the
	// WAF in front of the server (SPEC.md §3).
	//
	// connect-go reads and decodes a unary request body, up to this limit
	// after decompression, before interceptors run, so unauthenticated
	// callers get a full body read and decode per request. Revisit that
	// (for example by authenticating in HTTP middleware before the body is
	// read) before any service raises its read limit (blobs, streaming).
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
	// OIDC configures access-token validation (SPEC.md §9.1).
	OIDC OIDCConfig
	// MaxRequestBytes bounds every request body, after decompression.
	MaxRequestBytes int64
	// ShutdownTimeout bounds how long in-flight requests may drain after a
	// shutdown signal.
	ShutdownTimeout time.Duration
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
}

// OIDCConfig identifies the OIDC issuer whose access tokens the server
// accepts.
type OIDCConfig struct {
	// IssuerURL is the issuer identifier. Tokens' iss claim must equal it
	// exactly, and its key set is discovered from
	// IssuerURL/.well-known/openid-configuration.
	IssuerURL string
	// Audience must appear in tokens' aud claim.
	Audience string
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
		OIDC: OIDCConfig{
			IssuerURL: get(OIDCIssuerURLEnv),
			Audience:  get(OIDCAudienceEnv),
		},
		MaxRequestBytes: DefaultMaxRequestBytes,
		ShutdownTimeout: DefaultShutdownTimeout,
		LogLevel:        slog.LevelInfo,
	}

	problems = append(problems, checkIssuerURL(cfg.OIDC.IssuerURL))

	if cfg.OIDC.Audience == "" {
		problems = append(problems, fmt.Errorf("%s is required", OIDCAudienceEnv))
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

// checkIssuerURL requires an absolute https URL without query or fragment
// (OpenID Connect Discovery 1.0 §2). Plain http is accepted only for a
// loopback host, for local development.
func checkIssuerURL(issuer string) error {
	if issuer == "" {
		return fmt.Errorf("%s is required", OIDCIssuerURLEnv)
	}

	parsed, err := url.Parse(issuer)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return fmt.Errorf("%s: %q is not an absolute URL", OIDCIssuerURLEnv, issuer)
	}

	if parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return fmt.Errorf("%s: %q must not contain a query, fragment or credentials", OIDCIssuerURLEnv, issuer)
	}

	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if auth.IsLoopbackHost(parsed.Hostname()) {
			return nil
		}
	}

	return fmt.Errorf("%s: must use https (plain http is allowed only for a loopback host), got %q", OIDCIssuerURLEnv, issuer)
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
