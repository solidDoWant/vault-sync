import { describe, expect, it } from "vitest";

import type { SkippedEntry } from "../core/sync/journal";
import { longPathWarning, SkipNotices } from "./path-notices";

function skipped(documentId: string, path: string, reason: SkippedEntry["reason"] = "path-too-long"): SkippedEntry {
  return { documentId, path, reason, size: 10 };
}

describe("long path warning", () => {
  it("is silent for a path of exactly 200 characters", () => {
    expect(longPathWarning("a".repeat(197) + ".md")).toBeUndefined();
  });

  it("warns for a path of 201 characters", () => {
    expect(longPathWarning("a".repeat(198) + ".md")).toMatch(/longer than 200 characters/);
  });

  it("counts UTF-16 code units, as Windows counts its path limit", () => {
    // 200 code points, 201 code units.
    expect(longPathWarning("😀" + "a".repeat(196) + ".md")).toMatch(/201 characters/);
  });

  it("shows hidden characters in the path it names", () => {
    expect(longPathWarning("‮" + "a".repeat(198) + ".md")).toContain("\\u202E");
  });
});

describe("skip notices", () => {
  it("names each newly skipped document once, with the reason", () => {
    const notices = new SkipNotices();
    const first = notices.fresh([skipped("one", "Long/path.md")]);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('"Long/path.md"');
    expect(first[0]).toContain("The path is too long for this device's platform.");
    expect(notices.fresh([skipped("one", "Long/path.md")])).toEqual([]);
    expect(notices.fresh([skipped("one", "Long/path.md"), skipped("two", "Other.md", "reserved-name")])).toHaveLength(1);
  });

  it("names a document again when it is skipped for another reason", () => {
    const notices = new SkipNotices();
    notices.fresh([skipped("one", "A.md", "path-too-long")]);
    expect(notices.fresh([skipped("one", "A.md", "reserved-name")])).toHaveLength(1);
  });
});
