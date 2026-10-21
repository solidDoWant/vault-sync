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

describe("shrink progress", () => {
  it("reports after every candidate run, with the smallest failing length so far", async () => {
    const fails = (candidate: number[]) => Promise.resolve(candidate.includes(3));
    const reports: { runs: number; maxRuns: number; removed: boolean; length: number }[] = [];
    const result = await shrink(range(8), fails, 1000, (state) => reports.push({ ...state }));

    expect(reports).toHaveLength(result.runs);
    expect(reports.map((report) => report.runs)).toEqual(range(result.runs).map((index) => index + 1));
    expect(reports.every((report) => report.maxRuns === 1000)).toBe(true);
    // The first candidate drops the first half, [0..3], which holds 3: it passes, so nothing is removed.
    expect(reports[0]).toEqual({ runs: 1, maxRuns: 1000, removed: false, length: 8 });
    // The second drops [4..7] and still fails.
    expect(reports[1]).toEqual({ runs: 2, maxRuns: 1000, removed: true, length: 4 });
    expect(reports.at(-1)?.length).toBe(1);
  });
});
