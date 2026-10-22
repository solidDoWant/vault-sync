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

  it("generates exactly the schedules of before #229 when the run has no retention", () => {
    // The digest of seed 4242's 2000 steps for 3 clients and 2 engines,
    // computed with the generator from before retention steps existed.
    const schedule = generateSchedule({ seed: 4242, steps: 2000, clients: 3, engines: 2 });
    expect(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(schedule))))).toBe("9570346746379d65eb865a659dfcdfe58c6cde458990d5be7cb21b11971effd5");
    expect(generateSchedule({ seed: 4242, steps: 2000, clients: 3, engines: 2, retention: false })).toEqual(schedule);
    expect(schedule.some((step) => step.kind === "retention")).toBe(false);
  });

  it("runs the retention job between the steps of the seed's plain schedule when the run has retention", () => {
    const options = { seed: 99, steps: 3000, clients: 3, engines: 2 };
    const plain = generateSchedule(options);
    const schedule = generateSchedule({ ...options, retention: true });
    const retention = schedule.filter((step) => step.kind === "retention");
    // About one in two hundred steps.
    expect(retention.length).toBeGreaterThanOrEqual(5);
    expect(retention.length).toBeLessThanOrEqual(40);
    expect(schedule.filter((step) => step.kind !== "retention")).toEqual(plain);
    expect(generateSchedule({ ...options, retention: true })).toEqual(schedule);
    expect(JSON.parse(JSON.stringify(schedule))).toEqual(schedule);
  });

  it("generates exactly the schedules of before #35 when the run has no membership changes", () => {
    // The pinned digest above, now with membership steps known to the generator.
    const schedule = generateSchedule({ seed: 4242, steps: 2000, clients: 3, engines: 2, membership: false });
    expect(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(schedule))))).toBe("9570346746379d65eb865a659dfcdfe58c6cde458990d5be7cb21b11971effd5");
    expect(schedule.some((step) => step.kind === "membership")).toBe(false);
  });

  it("changes members' roles between the steps of the seed's plain schedule when the run has membership changes", () => {
    const options = { seed: 99, steps: 3000, clients: 3, engines: 2 };
    const plain = generateSchedule(options);
    const schedule = generateSchedule({ ...options, membership: true });
    const membership = schedule.filter((step) => step.kind === "membership");
    // About one in a hundred steps.
    expect(membership.length).toBeGreaterThanOrEqual(15);
    expect(membership.length).toBeLessThanOrEqual(60);
    expect(schedule.filter((step) => step.kind !== "membership")).toEqual(plain);
    expect(generateSchedule({ ...options, membership: true })).toEqual(schedule);
    // With retention too, the plain schedule and its retention steps are unchanged.
    const both = generateSchedule({ ...options, membership: true, retention: true });
    expect(both.filter((step) => step.kind !== "membership")).toEqual(generateSchedule({ ...options, retention: true }));
  });

  it("generates exactly the schedules of before #650 when the run has no restores", () => {
    // The pinned digest above, now with snapshot and restore steps known to the generator.
    const schedule = generateSchedule({ seed: 4242, steps: 2000, clients: 3, engines: 2, restores: false });
    expect(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(schedule))))).toBe("9570346746379d65eb865a659dfcdfe58c6cde458990d5be7cb21b11971effd5");
    expect(schedule.some((step) => step.kind === "snapshot" || step.kind === "restore")).toBe(false);
  });

  it("backs up and restores the vault's database between the steps of the seed's plain schedule when the run has restores", () => {
    const options = { seed: 99, steps: 3000, clients: 3, engines: 2 };
    const plain = generateSchedule(options);
    const schedule = generateSchedule({ ...options, restores: true });
    const snapshots = schedule.filter((step) => step.kind === "snapshot");
    const restores = schedule.filter((step) => step.kind === "restore");
    // About one backup in 150 steps and one restore in 250.
    expect(snapshots.length).toBeGreaterThanOrEqual(8);
    expect(snapshots.length).toBeLessThanOrEqual(45);
    expect(restores.length).toBeGreaterThanOrEqual(4);
    expect(restores.length).toBeLessThanOrEqual(30);
    // Some restore comes after a backup, so it puts the vault back.
    expect(schedule.findIndex((step) => step.kind === "snapshot")).toBeLessThan(schedule.length - 1 - [...schedule].reverse().findIndex((step) => step.kind === "restore"));
    expect(schedule.filter((step) => step.kind !== "snapshot" && step.kind !== "restore")).toEqual(plain);
    expect(generateSchedule({ ...options, restores: true })).toEqual(schedule);
    // With retention and membership changes too, those steps are unchanged.
    const all = generateSchedule({ ...options, restores: true, membership: true, retention: true });
    expect(all.filter((step) => step.kind !== "snapshot" && step.kind !== "restore")).toEqual(generateSchedule({ ...options, membership: true, retention: true }));
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
