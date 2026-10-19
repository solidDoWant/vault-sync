// Configuration the networked simulation suite receives from
// plugin/vitest.sim.config.ts through vitest's provide/inject, so that sim/
// needs no Node APIs (it is type-checked with src/core, without Node types).

import { inject } from "vitest";

import type { RegressionCase } from "./control";
import type { SimEndpoints } from "./runner";

export interface SimEnvironment extends SimEndpoints {
  /** Seeds to run (SIM_SEEDS from SIM_FIRST_SEED, or just SIM_SEED). */
  seeds: number[];
  /** Steps per seeded schedule (SIM_STEPS). */
  steps: number;
  /** Simulated clients per run (SIM_CLIENTS). */
  clients: number;
  /** Engines per seeded run, each with a user making random changes (SIM_ENGINES). */
  engines: number;
  /** Most runs spent minimizing one failing seed (SIM_SHRINK_RUNS). */
  shrinkRuns: number;
  /** Committed regression cases (sim/regressions/*.json), replayed every run. */
  regressions: RegressionCase[];
  /** Which suites to run; the broken-server check runs only `seeds`. */
  suites: string[];
}

declare module "vitest" {
  export interface ProvidedContext {
    sim: SimEnvironment;
  }
}

export function simEnvironment(): SimEnvironment {
  return inject("sim");
}
