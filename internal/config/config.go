// Package config loads the server configuration from environment variables
// (SPEC.md §12). Every variable is documented in docs/configuration.md.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/solidDoWant/vault-sync/internal/api"
	"github.com/solidDoWant/vault-sync/internal/auth"
	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/realtime"
	"github.com/solidDoWant/vault-sync/internal/retention"
	"github.com/solidDoWant/vault-sync/internal/store"
)

// Environment variable names.
const (
	ListenAddressEnv            = "VAULT_SYNC_LISTEN_ADDRESS"
	MetricsListenAddressEnv     = "VAULT_SYNC_METRICS_LISTEN_ADDRESS"
	DatabaseURLEnv              = "VAULT_SYNC_DATABASE_URL"
	DatabaseTLSCertFileEnv      = "VAULT_SYNC_DATABASE_TLS_CERT_FILE"
	DatabaseTLSKeyFileEnv       = "VAULT_SYNC_DATABASE_TLS_KEY_FILE"
	DatabaseTLSCAFileEnv        = "VAULT_SYNC_DATABASE_TLS_CA_FILE"
	MaxRequestBytesEnv          = "VAULT_SYNC_MAX_REQUEST_BYTES"
	WriteTimeoutEnv             = "VAULT_SYNC_WRITE_TIMEOUT"
	MaxConcurrentRPCsPerUserEnv = "VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER"
	ShutdownDelayEnv            = "VAULT_SYNC_SHUTDOWN_DELAY"
	ShutdownTimeoutEnv          = "VAULT_SYNC_SHUTDOWN_TIMEOUT"
	LogLevelEnv                 = "VAULT_SYNC_LOG_LEVEL"
	OIDCIssuerURLEnv            = "VAULT_SYNC_OIDC_ISSUER_URL"
	OIDCAudienceEnv             = "VAULT_SYNC_OIDC_AUDIENCE"
	OIDCClientIDEnv             = "VAULT_SYNC_OIDC_CLIENT_ID"
	EscrowRecipientEnv          = "VAULT_SYNC_ESCROW_RECIPIENT"
	EscrowDefaultEnv            = "VAULT_SYNC_ESCROW_DEFAULT"
	EscrowSigningKeyEnv         = "VAULT_SYNC_ESCROW_SIGNING_KEY"
	EscrowIdentityFileEnv       = "VAULT_SYNC_ESCROW_IDENTITY_FILE"
	EscrowJobTokenFileEnv       = "VAULT_SYNC_ESCROW_JOB_TOKEN_FILE"

	S3EndpointEnv            = "VAULT_SYNC_S3_ENDPOINT"
	S3RegionEnv              = "VAULT_SYNC_S3_REGION"
	S3BucketEnv              = "VAULT_SYNC_S3_BUCKET"
	S3AccessKeyIDFileEnv     = "VAULT_SYNC_S3_ACCESS_KEY_ID_FILE"
	S3SecretAccessKeyFileEnv = "VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE"
	S3ForcePathStyleEnv      = "VAULT_SYNC_S3_FORCE_PATH_STYLE"
	S3TLSCAFileEnv           = "VAULT_SYNC_S3_TLS_CA_FILE"
	S3IdleTimeoutEnv         = "VAULT_SYNC_S3_IDLE_TIMEOUT"

	BlobMaxChunkBytesEnv      = "VAULT_SYNC_BLOB_MAX_CHUNK_BYTES"
	BlobMaxSizeBytesEnv       = "VAULT_SYNC_BLOB_MAX_SIZE_BYTES"
	BlobMaxUploadsPerVaultEnv = "VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT"
	BlobUploadTTLEnv          = "VAULT_SYNC_BLOB_UPLOAD_TTL"
	BlobUploadReclaimIdleEnv  = "VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE"

	RealtimeMaxConnectionsEnv        = "VAULT_SYNC_REALTIME_MAX_CONNECTIONS"
	RealtimeMaxConnectionsPerUserEnv = "VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER"
	RealtimeMaxSubscriptionsEnv      = "VAULT_SYNC_REALTIME_MAX_SUBSCRIPTIONS"

	RetentionKeepAllEnv   = "VAULT_SYNC_RETENTION_KEEP_ALL"
	RetentionKeepDailyEnv = "VAULT_SYNC_RETENTION_KEEP_DAILY"
	BlobGCGraceEnv        = "VAULT_SYNC_BLOB_GC_GRACE"
	PurgeMarkerHorizonEnv = "VAULT_SYNC_RETENTION_PURGE_MARKER_HORIZON"

	RetentionOverrideMinKeepAllEnv   = "VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL"
	RetentionOverrideMinKeepDailyEnv = "VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY"
)

