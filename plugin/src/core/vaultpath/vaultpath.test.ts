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
      // Every non-empty vector is otherwise vault-relative, and new unless it breaks the new-path length limits.
      if (path !== "" && vector.valid) expect(isNewVaultPath(path)).toBe(vector.new);
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

/** A validity vector's path: `path` repeated `repeat` times (once if absent), then `suffix`. */
const validityPath = (vector: { path: string; repeat?: number; suffix?: string }) => vector.path.repeat(vector.repeat ?? 1) + (vector.suffix ?? "");

describe("isVaultRelativePath", () => {
  it("has shared vectors with both outcomes to check", () => {
    expect(shared.vectors.some((vector) => vector.valid)).toBe(true);
    expect(shared.vectors.some((vector) => !vector.valid)).toBe(true);
  });

  // The same file is asserted by internal/vaultpath and by CommitRevision in
  // Go, so passing here means the client accepts exactly what the server does.
  for (const vector of shared.vectors) {
    it(`${vector.valid ? "accepts" : "rejects"} the shared vector: ${vector.name}`, () => {
      expect(isVaultRelativePath(validityPath(vector))).toBe(vector.valid);
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
      expect(isNewVaultPath(validityPath(vector))).toBe(vector.new);
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
      // Every vector is otherwise a valid path, so only the normalized length decides it for a kept path.
      expect(isPathText(path)).toBe(true);
      expect(isVaultRelativePath(path)).toBe(true);
      expect(pathProblem(path, true)).toBe(vector.valid ? undefined : "too-long-normalized");
      expect(pathProblem(path) === undefined).toBe(vector.new);
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
    ["a forbidden character", "notes/a?.md", "forbidden-character"],
    ["a colon after the first character", "ab:c.md", "forbidden-character"],
    ["a leading space", " a.md", "edge-space"],
    ["a trailing space in a folder", "notes /a.md", "edge-space"],
    ["a trailing dot", "notes./a.md", "trailing-dot"],
    ["a reserved name", "com1.md", "reserved-name"],
    ["a reserved name without an extension", "notes/NUL", "reserved-name"],
    ["a name of 256 bytes", "a".repeat(256), "name-too-long"],
    ["a path of 1025 bytes", `${"a".repeat(254)}/`.repeat(4) + "abcde", "path-too-long"],
    ["a decomposed accent", "Cafe\u0301.md", "not-nfc"],
    ["a decomposed accent in a folder", "Re\u0301sume\u0301/a.md", "not-nfc"],
  ])("names %s", (_, path, problem) => {
    expect(pathProblem(path)).toBe(problem);
  });

  it("accepts a valid new path", () => {
    expect(pathProblem("notes/a.md")).toBeUndefined();
    expect(pathProblem("Caf\u00e9.md")).toBeUndefined();
    expect(pathProblem("a".repeat(255))).toBeUndefined();
    expect(pathProblem(`${"a".repeat(254)}/`.repeat(4) + "abcd")).toBeUndefined();
  });

  it("lets a live document keep a vault-relative path the new-path rule refuses", () => {
    expect(pathProblem("old\\note.md", true)).toBeUndefined();
    expect(pathProblem("1:x.md", true)).toBeUndefined();
    expect(pathProblem("CON.md", true)).toBeUndefined();
    expect(pathProblem("Cafe\u0301.md", true)).toBeUndefined();
    expect(pathProblem("a".repeat(4096), true)).toBeUndefined();
    expect(pathProblem("a\u0001b.md", true)).toBe("invalid-character");
    expect(pathProblem("../a.md", true)).toBe("not-vault-relative");
  });

  // Every shared vector: no problem exactly when the server's every rule passes.
  it("finds no problem exactly for the shared vectors every rule accepts", () => {
    for (const vector of shared.vectors) expect(pathProblem(validityPath(vector)) === undefined).toBe(vector.new);
    for (const vector of text.vectors) expect(pathProblem(textPath(vector)) === undefined).toBe(vector.new);
    for (const vector of key.vectors) expect(pathProblem(keyPath(vector)) === undefined).toBe(vector.new);
  });
});
