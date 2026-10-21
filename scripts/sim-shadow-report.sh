#!/usr/bin/env bash
# Writes the Markdown summary of the binding-shadow divergences
# (docs/testing/simulation.md, refactor step R4 of
# docs/design/engine-path-ownership.md) in the captured output of
# `make test-sim`: their count and the first 100 lines, for triage. Report
# only: it always exits 0 once it has read the output.
#
# Usage: sim-shadow-report.sh OUTPUT
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 OUTPUT" >&2
	exit 2
fi
output=$1

lines=$(grep -E ': SHADOW binding-shadow: ' "$output" | sort -u || true)
count=0
if [[ -n $lines ]]; then count=$(printf '%s\n' "$lines" | wc -l | tr -d ' '); fi

echo "## Binding-shadow divergences (report only, refactor step R4)"
echo
echo "${count} divergences between bindings and the derived ownership."
if [[ $count -gt 0 ]]; then
	echo
	echo '```'
	printf '%s\n' "$lines" | head -n 100
	echo '```'
fi
