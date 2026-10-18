#!/usr/bin/env bash
# Runs the schema-dependent integration tests against PostgreSQL 14, the
# minimum supported version (SPEC.md §3, §12), so a migration or query that
# needs a newer PostgreSQL fails here: every test in ./internal/store/ (the
# migrations and all store queries) and the rolling-upgrade test in
# ./cmd/vault-sync-server/ (the previous release's migrations followed by
# this one's). The rest of the integration suite runs only on the default
# image (scripts/test-integration.sh), to keep CI time down.
#
# The stack is scripts/with-test-stack.sh with VAULT_SYNC_TEST_POSTGRES_VERSION=14
# (deploy/compose/compose.test-postgres14.yaml). Unlike test-integration.sh,
# this needs Docker: without it there is nothing to check, so it fails.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info >/dev/null 2>&1; then
	echo "test-integration-postgres14: Docker is not available" >&2
	exit 1
fi

export VAULT_SYNC_TEST_POSTGRES_VERSION=14

# One stack, two go test runs: -run applies to every listed package, so the
# upgrade test is selected in a run of its own.
exec ./scripts/with-test-stack.sh bash -c '
	set -euo pipefail
	go test -race -count=1 -tags integration ./internal/store/
	go test -race -count=1 -tags integration -run "^TestRollingUpgrade$" ./cmd/vault-sync-server/
'
