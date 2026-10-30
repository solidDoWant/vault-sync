#!/usr/bin/env bash
# Regenerates the screenshots of the plugin's settings tab in the user guide
# (docs/user/images/). It runs only the e2e spec that takes them
# (plugin/test/e2e/specs/docs-screenshots.e2e.ts) through the e2e harness:
# a real Obsidian against a real server on PostgreSQL and S3 (docker compose).
# Expects the plugin to be built (plugin/dist); `make docs-screenshots` does
# that. Needs Docker, like `make test-e2e`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

out="$PWD/docs/user/images"
mkdir -p "$out"
export VAULT_SYNC_E2E_SCREENSHOTS_DIR="$out"
exec ./scripts/test-e2e.sh "$@"
