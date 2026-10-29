package vaultimport

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/pathkey"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const usage = "usage: vault-sync-server import VAULT_ID DIR"

// DeviceName names the device the import's revisions are attributed to. It
// is registered for the vault's owner for the run and removed afterwards.
const DeviceName = "vault-sync-server import"

// s3CheckTimeout bounds the startup check that the bucket is reachable.
const s3CheckTimeout = 30 * time.Second

// Report statuses.
const (
	// StatusOK: every file and empty folder was imported.
	StatusOK = "ok"
	// StatusPartial: the import finished, but skipped what Skipped lists.
	StatusPartial = "partial"
	// StatusFailed: the import stopped early, or did not start.
	StatusFailed = "failed"
)

// Report is the one-line JSON summary the subcommand writes to stdout.
type Report struct {
	Status  string    `json:"status"`
	Error   string    `json:"error,omitempty"`
	VaultID uuid.UUID `json:"vault_id"`
	Source  string    `json:"source"`
	Result
}

// Main runs the import subcommand with args (after "import") and returns its
// exit code: 0 when everything was imported, 1 when anything was skipped or
// the import failed, 2 on a usage error. It reads the database, object-store
// and blob size variables of the server through lookup; logs go to stderr.
func Main(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("vault-sync-server import", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { _, _ = fmt.Fprintln(stderr, usage) }

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	if flags.NArg() != 2 {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	vaultID, err := uuid.Parse(flags.Arg(0))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%q is not a vault ID\n%s\n", flags.Arg(0), usage)

		return 2
	}

	report := Report{VaultID: vaultID, Source: flags.Arg(1), Result: Result{Skipped: []Skip{}}}

	result, err := run(ctx, vaultID, report.Source, lookup, stderr)
	report.Result = result

	switch {
	case err != nil:
		report.Status = StatusFailed
		report.Error = err.Error()
	case len(result.Skipped) > 0:
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

func run(ctx context.Context, vaultID uuid.UUID, source string, lookup func(string) (string, bool), stderr io.Writer) (Result, error) {
	empty := Result{Skipped: []Skip{}}

	cfg, err := config.LoadImport(lookup)
	if err != nil {
		return empty, fmt.Errorf("invalid configuration; see docs/import.md: %s", strings.ReplaceAll(err.Error(), "\n", "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server import", "version", version.String(), "vault_id", vaultID)

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		return empty, fmt.Errorf("cannot open database: %w", err)
	}
	defer pool.Close()

	objects, err := blobstore.New(cfg.S3)
	if err != nil {
		return empty, fmt.Errorf("cannot use the S3 object store: %w", err)
	}

	checkCtx, cancel := context.WithTimeout(ctx, s3CheckTimeout)
	defer cancel()

	if err := objects.Check(checkCtx); err != nil {
		return empty, fmt.Errorf("cannot use the S3 object store: %w", err)
	}

	queries := store.New(pool)
	vault := queries.InVault(vaultID)

	owner, err := checkVault(ctx, vault)
	if err != nil {
		return empty, err
	}

	device, err := queries.RegisterDevice(ctx, owner, DeviceName, nil, math.MaxInt32)
	if err != nil {
		return empty, fmt.Errorf("register the import device: %w", err)
	}

	defer func() {
		if err := queries.RemoveDevice(context.WithoutCancel(ctx), owner, device.ID); err != nil {
			logger.ErrorContext(ctx, "cannot remove the import device", "device_id", device.ID, "error", err)
		}
	}()

	result, err := Import(ctx, Options{
		Source:       source,
		MaxFileBytes: cfg.MaxFileBytes,
		Target:       &StoreTarget{Vault: vault, Objects: objects, UserID: owner, DeviceID: device.ID},
	})
	if err != nil {
		logger.ErrorContext(ctx, "import failed", "error", err)
	} else {
		logger.InfoContext(ctx, "import finished", "text", result.Imported.Text, "blob", result.Imported.Blob,
			"folder", result.Imported.Folder, "bytes", result.Bytes, "skipped", len(result.Skipped))
	}

	return result, err
}

// checkVault returns the vault's first owner, after checking that the vault
// exists, is not end-to-end encrypted and has no documents yet.
func checkVault(ctx context.Context, vault *store.VaultStore) (uuid.UUID, error) {
	encryption, err := vault.Encryption(ctx)
	if errors.Is(err, store.ErrNotFound) {
		return uuid.Nil, fmt.Errorf("vault %s does not exist", vault.VaultID())
	}

	if err != nil {
		return uuid.Nil, err
	}

	if encryption != store.EncryptionNone {
		return uuid.Nil, fmt.Errorf("vault %s is end-to-end encrypted; only plaintext vaults can be imported into", vault.VaultID())
	}

	changes, err := vault.ListChanges(ctx, 0, nil, 1)
	if err != nil {
		return uuid.Nil, err
	}

	if changes.HeadSeq != 0 {
		return uuid.Nil, fmt.Errorf("vault %s is not empty; import only into a new vault", vault.VaultID())
	}

	members, err := vault.ListMembers(ctx)
	if err != nil {
		return uuid.Nil, err
	}

	for _, member := range members {
		if member.Role == store.RoleOwner {
			return member.UserID, nil
		}
	}

	return uuid.Nil, fmt.Errorf("vault %s has no owner", vault.VaultID())
}

// StoreTarget creates documents in a vault: content goes to the object store
// under its SHA-256, then one revision commits the document.
type StoreTarget struct {
	Vault    *store.VaultStore
	Objects  *blobstore.Objects
	UserID   uuid.UUID
	DeviceID uuid.UUID
}

// Create implements Target.
func (target *StoreTarget) Create(ctx context.Context, entry Entry) error {
	documentID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	revisionID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	revision := store.NewRevision{
		ID:         revisionID,
		DocumentID: documentID,
		Kind:       string(entry.Kind),
		Path:       entry.Path,
		PathKey:    pathkey.Key(entry.Path),
		DeviceID:   target.DeviceID,
		UserID:     target.UserID,
	}

	if entry.Kind != KindFolder {
		sum := sha256.Sum256(entry.Content)

		if err := target.Objects.Put(ctx, blobstore.BlobKey(target.Vault.VaultID(), sum[:]), entry.Content); err != nil {
			return fmt.Errorf("store content: %w", err)
		}

		if err := target.Vault.RecordCompleteBlob(ctx, sum[:], int64(len(entry.Content))); err != nil {
			return err
		}

		revision.ContentRef = sum[:]
		revision.ContentSize = int64(len(entry.Content))
	}

	_, err = target.Vault.CommitRevision(ctx, revision)

	switch {
	case errors.Is(err, store.ErrPathKeyTaken):
		return &SkipError{Reason: "another imported file or folder has the same name, ignoring case and Unicode normalization"}
	case errors.Is(err, store.ErrPathFolderTaken):
		return &SkipError{Reason: "the path collides with an imported file or folder of the same name"}
	case err != nil:
		return fmt.Errorf("commit: %w", err)
	}

	return nil
}
