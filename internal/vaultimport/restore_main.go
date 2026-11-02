package vaultimport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/version"
)

// RestoreReport is the one-line JSON summary of a restore from an export
// (docs/design/restore-from-export.md §6).
type RestoreReport struct {
	Status      string    `json:"status"`
	Error       string    `json:"error,omitempty"`
	VaultID     uuid.UUID `json:"vault_id"`
	Source      string    `json:"source"`
	SourceVault uuid.UUID `json:"source_vault"`
	RestoreResult
}

// restoreRun is what the command line asks a restore to do.
type restoreRun struct {
	serverURL     string
	vaultID       uuid.UUID
	exportDir     string
	sourceVaultID uuid.UUID
	allowPartial  bool
	secrets       secretSource
}

// encryptionE2EE is the manifest's encryption of an end-to-end encrypted
// vault.
const encryptionE2EE = "e2ee"

// mainRestore runs a restore and writes its report; it returns the exit
// code: 0 only when every document is at its own path.
func mainRestore(ctx context.Context, request restoreRun, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	report := RestoreReport{VaultID: request.vaultID, Source: request.exportDir, SourceVault: request.sourceVaultID}

	result, err := runRestore(ctx, request, lookup, stderr)
	report.RestoreResult = result

	switch {
	case err != nil:
		report.Status = StatusFailed
		report.Error = err.Error()
	case result.partial():
		report.Status = StatusPartial
	default:
		report.Status = StatusOK
	}

	encoded, encodeErr := json.Marshal(report)
	if encodeErr != nil {
		_, _ = fmt.Fprintf(stderr, "cannot encode the report: %v\n", encodeErr)

		return 1
	}

	_, _ = fmt.Fprintf(stdout, "%s\n", encoded)

	if report.Status != StatusOK {
		return 1
	}

	return 0
}

func runRestore(ctx context.Context, request restoreRun, lookup func(string) (string, bool), stderr io.Writer) (RestoreResult, error) {
	empty := newRestoreResult()

	cfg, err := config.LoadImport(lookup)
	if err != nil {
		return empty, fmt.Errorf("invalid configuration; see docs/admin/backup-and-restore.md: %s", strings.ReplaceAll(err.Error(), "\n", "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server import from an export", "version", version.String(), "server", request.serverURL,
		"vault_id", request.vaultID, "source_vault", request.sourceVaultID)

	manifest, err := ReadExportManifest(request.exportDir, request.sourceVaultID)
	if err != nil {
		return empty, err
	}

	client, err := signIn(ctx, request.serverURL, stderr)
	if err != nil {
		return empty, err
	}

	encrypted, err := client.checkVault(ctx, request.vaultID)
	if err != nil {
		return empty, err
	}

	if manifest.Vault.Encryption == encryptionE2EE && !encrypted {
		return empty, errors.New("the exported vault was end-to-end encrypted and the target vault is not; restore it into a new end-to-end encrypted vault")
	}

	cleanup := func() {}
	defer func() { cleanup() }()

	result, err := Restore(ctx, RestoreOptions{
		ExportDir:    request.exportDir,
		Manifest:     manifest,
		MaxFileBytes: cfg.MaxFileBytes,
		AllowPartial: request.allowPartial,
		Logger:       logger,
		Target: func(ctx context.Context) (RestoreTarget, error) {
			target, remove, err := openTarget(ctx, client, request.vaultID, encrypted, request.secrets, logger)
			if err != nil {
				return nil, err
			}

			cleanup = remove

			return target, nil
		},
	})
	if err != nil {
		logger.ErrorContext(ctx, "restore failed", "error", err)
	} else {
		logger.InfoContext(ctx, "restore finished", "text", result.Imported.Text, "blob", result.Imported.Blob,
			"folder", result.Imported.Folder, "bytes", result.Bytes, "fallback", len(result.Fallback),
			"missing", len(result.Missing), "failed_verification", len(result.FailedVerification))
	}

	return result, err
}
