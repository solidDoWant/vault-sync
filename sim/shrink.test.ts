import { describe, expect, it } from "vitest";

import { shrink } from "./shrink";

const range = (length: number) => Array.from({ length }, (_, index) => index);

describe("shrink", () => {
  it("reduces a failing sequence to the steps the failure needs", async () => {
    const fails = (candidate: number[]) => Promise.resolve(candidate.includes(13) && candidate.includes(77));
    const result = await shrink(range(100), fails, 1000);
    expect(result.items).toEqual([13, 77]);
  });

  it("keeps the order of the remaining steps", async () => {
    const fails = (candidate: number[]) => {
      const first = candidate.indexOf(30);
      return Promise.resolve(first >= 0 && candidate.indexOf(60) > first);
    };
    const result = await shrink(range(80), fails, 1000);
    expect(result.items).toEqual([30, 60]);
  });

  it("stops after maxRuns candidates", async () => {
    let calls = 0;
    const fails = (candidate: number[]) => {
      calls++;
      return Promise.resolve(candidate.length > 0);
    };
    const result = await shrink(range(1000), fails, 5);
    expect(calls).toBe(5);
    expect(result.runs).toBe(5);
  });

  it("returns the input when no step can be removed", async () => {
    const fails = (candidate: number[]) => Promise.resolve(candidate.length === 4);
    const result = await shrink(range(4), fails, 100);
    expect(result.items).toEqual([0, 1, 2, 3]);
  });
});
