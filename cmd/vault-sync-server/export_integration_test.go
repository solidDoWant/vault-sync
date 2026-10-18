//go:build integration && linux

package main_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/testinfra"
)

// The export subcommand runs from the binary, writes its summary to stdout
// and reports failure through its exit status.
func TestExportSubcommand(t *testing.T) {
	database := testinfra.PostgresConfig(t)
	bucket := testinfra.S3Bucket(t)

	pool, err := store.Open(t.Context(), database)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	_, err = store.Migrate(t.Context(), pool, slog.New(slog.DiscardHandler))
	require.NoError(t, err)

	queries := store.New(pool)
	user, err := queries.UpsertUser(t.Context(), "https://auth.example/", "alice")
	require.NoError(t, err)

	vault, err := queries.CreateVault(t.Context(), user, store.NewVault{Name: "Notes", Encryption: store.EncryptionNone}, 10)
	require.NoError(t, err)

	binary := buildServer(t)
	output := filepath.Join(t.TempDir(), "export")

	environment := append(os.Environ(),
		config.DatabaseURLEnv+"="+database.DSN,
		config.S3EndpointEnv+"="+bucket.Endpoint,
		config.S3RegionEnv+"="+bucket.Region,
		config.S3BucketEnv+"="+bucket.Bucket,
		config.S3AccessKeyIDFileEnv+"="+bucket.AccessKeyIDFile,
		config.S3SecretAccessKeyFileEnv+"="+bucket.SecretAccessKeyFile,
	)

	run := func(args ...string) (int, export.Summary) {
		var stdout bytes.Buffer

		command := exec.CommandContext(t.Context(), binary, args...)
		command.Env = environment
		command.Stdout = &stdout

		var exitErr *exec.ExitError

		err := command.Run()
		code := 0

		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			require.NoError(t, err)
		}

		var summary export.Summary
		if stdout.Len() > 0 {
			require.NoError(t, json.Unmarshal(stdout.Bytes(), &summary))
		}

		return code, summary
	}

	code, summary := run("export", "-out", output)
	assert.Equal(t, 0, code)
	assert.Equal(t, export.StatusOK, summary.Status)
	require.Len(t, summary.VaultDetails, 1)
	assert.Equal(t, vault.ID, summary.VaultDetails[0].ID)
	assert.DirExists(t, filepath.Join(output, vault.ID.String()))

	// An unrelated, non-empty directory is refused.
	unrelated := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(unrelated, "keep.txt"), []byte("keep"), 0o600))

	code, summary = run("export", "-out", unrelated)
	assert.Equal(t, 1, code)
	assert.Equal(t, export.StatusFailed, summary.Status)
	assert.FileExists(t, filepath.Join(unrelated, "keep.txt"))

	code, _ = run("export")
	assert.Equal(t, 2, code, "usage error")
}
