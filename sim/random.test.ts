import { describe, expect, it } from "vitest";

import { Random } from "./random";

function draws(random: Random, count: number): number[] {
  return Array.from({ length: count }, () => random.uint32());
}

describe("Random", () => {
  it("produces the same sequence for the same seed", () => {
    expect(draws(new Random(42), 100)).toEqual(draws(new Random(42), 100));
  });

  it("produces different sequences for different seeds", () => {
    expect(draws(new Random(1), 20)).not.toEqual(draws(new Random(2), 20));
  });

  it("pins the sequence, so schedules replay identically across versions and platforms", () => {
    // Committed regression cases are replayed from their steps, but seeds
    // printed by CI are replayed by regenerating the schedule: a change to
    // the generator would silently change what a seed means.
    expect(draws(new Random(1), 4)).toMatchInlineSnapshot(`
      [
        1235322124,
        80454549,
        756047286,
        620198036,
      ]
    `);
  });

  it("derives independent streams by label", () => {
    expect(draws(Random.derive(7, "schedule"), 10)).toEqual(draws(Random.derive(7, "schedule"), 10));
    expect(draws(Random.derive(7, "schedule"), 10)).not.toEqual(draws(Random.derive(7, "content"), 10));
  });

  it("keeps int within its bound and covers it", () => {
    const random = new Random(3);
    const seen = new Set<number>();
    for (let index = 0; index < 1000; index++) {
      const value = random.int(5);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
  });

  it("rejects a non-positive bound", () => {
    expect(() => new Random(1).int(0)).toThrow(RangeError);
  });

  it("chooses weighted keys roughly in proportion and never a zero-weight key", () => {
    const random = new Random(9);
    const counts = { often: 0, rarely: 0, never: 0 };
    for (let index = 0; index < 10_000; index++) counts[random.weighted({ often: 9, rarely: 1, never: 0 })]++;
    expect(counts.never).toBe(0);
    expect(counts.often).toBeGreaterThan(counts.rarely * 5);
    expect(counts.rarely).toBeGreaterThan(0);
  });
});
