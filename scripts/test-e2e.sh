#!/usr/bin/env bash
# Runs the plugin e2e suite (SPEC.md §13, docs/testing/e2e.md): the
# `e2e`-tagged Go driver in cmd/vault-sync-server starts a real
# vault-sync-server against PostgreSQL and an S3-compatible store (started
# with docker compose by scripts/with-test-stack.sh) and runs WebdriverIO,
# which downloads the pinned Obsidian (cached in
# plugin/.wdio-obsidian-cache) and drives the built plugin inside it. On
# Linux without a display, Obsidian runs headless under xvfb-run.
#
# Expects the plugin to be built (plugin/dist); `make test-e2e` does that.
# VAULT_SYNC_E2E_MOBILE=1 runs the suite in Obsidian's emulated mobile mode.
# Extra arguments are passed to `go test`.
#
# Like the simulation, the suite cannot be skipped: without Docker this
# fails. To run against a PostgreSQL you started yourself (as CI does on
# macOS and Windows), set VAULT_SYNC_TEST_DATABASE_URL and run
#   ./scripts/with-native-s3.sh go test -count=1 -tags e2e -run TestPluginE2E -v ./cmd/vault-sync-server/
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info >/dev/null 2>&1; then
	echo "test-e2e: Docker is required to start PostgreSQL and the S3 store" >&2
	exit 1
fi

go_test=(go test -count=1 -tags e2e -timeout "${E2E_TIMEOUT:-20m}" -run TestPluginE2E -v "$@" ./cmd/vault-sync-server/)

if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then
	go_test=(xvfb-run --auto-servernum --server-args "-screen 0 1280x1024x24" "${go_test[@]}")
fi

exec ./scripts/with-test-stack.sh "${go_test[@]}"
