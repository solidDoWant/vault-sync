import { describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { generateSchedule, maxFaultSteps, type StepKind } from "./schedule";

describe("generateSchedule", () => {
  it("generates the identical schedule for the same seed", () => {
    const options = { seed: 1234, steps: 500, clients: 3 };
    expect(generateSchedule(options)).toEqual(generateSchedule(options));
  });

  it("generates different schedules for different seeds", () => {
    expect(generateSchedule({ seed: 1, steps: 50, clients: 3 })).not.toEqual(generateSchedule({ seed: 2, steps: 50, clients: 3 }));
  });

  it("extends a schedule without changing its prefix when more steps are asked for", () => {
    const short = generateSchedule({ seed: 5, steps: 40, clients: 3 });
    const long = generateSchedule({ seed: 5, steps: 80, clients: 3 });
    expect(long.slice(0, 40)).toEqual(short);
  });

  it("produces plain JSON, so a schedule can be committed and replayed", () => {
    const schedule = generateSchedule({ seed: 77, steps: 200, clients: 4 });
    expect(JSON.parse(JSON.stringify(schedule))).toEqual(schedule);
  });

  it("covers every operation and fault kind, with in-range parameters", () => {
    const schedule = generateSchedule({ seed: 99, steps: 3000, clients: 3 });
    const kinds = new Set<StepKind>(schedule.map((step) => step.kind));
    expect([...kinds].sort()).toEqual(
      (["operation", "deliver-request", "deliver-response", "reorder", "delay", "drop-request", "drop-response", "partition", "crash"] satisfies StepKind[]).sort(),
    );
    const operations = new Set(schedule.flatMap((step) => (step.kind === "operation" ? [step.operation] : [])));
    expect([...operations].sort()).toEqual(["create", "delete", "edit", "pull", "rename"]);
    for (const step of schedule) {
      if ("client" in step && step.client !== undefined) {
        expect(step.client).toBeGreaterThanOrEqual(0);
        expect(step.client).toBeLessThan(3);
      }
      if (step.kind === "delay" || step.kind === "partition") {
        expect(step.steps).toBeGreaterThanOrEqual(1);
        expect(step.steps).toBeLessThanOrEqual(maxFaultSteps);
      }
    }
  });

  it("rejects invalid options", () => {
    expect(() => generateSchedule({ seed: 1, steps: 10, clients: 0 })).toThrow(RangeError);
    expect(() => generateSchedule({ seed: 1, steps: -1, clients: 1 })).toThrow(RangeError);
    expect(() => generateSchedule({ seed: 1, steps: 10, clients: 1, engines: -1 })).toThrow(RangeError);
    expect(() => generateSchedule({ seed: 1, steps: 10, clients: 1, engines: 1.5 })).toThrow(RangeError);
  });

  it("generates exactly the schedules of before #22 when the run has no engine users", () => {
    // The digest of seed 4242's 2000 steps for 3 clients, computed with the
    // generator from before engine operations existed, with the step weights
    // retuned in #110 (c60a78c). Before that retune (6201f44) it was
    // 9d03d04b91bd71eca1f9a1dba1bdae0dcee6a0610304d59dee41ffccea35905e.
    const schedule = generateSchedule({ seed: 4242, steps: 2000, clients: 3 });
    expect(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(schedule))))).toBe("b93c70d5465c4a9a9420c2e2034c35bdf22a0f21e542d91f818c8e0f6133b3c3");
    expect(generateSchedule({ seed: 4242, steps: 2000, clients: 3, engines: 0 })).toEqual(schedule);
  });

  it("has every engine's user make every kind of change when the run has engines", () => {
    const schedule = generateSchedule({ seed: 99, steps: 3000, clients: 3, engines: 2 });
    const engineSteps = schedule.flatMap((step) => (step.kind === "engine-operation" ? [step] : []));
    expect(new Set(engineSteps.map((step) => step.engine))).toEqual(new Set([0, 1]));
    expect([...new Set(engineSteps.map((step) => step.operation))].sort()).toEqual(["create", "delete", "edit", "push", "rename"]);
    // The other kinds are still generated.
    expect(new Set(schedule.map((step) => step.kind)).size).toBe(10);
  });
});
