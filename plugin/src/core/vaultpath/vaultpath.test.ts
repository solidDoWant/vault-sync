import { describe, expect, it } from "vitest";

import key from "../../../../testdata/paths/key.json";
import text from "../../../../testdata/paths/text.json";
import shared from "../../../../testdata/paths/validity.json";
import { fitsPathKeyLimit, isNewVaultPath, isPathText, isVaultRelativePath, pathProblem, type PathProblem } from "./vaultpath";

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

/** A key vector's path: `path` repeated `repeat` times, then `suffix` repeated `suffixRepeat` times. */
const keyPath = (vector: { path: string; repeat?: number; suffix?: string; suffixRepeat?: number }) =>
  vector.path.repeat(vector.repeat ?? 1) + (vector.suffix ?? "").repeat(vector.suffixRepeat ?? 1);

describe("fitsPathKeyLimit", () => {
  it("has shared vectors with both outcomes to check", () => {
    expect(key.vectors.some((vector) => vector.valid)).toBe(true);
    expect(key.vectors.some((vector) => !vector.valid)).toBe(true);
  });

  // The same file is asserted by CommitRevision in Go
  // (internal/server/path_integration_test.go).
  for (const vector of key.vectors) {
    it(`${vector.valid ? "accepts" : "rejects"} the shared vector: ${vector.name}`, () => {
      const path = keyPath(vector);
      expect(fitsPathKeyLimit(path)).toBe(vector.valid);
      // Every vector is otherwise a valid new path, so only the normalized length decides it.
      expect(isPathText(path)).toBe(true);
      expect(isNewVaultPath(path)).toBe(true);
      expect(pathProblem(path)).toBe(vector.valid ? undefined : "too-long-normalized");
    });
  }
});

describe("pathProblem", () => {
  it.each<[string, string, PathProblem]>([
    ["an empty path", "", "empty"],
    ["a path of 4097 bytes", "a".repeat(4097), "too-long"],
    ["a control character", "a\u0001b.md", "invalid-character"],
    ["a newline", "a\nb.md", "invalid-character"],
    ["a lone surrogate", "a\ud800b.md", "invalid-character"],
    ["a dot-dot segment", "../a.md", "not-vault-relative"],
    ["a segment of dots and spaces", "a/.. /b.md", "not-vault-relative"],
    ["a leading separator", "/a.md", "not-vault-relative"],
    ["a drive letter", "C:a.md", "not-vault-relative"],
    ["a backslash", "a\\b.md", "backslash"],
    ["one character and a colon", "1:x.md", "drive-prefix"],
  ])("names %s", (_, path, problem) => {
    expect(pathProblem(path)).toBe(problem);
  });

  it("accepts a valid new path", () => {
    expect(pathProblem("notes/a.md")).toBeUndefined();
    expect(pathProblem("a".repeat(4096))).toBeUndefined();
  });

  it("lets a live document keep a vault-relative path the new-path rule refuses", () => {
    expect(pathProblem("old\\note.md", true)).toBeUndefined();
    expect(pathProblem("1:x.md", true)).toBeUndefined();
    expect(pathProblem("a\u0001b.md", true)).toBe("invalid-character");
    expect(pathProblem("../a.md", true)).toBe("not-vault-relative");
  });

  // Every shared vector: no problem exactly when the server's every rule passes.
  it("finds no problem exactly for the shared vectors every rule accepts", () => {
    for (const vector of shared.vectors) expect(pathProblem(vector.path) === undefined).toBe(vector.new);
    for (const vector of text.vectors) expect(pathProblem(textPath(vector)) === undefined).toBe(vector.valid);
    for (const vector of key.vectors) expect(pathProblem(keyPath(vector)) === undefined).toBe(vector.valid);
  });
});
