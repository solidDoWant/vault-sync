#!/usr/bin/env bash
# Tests scripts/verify-group.sh's coverage check: it passes on the
# repository's groups, and fails when a Dafny file is in no group, in two
# groups, or listed but absent. Runs no `dafny`.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/verify-group.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

"$script" --check
matrix="$("$script" --matrix)"
[[ "$matrix" == \[\"*\"\] ]] || fail "--matrix printed $matrix"

mkdir -p "$work/verified/core"
touch "$work/verified/A.dfy" "$work/verified/core/B.dfy" "$work/verified/core/C.dfy"
run() {
  VERIFIED_DIR="$work/verified" VERIFY_GROUPS="$work/groups.txt" "$script" "$@"
}

printf '# comment\n1 A.dfy\n\n2 core/B.dfy\n2 core/C.dfy # trailing\n' >"$work/groups.txt"
run --check || fail "complete groups were rejected"
[[ "$(run --matrix)" == '["1","2"]' ]] || fail "--matrix printed $(run --matrix)"

printf '1 A.dfy\n2 core/B.dfy\n' >"$work/groups.txt"
if run --check 2>/dev/null; then fail "a file in no group passed"; fi
if run 1 2>/dev/null; then fail "a group ran with a file in no group"; fi
if run --matrix >/dev/null 2>&1; then fail "--matrix ran with a file in no group"; fi

printf '1 A.dfy\n2 core/B.dfy\n2 core/C.dfy\n3 core/C.dfy\n' >"$work/groups.txt"
if run --check 2>/dev/null; then fail "a file in two groups passed"; fi

printf '1 A.dfy\n2 core/B.dfy\n2 core/C.dfy\n2 core/D.dfy\n' >"$work/groups.txt"
if run --check 2>/dev/null; then fail "a listed file that is absent passed"; fi

printf '1 A.dfy\n2 core/B.dfy core/C.dfy\n' >"$work/groups.txt"
if run --check 2>/dev/null; then fail "a malformed line passed"; fi

printf '1 A.dfy\n2 core/B.dfy\n2 core/C.dfy\n' >"$work/groups.txt"
if run 9 2>/dev/null; then fail "an empty group passed"; fi

echo "verify-group: ok"
