/// <reference types="node" />
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadRegressionCases, loadShrinkTarget, resolveRegressionDir } from "../scripts/sim-regressions";

// The directory vitest.sim.config.ts reads its regression cases with (#131).
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const committedDir = path.join(repoRoot, "sim", "regressions");
const committedCount = readdirSync(committedDir).filter((file) => file.endsWith(".json")).length;

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sim-regressions-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function names(cases: unknown[]): string[] {
  return cases.map((regression) => (regression as { name: string }).name);
}

describe("SIM_REGRESSION_DIR resolution", () => {
  it("uses the committed sim/regressions when unset", () => {
    expect(path.resolve(resolveRegressionDir(undefined, repoRoot))).toBe(path.resolve(committedDir));
    expect(path.resolve(resolveRegressionDir("", repoRoot))).toBe(path.resolve(committedDir));
  });

  it("resolves the documented default sim/regressions against the repository root", () => {
    expect(path.resolve(resolveRegressionDir("sim/regressions", repoRoot))).toBe(path.resolve(committedDir));
  });

  it("replays every committed case when set to the documented default", () => {
    expect(committedCount).toBeGreaterThan(0);
    const cases = loadRegressionCases(resolveRegressionDir("sim/regressions", repoRoot), { required: true });
    expect(cases).toHaveLength(committedCount);
    expect(names(cases)).toContain("simfault-stale-base");
  });

  it("keeps an absolute directory as is", () => {
    const dir = scratchDir();
    expect(resolveRegressionDir(dir, repoRoot)).toBe(dir);
  });
});

describe("loading regression cases", () => {
  it("fails naming SIM_REGRESSION_DIR when the directory does not exist", () => {
    const missing = path.join(scratchDir(), "absent");
    expect(() => loadRegressionCases(missing, { required: true })).toThrow(/SIM_REGRESSION_DIR.*does not exist/s);
    expect(() => loadRegressionCases(missing, { required: true })).toThrow(missing);
  });

  it("fails naming SIM_REGRESSION_DIR when the path is not a directory", () => {
    const file = path.join(scratchDir(), "case.json");
    writeFileSync(file, "{}");
    expect(() => loadRegressionCases(file, { required: true })).toThrow(/SIM_REGRESSION_DIR.*not a directory/s);
  });

  it("fails naming SIM_REGRESSION_DIR when the directory holds no regression case", () => {
    const dir = scratchDir();
    writeFileSync(path.join(dir, "README.md"), "not a case");
    mkdirSync(path.join(dir, "nested.json"));
    expect(() => loadRegressionCases(dir, { required: true })).toThrow(/SIM_REGRESSION_DIR.*no regression cases/s);
  });

  it("loads every *.json case in name order", () => {
    const dir = scratchDir();
    writeFileSync(path.join(dir, "b.json"), JSON.stringify({ name: "b" }));
    writeFileSync(path.join(dir, "a.json"), JSON.stringify({ name: "a" }));
    writeFileSync(path.join(dir, "README.md"), "ignored");
    expect(names(loadRegressionCases(dir, { required: true }))).toEqual(["a", "b"]);
  });

  it("allows a missing or empty directory when the regression cases are not replayed", () => {
    expect(loadRegressionCases(path.join(scratchDir(), "absent"), { required: false })).toEqual([]);
    expect(loadRegressionCases(scratchDir(), { required: false })).toEqual([]);
  });
});

describe("the targeted shrink's case and violation (#822 item 7)", () => {
  it("loads the case relative to the repository root with the named violation and pattern", () => {
    const target = loadShrinkTarget({ SIM_SHRINK_CASE: "sim/regressions/simfault-stale-base.json", SIM_SHRINK_INVARIANT: "stale-base", SIM_SHRINK_MATCH: "seq \\d+" }, repoRoot);

    expect(target.invariant).toBe("stale-base");
    expect(target.pattern).toBe("seq \\d+");
    expect((target.regression as { name: string }).name).toBe("simfault-stale-base");
  });

  it("leaves the pattern out when SIM_SHRINK_MATCH is unset or empty", () => {
    expect(loadShrinkTarget({ SIM_SHRINK_CASE: "sim/regressions/simfault-stale-base.json", SIM_SHRINK_INVARIANT: "stale-base", SIM_SHRINK_MATCH: "" }, repoRoot)).not.toHaveProperty("pattern");
  });

  it("fails naming the variable when the case or the violation is missing, or the pattern is invalid", () => {
    expect(() => loadShrinkTarget({ SIM_SHRINK_INVARIANT: "stale-base" }, repoRoot)).toThrow(/SIM_SHRINK_CASE/u);
    expect(() => loadShrinkTarget({ SIM_SHRINK_CASE: "sim/regressions/simfault-stale-base.json" }, repoRoot)).toThrow(/SIM_SHRINK_INVARIANT/u);
    expect(() => loadShrinkTarget({ SIM_SHRINK_CASE: "sim/regressions/simfault-stale-base.json", SIM_SHRINK_INVARIANT: "stale-base", SIM_SHRINK_MATCH: "(" }, repoRoot)).toThrow(/SIM_SHRINK_MATCH/u);
  });
});
