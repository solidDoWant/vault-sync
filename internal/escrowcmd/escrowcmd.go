// Package escrowcmd is the `vault-sync-server escrow` subcommand. Its one
// command, `escrow fingerprint`, prints the fingerprint of the deployment's
// escrow pair (the age recipient and the Ed25519 signing public key), which
// the operator publishes so that owners can compare it with what their
// devices show (docs/design/encryption.md, "Escrow fingerprint"). It needs no
// database, no network and no private key.
package escrowcmd

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/e2ee"
)

const usage = `usage: vault-sync-server escrow fingerprint [--recipient AGE1PQ1…] [--signing-key BASE64]
Without the flags it reads ` + config.EscrowRecipientEnv + ` and ` + config.EscrowSigningKeyEnv + `.`

// Main runs the subcommand with args (after "escrow") and returns its exit
// code: 0 on success, 1 for a malformed recipient or signing key, 2 on a
// usage error. It reads the escrow variables of the server through lookup
// when a flag is not given. Errors never quote the input.
func Main(args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "fingerprint" {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	flags := flag.NewFlagSet("vault-sync-server escrow fingerprint", flag.ContinueOnError)
	flags.SetOutput(stderr)
	recipient := flags.String("recipient", "", "the escrow key's age hybrid recipient, age1pq1… (default "+config.EscrowRecipientEnv+")")
	signingKey := flags.String("signing-key", "", "the escrow signing public key, standard base64 of 32 bytes (default "+config.EscrowSigningKeyEnv+")")

	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	given := map[string]bool{}

	flags.Visit(func(defined *flag.Flag) { given[defined.Name] = true })

	if !given["recipient"] {
		*recipient, _ = lookup(config.EscrowRecipientEnv)
	}

	if !given["signing-key"] {
		*signingKey, _ = lookup(config.EscrowSigningKeyEnv)
	}

	*recipient, *signingKey = strings.TrimSpace(*recipient), strings.TrimSpace(*signingKey)

	if flags.NArg() > 0 || *recipient == "" || *signingKey == "" {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	fingerprint, err := escrowFingerprint(*recipient, *signingKey)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "vault-sync-server escrow fingerprint: %v\n", err)

		return 1
	}

	_, _ = fmt.Fprintln(stdout, fingerprint)

	return 0
}

// escrowFingerprint returns the escrow fingerprint of the pair as displayed.
// Its errors do not quote the input.
func escrowFingerprint(recipient, signingKey string) (string, error) {
	var problems []error

	if _, err := e2ee.ParseAgeRecipient(recipient); err != nil {
		problems = append(problems, errors.New("the recipient is not an age hybrid post-quantum recipient (age1pq1…)"))
	}

	signPub, err := base64.StdEncoding.DecodeString(signingKey)
	if err != nil || len(signPub) != e2ee.SignPublicKeySize {
		problems = append(problems, fmt.Errorf("the signing key is not a standard base64 Ed25519 public key (%d bytes)", e2ee.SignPublicKeySize))
	}

	if len(problems) > 0 {
		return "", errors.Join(problems...)
	}

	fingerprint, err := e2ee.EscrowBundle{SignPub: signPub, Recipient: recipient}.Fingerprint()
	if err != nil {
		return "", errors.New("the recipient is too long for an escrow bundle")
	}

	return e2ee.FormatFingerprint(fingerprint), nil
}
