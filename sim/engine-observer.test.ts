import { describe, expect, it } from "vitest";

import { harnessAliases, notificationSeq } from "./engine-observer";

describe("notificationSeq", () => {
  it("chooses a plain pull, a pull gated on the announced head, and one gated on an earlier head (#277)", () => {
    const head = 20n;
    const kinds = new Set<string>();
    for (let arg = 0; arg < 64; arg++) {
      const seq = notificationSeq(arg, head);
      if (seq === undefined) kinds.add("plain");
      else if (seq === head) kinds.add("head");
      else {
        expect(seq).toBeLessThan(head);
        expect(seq).toBeGreaterThanOrEqual(0n);
        kinds.add("earlier");
      }
    }
    expect(kinds).toEqual(new Set(["plain", "head", "earlier"]));
  });

  it("never announces a seq below zero or past the head", () => {
    for (let arg = 0; arg < 64; arg++) {
      for (const head of [0n, 1n, 2n]) {
        const seq = notificationSeq(arg, head);
        if (seq !== undefined) {
          expect(seq).toBeGreaterThanOrEqual(0n);
          expect(seq).toBeLessThanOrEqual(head);
        }
      }
    }
  });

  it("depends only on the step's argument and the head, so a replay pulls the same way", () => {
    for (let arg = 0; arg < 64; arg++) expect(notificationSeq(arg, 33n)).toEqual(notificationSeq(arg, 33n));
  });
});

describe("harnessAliases", () => {
  it("finds live paths that are one file with a path under the filesystem's name but two under the path key (#736)", () => {
    const live = ["ı.md", "I.md", "a.md", "I/x.md"];
    expect(harnessAliases("ı.md", live, "windows")).toEqual(["I.md"]);
    expect(harnessAliases("ı.md", live, "macos")).toEqual(["I.md"]);
    // A file whose name is one with another document's folder.
    expect(harnessAliases("ı", ["ı", "I/x.md"], "windows")).toEqual(["I/x.md"]);
    expect(harnessAliases("ı.md", live, "posix")).toEqual([]);
  });

  it("does not take two spellings with one path key for aliases", () => {
    expect(harnessAliases("Straße.md", ["Straße.md", "STRASSE.md", "straße.md"], "windows")).toEqual([]);
  });
});
