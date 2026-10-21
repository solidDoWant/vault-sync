#!/usr/bin/env bash
# Tests scripts/npm-audit.sh against `npm audit --json` reports in the shape
# npm 7+ prints.
set -euo pipefail

script="$(dirname "${BASH_SOURCE[0]}")/npm-audit.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

report() { # name severity fixAvailable...
	local vulns='{}'
	while [[ $# -gt 0 ]]; do
		vulns=$(jq -c --arg n "$1" --arg s "$2" --argjson f "$3" '. + {($n): {name: $n, severity: $s, fixAvailable: $f}}' <<<"$vulns")
		shift 3
	done
	jq -n --argjson v "$vulns" '{auditReportVersion: 2, vulnerabilities: $v}'
}

run() { # expected-exit shipped-json all-json
	local want=$1 got=0
	report_shipped=$2 report_all=$3
	echo "$report_shipped" >"$work/shipped.json"
	echo "$report_all" >"$work/all.json"
	NPM_AUDIT_SHIPPED_JSON="$work/shipped.json" NPM_AUDIT_ALL_JSON="$work/all.json" "$script" >"$work/out" 2>&1 || got=$?
	if [[ $got -ne $want ]]; then
		echo "FAIL: $4 (exit $got, want $want)" >&2
		cat "$work/out" >&2
		exit 1
	fi
}

none=$(report)
run 0 "$none" "$none" "passes with no advisories"

fixable=$(report serialize-javascript high true)
run 1 "$fixable" "$fixable" "fails on a fixable high in a shipped dependency"
grep -q 'high serialize-javascript fix-available' "$work/out" || { echo "FAIL: names the failing package" >&2; exit 1; }

major=$(report foo moderate '{"name":"foo","version":"9.0.0","isSemVerMajor":true}')
run 1 "$major" "$major" "a semver-major fix still counts as available"

unfixable=$(report extract-zip high false)
run 0 "$unfixable" "$unfixable" "passes on an unfixable shipped advisory"
grep -q 'warning: shipped dependencies with low-severity or unfixable' "$work/out" || { echo "FAIL: warns about the unfixable advisory" >&2; exit 1; }

low=$(report bar low true)
run 0 "$low" "$low" "passes on a fixable low"

dev=$(report extract-zip high false serialize-javascript high true)
run 0 "$none" "$dev" "passes on dev-only advisories, fixable or not"
grep -q 'dev/test-only.*' "$work/out" && grep -q 'serialize-javascript' "$work/out" || { echo "FAIL: lists dev-only advisories" >&2; exit 1; }

run 2 '{"error":{"code":"ENOTFOUND"}}' "$none" "fails when npm audit returns no report"

echo "npm-audit: ok"
