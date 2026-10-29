package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// EscrowRotationConfig is the configuration of the export job's escrow key
// rotation (docs/export.md): the database it reads escrow slots from, and
// the identities, signing keys and job token it rotates with.
type EscrowRotationConfig struct {
	// Database is the PostgreSQL connection configuration. Its pool is
	// read-only: every write goes through the server's job-only endpoint.
	Database store.Config
	// LogLevel is the minimum level logged.
	LogLevel slog.Level
	// EscrowIdentities are the hybrid private keys in EscrowIdentityFileEnv.
	EscrowIdentities [][]byte
	// EscrowSigningKeys are the Ed25519 escrow signing keys in
	// EscrowSigningKeyFileEnv, in file order.
	EscrowSigningKeys []ed25519.PrivateKey
	// EscrowJobToken is the bearer token of the job-only endpoint, read from
	// EscrowJobTokenFileEnv.
	EscrowJobToken []byte
}

// maxEscrowSigningKeyFileBytes bounds the escrow signing key file: a few
// seeds of 44 characters each, with comments.
const maxEscrowSigningKeyFileBytes = 64 << 10

// loadEscrowSigningKeys reads an escrow signing key file: one standard
// base64 Ed25519 seed (32 bytes) per line, with blank lines and lines
// starting with "#" ignored. Problems never quote the file's content.
func loadEscrowSigningKeys(path string) ([]ed25519.PrivateKey, error) {
	file, err := os.Open(path) //nolint:gosec // the operator's configured path.
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowSigningKeyFileEnv, err)
	}

	defer func() { _ = file.Close() }()

	content, err := io.ReadAll(io.LimitReader(file, maxEscrowSigningKeyFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EscrowSigningKeyFileEnv, err)
	}

	if len(content) > maxEscrowSigningKeyFileBytes {
		return nil, fmt.Errorf("%s: the file is larger than %d bytes", EscrowSigningKeyFileEnv, maxEscrowSigningKeyFileBytes)
	}

	var keys []ed25519.PrivateKey

	for number, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		seed, err := base64.StdEncoding.DecodeString(line)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("%s: line %d is not a standard base64 Ed25519 seed of %d bytes", EscrowSigningKeyFileEnv, number+1, ed25519.SeedSize)
		}

		keys = append(keys, ed25519.NewKeyFromSeed(seed))
	}

	if len(keys) == 0 {
		return nil, fmt.Errorf("%s: the file holds no signing key", EscrowSigningKeyFileEnv)
	}

	return keys, nil
}

// LoadEscrowRotation reads the escrow rotation configuration through
// lookup, like Load. The database, the escrow identity file, the escrow
// signing key file and the job token file are all required.
func LoadEscrowRotation(lookup func(string) (string, bool)) (EscrowRotationConfig, error) {
	get := func(name string) string {
		value, _ := lookup(name)

		return strings.TrimSpace(value)
	}

	cfg := EscrowRotationConfig{
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

	var err error

	if path := get(EscrowIdentityFileEnv); path == "" {
		problems = append(problems, fmt.Errorf("%s is required: the rotation re-wraps escrow slots with the escrow identities", EscrowIdentityFileEnv))
	} else if cfg.EscrowIdentities, err = loadEscrowIdentities(path); err != nil {
		problems = append(problems, err)
	}

	if path := get(EscrowSigningKeyFileEnv); path == "" {
		problems = append(problems, fmt.Errorf("%s is required: the rotation signs the escrow rotation statement", EscrowSigningKeyFileEnv))
	} else if cfg.EscrowSigningKeys, err = loadEscrowSigningKeys(path); err != nil {
		problems = append(problems, err)
	}

	if path := get(EscrowJobTokenFileEnv); path == "" {
		problems = append(problems, fmt.Errorf("%s is required: the rotation writes through the server's job-only endpoint", EscrowJobTokenFileEnv))
	} else if cfg.EscrowJobToken, err = loadEscrowJobToken(path); err != nil {
		problems = append(problems, err)
	}

	if err := errors.Join(problems...); err != nil {
		return EscrowRotationConfig{}, err
	}

	return cfg, nil
}
