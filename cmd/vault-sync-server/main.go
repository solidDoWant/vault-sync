// Command vault-sync-server runs the vault-sync API server. It is configured
// by environment variables (docs/configuration.md) and shuts down gracefully
// on SIGTERM or SIGINT. Subcommands (for example the plaintext export job)
// are added as the project is implemented; see SPEC.md §4.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/solidDoWant/vault-sync/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	code := server.Main(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)

	stop()
	os.Exit(code)
}
