// Package config loads the server configuration from environment variables
// (SPEC.md §12). Every variable is documented in docs/configuration.md.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/realtime"
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
	ShutdownDelayEnv        = "VAULT_SYNC_SHUTDOWN_DELAY"
	ShutdownTimeoutEnv      = "VAULT_SYNC_SHUTDOWN_TIMEOUT"
	LogLevelEnv             = "VAULT_SYNC_LOG_LEVEL"
	OIDCIssuerURLEnv        = "VAULT_SYNC_OIDC_ISSUER_URL"
	OIDCAudienceEnv         = "VAULT_SYNC_OIDC_AUDIENCE"

	S3EndpointEnv            = "VAULT_SYNC_S3_ENDPOINT"
	S3RegionEnv              = "VAULT_SYNC_S3_REGION"
	S3BucketEnv              = "VAULT_SYNC_S3_BUCKET"
	S3AccessKeyIDFileEnv     = "VAULT_SYNC_S3_ACCESS_KEY_ID_FILE"
	S3SecretAccessKeyFileEnv = "VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE"
	S3ForcePathStyleEnv      = "VAULT_SYNC_S3_FORCE_PATH_STYLE"
	S3TLSCAFileEnv           = "VAULT_SYNC_S3_TLS_CA_FILE"

	BlobMaxChunkBytesEnv      = "VAULT_SYNC_BLOB_MAX_CHUNK_BYTES"
	BlobMaxSizeBytesEnv       = "VAULT_SYNC_BLOB_MAX_SIZE_BYTES"
	BlobMaxUploadsPerVaultEnv = "VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT"
	BlobUploadTTLEnv          = "VAULT_SYNC_BLOB_UPLOAD_TTL"

	RealtimeMaxConnectionsEnv        = "VAULT_SYNC_REALTIME_MAX_CONNECTIONS"
	RealtimeMaxConnectionsPerUserEnv = "VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER"
	RealtimeMaxSubscriptionsEnv      = "VAULT_SYNC_REALTIME_MAX_SUBSCRIPTIONS"
)

// Realtime bounds.
const (
	MaxRealtimeMaxConnections        = 1_000_000
	MaxRealtimeMaxConnectionsPerUser = 10_000
	MaxRealtimeMaxSubscriptions      = 10_000
)

// RealtimeConfig bounds the realtime channel (SPEC.md §6.4). Each limit
// applies per server instance.
type RealtimeConfig struct {
	// MaxConnections bounds the open realtime connections.
	MaxConnections int
	// MaxConnectionsPerUser bounds one user's open realtime connections.
	MaxConnectionsPerUser int
	// MaxSubscriptions bounds the vaults one connection subscribes to.
	MaxSubscriptions int
}

// Blob defaults and bounds.
const (
	// DefaultBlobMaxChunkBytes keeps a chunk upload, with its protobuf
	// framing, below the WAF's 1 MiB inspected-body limit (SPEC.md §3).
	DefaultBlobMaxChunkBytes      = 768 << 10
	DefaultBlobMaxSizeBytes       = 1 << 30
	DefaultBlobMaxUploadsPerVault = 32
	DefaultBlobUploadTTL          = 24 * time.Hour

	// ChunkRequestOverheadBytes is reserved in every request body for the
	// fields of a PutBlobChunkRequest besides its data (binary protobuf: a
	// vault id, a blob id, an offset and field framing take under 100
	// bytes), so a maximum-size chunk always fits the body limit.
	ChunkRequestOverheadBytes = 1 << 10

	MaxBlobMaxUploadsPerVault = 10000
	MinBlobUploadTTL          = 10 * time.Minute
)

