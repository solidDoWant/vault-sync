// Package retentioncmd is the `vault-sync-server retention` subcommand, with
// which the operator sets, removes and lists per-vault retention overrides
// (SPEC.md §11, docs/configuration.md). It is the only way to set one: no
// API does.
package retentioncmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const usage = `usage:
  vault-sync-server retention set -vault ID -keep-all DURATION -keep-daily DURATION
  vault-sync-server retention unset -vault ID
  vault-sync-server retention list`

// listPage bounds each query of list.
const listPage = 1000

// Override is one vault's override as the subcommand prints it, one JSON
// object per line.
type Override struct {
	VaultID   uuid.UUID `json:"vault_id"`
	KeepAll   string    `json:"keep_all,omitempty"`
	KeepDaily string    `json:"keep_daily,omitempty"`
	// Updated is when the override was last set; empty after unset.
	Updated *time.Time `json:"updated_at,omitempty"`
	// Removed is set by unset: whether the vault had an override.
	Removed *bool `json:"removed,omitempty"`
}

// Main runs the subcommand with args (after "retention") and returns its
// exit code: 0 on success, 1 on failure, 2 on a usage error. It reads the
// database variables of the server through lookup.
func Main(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	flags := flag.NewFlagSet("vault-sync-server retention "+args[0], flag.ContinueOnError)
	flags.SetOutput(stderr)
	vault := flags.String("vault", "", "vault ID")
	keepAll := flags.Duration("keep-all", 0, "keep every revision younger than this (for example 4320h)")
	keepDaily := flags.Duration("keep-daily", 0, "thin older revisions to one a day until this age, then one a week")

	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}

		return 2
	}

	given := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { given[f.Name] = true })

	var vaultID uuid.UUID

	if given["vault"] {
		parsed, err := uuid.Parse(*vault)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "-vault: %q is not a vault ID\n", *vault)

			return 2
		}

		vaultID = parsed
	}

	var flagsOK bool

	switch args[0] {
	case "set":
		flagsOK = given["vault"] && given["keep-all"] && given["keep-daily"]
	case "unset":
		flagsOK = given["vault"] && !given["keep-all"] && !given["keep-daily"]
	case "list":
		flagsOK = len(given) == 0
	}

	if !flagsOK || flags.NArg() > 0 {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	cfg, err := config.LoadRetentionCommand(lookup)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "invalid configuration; see docs/configuration.md: %s\n",
			strings.ReplaceAll(err.Error(), "\n", "; "))

		return 1
	}

	policy := store.RetentionPolicy{KeepAll: *keepAll, KeepDaily: *keepDaily}
	if args[0] == "set" {
		if err := check(cfg, policy); err != nil {
			_, _ = fmt.Fprintf(stderr, "refused: %v\n", err)

			return 1
		}
	}

	pool, err := store.Open(ctx, cfg.Database)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open database: %v\n", err)

		return 1
	}
	defer pool.Close()

	queries := store.New(pool)
	encoder := json.NewEncoder(stdout)

	switch args[0] {
	case "set":
		err = set(ctx, queries, encoder, vaultID, policy)
	case "unset":
		err = unset(ctx, queries, encoder, vaultID)
	default:
		err = list(ctx, queries, encoder)
	}

	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%v\n", err)

		return 1
	}

	return 0
}

// check refuses an override below the operator's minimums.
func check(cfg config.RetentionCommandConfig, policy store.RetentionPolicy) error {
	var problems []error

	if policy.KeepAll < cfg.MinKeepAll {
		problems = append(problems, fmt.Errorf("-keep-all %s is below the minimum %s (%s)",
			policy.KeepAll, cfg.MinKeepAll, config.RetentionOverrideMinKeepAllEnv))
	}

	if policy.KeepDaily < cfg.MinKeepDaily {
		problems = append(problems, fmt.Errorf("-keep-daily %s is below the minimum %s (%s)",
			policy.KeepDaily, cfg.MinKeepDaily, config.RetentionOverrideMinKeepDailyEnv))
	}

	if policy.KeepDaily < policy.KeepAll {
		problems = append(problems, fmt.Errorf("-keep-daily %s is below -keep-all %s", policy.KeepDaily, policy.KeepAll))
	}

	return errors.Join(problems...)
}

func set(ctx context.Context, queries *store.Store, encoder *json.Encoder, vaultID uuid.UUID, policy store.RetentionPolicy) error {
	err := queries.SetVaultRetention(ctx, vaultID, policy)
	if errors.Is(err, store.ErrVaultNotFound) {
		return fmt.Errorf("no vault %s", vaultID)
	}

	if err != nil {
		return err
	}

	return encoder.Encode(Override{VaultID: vaultID, KeepAll: policy.KeepAll.String(), KeepDaily: policy.KeepDaily.String()})
}

func unset(ctx context.Context, queries *store.Store, encoder *json.Encoder, vaultID uuid.UUID) error {
	removed, err := queries.UnsetVaultRetention(ctx, vaultID)
	if err != nil {
		return err
	}

	return encoder.Encode(Override{VaultID: vaultID, Removed: &removed})
}

func list(ctx context.Context, queries *store.Store, encoder *json.Encoder) error {
	after := uuid.Nil

	for {
		page, err := queries.VaultRetentions(ctx, after, listPage)
		if err != nil {
			return err
		}

		for _, override := range page {
			err := encoder.Encode(Override{
				VaultID: override.VaultID, KeepAll: override.Policy.KeepAll.String(),
				KeepDaily: override.Policy.KeepDaily.String(), Updated: &override.Updated,
			})
			if err != nil {
				return err
			}

			after = override.VaultID
		}

		if len(page) < listPage {
			return nil
		}
	}
}
