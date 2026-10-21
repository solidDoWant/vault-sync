import { describe, expect, it } from "vitest";

import { isNotFoundOsError, isUnmaterializableOsError, pathRulesFor } from "./platform-rules";

const desktop = { isWin: false, isMacOS: false, isIosApp: false, isAndroidApp: false };

describe("pathRulesFor", () => {
  it("gives each platform its rules", () => {
    expect(pathRulesFor({ ...desktop, isWin: true }, "C:\\vault")).toEqual({ platform: "windows", root: "C:\\vault" });
    expect(pathRulesFor({ ...desktop, isMacOS: true }, "/Users/a/vault")).toEqual({ platform: "macos", root: "/Users/a/vault" });
    expect(pathRulesFor({ ...desktop, isIosApp: true })).toEqual({ platform: "macos" });
    expect(pathRulesFor(desktop, "/home/a/vault")).toEqual({ platform: "posix", root: "/home/a/vault" });
  });

  it("gives Android its shared storage's rules, whose filesystem folds case (#544)", () => {
    expect(pathRulesFor({ ...desktop, isAndroidApp: true })).toEqual({ platform: "android" });
  });
});

describe("isUnmaterializableOsError", () => {
  const cases: { name: string; error: unknown; expected: boolean }[] = [
    { name: "Node's name too long", error: Object.assign(new Error("ENAMETOOLONG: name too long, open '/v/x'"), { code: "ENAMETOOLONG" }), expected: true },
    { name: "Node's invalid argument (Windows refusing a name)", error: Object.assign(new Error("EINVAL: invalid argument, open 'C:\\v\\a<b.md'"), { code: "EINVAL" }), expected: true },
    { name: "an illegal byte sequence", error: Object.assign(new Error("EILSEQ"), { code: "EILSEQ" }), expected: true },
    { name: "a Capacitor message naming the code", error: new Error("open failed: ENAMETOOLONG (File name too long)"), expected: true },
    { name: "a message without a code", error: new Error("File name too long"), expected: true },
    { name: "a missing file", error: Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }), expected: false },
    { name: "a permission error", error: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }), expected: false },
    { name: "a file that already exists", error: new Error("File already exists."), expected: false },
    { name: "a full disk", error: Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), expected: false },
    { name: "a string", error: "ENAMETOOLONG", expected: false },
    { name: "null", error: null, expected: false },
  ];
  for (const { name, error, expected } of cases) {
    it(`${expected ? "recognizes" : "does not take"} ${name}`, () => {
      expect(isUnmaterializableOsError(error)).toBe(expected);
    });
  }
});

describe("isNotFoundOsError", () => {
  const cases: { name: string; error: unknown; expected: boolean }[] = [
    { name: "Node's ENOENT (Windows refusing a name, or a missing folder)", error: Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\v\\nnn.md'"), { code: "ENOENT" }), expected: true },
    { name: "an error with only the code", error: Object.assign(new Error("open failed"), { code: "ENOENT" }), expected: true },
    { name: "a Capacitor message naming the code", error: new Error("open failed: ENOENT (No such file or directory)"), expected: true },
    { name: "a message without a code", error: new Error("No such file or directory"), expected: true },
    { name: "a name too long", error: Object.assign(new Error("ENAMETOOLONG: name too long"), { code: "ENAMETOOLONG" }), expected: false },
    { name: "a permission error", error: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }), expected: false },
    { name: "a file that already exists", error: new Error("File already exists."), expected: false },
    { name: "a string", error: "ENOENT", expected: false },
    { name: "null", error: null, expected: false },
  ];
  for (const { name, error, expected } of cases) {
    it(`${expected ? "recognizes" : "does not take"} ${name}`, () => {
      expect(isNotFoundOsError(error)).toBe(expected);
    });
  }
});
