// How a failing seed becomes a regression case (sim/regressions/, recorded
// through the driver's control endpoint) and how the regressions suite
// replays one: with the run options the case recorded, so it replays the
// schedule that failed (#598, #646).

import type { Violation } from "./client";
import type { RegressionCase } from "./control";
import { runSteps, seededPlatforms, type RunOptions, type RunResult, type SimEndpoints } from "./runner";
import type { Step } from "./schedule";
import { shrink, type ShrinkProgress } from "./shrink";

/**
 * The regression case of a failing seeded run with `options`: the minimized
 * `steps` and the `violations` they produced. It records every option the
 * replay needs; the faithful filesystem, notification-gated pulls and
 * retention purges only when they were on, so a case without them reads as
 * before.
 */
export function recordedCase(name: string, options: RunOptions, violations: Violation[], steps: Step[]): RegressionCase {
  return {
    name,
    seed: options.seed,
    clients: options.clients,
    engines: options.engines,
    commitRetryBackoff: options.commitRetryBackoff,
    ...(options.faithfulFilesystem === true ? { faithfulFilesystem: true } : {}),
    ...(options.notificationPulls === true ? { notificationPulls: true } : {}),
    ...(options.retention === true ? { retention: true } : {}),
    ...(options.users !== undefined && options.users > 1 ? { users: options.users } : {}),
    violations,
    steps,
  };
}

/**
 * The run options that replay `regression`. A case without
 * `faithfulFilesystem` (every case recorded before #598, and every one
 * recorded with SIM_FAITHFUL_FS=0) replays with pathPool; a faithful one
 * with faithfulPathPool, as it was recorded. Both replay on the faithful
 * vault: the folded one is gone (#797). Likewise a case
 * recorded by the retention suite replays with `retention` (#646); its
 * steps carry the retention steps that purge.
 */
export function replayOptions(regression: RegressionCase): RunOptions {
  const engines = regression.engines ?? 1;
  return {
    seed: regression.seed,
    clients: regression.clients,
    engines,
    platforms: seededPlatforms(regression.seed, engines),
    commitRetryBackoff: regression.commitRetryBackoff,
    faithfulFilesystem: regression.faithfulFilesystem === true,
    notificationPulls: regression.notificationPulls === true,
    retention: regression.retention === true,
    ...(regression.users !== undefined && regression.users > 1 ? { users: regression.users } : {}),
  };
}

/**
 * Replays the committed `regression` case's steps with the options it
 * recorded (replayOptions), as the regressions suite does; `run` is
 * runSteps but for tests.
 */
export function replayRegression(endpoints: SimEndpoints, regression: RegressionCase, run: typeof runSteps = runSteps): Promise<RunResult> {
  return run(endpoints, replayOptions(regression), regression.steps);
}

/** One named violation a targeted shrink keeps (SIM_SHRINK_INVARIANT, SIM_SHRINK_MATCH). */
export interface ShrinkTarget {
  /** The violation's kind, e.g. `phantom-delete`. */
  invariant: string;
  /** A regular expression its detail must match; any detail when unset. */
  pattern?: string;
}

/** Whether `violations` hold the `target` violation: one of its kind whose detail matches its pattern. */
export function reproduces(target: ShrinkTarget, violations: readonly Violation[]): boolean {
  const pattern = target.pattern === undefined || target.pattern === "" ? undefined : new RegExp(target.pattern, "u");
  return violations.some((violation) => violation.invariant === target.invariant && (pattern === undefined || pattern.test(violation.detail)));
}

/**
 * Minimizes the saved `regression` case to the steps that still reproduce
 * the `target` violation, within `maxRuns` re-runs (#822 item 7): unlike
 * the seeded suites' shrink, which keeps any violation of the kinds the run
 * had, a candidate that fails only for another reason is not kept, so the
 * shrink cannot drift to another mechanism (#381, #498). It replays the
 * case first and throws if that does not reproduce the target. The result
 * is the case named `<name>-min`, with the minimized steps and the
 * violations they produce; `run` is runSteps but for tests.
 */
export async function shrinkCase(
  endpoints: SimEndpoints,
  regression: RegressionCase,
  target: ShrinkTarget,
  maxRuns: number,
  progress?: (state: ShrinkProgress) => void,
  run: typeof runSteps = runSteps,
): Promise<{ regression: RegressionCase; runs: number }> {
  const options = replayOptions(regression);
  const full = await run(endpoints, options, regression.steps);
  if (!reproduces(target, full.violations)) {
    const found = full.violations.map((violation) => `${violation.invariant}: ${violation.detail}`).join("; ");
    throw new Error(`${regression.name} does not reproduce ${target.invariant}${target.pattern === undefined ? "" : ` matching /${target.pattern}/`}; its replay violated: ${found === "" ? "nothing" : found}`);
  }
  const minimized = await shrink(regression.steps, async (steps) => reproduces(target, (await run(endpoints, options, steps)).violations), maxRuns, progress);
  const final = await run(endpoints, options, minimized.items);
  return { regression: recordedCase(`${regression.name}-min`, options, final.violations, minimized.items), runs: minimized.runs };
}
