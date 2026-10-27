#!/usr/bin/env bash
# Tests scripts/path-axioms_check.sh: it passes on the repository's files, and
# fails when an axiom has no property test or more than one.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
check="$here/path-axioms_check.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

"$check"

cat >"$work/spec.dfy" <<'DFY'
  lemma {:axiom} Alpha(p: Path)
  lemma {:axiom} Beta(p: Path)
  lemma Gamma(p: Path)
DFY

printf '  it("Alpha", () => {});\n  it("Beta", () => {});\n' >"$work/ok.test.ts"
"$check" "$work/spec.dfy" "$work/ok.test.ts"

printf '  it("Alpha", () => {});\n  it("BetaPrime", () => {});\n' >"$work/missing.test.ts"
if "$check" "$work/spec.dfy" "$work/missing.test.ts" 2>/dev/null; then
  echo "FAIL: an axiom without a property test passed" >&2
  exit 1
fi

printf '  it("Alpha", () => {});\n  it("Beta", () => {});\n  it("Beta", () => {});\n' >"$work/duplicate.test.ts"
if "$check" "$work/spec.dfy" "$work/duplicate.test.ts" 2>/dev/null; then
  echo "FAIL: an axiom with two property tests passed" >&2
  exit 1
fi

echo "path-axioms_check: ok"
