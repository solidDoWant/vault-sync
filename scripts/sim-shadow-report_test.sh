#!/usr/bin/env bash
# Tests scripts/sim-shadow-report.sh, the nightly simulation's summary of
# binding-shadow divergences, against output in the shape the harness prints
# (sim/simulation.sim.test.ts reportShadow).
set -euo pipefail

script="$(dirname "${BASH_SOURCE[0]}")/sim-shadow-report.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
	echo "FAIL: $1" >&2
	echo "--- report ---" >&2
	cat "$work/report" >&2
	exit 1
}

cat >"$work/output" <<'EOF'
seed 3 (posix, windows path rules): acknowledged 4, binding-shadow divergences 2
seed 3: SHADOW binding-shadow: e3 (posix) c0.d1 bound to a.md, derived no file
seed 3: SHADOW binding-shadow: e4 (windows) c1.d2 bound to no file (user-deleted), derived b.md
seed 3: SHADOW binding-shadow: e3 (posix) c0.d1 bound to a.md, derived no file
SHADOW binding-shadow: a line the harness did not print for a seed
EOF
"$script" "$work/output" >"$work/report"
grep -qx '2 divergences between bindings and the derived ownership.' "$work/report" || fail "counts each seed's divergence once"
grep -qF 'seed 3: SHADOW binding-shadow: e4 (windows) c1.d2 bound to no file (user-deleted), derived b.md' "$work/report" || fail "lists the divergences"
if grep -qF 'did not print' "$work/report"; then fail "copies only the harness's lines"; fi

: >"$work/empty"
"$script" "$work/empty" >"$work/report"
grep -qx '0 divergences between bindings and the derived ownership.' "$work/report" || fail "reports none"
if grep -qF '```' "$work/report"; then fail "prints no block without divergences"; fi

if "$script" >/dev/null 2>&1; then
	echo "FAIL: accepts a missing argument" >&2
	exit 1
fi

echo "sim-shadow-report: ok"
