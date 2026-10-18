// Package testinfra gives integration tests access to the dependencies that
// `make test-integration` starts with docker compose (PostgreSQL and an
// S3-compatible store). Each accessor skips the calling test, with a message
// naming the missing variable, when the dependency is not configured, so the
// `integration`-tagged tests pass (as skips) on machines without Docker.
package testinfra

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/store"
)

// Environment variables exported by scripts/test-integration.sh.
const (
	// DatabaseURLEnv is a PostgreSQL URL for a role allowed to create
	// databases.
	DatabaseURLEnv = "VAULT_SYNC_TEST_DATABASE_URL"
	// S3EndpointEnv is the base URL of the S3-compatible store.
	S3EndpointEnv = "VAULT_SYNC_TEST_S3_ENDPOINT"
	// S3RegionEnv is the S3 region.
	S3RegionEnv = "VAULT_SYNC_TEST_S3_REGION"
	// S3AccessKeyEnv is the S3 access key id.
	S3AccessKeyEnv = "VAULT_SYNC_TEST_S3_ACCESS_KEY"
	// S3SecretKeyEnv is the S3 secret access key.
	S3SecretKeyEnv = "VAULT_SYNC_TEST_S3_SECRET_KEY"
)

func requireEnv(t testing.TB, name, dependency string) string {
	t.Helper()

	value := os.Getenv(name)
	if value == "" {
		t.Skipf("skipping: %s is not set, so %s is unavailable; run `make test-integration` (requires Docker) to start it", name, dependency)
	}

	return value
}

// PostgresConfig creates an empty database for the calling test, drops it
// when the test ends, and returns a store configuration pointing at it.
func PostgresConfig(t testing.TB) store.Config {
	t.Helper()

	baseURL := requireEnv(t, DatabaseURLEnv, "PostgreSQL")

	admin, err := pgx.Connect(t.Context(), baseURL)
	require.NoError(t, err, "connect to %s", DatabaseURLEnv)

	defer func() { _ = admin.Close(context.WithoutCancel(t.Context())) }()

	suffix := make([]byte, 8)
	_, _ = rand.Read(suffix)
	name := "vault_sync_test_" + hex.EncodeToString(suffix)

	_, err = admin.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)

	t.Cleanup(func() {
		// t.Context is already canceled when cleanups run.
		ctx := context.WithoutCancel(t.Context())

		conn, err := pgx.Connect(ctx, baseURL)
		if err != nil {
			t.Errorf("connect to drop test database %s: %v", name, err)

			return
		}

		defer func() { _ = conn.Close(ctx) }()

		if _, err := conn.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Errorf("drop test database %s: %v", name, err)
		}
	})

	databaseURL, err := url.Parse(baseURL)
	require.NoError(t, err, "%s must be a postgres:// URL", DatabaseURLEnv)

	databaseURL.Path = "/" + name

	return store.Config{DSN: databaseURL.String()}
}

// S3Config describes the S3-compatible store started for integration tests.
type S3Config struct {
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
}

// S3 returns the S3-compatible store's connection details.
func S3(t testing.TB) S3Config {
	t.Helper()

	return S3Config{
		Endpoint:  requireEnv(t, S3EndpointEnv, "the S3-compatible store"),
		Region:    requireEnv(t, S3RegionEnv, "the S3-compatible store"),
		AccessKey: requireEnv(t, S3AccessKeyEnv, "the S3-compatible store"),
		SecretKey: requireEnv(t, S3SecretKeyEnv, "the S3-compatible store"),
	}
}
