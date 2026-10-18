import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The networked simulation suite (../sim/*.sim.test.ts, SPEC.md §13). `make
// test-sim` runs it through the `sim`-tagged Go driver (sim/simulation_test.go),
// which starts PostgreSQL, the S3 store, the real server and a control endpoint
// and passes their addresses in VAULT_SYNC_SIM_*. The harness itself is
// type-checked with src/core and may not use Node APIs, so this file reads the
// environment and the committed regression cases and hands them over with
// vitest's provide/inject (sim/environment.ts).

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run the simulation with \`make test-sim\``);
  return value;
}

// The Go driver passes the directory it writes failing seeds to (an absolute
// path); by default it is the committed sim/regressions.
const regressionsDir = process.env.SIM_REGRESSION_DIR || fileURLToPath(new URL("../sim/regressions/", import.meta.url));
const regressions = (existsSync(regressionsDir) ? readdirSync(regressionsDir) : [])
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(path.join(regressionsDir, file), "utf8")) as unknown);

const firstSeed = integer("SIM_FIRST_SEED", 1);
const single = process.env.SIM_SEED;
const seeds = single !== undefined && single !== "" ? [integer("SIM_SEED", 0)] : Array.from({ length: integer("SIM_SEEDS", 10) }, (_, index) => firstSeed + index);
const clients = integer("SIM_CLIENTS", 3);
if (clients < 1) throw new Error("SIM_CLIENTS must be at least 1");

export default defineConfig({
  test: {
    include: ["../sim/**/*.sim.test.ts"],
    // One server, one schedule at a time: runs are serialized so that each
    // replays deterministically.
    fileParallelism: false,
    testTimeout: 60 * 60 * 1000,
    provide: {
      sim: {
        serverUrl: required("VAULT_SYNC_SIM_SERVER_URL"),
        controlUrl: required("VAULT_SYNC_SIM_CONTROL_URL"),
        seeds,
        steps: integer("SIM_STEPS", 1000),
        clients,
        shrinkRuns: integer("SIM_SHRINK_RUNS", 150),
        regressions,
        suites: (process.env.VAULT_SYNC_SIM_SUITES ?? "seeds,regressions,scenarios,determinism").split(","),
      },
    },
  },
});
