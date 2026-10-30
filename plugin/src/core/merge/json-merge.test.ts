import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mergeJson } from "./json-merge";
import { equal } from "./tree-merge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function merge(base: string, local: string, remote: string): string | null {
  const merged = mergeJson(encoder.encode(base), encoder.encode(local), encoder.encode(remote));
  return merged === null ? null : decoder.decode(merged);
}

describe("mergeJson", () => {
  it("merges changes to different keys, nested objects included, in the local side's indentation", () => {
    const base = '{\n  "a": 1,\n  "nested": { "x": 1, "y": 1 }\n}\n';
    const local = '{\n  "a": 2,\n  "nested": { "x": 2, "y": 1 }\n}\n';
    const remote = '{\n  "a": 1,\n  "nested": { "x": 1, "y": 3 },\n  "added": true\n}\n';
    expect(merge(base, local, remote)).toBe('{\n  "a": 2,\n  "nested": {\n    "x": 2,\n    "y": 3\n  },\n  "added": true\n}\n');
  });

  it("treats an array as one value: both sides changing it falls back", () => {
    expect(merge('{"list": [1, 2]}', '{"list": [1, 2, 3]}', '{"list": [0, 1, 2]}')).toBeNull();
    expect(merge('{"list": [1, 2], "b": 1}', '{"list": [1, 2, 3], "b": 1}', '{"list": [1, 2], "b": 2}')).toBe('{"list":[1,2,3],"b":2}');
  });

  it("falls back on a deletion against a change, or a side that is not JSON", () => {
    expect(merge('{"a": 1}', "{}", '{"a": 2}')).toBeNull();
    expect(merge('{"a": 1}', '{"a": 1', '{"a": 2}')).toBeNull();
  });

  it("keeps a __proto__ key as data", () => {
    expect(merge('{"b": 1}', '{"b": 1, "__proto__": {"x": 1}}', '{"b": 2}')).toBe('{"b":2,"__proto__":{"x":1}}');
  });
});

const valueArbitrary = fc.dictionary(
  fc.constantFrom("a", "b", "c", "d"),
  fc.oneof(fc.integer({ min: 0, max: 2 }), fc.constant([1]), fc.dictionary(fc.constantFrom("x", "y"), fc.integer({ min: 0, max: 2 }))),
);
const json = (value: unknown) => JSON.stringify(value, null, 2);

describe("mergeJson properties", () => {
  it("merge(base, x, base) = x and merge(base, x, x) = x, byte for byte", () => {
    fc.assert(
      fc.property(valueArbitrary, valueArbitrary, (b, x) => {
        expect(merge(json(b), json(x), json(b))).toBe(json(x));
        expect(merge(json(b), json(x), json(x))).toBe(json(x));
      }),
    );
  });

  it("is symmetric up to key order, and every merged result is JSON", () => {
    fc.assert(
      fc.property(valueArbitrary, valueArbitrary, valueArbitrary, (b, x, y) => {
        const forward = merge(json(b), json(x), json(y));
        const backward = merge(json(b), json(y), json(x));
        expect(forward === null).toBe(backward === null);
        if (forward === null || backward === null) return;
        expect(equal(JSON.parse(forward), JSON.parse(backward))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
