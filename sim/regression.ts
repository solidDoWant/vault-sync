// How a failing seed becomes a regression case (sim/regressions/, recorded
// through the driver's control endpoint) and how the regressions suite
// replays one: with the run options the case recorded, so it replays the
// schedule that failed (#598, #646).

import type { Violation } from "./client";
import type { RegressionCase } from "./control";
import { runSteps, seededPlatforms, type RunOptions, type RunResult, type SimEndpoints } from "./runner";
import type { Step } from "./schedule";

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
    violations,
    steps,
  };
}

/**
 * The run options that replay `regression`. A case without
 * `faithfulFilesystem` (every case recorded before #598, and every folded
 * one) replays on the folded vault with pathPool; a faithful one on the
 * faithful vault with faithfulPathPool, as it was recorded. Likewise a case
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
