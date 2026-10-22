import { describe, expect, it } from "vitest";

import type { RegressionCase } from "./control";
import { recordedCase, replayOptions, replayRegression } from "./regression";
import { seededCommitRetryBackoff, seededPlatforms, type RunOptions, type RunResult, type SimEndpoints } from "./runner";
import type { Step } from "./schedule";

const steps: Step[] = [{ kind: "operation", client: 0, operation: "create", arg: 7 }, { kind: "deliver-request" }];
const violations = [{ invariant: "lost-write", detail: "e3's user wrote 0a1b2c3d to Straße.md at step 1; it is in no vault" }];

/** A case as the driver writes it to disk and the regressions suite loads it back. */
function throughDisk(regression: RegressionCase): RegressionCase {
  return JSON.parse(JSON.stringify(regression)) as RegressionCase;
}

function seededOptions(faithfulFilesystem: boolean, notificationPulls = true, retention = false): RunOptions {
  return { seed: 42, clients: 3, engines: 2, platforms: seededPlatforms(42, 2), commitRetryBackoff: seededCommitRetryBackoff, faithfulFilesystem, notificationPulls, retention };
}

describe("regression cases", () => {
  it("replay a case recorded on the faithful filesystem on the faithful filesystem", () => {
    const regression = throughDisk(recordedCase("seed-42-faithful-fs", seededOptions(true), violations, steps));

    expect(regression.faithfulFilesystem).toBe(true);
    expect(replayOptions(regression)).toEqual(seededOptions(true));
  });

  it("replay a case recorded with the plain pool with the plain pool", () => {
    const regression = throughDisk(recordedCase("seed-42", seededOptions(false), violations, steps));

    expect(regression).not.toHaveProperty("faithfulFilesystem");
    expect(replayOptions(regression)).toEqual(seededOptions(false));
  });

  it("replay a case recorded before the faithful filesystem was recorded with the plain pool", () => {
    // The shape of the cases committed under sim/regressions before #598.
    const legacy = throughDisk({ name: "seed-16", seed: 16, clients: 3, engines: 2, commitRetryBackoff: 30, violations, steps });

    expect(replayOptions(legacy).faithfulFilesystem).toBe(false);
  });

  it("replay a case recorded without notification-gated pulls without them (#277)", () => {
    const regression = throughDisk(recordedCase("seed-42", seededOptions(false, false), violations, steps));

    expect(regression).not.toHaveProperty("notificationPulls");
    expect(replayOptions(regression)).toEqual(seededOptions(false, false));
  });

  it("replay a case recorded with notification-gated pulls with them (#277)", () => {
    const regression = throughDisk(recordedCase("seed-42", seededOptions(false), violations, steps));

    expect(regression.notificationPulls).toBe(true);
    expect(replayOptions(regression).notificationPulls).toBe(true);
  });

  it("replay a case from before #22 and #110 with one engine and no commit retry backoff", () => {
    const legacy = throughDisk({ name: "seed-3", seed: 3, clients: 2, violations, steps });

    expect(replayOptions(legacy)).toEqual({ seed: 3, clients: 2, engines: 1, platforms: seededPlatforms(3, 1), commitRetryBackoff: undefined, faithfulFilesystem: false, notificationPulls: false, retention: false });
  });

  it("replay a case recorded with retention purges with them (#646)", () => {
    const options = seededOptions(false, true, true);
    const regression = throughDisk(recordedCase("seed-42-retention", options, violations, steps));

    expect(regression.retention).toBe(true);
    expect(replayOptions(regression)).toEqual(options);
  });

  it("replay a case recorded without retention purges without them (#646)", () => {
    const regression = throughDisk(recordedCase("seed-42", seededOptions(false), violations, steps));

    expect(regression).not.toHaveProperty("retention");
    expect(replayOptions(regression).retention).toBe(false);
  });

  it("replay a case recorded before retention was recorded without it (#646)", () => {
    const legacy = throughDisk({ name: "seed-16", seed: 16, clients: 3, engines: 2, commitRetryBackoff: 30, violations, steps });

    expect(replayOptions(legacy).retention).toBe(false);
  });

  it("run a committed case's steps with the options it recorded (#646)", async () => {
    const recorded: RunOptions = { seed: 42, clients: 3, engines: 2, platforms: seededPlatforms(42, 2), commitRetryBackoff: seededCommitRetryBackoff, retention: true, faithfulFilesystem: true, notificationPulls: true };
    const regression = throughDisk(recordedCase("seed-42-retention-faithful-fs", recorded, violations, steps));
    const endpoints = { serverUrl: "http://server.invalid", controlUrl: "http://control.invalid" } as unknown as SimEndpoints;
    const result = { violations } as unknown as RunResult;
    const runs: [SimEndpoints, RunOptions, readonly Step[]][] = [];

    const replayed = await replayRegression(endpoints, regression, (...run) => {
      runs.push(run);
      return Promise.resolve(result);
    });

    expect(replayed).toBe(result);
    expect(runs).toEqual([[endpoints, recorded, steps]]);
  });

  it("replay a case recorded with several users with them (#35)", () => {
    const options = { ...seededOptions(false), users: 3 };
    const regression = throughDisk(recordedCase("seed-42-members", options, violations, steps));

    expect(regression.users).toBe(3);
    expect(replayOptions(regression)).toEqual(options);
  });

  it("replay a case recorded with one user, or before #35, with one user", () => {
    const regression = throughDisk(recordedCase("seed-42", { ...seededOptions(false), users: 1 }, violations, steps));

    expect(regression).not.toHaveProperty("users");
    expect(replayOptions(regression).users ?? 1).toBe(1);
  });

  it("record the minimized steps and their violations", () => {
    const regression = recordedCase("seed-42", seededOptions(false), violations, steps);

    expect(regression).toMatchObject({ name: "seed-42", seed: 42, clients: 3, engines: 2, commitRetryBackoff: seededCommitRetryBackoff, violations, steps });
  });
});
