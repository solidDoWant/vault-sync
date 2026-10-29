// Command vault-sync-server runs the vault-sync API server. It is configured
// by environment variables (docs/configuration.md) and shuts down gracefully
// on SIGTERM or SIGINT.
//
// `vault-sync-server export -out DIR` instead writes a plaintext copy of
// every vault to DIR and exits (docs/export.md, SPEC.md §4).
//
// `vault-sync-server import SERVER_URL VAULT_ID DIR` loads a folder of Markdown notes
// and attachments into an empty vault and exits (docs/import.md).
//
// `vault-sync-server retention set|unset|list` manages per-vault retention
// overrides and exits (docs/configuration.md, SPEC.md §11).
//
// `vault-sync-server vault undelete VAULT_ID` restores a deleted vault that
// has not been purged yet and exits (docs/design/sharing.md).
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/retentioncmd"
	"github.com/solidDoWant/vault-sync/internal/server"
	"github.com/solidDoWant/vault-sync/internal/vaultcmd"
	"github.com/solidDoWant/vault-sync/internal/vaultimport"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)

	var code int

	switch {
	case len(os.Args) > 1 && os.Args[1] == "export":
		code = export.Main(ctx, os.Args[2:], os.LookupEnv, os.Stdout, os.Stderr)
	case len(os.Args) > 1 && os.Args[1] == "import":
		code = vaultimport.Main(ctx, os.Args[2:], os.LookupEnv, os.Stdout, os.Stderr)
	case len(os.Args) > 1 && os.Args[1] == "retention":
		code = retentioncmd.Main(ctx, os.Args[2:], os.LookupEnv, os.Stdout, os.Stderr)
	case len(os.Args) > 1 && os.Args[1] == "vault":
		code = vaultcmd.Main(ctx, os.Args[2:], os.LookupEnv, os.Stdout, os.Stderr)
	default:
		code = server.Main(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	}

	stop()
	os.Exit(code)
}
