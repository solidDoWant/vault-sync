#!/usr/bin/env bash
# Runs every acceptance test, a test named for its scenario in
# docs/acceptance/phase-2.md (`[AC-nn]`) or docs/acceptance/phase-3.md
# (`[P3-nn]`), and prints each checklist's scoreboard: one line per scenario
# (pass, fail, not run, no test) and the number passing (`make acceptance`).
#
# - Go integration tests named `TestAC<nn>...` (Go function names cannot hold
#   brackets) and the top-level Go tests holding an `[AC-nn] ...` subtest, run
#   whole (`[P3-nn] ...` subtests too), with the plugin integration suite,
#   whose `[AC-nn] ...` tests the
#   scoreboard reads from its report (scripts/test-integration.sh);
# - the desktop e2e spec files that hold an `[AC-nn] ...` or `[P3-nn] ...`
#   test, run whole
#   (scripts/test-e2e.sh; plugin/wdio.conf.mts records the results);
# - the Android device checks (`*.android.e2e.ts`), which need an Android
#   emulator and so are not run here: with VAULT_SYNC_ACCEPTANCE_ANDROID_RESULTS
#   naming a directory that holds the android-e2e.jsonl an android-e2e run
#   recorded (plugin/wdio.android.conf.mts), the scoreboard reads that run's
#   results too (the acceptance workflow downloads the latest one on master).
#
# A failing suite does not stop the others: its tests show as fail or not run.
# The scoreboards are also written to build/acceptance/scoreboard.txt, with the
# suites' output in build/acceptance/*.log. Needs Docker, like test-e2e.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

out=build/acceptance
results="$out/results"
rm -rf "$out"
mkdir -p "$results"
export VAULT_SYNC_ACCEPTANCE_RESULTS="$PWD/$results"

android_results="${VAULT_SYNC_ACCEPTANCE_ANDROID_RESULTS:-}"
if [[ -n "$android_results" && -f "$android_results/android-e2e.jsonl" ]]; then
	echo "acceptance: Android device checks from $android_results" >&2
	cp "$android_results/android-e2e.jsonl" "$results/android-e2e.jsonl"
elif [[ -n "$android_results" ]]; then
	echo "acceptance: no android-e2e.jsonl in $android_results; the Android device checks show as not run" >&2
fi

go_tests=$(./scripts/acceptance-scoreboard.py --go-run-pattern --sources .) || exit 1
echo "acceptance: integration tests $go_tests (log: $out/integration.log)" >&2
./scripts/test-integration.sh -json -run "$go_tests" ./... >"$results/go-integration.json" 2>"$out/integration.log" ||
	echo "acceptance: the integration tests failed; see $out/integration.log and $results/go-integration.json" >&2

if grep -lE "\bit\(\s*[\"'\`]\[(AC|P3)-[0-9]+\]" plugin/test/e2e/specs/*.e2e.ts | grep -qv '\.android\.e2e\.ts$'; then
	echo "acceptance: e2e specs (log: $out/e2e.log)" >&2
	./scripts/test-e2e.sh >"$out/e2e.log" 2>&1 ||
		echo "acceptance: the e2e suite failed; see $out/e2e.log" >&2
else
	echo "acceptance: no desktop e2e spec has an acceptance test" >&2
fi

{
	echo "Phase 2 (docs/acceptance/phase-2.md)"
	./scripts/acceptance-scoreboard.py --checklist docs/acceptance/phase-2.md --results "$results" --sources .
	echo
	echo "Phase 3 (docs/acceptance/phase-3.md)"
	./scripts/acceptance-scoreboard.py --checklist docs/acceptance/phase-3.md --results "$results" --sources .
} | tee "$out/scoreboard.txt"
