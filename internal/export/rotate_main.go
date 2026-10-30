package export

import (
	"context"
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
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	vaultsyncv1 "github.com/solidDoWant/vault-sync/gen/vaultsync/v1"
	"github.com/solidDoWant/vault-sync/gen/vaultsync/v1/vaultsyncv1connect"
	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
	"github.com/solidDoWant/vault-sync/internal/store"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const (
	rotateUsage = "usage: vault-sync-server export rotate-escrow -server URL -recipient AGE1PQ1… -signing-public-key BASE64"
	// rotationRequestTimeout bounds each write to the job-only endpoint.
	rotationRequestTimeout = time.Minute
)

// RotateMain runs `export rotate-escrow`: it rotates the deployment's escrow
// key to the bundle named by -recipient and -signing-public-key, writing
// through the server at -server, and writes a one-line JSON
// RotationSummary to stdout (logs go to stderr). It returns the process
// exit code: 0 when no escrow slot is left on an old key, 1 when some are
// or any failed its check, 2 for invalid flags.
func RotateMain(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("vault-sync-server export rotate-escrow", flag.ContinueOnError)
	flags.SetOutput(stderr)
	server := flags.String("server", "", "the vault-sync server's URL (required); the writes go through its job-only endpoint")
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
		_, _ = fmt.Fprintln(stderr, rotateUsage)

		return 2
	}

	summary, err := runRotation(ctx, strings.TrimRight(serverURL.String(), "/"), e2ee.EscrowBundle{SignPub: signPub, Recipient: *recipient}, lookup, stderr)
	if err != nil && summary.Status == "" {
		summary = RotationSummary{Status: StatusFailed, Error: err.Error(), Failures: []SlotFailure{}}
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

func runRotation(ctx context.Context, serverURL string, target e2ee.EscrowBundle, lookup func(string) (string, bool), stderr io.Writer) (RotationSummary, error) {
	cfg, err := config.LoadEscrowRotation(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(stderr, nil))
		logger.ErrorContext(ctx, "invalid configuration; see docs/export.md", "problems", problemList(err))

		return RotationSummary{}, fmt.Errorf("invalid configuration: %s", strings.Join(problemList(err), "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server export rotate-escrow", "version", version.String(), "server", serverURL)

	identities := make([]EscrowIdentity, 0, len(cfg.EscrowIdentities))

	for _, privateKey := range cfg.EscrowIdentities {
		identity, err := NewEscrowIdentity(privateKey)
		if err != nil {
			return RotationSummary{}, fmt.Errorf("escrow identity: %w", err)
		}

		identities = append(identities, identity)
	}

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		logger.ErrorContext(ctx, "cannot open database", "error", err)

		return RotationSummary{}, err
	}
	defer pool.Close()

	summary, err := Rotate(ctx, RotationOptions{
		Source:      &StoreRotationSource{Store: store.New(pool)},
		Writer:      NewEscrowJobWriter(&http.Client{Timeout: rotationRequestTimeout}, serverURL, cfg.EscrowJobToken),
		Logger:      logger,
		Target:      target,
		Identities:  identities,
		SigningKeys: cfg.EscrowSigningKeys,
	})
	if err != nil {
		logger.ErrorContext(ctx, "escrow rotation failed", "error", err)
	} else {
		logger.InfoContext(ctx, "escrow rotation finished", "status", summary.Status, "appended_statement", summary.AppendedStatement,
			"vaults", summary.Vaults, "rewrapped", summary.Rewrapped, "old_key_slots", summary.OldKeySlots, "failed_slots", summary.FailedSlots)
	}

	return summary, err
}

// StoreRotationSource reads the escrow chain and escrow slots from the store.
type StoreRotationSource struct {
	Store *store.Store
}

// EscrowChain implements RotationSource.
func (source *StoreRotationSource) EscrowChain(ctx context.Context) (store.EscrowChain, error) {
	return source.Store.EscrowChain(ctx, nil)
}

// Vaults implements RotationSource.
func (source *StoreRotationSource) Vaults(ctx context.Context, after uuid.UUID, limit int) ([]store.Vault, error) {
	return source.Store.AllVaults(ctx, after, limit)
}

// Epochs implements RotationSource.
func (source *StoreRotationSource) Epochs(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.Epoch, error) {
	return source.Store.InVault(vaultID).ListEpochs(ctx, after, limit)
}

// AllEscrowSlots implements RotationSource.
func (source *StoreRotationSource) AllEscrowSlots(ctx context.Context, vaultID uuid.UUID, after int32, limit int) ([]store.KeySlot, error) {
	return source.Store.InVault(vaultID).ListEscrowSlots(ctx, after, limit)
}

// EscrowJobWriter writes through the server's EscrowJobService with the job
// token.
type EscrowJobWriter struct {
	client vaultsyncv1connect.EscrowJobServiceClient
}

// NewEscrowJobWriter returns a writer to the EscrowJobService at serverURL
// that presents token as its bearer token.
func NewEscrowJobWriter(httpClient *http.Client, serverURL string, token []byte) *EscrowJobWriter {
	authorization := "Bearer " + string(token)
	interceptor := connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			request.Header().Set("Authorization", authorization)

			return next(ctx, request)
		}
	})

	return &EscrowJobWriter{client: vaultsyncv1connect.NewEscrowJobServiceClient(httpClient, serverURL, connect.WithInterceptors(interceptor))}
}

// AppendEscrowRotation implements RotationWriter.
func (writer *EscrowJobWriter) AppendEscrowRotation(ctx context.Context, statement e2ee.EscrowRotation) error {
	newBundle, err := statement.NewBundle.Encode()
	if err != nil {
		return err
	}

	_, err = writer.client.AppendEscrowRotation(ctx, connect.NewRequest(&vaultsyncv1.AppendEscrowRotationRequest{
		Statement: &vaultsyncv1.EscrowRotationStatement{OldBundleHash: statement.OldBundleHash, NewBundle: newBundle, Signature: statement.Signature},
	}))

	return err
}

// ResetEscrowChain implements ResetWriter.
func (writer *EscrowJobWriter) ResetEscrowChain(ctx context.Context, expectedHeadHash []byte, newBundle e2ee.EscrowBundle) error {
	encoded, err := newBundle.Encode()
	if err != nil {
		return err
	}

	_, err = writer.client.ResetEscrowChain(ctx, connect.NewRequest(&vaultsyncv1.ResetEscrowChainRequest{
		ExpectedHeadHash: expectedHeadHash,
		NewBundle:        encoded,
	}))

	return err
}

// ReplaceEscrowSlot implements RotationWriter.
func (writer *EscrowJobWriter) ReplaceEscrowSlot(ctx context.Context, replacement store.EscrowSlotReplacement) error {
	_, err := writer.client.ReplaceEscrowSlot(ctx, connect.NewRequest(&vaultsyncv1.ReplaceEscrowSlotRequest{
		VaultId:        replacement.VaultID.String(),
		Epoch:          uint32(replacement.Epoch), //nolint:gosec // escrow slots have positive epochs.
		OldRecipientId: replacement.OldRecipientID,
		NewRecipientId: replacement.NewRecipientID,
		WrappedKey:     replacement.WrappedKey,
	}))
	if connect.CodeOf(err) == connect.CodeNotFound {
		return ErrEscrowSlotGone
	}

	return err
}