// Retention bounds; the defaults are retention.DefaultKeepAll,
// retention.DefaultKeepDaily, retention.DefaultGrace and
// retention.DefaultMarkerHorizon.
const (
	// MinRetentionKeepAll keeps at least a day of complete history, so a
	// device that was offline briefly still finds the base of its edits.
	MinRetentionKeepAll = 24 * time.Hour
	// MinBlobGCGrace leaves a client that just read a purged revision time
	// to restore it without uploading its content again.
	MinBlobGCGrace = time.Hour
	// MinPurgeMarkerHorizon keeps a purge marker for at least a day, so a
	// device that was offline briefly across a purge pulls on instead of
	// resyncing.
	MinPurgeMarkerHorizon = 24 * time.Hour
)

// RetentionConfig is the retention policy and blob garbage collection
// (SPEC.md §11).
type RetentionConfig struct {
	// KeepAll keeps every revision younger than this.
	KeepAll time.Duration
	// KeepDaily thins revisions between KeepAll and this age to one a day;
	// older revisions are thinned to one a week. Never below KeepAll.
	KeepDaily time.Duration
	// BlobGrace is how long a blob no revision references is kept after
	// the purge of the last revision referencing it.
	BlobGrace time.Duration
	// PurgeMarkerHorizon is how long a purge marker is kept after its
	// purge; a device that has not pulled for longer resyncs (SPEC.md §11).
	PurgeMarkerHorizon time.Duration
}

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
	// DefaultBlobUploadReclaimIdle: an upload in progress records activity
	// on every chunk, so a session idle this long has been abandoned.
	DefaultBlobUploadReclaimIdle = 10 * time.Minute

	// ChunkRequestOverheadBytes is reserved in every request body for the
	// fields of a PutBlobChunkRequest besides its data (binary protobuf: a
	// vault id, a blob id, an offset and field framing take under 100
	// bytes), so a maximum-size chunk always fits the body limit. JSON
	// clients are advertised smaller chunks (api.BlobService).
	ChunkRequestOverheadBytes = api.ChunkReserveBytes

	MaxBlobMaxUploadsPerVault = 10000
	MinBlobUploadTTL          = 10 * time.Minute
	// MinBlobUploadReclaimIdle is the upload TTL's minimum, for the same
	// reason: a request that read its session (recording activity) must
	// finish writing its staged objects before the session can be given up.
	MinBlobUploadReclaimIdle = MinBlobUploadTTL
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
	// UploadReclaimIdle is how long an upload session must be idle before
	// a new upload in a vault at MaxUploadsPerVault reclaims it. At most
	// UploadTTL.
	UploadReclaimIdle time.Duration
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
	// DefaultWriteTimeout lets a maximum-size (1 MiB) response reach a
	// client on a slow mobile link (about 100 kbit/s).
	DefaultWriteTimeout = 2 * time.Minute
	MinWriteTimeout     = time.Second
	MaxWriteTimeout     = time.Hour
	// MinS3IdleTimeout and MaxS3IdleTimeout bound S3IdleTimeoutEnv; the
	// default is blobstore.DefaultIdleTimeout.
	MinS3IdleTimeout = time.Second
	MaxS3IdleTimeout = time.Hour
	// DefaultShutdownDelay covers typical load-balancer and Kubernetes
	// endpoint propagation after /readyz starts failing.
	DefaultShutdownDelay = 5 * time.Second
	MaxShutdownDelay     = 5 * time.Minute

	// MinMaxRequestBytes is also the smallest send limit: every page of
	// revisions holds at least one, which must fit it.
	MinMaxRequestBytes = api.MinResponseLimitBytes
	MaxMaxRequestBytes = 64 << 20

	// DefaultMaxConcurrentRPCsPerUser bounds one user's in-flight
	// authenticated RPCs on one replica. A device makes one RPC at a time,
	// so this admits as many devices syncing at once as the realtime
	// channel admits connections per user, while one user's stalled
	// responses hold at most this many response buffers (up to
	// MaxRequestBytes each).
	DefaultMaxConcurrentRPCsPerUser = 32
	MaxMaxConcurrentRPCsPerUser     = 10_000
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
	// MaxConcurrentRPCsPerUser bounds one user's in-flight authenticated
	// RPCs on this replica; further calls are rejected at once with
	// RESOURCE_EXHAUSTED.
	MaxConcurrentRPCsPerUser int
	// WriteTimeout bounds how long writing an API response may take, from
	// its first byte, so clients that stop reading release their
	// connection. It does not bound the handler's work before the response
	// starts. The realtime WebSocket is exempt.
	WriteTimeout time.Duration
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
	// Retention is the retention policy.
	Retention RetentionConfig
	// Escrow is the deployment's escrow public key, published to clients,
	// and whether new encrypted vaults have escrow by default (SPEC.md
	// §9.4). Its PublicKey is nil when no escrow key is configured.
	Escrow api.Escrow
	// EscrowJobToken is the static bearer token of the export job's escrow
	// rotation endpoint, read from EscrowJobTokenFileEnv; nil when unset,
	// which turns the endpoint off.
	EscrowJobToken []byte
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
	// ClientID is the public OAuth client id the plugin signs in as,
	// advertised by GetServerInfo. It defaults to Audience when that is a
	// valid client id (MaxOIDCClientIDBytes printable ASCII characters at
	// most), and is otherwise empty: no client id is advertised.
	ClientID string
}

