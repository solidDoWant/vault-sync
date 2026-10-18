import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/paths/vectors.json";
import { pathKey } from "./pathkey";

describe("pathKey", () => {
  it("has shared vectors to check", () => {
    expect(shared.vectors.length).toBeGreaterThan(0);
  });

  // The same file is asserted by internal/pathkey in Go, so passing here means
  // both languages produce exactly the same path_key for every vector.
  for (const vector of shared.vectors) {
    it(`matches the shared vector: ${vector.name}`, () => {
      expect(pathKey(vector.path)).toBe(vector.path_key);
    });

    it(`is idempotent: ${vector.name}`, () => {
      const key = pathKey(vector.path);
      expect(pathKey(key)).toBe(key);
    });
  }

  it("does not depend on the host locale's case mapping", () => {
    // toLowerCase would leave ß and turn Cherokee lowercase letters into themselves.
    expect(pathKey("Fuß")).toBe(pathKey("FUSS"));
    expect(pathKey("ꭰ")).toBe(pathKey("Ꭰ"));
  });
});
