import { describe, expect, it } from "vitest";

import text from "../../../../testdata/paths/text.json";
import shared from "../../../../testdata/paths/validity.json";
import { isNewVaultPath, isPathText, isVaultRelativePath } from "./vaultpath";

/** A text vector's path: `path` repeated `repeat` times (once if absent). */
const textPath = (vector: { path: string; repeat?: number }) => vector.path.repeat(vector.repeat ?? 1);

describe("isPathText", () => {
  it("has shared vectors with both outcomes to check", () => {
    expect(text.vectors.some((vector) => vector.valid)).toBe(true);
    expect(text.vectors.some((vector) => !vector.valid)).toBe(true);
  });

  // The same file is asserted by vaultpath.CheckText and by CommitRevision
  // in Go.
  for (const vector of text.vectors) {
    it(`${vector.valid ? "accepts" : "rejects"} the shared vector: ${vector.name}`, () => {
      const path = textPath(vector);
      expect(isPathText(path)).toBe(vector.valid);
      // Every non-empty vector is otherwise a new path, so only the text rule decides it.
      if (path !== "") expect(isNewVaultPath(path)).toBe(true);
    });
  }

  // A JavaScript string can hold UTF-16 that is not valid Unicode, which has
  // no UTF-8 form; Go's strings (and the JSON vectors) cannot.
  it.each([
    ["a lone high surrogate", "a\ud800b.md"],
    ["a lone low surrogate", "a\udc00b.md"],
    ["a high surrogate at the end", "a.md\ud83d"],
    ["surrogates in the wrong order", "a\ude00\ud83db.md"],
  ])("rejects a path with %s", (_, path) => {
    expect(isPathText(path)).toBe(false);
  });
});

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