// BlobConfig bounds blob uploads (SPEC.md §6.2).
type BlobConfig struct {
	// MaxChunkBytes is the largest upload chunk and the largest download
	// range returned at once.
	MaxChunkBytes int64
	// MaxSizeBytes is the largest blob.
	MaxSizeBytes int64
	// MaxUploadsPerVault bounds the upload sessions in progress per vault.
	MaxUploadsPerVault int
	// UploadTTL is how long an upload session may be idle before it is
	// removed.
	UploadTTL time.Duration
}

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
	// DefaultShutdownDelay covers typical load-balancer and Kubernetes
	// endpoint propagation after /readyz starts failing.
	DefaultShutdownDelay = 5 * time.Second
	MaxShutdownDelay     = 5 * time.Minute

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
	// ShutdownDelay is how long after a shutdown signal /readyz fails while
	// the API still accepts requests, before draining starts.
	ShutdownDelay time.Duration
	// ShutdownTimeout bounds how long in-flight requests may drain after
	// ShutdownDelay.
	ShutdownTimeout time.Duration
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
	// S3 is the object store holding blob contents, or nil when no S3
	// variable is set; the blob RPCs are then unimplemented.
	S3 *blobstore.Config
	// Blobs bounds blob uploads.
	Blobs BlobConfig
	// Realtime bounds the realtime channel.
	Realtime RealtimeConfig
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
		ShutdownDelay:   DefaultShutdownDelay,
		ShutdownTimeout: DefaultShutdownTimeout,
		LogLevel:        slog.LevelInfo,
		Blobs: BlobConfig{
			MaxChunkBytes:      DefaultBlobMaxChunkBytes,
			MaxSizeBytes:       DefaultBlobMaxSizeBytes,
			MaxUploadsPerVault: DefaultBlobMaxUploadsPerVault,
			UploadTTL:          DefaultBlobUploadTTL,
		},
		Realtime: RealtimeConfig{
			MaxConnections:        realtime.DefaultMaxConnections,
			MaxConnectionsPerUser: realtime.DefaultMaxConnectionsPerUser,
			MaxSubscriptions:      realtime.DefaultMaxSubscriptions,
		},
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

	if raw := get(ShutdownDelayEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 5s)", ShutdownDelayEnv, raw))
		case value < 0 || value > MaxShutdownDelay:
			problems = append(problems, fmt.Errorf("%s: %s is outside the allowed range 0s to %s", ShutdownDelayEnv, raw, MaxShutdownDelay))
		default:
			cfg.ShutdownDelay = value
		}
	}

	if raw := get(LogLevelEnv); raw != "" {
		if err := cfg.LogLevel.UnmarshalText([]byte(raw)); err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not one of debug, info, warn, error", LogLevelEnv, raw))
		}
	}

	var s3Problems []error

	cfg.S3, s3Problems = loadS3(get)
	problems = append(problems, s3Problems...)
	problems = append(problems, loadBlobs(get, &cfg)...)
	problems = append(problems, loadRealtime(get, &cfg.Realtime)...)

	if err := errors.Join(problems...); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// loadS3 returns the object-store configuration, or nil when no S3 variable
// is set.
func loadS3(get func(string) string) (*blobstore.Config, []error) {
	names := []string{
		S3EndpointEnv, S3RegionEnv, S3BucketEnv, S3AccessKeyIDFileEnv,
		S3SecretAccessKeyFileEnv, S3ForcePathStyleEnv, S3TLSCAFileEnv,
	}

	if !slices.ContainsFunc(names, func(name string) bool { return get(name) != "" }) {
		return nil, nil
	}

	s3 := &blobstore.Config{
		Endpoint:            get(S3EndpointEnv),
		Region:              stringOr(get(S3RegionEnv), blobstore.DefaultRegion),
		Bucket:              get(S3BucketEnv),
		AccessKeyIDFile:     get(S3AccessKeyIDFileEnv),
		SecretAccessKeyFile: get(S3SecretAccessKeyFileEnv),
		ForcePathStyle:      true,
		TLSCAFile:           get(S3TLSCAFileEnv),
	}

	var problems []error

	if raw := get(S3ForcePathStyleEnv); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not true or false", S3ForcePathStyleEnv, raw))
		}

		s3.ForcePathStyle = value
	}

	if s3.Bucket == "" {
		problems = append(problems, fmt.Errorf("%s is required when any VAULT_SYNC_S3_* variable is set", S3BucketEnv))
	}

	if s3.AccessKeyIDFile == "" || s3.SecretAccessKeyFile == "" {
		problems = append(problems, fmt.Errorf("%s and %s are required when any VAULT_SYNC_S3_* variable is set", S3AccessKeyIDFileEnv, S3SecretAccessKeyFileEnv))
	}

	if s3.Bucket != "" && s3.AccessKeyIDFile != "" && s3.SecretAccessKeyFile != "" {
		// Validate reads the credential and CA files but never echoes
		// their contents.
		if err := s3.Validate(); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", strings.Join([]string{S3EndpointEnv, S3AccessKeyIDFileEnv, S3SecretAccessKeyFileEnv, S3TLSCAFileEnv}, ", "), err))
		}
	}

	return s3, problems
}

