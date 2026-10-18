#!/usr/bin/env bash
# Runs the `integration`-tagged Go tests against PostgreSQL and an S3-compatible
# store started with docker compose (scripts/with-test-stack.sh), and tears the
# stack down on exit, whether the tests pass, fail, or are interrupted.
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

exec ./scripts/with-test-stack.sh "${go_test[@]}"
