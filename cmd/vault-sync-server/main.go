// Command vault-sync-server runs the vault-sync API server. Subcommands (for
// example the plaintext export job) are added as the project is implemented;
// see SPEC.md §4.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/solidDoWant/vault-sync/internal/version"
)

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")

	flag.Parse()

	if *showVersion {
		fmt.Println(version.String())

		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	logger.Error("server not implemented yet", "version", version.String())
	os.Exit(1)
}