// MaxOIDCClientIDBytes bounds VAULT_SYNC_OIDC_CLIENT_ID. OAuth 2.0 does not
// bound client ids; identity providers generate ids far shorter than this.
const MaxOIDCClientIDBytes = 255

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
		MaxRequestBytes:          DefaultMaxRequestBytes,
		WriteTimeout:             DefaultWriteTimeout,
		MaxConcurrentRPCsPerUser: DefaultMaxConcurrentRPCsPerUser,
		ShutdownDelay:            DefaultShutdownDelay,
		ShutdownTimeout:          DefaultShutdownTimeout,
		LogLevel:                 slog.LevelInfo,
		Blobs: BlobConfig{
			MaxChunkBytes:      DefaultBlobMaxChunkBytes,
			MaxSizeBytes:       DefaultBlobMaxSizeBytes,
			MaxUploadsPerVault: DefaultBlobMaxUploadsPerVault,
			UploadTTL:          DefaultBlobUploadTTL,
			UploadReclaimIdle:  DefaultBlobUploadReclaimIdle,
		},
		Realtime: RealtimeConfig{
			MaxConnections:        realtime.DefaultMaxConnections,
			MaxConnectionsPerUser: realtime.DefaultMaxConnectionsPerUser,
			MaxSubscriptions:      realtime.DefaultMaxSubscriptions,
		},
		Retention: RetentionConfig{
			KeepAll:   retention.DefaultKeepAll,
			KeepDaily: retention.DefaultKeepDaily,
			BlobGrace: retention.DefaultGrace,

			PurgeMarkerHorizon: retention.DefaultMarkerHorizon,
		},
	}

	problems = append(problems, checkIssuerURL(cfg.OIDC.IssuerURL))

	if cfg.OIDC.Audience == "" {
		problems = append(problems, fmt.Errorf("%s is required", OIDCAudienceEnv))
	}

	if clientID := get(OIDCClientIDEnv); clientID != "" {
		if err := checkClientID(clientID); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", OIDCClientIDEnv, err))
		} else {
			cfg.OIDC.ClientID = clientID
		}
	} else if checkClientID(cfg.OIDC.Audience) == nil {
		// The Authentik setup: the access token's aud is the client id.
		cfg.OIDC.ClientID = cfg.OIDC.Audience
	}

	escrow, err := escrowConfig(get)
	problems = append(problems, err)
	cfg.Escrow = escrow

	if path := get(EscrowJobTokenFileEnv); path != "" {
		token, err := loadEscrowJobToken(path)
		problems = append(problems, err)
		cfg.EscrowJobToken = token
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
		case value < MinMaxRequestBytes:
			problems = append(problems, fmt.Errorf(
				"%s: %d is outside the allowed range %d to %d bytes: the minimum is the largest ListChanges or GetDocumentHistory response with a single revision",
				MaxRequestBytesEnv, value, MinMaxRequestBytes, MaxMaxRequestBytes))
		case value > MaxMaxRequestBytes:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range %d to %d bytes", MaxRequestBytesEnv, value, MinMaxRequestBytes, MaxMaxRequestBytes))
		default:
			cfg.MaxRequestBytes = value
		}
	}

	if raw := get(WriteTimeoutEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 2m)", WriteTimeoutEnv, raw))
		case value < MinWriteTimeout || value > MaxWriteTimeout:
			problems = append(problems, fmt.Errorf("%s: %s is outside the allowed range %s to %s", WriteTimeoutEnv, raw, MinWriteTimeout, MaxWriteTimeout))
		default:
			cfg.WriteTimeout = value
		}
	}

	if raw := get(MaxConcurrentRPCsPerUserEnv); raw != "" {
		value, err := strconv.Atoi(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not an integer", MaxConcurrentRPCsPerUserEnv, raw))
		case value < 1 || value > MaxMaxConcurrentRPCsPerUser:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range 1 to %d", MaxConcurrentRPCsPerUserEnv, value, MaxMaxConcurrentRPCsPerUser))
		default:
			cfg.MaxConcurrentRPCsPerUser = value
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
	problems = append(problems, loadRetention(get, &cfg.Retention)...)

	if err := errors.Join(problems...); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// ExportConfig is the configuration of the export subcommand (SPEC.md §4).
// It reads the same database and object-store variables as the server.
type ExportConfig struct {
	// Database is the PostgreSQL connection configuration. Its pool is
	// read-only.
	Database store.Config
	// S3 is the object store holding blob contents.
	S3 blobstore.Config
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
	// EscrowIdentities are the hybrid private keys of the escrow
	// identities in EscrowIdentityFileEnv, in file order; none when it is
	// unset.
	EscrowIdentities [][]byte
}

// maxEscrowIdentityFileBytes bounds the escrow identity file: a few
// identities of about 90 characters each, with comments.
const maxEscrowIdentityFileBytes = 64 << 10

// loadEscrowIdentities reads an age identity file: one AGE-SECRET-KEY-PQ-1…
// identity per line, with blank lines and lines starting with "#" (as
// age-keygen writes) ignored. Problems never quote the file's content.
func loadEscrowIdentities(path string) ([][]byte, error) {
	file, err := os.Open(path) //nolint:gosec // the operator's configured path.
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowIdentityFileEnv, err)
	}

	defer func() { _ = file.Close() }()

	content, err := io.ReadAll(io.LimitReader(file, maxEscrowIdentityFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowIdentityFileEnv, err)
	}

	if len(content) > maxEscrowIdentityFileBytes {
		return nil, fmt.Errorf("%s: the file is larger than %d bytes", EscrowIdentityFileEnv, maxEscrowIdentityFileBytes)
	}

	var identities [][]byte

	for number, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		privateKey, err := e2ee.ParseAgeIdentity(line)
		if err != nil {
			return nil, fmt.Errorf("%s: line %d is not an age hybrid post-quantum identity (AGE-SECRET-KEY-PQ-1…)", EscrowIdentityFileEnv, number+1)
		}

		identities = append(identities, privateKey)
	}

	if len(identities) == 0 {
		return nil, fmt.Errorf("%s: the file holds no identity", EscrowIdentityFileEnv)
	}

	return identities, nil
}

