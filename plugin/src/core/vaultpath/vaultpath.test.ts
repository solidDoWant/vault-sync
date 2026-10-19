import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/paths/validity.json";
import { isNewVaultPath, isVaultRelativePath } from "./vaultpath";

describe("isVaultRelativePath", () => {
  it("has shared vectors with both outcomes to check", () => {
    expect(shared.vectors.some((vector) => vector.valid)).toBe(true);
    expect(shared.vectors.some((vector) => !vector.valid)).toBe(true);
  });

  // The same file is asserted by internal/vaultpath and by CommitRevision in
  // Go, so passing here means the client accepts exactly what the server does.
  for (const vector of shared.vectors) {
    it(`${vector.valid ? "accepts" : "rejects"} the shared vector: ${vector.name}`, () => {
      expect(isVaultRelativePath(vector.path)).toBe(vector.valid);
    });
  }
});

describe("isNewVaultPath", () => {
  it("has shared vectors that are new, valid only, and invalid", () => {
    expect(shared.vectors.some((vector) => vector.new)).toBe(true);
    expect(shared.vectors.some((vector) => vector.valid && !vector.new)).toBe(true);
    expect(shared.vectors.some((vector) => !vector.valid && !vector.new)).toBe(true);
  });

  // The same file is asserted by vaultpath.CheckNew and by CommitRevision's
  // creates in Go.
  for (const vector of shared.vectors) {
    it(`${vector.new ? "accepts" : "rejects"} the shared vector as a new path: ${vector.name}`, () => {
      expect(isNewVaultPath(vector.path)).toBe(vector.new);
    });
  }
});
