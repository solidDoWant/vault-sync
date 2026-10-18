#!/usr/bin/env bash
# Runs the `integration`-tagged Go tests against PostgreSQL and an S3-compatible
# store started with docker compose, and tears the stack down on exit, whether
# the tests pass, fail, or are interrupted.
#
# Without Docker the tests still run, and every test that needs a dependency
# skips with a message naming the missing environment variable.
#
# Extra arguments are passed to `go test` (default package pattern: ./...).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -eq 0 ]]; then
	set -- ./...
fi

go_test=(go test -race -count=1 -tags integration "$@")

if ! docker info >/dev/null 2>&1; then
	echo "test-integration: Docker is not available; integration tests will be skipped" >&2
	exec "${go_test[@]}"
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

"${go_test[@]}"
