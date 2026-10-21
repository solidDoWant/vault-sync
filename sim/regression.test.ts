import { describe, expect, it } from "vitest";

import type { RegressionCase } from "./control";
import { recordedCase, replayOptions } from "./regression";
import { seededCommitRetryBackoff, seededPlatforms, type RunOptions } from "./runner";
import type { Step } from "./schedule";

const steps: Step[] = [{ kind: "operation", client: 0, operation: "create", arg: 7 }, { kind: "deliver-request" }];
const violations = [{ invariant: "lost-write", detail: "e3's user wrote 0a1b2c3d to Straße.md at step 1; it is in no vault" }];

/** A case as the driver writes it to disk and the regressions suite loads it back. */
function throughDisk(regression: RegressionCase): RegressionCase {
  return JSON.parse(JSON.stringify(regression)) as RegressionCase;
}

function seededOptions(faithfulFilesystem: boolean): RunOptions {
  return { seed: 42, clients: 3, engines: 2, platforms: seededPlatforms(42, 2), commitRetryBackoff: seededCommitRetryBackoff, faithfulFilesystem };
}

describe("regression cases", () => {
  it("replay a case recorded on the faithful filesystem on the faithful filesystem", () => {
    const regression = throughDisk(recordedCase("seed-42-faithful-fs", seededOptions(true), violations, steps));

    expect(regression.faithfulFilesystem).toBe(true);
    expect(replayOptions(regression)).toEqual(seededOptions(true));
  });

  it("replay a case recorded on the folded vault folded", () => {
    const regression = throughDisk(recordedCase("seed-42", seededOptions(false), violations, steps));

    expect(regression).not.toHaveProperty("faithfulFilesystem");
    expect(replayOptions(regression)).toEqual(seededOptions(false));
  });

  it("replay a case recorded before the faithful filesystem was recorded folded", () => {
    // The shape of the cases committed under sim/regressions before #598.
    const legacy = throughDisk({ name: "seed-16", seed: 16, clients: 3, engines: 2, commitRetryBackoff: 30, violations, steps });

    expect(replayOptions(legacy).faithfulFilesystem).toBe(false);
  });

  it("replay a case from before #22 and #110 with one engine and no commit retry backoff", () => {
    const legacy = throughDisk({ name: "seed-3", seed: 3, clients: 2, violations, steps });

    expect(replayOptions(legacy)).toEqual({ seed: 3, clients: 2, engines: 1, platforms: seededPlatforms(3, 1), commitRetryBackoff: undefined, faithfulFilesystem: false });
  });

  it("record the minimized steps and their violations", () => {
    const regression = recordedCase("seed-42", seededOptions(false), violations, steps);

    expect(regression).toMatchObject({ name: "seed-42", seed: 42, clients: 3, engines: 2, commitRetryBackoff: seededCommitRetryBackoff, violations, steps });
  });
});
