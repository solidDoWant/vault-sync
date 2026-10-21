#!/usr/bin/env bash
# Tests scripts/sim-nightly-report.sh, the body of the issue the nightly
# simulation files on failure, against output in the shape the harness
# prints (sim/simulation.sim.test.ts).
set -euo pipefail

script="$(dirname "${BASH_SOURCE[0]}")/sim-nightly-report.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
	echo "FAIL: $1" >&2
	echo "--- report ---" >&2
	cat "$work/report" >&2
	exit 1
}

cat >"$work/output" <<'EOF'
 ✓ seed 1 keeps every invariant
AssertionError: SIM FAILURE: seed 7 violated invariants (3000 steps, 3 clients):
  lost-write: e3's user wrote 0a1b2c3d to a.md at step 12; it is in no vault
  phantom-delete: e4 deleted c0.d1 at b.md (seq 9, e4.x2) although its user never deleted it
Minimized to 40 steps in 30 runs, which violate:
  lost-write: e3's user wrote 0a1b2c3d to a.md at step 3; it is in no vault
Regression case written to /tmp/x/seed-7.json.
Replay with: make test-sim SIM_SEED=7 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2
Trace of the minimized schedule (last lines):
3: e3 user writes a.md (0a1b2c3d, 9 B)
  not-a-violation: a trace line indented like one
FAIL ../sim/simulation.sim.test.ts > seeded schedules > seed 7 keeps every invariant
AssertionError: SIM FAILURE: seed 7 violated invariants (3000 steps, 3 clients):
AssertionError: SIM FAILURE: seed 12 violated invariants (3000 steps, 3 clients):
  liveness: clients did not become idle while draining
Minimized to 3000 steps in 0 runs, which violate:
Replay with: make test-sim SIM_SEED=12 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2
EOF

"$script" "$work/output" "https://example.test/run/1" >"$work/report"
grep -qF "https://example.test/run/1" "$work/report" || fail "the run URL is missing"
grep -qF "SIM FAILURE: seed 7 violated" "$work/report" || fail "seed 7 is missing"
grep -qF "SIM FAILURE: seed 12 violated" "$work/report" || fail "seed 12 is missing"
grep -qF "  phantom-delete: e4 deleted c0.d1" "$work/report" || fail "seed 7's violations are missing"
grep -qF "  liveness: clients did not become idle" "$work/report" || fail "seed 12's violation is missing"
grep -qxF "make test-sim SIM_SEED=7 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2" "$work/report" || fail "seed 7's replay command is missing"
grep -qxF "make test-sim SIM_SEED=12 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2" "$work/report" || fail "seed 12's replay command is missing"
[[ $(grep -c "SIM FAILURE: seed 7 " "$work/report") -eq 1 ]] || fail "seed 7 is listed more than once"
! grep -qF "not-a-violation" "$work/report" || fail "a trace line was copied"
! grep -qF "e3 user writes" "$work/report" || fail "the trace was copied"
grep -qF "The nightly simulation failed: https://example.test/run/1" "$work/report" || fail "the default heading is missing"
grep -qF '`sim-regressions` artifact' "$work/report" || fail "the default artifact is missing"
grep -qF "faithfulFilesystem" "$work/report" || fail "the note on faithful-filesystem cases is missing"

# The faithful-filesystem job (non-gating) names its own artifact and heading.
cat >"$work/faithful" <<'EOF2'
AssertionError: SIM FAILURE: seed 9 violated invariants (3000 steps, 3 clients):
  lost-write: e3's user wrote 0a1b2c3d to Straße.md at step 4; it is in no vault
Regression case written to /tmp/x/seed-9-faithful-fs.json.
Replay with: make test-sim SIM_SEED=9 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2 SIM_FAITHFUL_FS=1
EOF2
"$script" "$work/faithful" "https://example.test/run/3" sim-faithful-fs "The faithful-filesystem simulation (non-gating) failed" >"$work/report"
grep -qF "The faithful-filesystem simulation (non-gating) failed: https://example.test/run/3" "$work/report" || fail "the given heading is missing"
grep -qF '`sim-faithful-fs` artifact' "$work/report" || fail "the given artifact is missing"
! grep -qF "sim-regressions" "$work/report" || fail "the faithful report names the gating job's artifact"
! grep -qF "The nightly simulation failed" "$work/report" || fail "the faithful report uses the gating job's heading"
grep -qxF "make test-sim SIM_SEED=9 SIM_STEPS=3000 SIM_CLIENTS=3 SIM_ENGINES=2 SIM_FAITHFUL_FS=1" "$work/report" || fail "the faithful replay command is missing"
if "$script" "$work/faithful" "https://example.test/run/3" 'x`y' >/dev/null 2>&1; then fail "an artifact name with Markdown was accepted"; fi

printf 'ok\n FAIL setup\n' >"$work/output"
"$script" "$work/output" "https://example.test/run/2" >"$work/report"
grep -qF "No seed reported a violation" "$work/report" || fail "a failure without a seed is not explained"

if "$script" "$work/output" >/dev/null 2>&1; then fail "a missing argument was accepted"; fi
if "$script" "$work/output" url artifact heading extra >/dev/null 2>&1; then fail "an extra argument was accepted"; fi

echo "sim-nightly-report: ok"
