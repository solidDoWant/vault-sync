#!/usr/bin/env bash
# Fails unless every axiom of the engine specification's path model
# (`lemma {:axiom} Name` in plugin/verified/spec/Paths.dfy) has exactly one
# property test named after it (`it("Name", ...)`) in
# plugin/src/core/pathkey/path-axioms.test.ts, which checks it against the
# TypeScript implementations (#951). Run by `make test`, through
# scripts/path-axioms_check_test.sh, which also runs it on
# plugin/verified/core/Push.dfy against plugin/src/verified/core-axioms.test.ts
# (#1045).
#
# Usage: path-axioms_check.sh [SPEC_FILE TEST_FILE]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
spec="${1:-$root/plugin/verified/spec/Paths.dfy}"
tests="${2:-$root/plugin/src/core/pathkey/path-axioms.test.ts}"

axioms="$(sed -nE 's/^[[:space:]]*lemma[[:space:]]+\{:axiom\}[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$spec")"
if [ -z "$axioms" ]; then
  echo "path-axioms: no axioms found in $spec" >&2
  exit 1
fi

status=0
for axiom in $axioms; do
  count="$(grep -cE "^[[:space:]]*it\(\"$axiom\"," "$tests" || true)"
  if [ "$count" != 1 ]; then
    echo "path-axioms: axiom $axiom of $spec has $count property tests named after it in $tests (want exactly 1)" >&2
    status=1
  fi
done
exit "$status"
