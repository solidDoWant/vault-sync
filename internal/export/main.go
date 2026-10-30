package export

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/blobstore"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/version"
)

// s3CheckTimeout bounds the startup check that the bucket is reachable.
const s3CheckTimeout = 30 * time.Second

// recordTimeout bounds recording the run's outcome in the database.
const recordTimeout = 30 * time.Second

// Main runs the export subcommand: it loads the configuration through
// lookup, exports every vault to the -out directory, and writes a one-line
// JSON Summary to stdout (logs go to stderr). It returns the process exit
// code: 0 when every document was exported, 1 on any failure or left-out
// document, 2 for invalid flags. `export rotate-escrow …` runs RotateMain
// instead.
func Main(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "rotate-escrow" {
		return RotateMain(ctx, args[1:], lookup, stdout, stderr)
	}

	flags := flag.NewFlagSet("vault-sync-server export", flag.ContinueOnError)
	flags.SetOutput(stderr)
	output := flags.String("out", "", "export directory (required); replaced atomically by each run")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	if *output == "" || flags.NArg() > 0 {
		_, _ = fmt.Fprintln(stderr, "usage: vault-sync-server export -out DIR")

		return 2
	}

	started := time.Now()

	summary, err := runExport(ctx, *output, lookup, stderr)
	if err != nil && summary.Status == "" {
		// The export did not start: report the failure in the same shape.
		summary = Summary{
			Status: StatusFailed, Error: err.Error(), Output: *output, StartedAt: started.UTC(),
			DurationSeconds: time.Since(started).Seconds(), VaultDetails: []VaultSummary{},
		}
	}

	encoded, encodeErr := json.Marshal(summary)
	if encodeErr != nil {
		_, _ = fmt.Fprintf(stderr, "cannot encode the summary: %v\n", encodeErr)

		return 1
	}

	_, _ = fmt.Fprintf(stdout, "%s\n", encoded)

	if summary.Status != StatusOK {
		return 1
	}

	return 0
}

func runExport(ctx context.Context, output string, lookup func(string) (string, bool), stderr io.Writer) (Summary, error) {
	cfg, err := config.LoadExport(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(stderr, nil))
		logger.ErrorContext(ctx, "invalid configuration; see docs/admin/backup-and-restore.md", "problems", problemList(err))

		return Summary{}, fmt.Errorf("invalid configuration: %s", strings.Join(problemList(err), "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server export", "version", version.String(), "output", output)

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		logger.ErrorContext(ctx, "cannot open database", "error", err)

		return Summary{}, err
	}
	defer pool.Close()

	objects, err := blobstore.New(cfg.S3)
	if err != nil {
		logger.ErrorContext(ctx, "cannot use the S3 object store", "error", err)

		return Summary{}, err
	}

	checkCtx, cancel := context.WithTimeout(ctx, s3CheckTimeout)
	defer cancel()

	if err := objects.Check(checkCtx); err != nil {
		logger.ErrorContext(ctx, "cannot use the S3 object store", "error", err)

		return Summary{}, err
	}

	identities := make([]EscrowIdentity, 0, len(cfg.EscrowIdentities))

	for _, privateKey := range cfg.EscrowIdentities {
		identity, err := NewEscrowIdentity(privateKey)
		if err != nil {
			return Summary{}, fmt.Errorf("escrow identity: %w", err)
		}

		identities = append(identities, identity)
	}

	queries := store.New(pool)

	summary, err := Run(ctx, Options{
		Output:           output,
		Source:           &StoreSource{Store: queries, Objects: objects},
		Logger:           logger,
		EscrowIdentities: identities,
	})
	if err != nil {
		logger.ErrorContext(ctx, "export failed; the previous export is untouched", "error", err)
	} else {
		logger.InfoContext(ctx, "export finished", "status", summary.Status, "vaults", summary.Vaults,
			"skipped_vaults", summary.SkippedVaults, "failed_vaults", summary.FailedVaults,
			"files", summary.Files, "bytes", summary.Bytes, "unplaced", summary.Unplaced, "document_errors", summary.DocumentErrors)
	}

	// Recorded even when the run was interrupted, so the status shows it;
	// failing to record it does not change the export's outcome.
	recordCtx, cancelRecord := context.WithTimeout(context.WithoutCancel(ctx), recordTimeout)
	defer cancelRecord()

	if recordErr := queries.RecordExportRun(recordCtx, summary.Status); recordErr != nil {
		logger.WarnContext(ctx, "cannot record the export's outcome in export_status; see docs/admin/backup-and-restore.md for the grant it needs", "error", recordErr)
	}

	return summary, err
}

// StoreSource reads vaults and documents from the store and content from the
// object store.
type StoreSource struct {
	Store   *store.Store
	Objects *blobstore.Objects
}

// Vaults implements Source.
func (source *StoreSource) Vaults(ctx context.Context, after uuid.UUID, limit int) ([]store.Vault, error) {
	return source.Store.AllVaults(ctx, after, limit)
}

// Documents implements Source.
func (source *StoreSource) Documents(ctx context.Context, vaultID uuid.UUID, seq int64, after uuid.UUID, limit int) ([]store.LiveDocument, error) {
	return source.Store.InVault(vaultID).LiveDocumentsAt(ctx, seq, after, limit)
}

// Content implements Source.
func (source *StoreSource) Content(ctx context.Context, vaultID uuid.UUID, blobID []byte) (io.ReadCloser, error) {
	content, err := source.Objects.Open(ctx, blobstore.BlobKey(vaultID, blobID))
	if errors.Is(err, blobstore.ErrNoObject) {
		return nil, ErrContentMissing
	}

	return content, err
}

// Epochs implements Source.
func (source *StoreSource) Epochs(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.Epoch, error) {
	return source.Store.InVault(vaultID).ListEpochs(ctx, after, limit)
}

// EscrowSlots implements Source.
func (source *StoreSource) EscrowSlots(ctx context.Context, vaultID uuid.UUID, keyID string, after int32, limit int) ([]store.KeySlot, error) {
	return source.Store.InVault(vaultID).ListKeySlots(ctx, store.RecipientEscrow, keyID, after, limit)
}

// problemList flattens errors.Join trees into one message per problem.
func problemList(err error) []string {
	var joined interface{ Unwrap() []error }
	if !errors.As(err, &joined) {
		return []string{err.Error()}
	}

	var problems []string
	for _, problem := range joined.Unwrap() {
		problems = append(problems, problem.Error())
	}

	return problems
}