const (
	// minEscrowJobTokenBytes is the shortest job token accepted: 32 random
	// bytes in base64 are 44 characters.
	minEscrowJobTokenBytes = 32
	// maxEscrowJobTokenBytes bounds the job token file.
	maxEscrowJobTokenBytes = 4 << 10
)

// loadEscrowJobToken reads the job token file: one token, surrounding
// whitespace ignored. Problems never quote the file's content.
func loadEscrowJobToken(path string) ([]byte, error) {
	file, err := os.Open(path) //nolint:gosec // the operator's configured path.
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowJobTokenFileEnv, err)
	}

	defer func() { _ = file.Close() }()

	content, err := io.ReadAll(io.LimitReader(file, maxEscrowJobTokenBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowJobTokenFileEnv, err)
	}

	if len(content) > maxEscrowJobTokenBytes {
		return nil, fmt.Errorf("%s: the file is larger than %d bytes", EscrowJobTokenFileEnv, maxEscrowJobTokenBytes)
	}

	token := strings.TrimSpace(string(content))
	if len(token) < minEscrowJobTokenBytes {
		return nil, fmt.Errorf("%s: the token must be at least %d characters", EscrowJobTokenFileEnv, minEscrowJobTokenBytes)
	}

	if strings.ContainsFunc(token, unicode.IsSpace) {
		return nil, fmt.Errorf("%s: the token must be a single line without spaces", EscrowJobTokenFileEnv)
	}

	return []byte(token), nil
}

