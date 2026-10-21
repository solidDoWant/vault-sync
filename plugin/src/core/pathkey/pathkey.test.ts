import { afterEach, describe, expect, it, vi } from "vitest";

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

  describe("on an engine whose Unicode tables are older than the pinned version", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // An older Electron or Android WebView normalizes characters added since
    // its Unicode version as if they had no normalization data. pathKey must
    // not consult the engine at all, so make the engine's normalize unusable.
    it("matches every shared vector without String.prototype.normalize", () => {
      vi.spyOn(String.prototype, "normalize").mockImplementation(() => {
        throw new Error("String.prototype.normalize must not be used for path_key");
      });
      for (const vector of shared.vectors) {
        expect(pathKey(vector.path), vector.name).toBe(vector.path_key);
      }
    });
  });
});
