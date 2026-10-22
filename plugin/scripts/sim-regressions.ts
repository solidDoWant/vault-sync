/// <reference types="node" />
// Finds and loads the simulation's regression cases for vitest.sim.config.ts
// (docs/testing/simulation.md). The committed cases are the safety net for
// sync bugs, so a regression directory that is missing or holds no case is a
// loud failure whenever they are to be replayed, never a silently skipped
// suite (#131).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const regressionDirEnv = "SIM_REGRESSION_DIR";

/**
 * Resolves the value of SIM_REGRESSION_DIR. A relative value is relative to
 * the repository root (where `make test-sim` runs); unset or empty is the
 * committed sim/regressions. The Go driver resolves it the same way
 * (sim/regressiondir_test.go) and passes the absolute result.
 */
export function resolveRegressionDir(value: string | undefined, repoRoot: string): string {
  return path.resolve(repoRoot, value === undefined || value === "" ? path.join("sim", "regressions") : value);
}

/**
 * Loads every `*.json` regression case in `dir`, in name order. When
 * `required` (the regressions suite will run), a missing directory, a path
 * that is not a directory, or a directory without a case throws an error
 * naming SIM_REGRESSION_DIR.
 */
export function loadRegressionCases(dir: string, { required }: { required: boolean }): unknown[] {
  const fail = (problem: string): never => {
    throw new Error(
      `${regressionDirEnv}: the regression directory ${dir} ${problem}, so the committed regression cases cannot be replayed. ` +
        `Leave ${regressionDirEnv} unset to use sim/regressions, or point it (relative to the repository root) at a directory of *.json cases.`,
    );
  };

  let stats;
  try {
    stats = statSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return required ? fail("does not exist") : [];
  }
  if (!stats.isDirectory()) return required ? fail("is not a directory") : [];

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0 && required) fail("contains no regression cases (*.json)");

  return files.map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown);
}

/**
 * The saved case and the violation the `shrink` suite keeps, from
 * SIM_SHRINK_CASE (a regression case's JSON file, relative to the repository
 * root), SIM_SHRINK_INVARIANT (the violation's kind) and SIM_SHRINK_MATCH (a
 * regular expression its detail must match, optional). A missing case or
 * kind, an unreadable file or an invalid expression throws, naming the
 * variable.
 */
export function loadShrinkTarget(env: Record<string, string | undefined>, repoRoot: string): { regression: unknown; invariant: string; pattern?: string } {
  const file = env.SIM_SHRINK_CASE;
  const invariant = env.SIM_SHRINK_INVARIANT;
  if (file === undefined || file === "") throw new Error("SIM_SHRINK_CASE must name the regression case (a *.json file) the shrink suite minimizes");
  if (invariant === undefined || invariant === "") throw new Error("SIM_SHRINK_INVARIANT must name the violation (its kind, e.g. phantom-delete) the shrink suite keeps");
  const pattern = env.SIM_SHRINK_MATCH;
  if (pattern !== undefined && pattern !== "") {
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      throw new Error(`SIM_SHRINK_MATCH is not a valid regular expression: ${(error as Error).message}`, { cause: error });
    }
  }
  const regression = JSON.parse(readFileSync(path.resolve(repoRoot, file), "utf8")) as unknown;
  return { regression, invariant, ...(pattern === undefined || pattern === "" ? {} : { pattern }) };
}
