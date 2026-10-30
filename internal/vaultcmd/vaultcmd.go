// Package vaultcmd is the `vault-sync-server vault` subcommand, with which
// the operator undeletes a vault an owner deleted, before the server purges
// it (docs/design/sharing.md, "Deleting a vault"). No API does this.
package vaultcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/google/uuid"

	"github.com/solidDoWant/vault-sync/internal/config"
	"github.com/solidDoWant/vault-sync/internal/store"
)

const usage = `usage:
  vault-sync-server vault undelete VAULT_ID`

// Main runs the subcommand with args (after "vault") and returns its exit
// code: 0 on success, 1 on failure, 2 on a usage error. It reads the
// database variables of the server through lookup.
func Main(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "undelete" {
		_, _ = fmt.Fprintln(stderr, usage)

		return 2
	}

	vaultID, err := uuid.Parse(args[1])
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%q is not a vault ID\n%s\n", args[1], usage)

		return 2
	}

	cfg, err := config.LoadVaultCommand(lookup)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "invalid configuration; see docs/admin/configuration.md: %s\n",
			strings.ReplaceAll(err.Error(), "\n", "; "))

		return 1
	}

	pool, err := store.Open(ctx, cfg)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open database: %v\n", err)

		return 1
	}
	defer pool.Close()

	err = store.New(pool).UndeleteVault(ctx, vaultID)

	switch {
	case errors.Is(err, store.ErrVaultNotFound):
		_, _ = fmt.Fprintf(stderr, "no vault %s: it does not exist or has been purged\n", vaultID)

		return 1
	case errors.Is(err, store.ErrVaultNotDeleted):
		_, _ = fmt.Fprintf(stderr, "vault %s is not deleted\n", vaultID)

		return 1
	case err != nil:
		_, _ = fmt.Fprintf(stderr, "cannot undelete vault %s: %v\n", vaultID, err)

		return 1
	}

	_, _ = fmt.Fprintf(stdout, "undeleted vault %s\n", vaultID)

	return 0
}