// LoadExport reads the export configuration through lookup, like Load. The
// database and the object store are both required; the API, OIDC and limit
// variables are ignored.
func LoadExport(lookup func(string) (string, bool)) (ExportConfig, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	cfg := ExportConfig{
		Database: store.Config{
			DSN:         get(DatabaseURLEnv),
			TLSCertFile: get(DatabaseTLSCertFileEnv),
			TLSKeyFile:  get(DatabaseTLSKeyFileEnv),
			TLSCAFile:   get(DatabaseTLSCAFileEnv),
			ReadOnly:    true,
		},
		LogLevel: slog.LevelInfo,
	}

	problems := []error{checkDatabase(cfg.Database)}

	if raw := get(LogLevelEnv); raw != "" {
		if err := cfg.LogLevel.UnmarshalText([]byte(raw)); err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not one of debug, info, warn, error", LogLevelEnv, raw))
		}
	}

	s3, s3Problems := loadS3(get)
	problems = append(problems, s3Problems...)

	if s3 == nil {
		problems = append(problems, fmt.Errorf("%s and the other VAULT_SYNC_S3_* variables are required: the export reads blob contents from S3", S3BucketEnv))
	} else {
		cfg.S3 = *s3
	}

	if path := get(EscrowIdentityFileEnv); path != "" {
		identities, err := loadEscrowIdentities(path)
		if err != nil {
			problems = append(problems, err)
		}

		cfg.EscrowIdentities = identities
	}

	if err := errors.Join(problems...); err != nil {
		return ExportConfig{}, err
	}

	return cfg, nil
}

// ImportConfig is the configuration of the import subcommand (engine.md
// §9), a client of the server's API. Every variable is optional.
type ImportConfig struct {
	// MaxFileBytes is the largest file imported; larger files are skipped
	// without being read. The server refuses files over its own limit.
	MaxFileBytes int64
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
}

// LoadImport reads the import configuration through lookup, like Load: the
// log level and the blob size limit. The import reaches the database and
// the object store only through the server, so it reads no database, S3,
// API or OIDC variables.
func LoadImport(lookup func(string) (string, bool)) (ImportConfig, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	cfg := ImportConfig{
		MaxFileBytes: DefaultBlobMaxSizeBytes,
		LogLevel:     slog.LevelInfo,
	}

	var problems []error

	if raw := get(LogLevelEnv); raw != "" {
		if err := cfg.LogLevel.UnmarshalText([]byte(raw)); err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not one of debug, info, warn, error", LogLevelEnv, raw))
		}
	}

	if raw := get(BlobMaxSizeBytesEnv); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not an integer", BlobMaxSizeBytesEnv, raw))
		case value < 1 || value > blobstore.MaxBlobBytes:
			problems = append(problems, fmt.Errorf("%s: %d is outside the allowed range %d to %d",
				BlobMaxSizeBytesEnv, value, 1, int64(blobstore.MaxBlobBytes)))
		default:
			cfg.MaxFileBytes = value
		}
	}

	if err := errors.Join(problems...); err != nil {
		return ImportConfig{}, err
	}

	return cfg, nil
}

