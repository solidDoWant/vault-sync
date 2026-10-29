#!/usr/bin/env bash
# Runs every acceptance test, a test named for its scenario in
# docs/acceptance/phase-2.md, and prints the scoreboard: one line per scenario
# (pass, fail, not run, no test) and the number passing (`make acceptance`).
#
# - Go integration tests named `TestAC<nn>...` (Go function names cannot hold
#   brackets) and the top-level Go tests holding an `[AC-nn] ...` subtest, run
#   whole, with the plugin integration suite, whose `[AC-nn] ...` tests the
#   scoreboard reads from its report (scripts/test-integration.sh);
# - the desktop e2e spec files that hold an `[AC-nn] ...` test, run whole
#   (scripts/test-e2e.sh; plugin/wdio.conf.mts records the results).
#
# A failing suite does not stop the others: its tests show as fail or not run.
# The scoreboard is also written to build/acceptance/scoreboard.txt, with the
# suites' output in build/acceptance/*.log. Needs Docker, like test-e2e.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

out=build/acceptance
results="$out/results"
rm -rf "$out"
mkdir -p "$results"
export VAULT_SYNC_ACCEPTANCE_RESULTS="$PWD/$results"

go_tests=$(./scripts/acceptance-scoreboard.py --go-run-pattern --sources .) || exit 1
echo "acceptance: integration tests $go_tests (log: $out/integration.log)" >&2
./scripts/test-integration.sh -json -run "$go_tests" ./... >"$results/go-integration.json" 2>"$out/integration.log" ||
	echo "acceptance: the integration tests failed; see $out/integration.log and $results/go-integration.json" >&2

if grep -lE "\bit\(\s*[\"'\`]\[AC-[0-9]+\]" plugin/test/e2e/specs/*.e2e.ts | grep -qv '\.android\.e2e\.ts$'; then
	echo "acceptance: e2e specs (log: $out/e2e.log)" >&2
	./scripts/test-e2e.sh >"$out/e2e.log" 2>&1 ||
		echo "acceptance: the e2e suite failed; see $out/e2e.log" >&2
else
	echo "acceptance: no desktop e2e spec has an acceptance test" >&2
fi

./scripts/acceptance-scoreboard.py --checklist docs/acceptance/phase-2.md --results "$results" --sources . | tee "$out/scoreboard.txt"