func loadBlobs(get func(string) string, cfg *Config) []error {
	var problems []error

	parseInt := func(name string, minimum, maximum int64, target *int64) {
		raw := get(name)
		if raw == "" {
			return
		}

		value, err := strconv.ParseInt(raw, 10, 64)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not an integer", name, raw))
		case value < minimum || value > maximum:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range %d to %d", name, value, minimum, maximum))
		default:
			*target = value
		}
	}

	parseInt(BlobMaxChunkBytesEnv, blobstore.MinChunkBytes, MaxMaxRequestBytes, &cfg.Blobs.MaxChunkBytes)
	parseInt(BlobMaxSizeBytesEnv, 1, blobstore.MaxBlobBytes, &cfg.Blobs.MaxSizeBytes)

	uploads := int64(cfg.Blobs.MaxUploadsPerVault)
	parseInt(BlobMaxUploadsPerVaultEnv, 1, MaxBlobMaxUploadsPerVault, &uploads)
	cfg.Blobs.MaxUploadsPerVault = int(uploads)

	if raw := get(BlobUploadTTLEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 24h)", BlobUploadTTLEnv, raw))
		case value < MinBlobUploadTTL:
			problems = append(problems, fmt.Errorf("%s: must be at least %s, got %s", BlobUploadTTLEnv, MinBlobUploadTTL, raw))
		default:
			cfg.Blobs.UploadTTL = value
		}
	}

	// Every chunk upload must fit the request body limit (which matches the
	// WAF's), framing included, or uploads could never succeed.
	if cfg.Blobs.MaxChunkBytes+ChunkRequestOverheadBytes > cfg.MaxRequestBytes {
		problems = append(problems, fmt.Errorf(
			"%s (%d) plus %d bytes of request framing must not exceed %s (%d): lower the chunk size or raise the request limit",
			BlobMaxChunkBytesEnv, cfg.Blobs.MaxChunkBytes, ChunkRequestOverheadBytes, MaxRequestBytesEnv, cfg.MaxRequestBytes))
	}

	return problems
}

func loadRealtime(get func(string) string, cfg *RealtimeConfig) []error {
	var problems []error

	parseInt := func(name string, maximum int, target *int) {
		raw := get(name)
		if raw == "" {
			return
		}

		value, err := strconv.Atoi(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not an integer", name, raw))
		case value < 1 || value > maximum:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range 1 to %d", name, value, maximum))
		default:
			*target = value
		}
	}

	parseInt(RealtimeMaxConnectionsEnv, MaxRealtimeMaxConnections, &cfg.MaxConnections)
	parseInt(RealtimeMaxConnectionsPerUserEnv, MaxRealtimeMaxConnectionsPerUser, &cfg.MaxConnectionsPerUser)
	parseInt(RealtimeMaxSubscriptionsEnv, MaxRealtimeMaxSubscriptions, &cfg.MaxSubscriptions)

	return problems
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