// RetentionCommandConfig is the configuration of the retention subcommand,
// which manages per-vault retention overrides (SPEC.md §11).
type RetentionCommandConfig struct {
	// Database is the PostgreSQL connection configuration.
	Database store.Config
	// MinKeepAll and MinKeepDaily are the least KeepAll and KeepDaily an
	// override may have. MinKeepAll is never below MinRetentionKeepAll.
	MinKeepAll   time.Duration
	MinKeepDaily time.Duration
}

// LoadRetentionCommand reads the retention subcommand's configuration
// through lookup, like Load. Only the database is required; the object
// store, API, OIDC, log and limit variables are ignored.
func LoadRetentionCommand(lookup func(string) (string, bool)) (RetentionCommandConfig, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	cfg := RetentionCommandConfig{
		Database: store.Config{
			DSN:         get(DatabaseURLEnv),
			TLSCertFile: get(DatabaseTLSCertFileEnv),
			TLSKeyFile:  get(DatabaseTLSKeyFileEnv),
			TLSCAFile:   get(DatabaseTLSCAFileEnv),
		},
		MinKeepAll: MinRetentionKeepAll,
	}

	problems := []error{checkDatabase(cfg.Database)}

	for _, minimum := range []struct {
		name   string
		floor  time.Duration
		target *time.Duration
	}{
		{RetentionOverrideMinKeepAllEnv, MinRetentionKeepAll, &cfg.MinKeepAll},
		{RetentionOverrideMinKeepDailyEnv, 0, &cfg.MinKeepDaily},
	} {
		raw := get(minimum.name)
		if raw == "" {
			continue
		}

		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 2160h)", minimum.name, raw))
		case value < minimum.floor:
			problems = append(problems, fmt.Errorf("%s: must be at least %s, got %s", minimum.name, minimum.floor, raw))
		default:
			*minimum.target = value
		}
	}

	if err := errors.Join(problems...); err != nil {
		return RetentionCommandConfig{}, err
	}

	return cfg, nil
}

