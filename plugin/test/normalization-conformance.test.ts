import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { nfc, nfd } from "../src/core/pathkey/normalize";
import { NORMALIZATION_UNICODE_VERSION } from "../src/core/pathkey/normalization-table";

// The Unicode normalization conformance suite of the pinned Unicode version.
// internal/pathkey (Go) runs the same file, so both languages normalize every
// listed sequence identically, whatever Unicode version the engine has.
const suite = gunzipSync(readFileSync(fileURLToPath(new URL(`../../testdata/paths/NormalizationTest-${NORMALIZATION_UNICODE_VERSION}.txt.gz`, import.meta.url)))).toString("utf8");

function parseSequence(field: string): string {
  return String.fromCodePoint(...field.trim().split(/\s+/).map((hex) => Number.parseInt(hex, 16)));
}

describe("canonical normalization", () => {
  it("passes the Unicode normalization conformance suite", () => {
    const listedInPart1 = new Set<number>();
    let part = "";
    let cases = 0;
    const failures: string[] = [];
    suite.split("\n").forEach((rawLine, index) => {
      const text = rawLine.split("#")[0] ?? "";
      if (text.startsWith("@")) {
        part = text.trim();
        return;
      }
      if (text.trim() === "") return;
      const columns = text.split(";").slice(0, 5).map(parseSequence);
      const [c1 = "", c2 = "", c3 = "", c4 = "", c5 = ""] = columns;
      if (part === "@Part1") listedInPart1.add(c1.codePointAt(0) ?? 0);
      for (const [label, actual, expected] of [
        ["NFD(c1)", nfd(c1), c3],
        ["NFD(c2)", nfd(c2), c3],
        ["NFD(c3)", nfd(c3), c3],
        ["NFD(c4)", nfd(c4), c5],
        ["NFD(c5)", nfd(c5), c5],
        ["NFC(c1)", nfc(c1), c2],
        ["NFC(c2)", nfc(c2), c2],
        ["NFC(c3)", nfc(c3), c2],
        ["NFC(c4)", nfc(c4), c4],
        ["NFC(c5)", nfc(c5), c4],
      ] as const) {
        if (actual !== expected) failures.push(`line ${String(index + 1)}: ${label}`);
      }
      cases++;
    });
    expect(cases).toBeGreaterThan(10000);
    expect(failures.slice(0, 20)).toEqual([]);

    // Every code point not listed in part 1 is unchanged by both forms.
    const changed: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || listedInPart1.has(codePoint)) continue;
      const char = String.fromCodePoint(codePoint);
      if (nfd(char) !== char || nfc(char) !== char) changed.push(codePoint.toString(16));
    }
    expect(changed.slice(0, 20)).toEqual([]);
  });

  it("normalizes a path longer than the argument limit of String.fromCodePoint", () => {
    expect(nfc("é".repeat(200_000))).toBe("é".repeat(200_000));
  });

  it("canonically orders a run of combining marks longer than the call argument limit", () => {
    // U+0316 (class 220) and U+0301 (class 230) alternate in one run of 300,000 non-starters.
    const marks = 150_000;
    const text = "a" + "\u0316\u0301".repeat(marks);
    expect(nfd(text)).toBe("a" + "\u0316".repeat(marks) + "\u0301".repeat(marks));
    // The first U+0301 is not blocked by the lower-class U+0316 marks, so it composes with "a".
    expect(nfc(text)).toBe("\u00e1" + "\u0316".repeat(marks) + "\u0301".repeat(marks - 1));
  });

  it("composes a Hangul LV syllable with a trailing jamo only from U+11A8", () => {
    // U+11A7 is T_BASE itself, one below the first trailing consonant: it must not compose.
    expect(nfc("\uac00\u11a7")).toBe("\uac00\u11a7");
    expect(nfc("\uac00\u11a8")).toBe("\uac01");
  });
});
