// Command vault-sync-server runs the vault-sync API server. It is configured
// by environment variables (docs/configuration.md) and shuts down gracefully
// on SIGTERM or SIGINT.
//
// `vault-sync-server export -out DIR` instead writes a plaintext copy of
// every vault to DIR and exits (docs/export.md, SPEC.md §4).
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/solidDoWant/vault-sync/internal/export"
	"github.com/solidDoWant/vault-sync/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)

	var code int
	if len(os.Args) > 1 && os.Args[1] == "export" {
		code = export.Main(ctx, os.Args[2:], os.LookupEnv, os.Stdout, os.Stderr)
	} else {
		code = server.Main(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	}

	stop()
	os.Exit(code)
}
