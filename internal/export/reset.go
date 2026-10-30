package export

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const resetUsage = "usage: vault-sync-server export reset-escrow -server URL -recipient AGE1PQ1… -signing-public-key BASE64"

// EscrowChainSource reads the deployment's stored escrow chain.
type EscrowChainSource interface {
	// EscrowChain returns the stored escrow chain.
	EscrowChain(ctx context.Context) (store.EscrowChain, error)
}

// ResetWriter is the server's job-only endpoint an escrow reset writes
// through.
type ResetWriter interface {
	// ResetEscrowChain appends a reset point to newBundle after the chain
	// head that hashes to expectedHeadHash.
	ResetEscrowChain(ctx context.Context, expectedHeadHash []byte, newBundle e2ee.EscrowBundle) error
}

// ResetSummary is the one-line JSON outcome of `export reset-escrow`.
type ResetSummary struct {
	// Status is ok when the reset point was appended, failed otherwise.
	Status string `json:"status"`
	// Error says why the run failed; empty when it did not.
	Error string `json:"error,omitempty"`
}

// ResetEscrow appends a reset point to target after the stored chain's
// head (docs/design/encryption.md, "Escrow reset on the server"). It checks
// the stored chain first and names its head's hash, so the server appends
// only while the head has not moved.
func ResetEscrow(ctx context.Context, source EscrowChainSource, writer ResetWriter, target e2ee.EscrowBundle) error {
	if _, err := target.Encode(); err != nil {
		return fmt.Errorf("the new escrow bundle: %w", err)
	}

	stored, err := source.EscrowChain(ctx)
	if err != nil {
		return fmt.Errorf("read the escrow chain: %w", err)
	}

	if stored.Root == nil {
		return errors.New("the deployment has no escrow chain")
	}

	headEncoded := stored.Root
	if len(stored.Rotations) > 0 {
		headEncoded = stored.Rotations[len(stored.Rotations)-1].NewBundle
	}

	headHash := sha256.Sum256(headEncoded)

	if err := writer.ResetEscrowChain(ctx, headHash[:], target); err != nil {
		return fmt.Errorf("append the reset point: %w", err)
	}

	return nil
}

// ResetMain runs `export reset-escrow`: it appends a reset point to the
// bundle named by -recipient and -signing-public-key, writing through the
// server at -server, and writes a one-line JSON ResetSummary to stdout (logs
// go to stderr). It returns the process exit code: 0 when the reset point
// was appended, 1 when it was not, 2 for invalid flags.
func ResetMain(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("vault-sync-server export reset-escrow", flag.ContinueOnError)
	flags.SetOutput(stderr)
	server := flags.String("server", "", "the vault-sync server's URL (required); the reset point is written through its job-only endpoint")
	recipient := flags.String("recipient", "", "the new escrow key's age recipient, age1pq1… (required)")
	signingPublicKey := flags.String("signing-public-key", "", "the new escrow signing public key, standard base64 (required)")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	serverURL, urlErr := url.Parse(*server)
	signPub, signErr := base64.StdEncoding.DecodeString(*signingPublicKey)

	if flags.NArg() > 0 || urlErr != nil || (serverURL.Scheme != "http" && serverURL.Scheme != "https") || serverURL.Host == "" ||
		*recipient == "" || signErr != nil || len(signPub) != e2ee.SignPublicKeySize {
		_, _ = fmt.Fprintln(stderr, resetUsage)

		return 2
	}

	summary := ResetSummary{Status: StatusOK}

	err := runReset(ctx, strings.TrimRight(serverURL.String(), "/"), e2ee.EscrowBundle{SignPub: signPub, Recipient: *recipient}, lookup, stderr)
	if err != nil {
		summary = ResetSummary{Status: StatusFailed, Error: err.Error()}
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

func runReset(ctx context.Context, serverURL string, target e2ee.EscrowBundle, lookup func(string) (string, bool), stderr io.Writer) error {
	cfg, err := config.LoadEscrowReset(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(stderr, nil))
		logger.ErrorContext(ctx, "invalid configuration; see docs/export.md", "problems", problemList(err))

		return fmt.Errorf("invalid configuration: %s", strings.Join(problemList(err), "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server export reset-escrow", "version", version.String(), "server", serverURL)

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		logger.ErrorContext(ctx, "cannot open database", "error", err)

		return err
	}
	defer pool.Close()

	err = ResetEscrow(ctx, &StoreRotationSource{Store: store.New(pool)},
		NewEscrowJobWriter(&http.Client{Timeout: rotationRequestTimeout}, serverURL, cfg.EscrowJobToken), target)
	if err != nil {
		logger.ErrorContext(ctx, "escrow reset failed", "error", err)

		return err
	}

	logger.InfoContext(ctx, "escrow reset point appended; now set VAULT_SYNC_ESCROW_RECIPIENT and VAULT_SYNC_ESCROW_SIGNING_KEY to the new bundle")

	return nil
}
