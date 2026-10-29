package vaultimport

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"strings"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const usage = "usage: vault-sync-server import SERVER_URL VAULT_ID DIR"

// DeviceName names the device the import's revisions are attributed to. It
// is registered for the signed-in user for the run and removed afterwards.
const DeviceName = "vault-sync-server import"

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
// the import failed, 2 on a usage error. The import is a client of the
// server's API: it signs in with the OIDC device authorization grant, telling
// the user on stderr where to approve the sign-in, and commits like any other
// device. It reads the optional log level and file size limit through
// lookup; logs go to stderr.
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

	if flags.NArg() != 3 {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	serverURL, err := url.Parse(flags.Arg(0))
	if err != nil || (serverURL.Scheme != "https" && serverURL.Scheme != "http") || serverURL.Host == "" {
		_, _ = fmt.Fprintf(stderr, "%q is not an http(s) server URL\n%s\n", flags.Arg(0), usage)

		return 2
	}

	vaultID, err := uuid.Parse(flags.Arg(1))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%q is not a vault ID\n%s\n", flags.Arg(1), usage)

		return 2
	}

	report := Report{VaultID: vaultID, Source: flags.Arg(2), Result: Result{Skipped: []Skip{}}}

	result, err := run(ctx, strings.TrimSuffix(serverURL.String(), "/"), vaultID, report.Source, lookup, stderr)
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

func run(ctx context.Context, serverURL string, vaultID uuid.UUID, source string, lookup func(string) (string, bool), stderr io.Writer) (Result, error) {
	empty := Result{Skipped: []Skip{}}

	cfg, err := config.LoadImport(lookup)
	if err != nil {
		return empty, fmt.Errorf("invalid configuration; see docs/import.md: %s", strings.ReplaceAll(err.Error(), "\n", "; "))
	}

	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.InfoContext(ctx, "starting vault-sync-server import", "version", version.String(), "server", serverURL, "vault_id", vaultID)

	client, err := signIn(ctx, serverURL, stderr)
	if err != nil {
		return empty, err
	}

	if err := client.checkVault(ctx, vaultID); err != nil {
		return empty, err
	}

	deviceID, err := client.registerDevice(ctx)
	if err != nil {
		return empty, err
	}

	defer func() {
		if err := client.removeDevice(context.WithoutCancel(ctx), deviceID); err != nil {
			logger.ErrorContext(ctx, "cannot remove the import device", "device_id", deviceID, "error", err)
		}
	}()

	result, err := Import(ctx, Options{
		Source:       source,
		MaxFileBytes: cfg.MaxFileBytes,
		Target:       &APITarget{client: client, vaultID: vaultID, deviceID: deviceID},
	})
	if err != nil {
		logger.ErrorContext(ctx, "import failed", "error", err)
	} else {
		logger.InfoContext(ctx, "import finished", "text", result.Imported.Text, "blob", result.Imported.Blob,
			"folder", result.Imported.Folder, "bytes", result.Bytes, "skipped", len(result.Skipped))
	}

	return result, err
}
