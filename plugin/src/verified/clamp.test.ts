import { describe, expect, it } from "vitest";

import { clamp } from "./clamp";

describe("clamp (Dafny-compiled)", () => {
  it.each([
    { x: 5, lo: 0, hi: 10, expected: 5 },
    { x: 0, lo: 0, hi: 10, expected: 0 },
    { x: 10, lo: 0, hi: 10, expected: 10 },
    { x: -1, lo: 0, hi: 10, expected: 0 },
    { x: 11, lo: 0, hi: 10, expected: 10 },
    { x: -7, lo: -7, hi: -7, expected: -7 },
    { x: Number.MAX_SAFE_INTEGER, lo: Number.MIN_SAFE_INTEGER, hi: 3, expected: 3 },
  ])("clamps $x into [$lo, $hi] as $expected", ({ x, lo, hi, expected }) => {
    expect(clamp(x, lo, hi)).toBe(expected);
  });

  it("rejects an empty range instead of calling the compiled code outside its precondition", () => {
    expect(() => clamp(1, 2, 1)).toThrow(RangeError);
  });

  it("rejects values that are not safe integers", () => {
    expect(() => clamp(1.5, 0, 2)).toThrow(RangeError);
    expect(() => clamp(Number.NaN, 0, 2)).toThrow(RangeError);
    expect(() => clamp(2 ** 53, 0, 2)).toThrow(RangeError);
  });
});
