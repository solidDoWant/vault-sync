#!/usr/bin/env bash
# Starts PostgreSQL and an S3-compatible store with docker compose
# (deploy/compose/compose.test.yaml), exports their connection details as the
# VAULT_SYNC_TEST_* variables internal/testinfra reads, runs the given
# command, and tears the stack down on exit, whether the command passes,
# fails, or is interrupted. Requires Docker.
#
# VAULT_SYNC_TEST_POSTGRES_VERSION selects another PostgreSQL major version
# than the default image: it applies the compose override
# deploy/compose/compose.test-postgres<version>.yaml (only 14, the minimum
# supported version, exists) and fails unless the running server reports that
# major version.
#
# Used by scripts/test-integration.sh and scripts/test-e2e.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -eq 0 ]]; then
	echo "usage: $0 command [argument ...]" >&2
	exit 2
fi

# One compose project per run, so concurrent runs (e.g. several worktrees)
# do not share or tear down each other's containers.
compose_files=(deploy/compose/compose.test.yaml)

postgres_version="${VAULT_SYNC_TEST_POSTGRES_VERSION:-}"
if [[ -n "$postgres_version" ]]; then
	override="deploy/compose/compose.test-postgres${postgres_version}.yaml"
	if [[ ! "$postgres_version" =~ ^[0-9]+$ || ! -f "$override" ]]; then
		echo "with-test-stack: no compose override for VAULT_SYNC_TEST_POSTGRES_VERSION=${postgres_version} (expected ${override})" >&2
		exit 2
	fi
	compose_files+=("$override")
fi

compose=(docker compose --project-name "vault-sync-test-$$")
for file in "${compose_files[@]}"; do
	compose+=(--file "$file")
done

cleanup() {
	"${compose[@]}" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Pull first (scripts/test-images.sh): only images not already present, so
# images restored from CI's cache never touch the registry, retrying with
# backoff, longer on a rate limit, so a registry's transient 5xx or 429 does
# not fail the run (#606, #727).
./scripts/test-images.sh pull "${compose_files[@]}"

"${compose[@]}" up --detach --wait --wait-timeout 120 --pull missing --quiet-pull

if [[ -n "$postgres_version" ]]; then
	# server_version_num is major * 10000 + minor for PostgreSQL 10 and newer.
	server_version_num="$("${compose[@]}" exec -T postgres psql --username=vault_sync --dbname=vault_sync --no-align --tuples-only --command='SHOW server_version_num')"
	if [[ "$((server_version_num / 10000))" != "$postgres_version" ]]; then
		echo "with-test-stack: wanted PostgreSQL ${postgres_version}, but the server reports server_version_num ${server_version_num}" >&2
		exit 1
	fi
	echo "with-test-stack: PostgreSQL server_version_num ${server_version_num}" >&2
fi

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