// loadS3 returns the object-store configuration, or nil when no S3 variable
// is set.
func loadS3(get func(string) string) (*blobstore.Config, []error) {
	names := []string{
		S3EndpointEnv, S3RegionEnv, S3BucketEnv, S3AccessKeyIDFileEnv,
		S3SecretAccessKeyFileEnv, S3ForcePathStyleEnv, S3TLSCAFileEnv, S3IdleTimeoutEnv,
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

	if raw := get(S3IdleTimeoutEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 2m)", S3IdleTimeoutEnv, raw))
		case value < MinS3IdleTimeout || value > MaxS3IdleTimeout:
			problems = append(problems, fmt.Errorf("%s: %s is outside the allowed range %s to %s", S3IdleTimeoutEnv, raw, MinS3IdleTimeout, MaxS3IdleTimeout))
		default:
			s3.IdleTimeout = value
		}
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

	if raw := get(BlobUploadReclaimIdleEnv); raw != "" {
		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 10m)", BlobUploadReclaimIdleEnv, raw))
		case value < MinBlobUploadReclaimIdle:
			problems = append(problems, fmt.Errorf("%s: must be at least %s, got %s", BlobUploadReclaimIdleEnv, MinBlobUploadReclaimIdle, raw))
		default:
			cfg.Blobs.UploadReclaimIdle = value
		}
	}

	// Beyond the TTL the cleanup routine has already removed the session.
	if cfg.Blobs.UploadReclaimIdle > cfg.Blobs.UploadTTL {
		problems = append(problems, fmt.Errorf("%s (%s) must not exceed %s (%s)",
			BlobUploadReclaimIdleEnv, cfg.Blobs.UploadReclaimIdle, BlobUploadTTLEnv, cfg.Blobs.UploadTTL))
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

func loadRetention(get func(string) string, cfg *RetentionConfig) []error {
	var problems []error

	parseDuration := func(name string, minimum time.Duration, target *time.Duration) bool {
		raw := get(name)
		if raw == "" {
			return true
		}

		value, err := time.ParseDuration(raw)

		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %q is not a duration (for example 2160h)", name, raw))
		case value < minimum:
			problems = append(problems, fmt.Errorf("%s: must be at least %s, got %s", name, minimum, raw))
		default:
			*target = value

			return true
		}

		return false
	}

	keepAll := parseDuration(RetentionKeepAllEnv, MinRetentionKeepAll, &cfg.KeepAll)
	keepDaily := parseDuration(RetentionKeepDailyEnv, 0, &cfg.KeepDaily)
	parseDuration(BlobGCGraceEnv, MinBlobGCGrace, &cfg.BlobGrace)
	parseDuration(PurgeMarkerHorizonEnv, MinPurgeMarkerHorizon, &cfg.PurgeMarkerHorizon)

	if keepAll && keepDaily && cfg.KeepDaily < cfg.KeepAll {
		problems = append(problems, fmt.Errorf("%s (%s) must not be below %s (%s)",
			RetentionKeepDailyEnv, cfg.KeepDaily, RetentionKeepAllEnv, cfg.KeepAll))
	}

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

// checkClientID requires a client id clients can send: 1 to
// MaxOIDCClientIDBytes characters of printable ASCII (RFC 6749 appendix A.1,
// VSCHAR). It is advertised to unauthenticated callers, so it is bounded.
func checkClientID(clientID string) error {
	if clientID == "" || len(clientID) > MaxOIDCClientIDBytes {
		return fmt.Errorf("must be 1 to %d bytes long, got %d", MaxOIDCClientIDBytes, len(clientID))
	}

	for _, character := range []byte(clientID) {
		if character < 0x20 || character > 0x7e {
			return errors.New("must contain only printable ASCII characters")
		}
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

// LoadVaultCommand reads the database configuration of the vault
// subcommand, with which the operator undeletes a vault, through lookup,
// like Load. Only the database is required; every other variable is
// ignored.
func LoadVaultCommand(lookup func(string) (string, bool)) (store.Config, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	cfg := store.Config{
		DSN:         get(DatabaseURLEnv),
		TLSCertFile: get(DatabaseTLSCertFileEnv),
		TLSKeyFile:  get(DatabaseTLSKeyFileEnv),
		TLSCAFile:   get(DatabaseTLSCAFileEnv),
	}

	return cfg, checkDatabase(cfg)
}

// escrowConfig reads the escrow bundle, the escrow public key (an age hybrid
// recipient, age1pq1…) with its escrow signing public key (base64 Ed25519),
// and the escrow default, which is on unless set to false.
func escrowConfig(get func(string) string) (api.Escrow, error) {
	escrow := api.Escrow{Default: true}

	var problems []error

	if raw := get(EscrowDefaultEnv); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			problems = append(problems, fmt.Errorf("%s: %q is not true or false", EscrowDefaultEnv, raw))
		}

		escrow.Default = value
	}

	recipient := strings.TrimSpace(get(EscrowRecipientEnv))
	rawSigningKey := strings.TrimSpace(get(EscrowSigningKeyEnv))

	if (recipient == "") != (rawSigningKey == "") {
		problems = append(problems, fmt.Errorf("%s and %s must be set together", EscrowRecipientEnv, EscrowSigningKeyEnv))
	}

	var signingKey []byte

	if rawSigningKey != "" {
		decoded, err := base64.StdEncoding.DecodeString(rawSigningKey)
		if err != nil || len(decoded) != e2ee.SignPublicKeySize {
			problems = append(problems, fmt.Errorf("%s: not a base64 Ed25519 public key (%d bytes)", EscrowSigningKeyEnv, e2ee.SignPublicKeySize))
		} else {
			signingKey = decoded
		}
	}

	if recipient != "" {
		publicKey, err := e2ee.ParseAgeRecipient(recipient)
		if err != nil {
			// The value is a public key, but the error need not repeat it.
			problems = append(problems, fmt.Errorf("%s: not an age hybrid post-quantum recipient (age1pq1…)", EscrowRecipientEnv))
		} else {
			escrow.PublicKey = publicKey
			escrow.KeyID, err = e2ee.EscrowKeyID(publicKey)
			problems = append(problems, err)
		}
	}

	if escrow.PublicKey != nil && signingKey != nil {
		escrow.Bundle = &e2ee.EscrowBundle{SignPub: signingKey, Recipient: recipient}
		if _, err := escrow.Bundle.Encode(); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", EscrowRecipientEnv, err))
		}
	}

	return escrow, errors.Join(problems...)
}
