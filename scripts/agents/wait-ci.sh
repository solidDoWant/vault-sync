#!/usr/bin/env bash
# Waits up to SECONDS (default 230) for every CI check on PR to finish, then
# prints them. Exit status: 0 = all finished and passing, 1 = finished with a
# failure, 3 = still running (call again), 2 = usage error. Use this instead
# of `gh pr checks --watch` (see wait-for.sh for why waits are bounded).
#
#   ./scripts/agents/wait-ci.sh 287
set -uo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 PR [SECONDS]" >&2
  exit 2
fi
pr=$1 limit=${2:-230}
deadline=$(( $(date +%s) + limit ))

while :; do
  checks=$(gh pr checks "$pr" --json name,bucket 2>/dev/null)
  if [ -n "$checks" ] && [ "$(jq '[.[] | select(.bucket == "pending")] | length' <<<"$checks")" -eq 0 ]; then
    jq -r '.[] | "\(.bucket)\t\(.name)"' <<<"$checks"
    [ "$(jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length' <<<"$checks")" -eq 0 ]
    exit $?
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "wait-ci: PR $pr still has pending checks after ${limit}s" >&2
    exit 3
  fi
  sleep 15
done
