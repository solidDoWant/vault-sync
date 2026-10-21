#!/usr/bin/env bash
# Checks the plugin's npm dependencies for known vulnerabilities without the
# noise of advisories nobody can act on. It fails only on a moderate or worse
# vulnerability in a dependency the plugin ships (npm audit --omit=dev) that
# has a fix available; unfixable advisories and dev/test-only findings are
# printed as warnings.
#
# Usage: npm-audit.sh
# Tests set NPM_AUDIT_SHIPPED_JSON and NPM_AUDIT_ALL_JSON to files holding
# `npm audit --json` output instead of querying the registry.
set -euo pipefail

plugin="$(dirname "${BASH_SOURCE[0]}")/../plugin"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

audit() { # $1: output file, rest: npm audit flags
	local out=$1
	shift
	(cd "$plugin" && npm audit --json "$@" >"$out") || true
}

if [[ -n "${NPM_AUDIT_SHIPPED_JSON:-}" ]]; then
	cp "$NPM_AUDIT_SHIPPED_JSON" "$work/shipped.json"
	cp "$NPM_AUDIT_ALL_JSON" "$work/all.json"
else
	audit "$work/shipped.json" --omit=dev
	audit "$work/all.json"
fi

for f in shipped all; do
	if ! jq -e 'has("vulnerabilities") and (has("error") | not)' "$work/$f.json" >/dev/null 2>&1; then
		echo "npm audit ($f) did not return a report:" >&2
		cat "$work/$f.json" >&2
		exit 2
	fi
done

# One line per vulnerable package: "<severity> <name> <fix>".
summarize='.vulnerabilities | to_entries[] | .value
	| "\(.severity) \(.name) \(if .fixAvailable == false then "no-fix" else "fix-available" end)"'
jq -r "$summarize" "$work/shipped.json" | sort -u >"$work/shipped"
jq -r "$summarize" "$work/all.json" | sort -u >"$work/all"

failing=$(awk '$1 != "info" && $1 != "low" && $3 == "fix-available"' "$work/shipped")
warn_unfixable=$(awk '$3 == "no-fix" || $1 == "info" || $1 == "low"' "$work/shipped")
dev_only=$(comm -13 <(awk '{print $2}' "$work/shipped" | sort -u) <(awk '{print $2}' "$work/all" | sort -u) |
	while read -r name; do grep " $name " "$work/all"; done)

if [[ -n "$warn_unfixable" ]]; then
	echo "warning: shipped dependencies with low-severity or unfixable advisories:"
	sed 's/^/  /' <<<"$warn_unfixable"
fi
if [[ -n "$dev_only" ]]; then
	echo "warning: dev/test-only dependencies with advisories (not shipped):"
	sed 's/^/  /' <<<"$dev_only"
fi
if [[ -n "$failing" ]]; then
	echo "FAIL: shipped dependencies with fixable moderate+ vulnerabilities (see \`cd plugin && npm audit --omit=dev\`):" >&2
	sed 's/^/  /' <<<"$failing" >&2
	exit 1
fi
echo "npm-audit: no fixable vulnerabilities in shipped dependencies"
