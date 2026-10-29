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
	"os"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/term"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/version"
)

const usage = "usage: vault-sync-server import [-passphrase-file FILE | -private-key-file FILE | -escrow-identity-file FILE | -escrow] SERVER_URL VAULT_ID DIR"

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
	passphraseFile := flags.String("passphrase-file", "", "file holding your recovery passphrase, for an end-to-end encrypted vault")
	privateKeyFile := flags.String("private-key-file", "", "file holding your private key as an age identity, for an end-to-end encrypted vault")
	escrowIdentityFile := flags.String("escrow-identity-file", "", "file holding the deployment's escrow identity (age identity file), for an escrowed end-to-end encrypted vault")
	escrowPrompt := flags.Bool("escrow", false, "type the deployment's escrow identity at the terminal, for an escrowed end-to-end encrypted vault")

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

	given := 0

	for _, set := range []bool{*passphraseFile != "", *privateKeyFile != "", *escrowIdentityFile != "", *escrowPrompt} {
		if set {
			given++
		}
	}

	if given > 1 {
		_, _ = fmt.Fprintf(stderr, "give at most one of -passphrase-file, -private-key-file, -escrow-identity-file and -escrow\n%s\n", usage)

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

	secrets := secretSource{
		passphraseFile:     *passphraseFile,
		privateKeyFile:     *privateKeyFile,
		escrowIdentityFile: *escrowIdentityFile,
		escrowPrompt:       *escrowPrompt,
		prompt:             stderr,
	}

	result, err := run(ctx, strings.TrimSuffix(serverURL.String(), "/"), vaultID, report.Source, secrets, lookup, stderr)
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

func run(ctx context.Context, serverURL string, vaultID uuid.UUID, source string, secrets secretSource, lookup func(string) (string, bool), stderr io.Writer) (Result, error) {
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

	encrypted, err := client.checkVault(ctx, vaultID)
	if err != nil {
		return empty, err
	}

	target := &APITarget{client: client, vaultID: vaultID}

	if encrypted {
		opener, err := secrets.opener(ctx, client)
		if err != nil {
			return empty, err
		}

		target.refreshKeys = func(ctx context.Context) (*vaultKeys, error) { return client.vaultKeys(ctx, vaultID, opener) }
		if target.keys, err = target.refreshKeys(ctx); err != nil {
			return empty, err
		}

		logger.InfoContext(ctx, "unlocked the vault's keys", "epoch", target.keys.epoch)
	}

	target.deviceID, err = client.registerDevice(ctx)
	if err != nil {
		return empty, err
	}

	deviceID := target.deviceID

	defer func() {
		if err := client.removeDevice(context.WithoutCancel(ctx), deviceID); err != nil {
			logger.ErrorContext(ctx, "cannot remove the import device", "device_id", deviceID, "error", err)
		}
	}()

	result, err := Import(ctx, Options{
		Source:       source,
		MaxFileBytes: cfg.MaxFileBytes,
		Target:       target,
	})
	if err != nil {
		logger.ErrorContext(ctx, "import failed", "error", err)
	} else {
		logger.InfoContext(ctx, "import finished", "text", result.Imported.Text, "blob", result.Imported.Blob,
			"folder", result.Imported.Folder, "bytes", result.Bytes, "skipped", len(result.Skipped))
	}

	return result, err
}

// secretSource is where the import reads what unlocks an end-to-end
// encrypted vault's keys: the escrow identity from a file or typed at the
// terminal, or the user's key from a passphrase file, a private key file,
// or else a passphrase typed at the terminal. The secret itself is never an
// argument.
type secretSource struct {
	passphraseFile     string
	privateKeyFile     string
	escrowIdentityFile string
	escrowPrompt       bool
	// prompt is where the terminal prompt is written.
	prompt io.Writer
}

// readTerminalPassphrase reads a passphrase from the terminal without
// echoing it; it fails when standard input is not a terminal.
var readTerminalPassphrase = func(prompt io.Writer) (string, error) {
	return readTerminalSecret(prompt, "Recovery passphrase: ", "the passphrase",
		"the vault is end-to-end encrypted: give -passphrase-file, -private-key-file or -escrow-identity-file, or run the import at a terminal to type the passphrase")
}

// readTerminalEscrowIdentity reads an escrow identity from the terminal
// without echoing it; it fails when standard input is not a terminal.
var readTerminalEscrowIdentity = func(prompt io.Writer) (string, error) {
	return readTerminalSecret(prompt, "Escrow identity (AGE-SECRET-KEY-PQ-1…): ", "the escrow identity",
		"-escrow reads the escrow identity at a terminal; give -escrow-identity-file instead")
}

func readTerminalSecret(prompt io.Writer, label, what, notTerminal string) (string, error) {
	fd := int(os.Stdin.Fd()) //nolint:gosec // a file descriptor fits an int.
	if !term.IsTerminal(fd) {
		return "", errors.New(notTerminal)
	}

	_, _ = fmt.Fprint(prompt, label)
	secret, err := term.ReadPassword(fd)
	_, _ = fmt.Fprintln(prompt)

	if err != nil {
		return "", fmt.Errorf("read %s: %w", what, err)
	}

	return string(secret), nil
}

// opener returns what opens the vault's key slots: the escrow identity for
// the escrow slots, or else the user's private key, unlocked through the
// server, for the user's own slots.
func (source secretSource) opener(ctx context.Context, client *apiClient) (slotOpener, error) {
	switch {
	case source.escrowIdentityFile != "":
		identities, err := ReadEscrowIdentityFile(source.escrowIdentityFile)
		if err != nil {
			return slotOpener{}, err
		}

		return escrowSlots(identities), nil
	case source.escrowPrompt:
		typed, err := readTerminalEscrowIdentity(source.prompt)
		if err != nil {
			return slotOpener{}, err
		}

		identities, err := ParseEscrowIdentities(typed)
		if err != nil {
			return slotOpener{}, fmt.Errorf("the escrow identity: %w", err)
		}

		return escrowSlots(identities), nil
	}

	secret, err := source.read()
	if err != nil {
		return slotOpener{}, err
	}

	privateKey, err := client.userPrivateKey(ctx, secret)
	if err != nil {
		return slotOpener{}, err
	}

	return userSlots(privateKey), nil
}

func (source secretSource) read() (UserSecret, error) {
	switch {
	case source.privateKeyFile != "":
		privateKey, err := ReadPrivateKeyFile(source.privateKeyFile)

		return UserSecret{PrivateKey: privateKey}, err
	case source.passphraseFile != "":
		passphrase, err := ReadPassphraseFile(source.passphraseFile)

		return UserSecret{Passphrase: passphrase}, err
	}

	passphrase, err := readTerminalPassphrase(source.prompt)
	if err == nil && passphrase == "" {
		err = errors.New("the passphrase is empty")
	}

	return UserSecret{Passphrase: passphrase}, err
}
