#!/usr/bin/env bash
# Writes the Markdown body of the issue the nightly simulation
# (.github/workflows/sim-nightly.yml, docs/testing/simulation.md) files when
# it fails: the failing seeds, the invariants each violated, and the command
# that replays each one.
#
# Usage: sim-nightly-report.sh OUTPUT RUN_URL
#   OUTPUT   the captured output of `make test-sim`
#   RUN_URL  the workflow run, whose artifact holds the minimized cases
#
# The output contains no secrets: the simulation's tokens come from a fake
# OIDC issuer that lives only as long as the run. Only the lines the harness
# prints for a failing seed are copied, never the traces.
set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "usage: $0 OUTPUT RUN_URL" >&2
	exit 2
fi
output=$1
run_url=$2

# Violations end at the first line that is not one ("Minimized to ...").
failures=$(awk '
	/SIM FAILURE: seed [0-9]+ / { inside = !seen[$0]++; if (inside) print; next }
	inside && /^  [a-z-]+: / { print; next }
	{ inside = 0 }
' "$output")
replays=$(grep -oE 'Replay with: make test-sim SIM_SEED=[0-9]+( SIM_[A-Z_]+=[0-9]+)*' "$output" | sort -u | sed 's/^Replay with: //' || true)

echo "The nightly simulation failed: ${run_url}"
echo
if [[ -z $failures ]]; then
	echo "No seed reported a violation, so something else failed (the driver, the broken-server check or the setup). See the run's log."
	exit 0
fi
echo "Failing seeds and the invariants they violated:"
echo
echo '```'
echo "$failures"
echo '```'
echo
echo "Replay each locally:"
echo
echo '```sh'
echo "$replays"
echo '```'
echo
echo "The minimized cases are in the run's \`sim-regressions\` artifact. Following CLAUDE.md, commit a case with the fix of its bug."
