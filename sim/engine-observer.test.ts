import { describe, expect, it } from "vitest";

import { checkLiveDocuments, harnessAliases, notificationSeq } from "./engine-observer";

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

describe("checkLiveDocuments with an F-alias group (#736, #749)", () => {
  // ı.md and I.md: two live documents, one file on Windows and macOS.
  const heads = new Map([
    ["I.md", "upper-hash"],
    ["ı.md", "dotless-hash"],
  ]);
  const invariants = (files: [string, string][], unmaterializable: [string, string][]) =>
    checkLiveDocuments({ name: "e0", platform: "windows", heads, files: new Map(files), unmaterializable: new Map(unmaterializable) }).map((violation) => violation.invariant);

  it("raises nothing when the device holds one alias with its head content and reports the other", () => {
    expect(invariants([["I.md", "upper-hash"]], [["ı.md", "alias"]])).toEqual([]);
    expect(invariants([["ı.md", "dotless-hash"]], [["I.md", "alias"]])).toEqual([]);
  });

  it("raises engine-convergence when the device holds none of the group", () => {
    expect(invariants([], [["ı.md", "alias"], ["I.md", "alias"]])).toEqual(["engine-convergence", "engine-convergence"]);
    // The one file holds content neither document has.
    expect(invariants([["I.md", "other-hash"]], [["ı.md", "alias"], ["I.md", "alias"]])).toEqual(["engine-convergence", "engine-convergence"]);
  });

  it("raises engine-unmaterializable when the device reports the alias it holds", () => {
    expect(invariants([["I.md", "upper-hash"]], [["ı.md", "alias"], ["I.md", "alias"]])).toEqual(["engine-unmaterializable"]);
  });

  it("raises engine-unmaterializable when the device does not report the alias it is missing", () => {
    expect(invariants([["I.md", "upper-hash"]], [])).toEqual(["engine-unmaterializable"]);
  });

  it("expects both documents held on posix, where they are two files", () => {
    const upper: [string, string] = ["I.md", "upper-hash"];
    expect(checkLiveDocuments({ name: "e0", platform: "posix", heads, files: new Map([upper, ["ı.md", "dotless-hash"]]), unmaterializable: new Map() })).toEqual([]);
    expect(checkLiveDocuments({ name: "e0", platform: "posix", heads, files: new Map([upper]), unmaterializable: new Map([["ı.md", "alias"]]) }).map((violation) => violation.invariant).sort()).toEqual(["engine-convergence", "engine-unmaterializable"]);
  });
});
