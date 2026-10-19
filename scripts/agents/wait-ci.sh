#!/usr/bin/env bash
# Waits up to SECONDS (default 230) for every CI check on PR to finish, then
# prints them. Exit status: 0 = all finished and passing, 1 = finished with a
# failure, 3 = still running (call again), 2 = usage error. Use this instead
# of `gh pr checks --watch` (see wait-for.sh for why waits are bounded).
#
# CI counts as still running until at least one required check (branch
# protection's, e.g. the `checks` aggregator job) is reported for the PR's
# head: right after a push the only check listed may be one that finishes at
# once (CodeRabbit), and `checks` is only registered once the jobs it needs
# have finished. A PR whose base branch requires no checks therefore never
# exits 0; it exits 3 at the deadline.
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
  # gh fails with nothing on stdout while no required check is reported.
  required=$(gh pr checks "$pr" --required --json name,bucket 2>/dev/null)
  if [ -n "$checks" ] && [ -n "$required" ] &&
    [ "$(jq 'length' <<<"$required")" -gt 0 ] &&
    [ "$(jq -s '[.[][] | select(.bucket == "pending")] | length' <<<"$checks$required")" -eq 0 ]; then
    jq -r '.[] | "\(.bucket)\t\(.name)"' <<<"$checks"
    [ "$(jq -s '[.[][] | select(.bucket == "fail" or .bucket == "cancel")] | length' <<<"$checks$required")" -eq 0 ]
    exit $?
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "wait-ci: PR $pr still has pending or unregistered required checks after ${limit}s" >&2
    exit 3
  fi
  sleep 15
done
