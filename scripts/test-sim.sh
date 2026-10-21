#!/usr/bin/env bash
# Runs the multi-client sync simulation (SPEC.md §13, docs/testing/simulation.md):
# the `sim`-tagged Go driver in sim/ starts a real vault-sync-server against
# PostgreSQL and an S3-compatible store (started with docker compose by
# scripts/with-test-stack.sh) and runs the TypeScript harness against it.
#
# Tuning (environment): SIM_SEEDS, SIM_FIRST_SEED, SIM_SEED, SIM_STEPS,
# SIM_CLIENTS, SIM_ENGINES, SIM_SHRINK_RUNS, SIM_FAITHFUL_FS (1: seeded suites on the
# faithful-filesystem vault), SIM_REGRESSION_DIR (relative to the repository
# root; a missing or empty directory fails the run); SIM_TIMEOUT bounds the
# whole run (default 15m; a longer deliberate run sets it explicitly -- a hung
# seed must not hold an agent for an hour). Extra arguments are passed to `go test`.
#
# Unlike the integration tests, the simulation cannot be skipped: without
# Docker this fails.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info >/dev/null 2>&1; then
	echo "test-sim: Docker is required to start PostgreSQL and the S3 store" >&2
	exit 1
fi

exec ./scripts/with-test-stack.sh go test -count=1 -tags sim -timeout "${SIM_TIMEOUT:-15m}" -v "$@" ./sim/
