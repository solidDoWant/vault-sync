#!/usr/bin/env bash
# Starts PostgreSQL and an S3-compatible store with docker compose
# (deploy/compose/compose.test.yaml), exports their connection details as the
# VAULT_SYNC_TEST_* variables internal/testinfra reads, runs the given
# command, and tears the stack down on exit, whether the command passes,
# fails, or is interrupted. Requires Docker.
#
# Used by scripts/test-integration.sh, scripts/test-sim.sh and scripts/test-e2e.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -eq 0 ]]; then
	echo "usage: $0 command [argument ...]" >&2
	exit 2
fi

# One compose project per run, so concurrent runs (e.g. several worktrees)
# do not share or tear down each other's containers.
compose=(docker compose --project-name "vault-sync-test-$$" --file deploy/compose/compose.test.yaml)

cleanup() {
	"${compose[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up --detach --wait --wait-timeout 120 --quiet-pull

host_port() {
	local address
	address="$("${compose[@]}" port "$1" "$2")"
	echo "${address##*:}"
}

postgres_port="$(host_port postgres 5432)"
s3_port="$(host_port s3 7070)"

export VAULT_SYNC_TEST_DATABASE_URL="postgres://vault_sync:vault_sync@127.0.0.1:${postgres_port}/vault_sync?sslmode=disable"
export VAULT_SYNC_TEST_S3_ENDPOINT="http://127.0.0.1:${s3_port}"
export VAULT_SYNC_TEST_S3_REGION="us-east-1"
export VAULT_SYNC_TEST_S3_ACCESS_KEY="vault-sync-test"
export VAULT_SYNC_TEST_S3_SECRET_KEY="vault-sync-test-secret"

"$@"
