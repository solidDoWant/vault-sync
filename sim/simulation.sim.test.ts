// The networked simulation suite (SPEC.md §13). It needs a running server and
// the driver's control endpoint, so it runs only from `make test-sim`, through
// sim/simulation_test.go and plugin/vitest.sim.config.ts; `make test` excludes
// it.

import { describe, expect, it } from "vitest";

import { Control } from "./control";
import { simEnvironment } from "./environment";
import { runSeed, runSteps, type RunResult } from "./runner";
import { lostResponseAfterHeadMoved } from "./scenarios";
import { generateSchedule, type Step } from "./schedule";
import { shrink } from "./shrink";

const environment = simEnvironment();
const suites = new Set(environment.suites);

/** The last lines of a trace, enough to see how a failure came about. */
function tail(trace: readonly string[], lines = 80): string {
  return trace.slice(-lines).join("\n");
}

/** How often notable events occurred in a run, to show what a schedule exercised. */
function summarize(trace: readonly string[]): string {
  const events: [string, string][] = [
    ["acknowledged", " acknowledged "],
    ["head moved", "head moved"],
    ["path taken", "path taken"],
    ["retried after network failure", "retries "],
    ["requests lost", "request lost"],
    ["responses lost", "response lost after"],
    ["delayed", " held for "],
    ["reordered", "out of order"],
    ["partitions", " partitioned for "],
    ["crashes", " crashed and restarted"],
  ];
  return events.map(([name, needle]) => `${name} ${String(trace.filter((line) => line.includes(needle)).length)}`).join(", ");
}

function describeViolations(result: RunResult): string {
  return result.violations.map((violation) => `  ${violation.invariant}: ${violation.detail}`).join("\n");
}

describe.runIf(suites.has("seeds"))("seeded schedules", () => {
  it.each(environment.seeds)("seed %i keeps every invariant", async (seed) => {
    const options = { seed, clients: environment.clients };
    const result = await runSeed(environment, { ...options, steps: environment.steps });
    console.log(`seed ${String(seed)}: ${summarize(result.trace)}`);
    if (result.violations.length === 0) return;

    // Minimize: keep removing steps while a violation of the same kind remains.
    const invariants = new Set(result.violations.map((violation) => violation.invariant));
    const stillFails = async (steps: Step[]) => (await runSteps(environment, options, steps)).violations.some((violation) => invariants.has(violation.invariant));
    const minimized = await shrink(result.steps, stillFails, environment.shrinkRuns);
    const replay = await runSteps(environment, options, minimized.items);
    const [steps, final] = replay.violations.length > 0 ? [minimized.items, replay] : [result.steps, result];
    const written = await new Control(environment.controlUrl).report({ name: `seed-${String(seed)}`, seed, clients: options.clients, violations: final.violations, steps });

    expect.fail(
      [
        `SIM FAILURE: seed ${String(seed)} violated invariants (${String(environment.steps)} steps, ${String(options.clients)} clients):`,
        describeViolations(result),
        `Minimized to ${String(steps.length)} steps in ${String(minimized.runs)} runs, which violate:`,
        describeViolations(final),
        `Regression case written to ${written}.`,
        `Replay with: make test-sim SIM_SEED=${String(seed)} SIM_STEPS=${String(environment.steps)} SIM_CLIENTS=${String(options.clients)}`,
        "Trace of the minimized schedule (last lines):",
        tail(final.trace),
      ].join("\n"),
    );
  });
});

describe.runIf(suites.has("regressions") && environment.regressions.length > 0)("committed regression cases", () => {
  it.each(environment.regressions.map((regression) => [regression.name, regression] as const))("%s keeps every invariant", async (_name, regression) => {
    const result = await runSteps(environment, { seed: regression.seed, clients: regression.clients }, regression.steps);
    expect(result.violations, tail(result.trace)).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted scenarios", () => {
  it("returns the committed revision when a commit whose response was lost is retried after the head moved", async () => {
    const result = await lostResponseAfterHeadMoved(environment);
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    // c0's retry got its own revision back, and c1's commit landed on top of it.
    expect(result.acknowledgedBy[0], trace).toContain(result.retried);
    expect(result.trace.filter((line) => line.includes(`${result.retried} -> FailedPrecondition`)), trace).toEqual([]);
    const seqOf = (label: string) => result.trace.find((line) => line.includes(`acknowledged ${label} `))?.match(/seq=(\d+)/)?.[1];
    const retriedSeq = Number(seqOf(result.retried));
    const otherSeq = Number(seqOf(result.acknowledgedBy[1]?.at(-1) ?? ""));
    expect(retriedSeq, trace).toBeLessThan(otherSeq);
    // The retry really did happen after c1's commit moved the head.
    const retryAt = result.trace.findIndex((line) => line.includes(`acknowledged ${result.retried} `));
    const otherAt = result.trace.findIndex((line) => line.includes(`acknowledged ${result.acknowledgedBy[1]?.at(-1) ?? "?"} `));
    expect(otherAt, trace).toBeLessThan(retryAt);
  });
});

describe.runIf(suites.has("determinism"))("determinism", () => {
  const seed = environment.seeds[0] ?? 1;
  const steps = Math.min(environment.steps, 150);

  it("generates the identical schedule from the same seed", () => {
    const options = { seed, steps, clients: environment.clients };
    expect(generateSchedule(options)).toEqual(generateSchedule(options));
  });

  it("replays the identical client-side operations, faults and outcomes when a seed is re-run", async () => {
    const options = { seed, clients: environment.clients, steps };
    const first = await runSeed(environment, options);
    const second = await runSeed(environment, options);

    expect(second.vaultId).not.toBe(first.vaultId);
    expect(second.steps).toEqual(first.steps);
    expect(second.trace).toEqual(first.trace);
    // The schedule exercised faults, so the comparison covers them.
    expect(first.trace.some((line) => line.includes("lost"))).toBe(true);
  });
});
