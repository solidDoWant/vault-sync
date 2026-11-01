import { describe, expect, it } from "vitest";

import { diffCounts, foldUnchanged, isFold, lineDiff, matchingDocuments, revertChange, sideBySide, withWordChanges, wordDiff, type DiffLine } from "./history-diff";

describe("lineDiff", () => {
  it("numbers kept, removed and added lines in each version", () => {
    expect(lineDiff("one\ntwo\nthree\n", "one\n2\nthree\nfour\n")).toEqual([
      { kind: "same", text: "one", before: 1, after: 1 },
      { kind: "removed", text: "two", before: 2, after: undefined },
      { kind: "added", text: "2", before: undefined, after: 2 },
      { kind: "same", text: "three", before: 3, after: 3 },
      { kind: "added", text: "four", before: undefined, after: 4 },
    ]);
  });

  it("finds no change between equal texts", () => {
    const lines = lineDiff("a\nb\n", "a\nb\n");
    expect(lines.every((line) => line.kind === "same")).toBe(true);
    expect(diffCounts(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("compares from and to an empty text", () => {
    expect(lineDiff("", "new\n")).toEqual([{ kind: "added", text: "new", before: undefined, after: 1 }]);
    expect(lineDiff("old\n", "")).toEqual([{ kind: "removed", text: "old", before: 1, after: undefined }]);
  });

  it("shows lines without their CRLF endings", () => {
    expect(lineDiff("a\r\nb\r\n", "a\r\nc\r\n").map((line) => line.text)).toEqual(["a", "b", "c"]);
  });

  it("counts added and removed lines", () => {
    expect(diffCounts(lineDiff("a\nb\nc\n", "a\nx\ny\n"))).toEqual({ added: 2, removed: 2 });
  });
});

describe("sideBySide", () => {
  it("puts each removed line opposite the added line that replaced it, and kept lines on both sides", () => {
    expect(sideBySide(lineDiff("one\ntwo\nthree\n", "one\n2\nthree\n"))).toEqual([
      { left: { kind: "same", text: "one", number: 1 }, right: { kind: "same", text: "one", number: 1 } },
      { left: { kind: "removed", text: "two", number: 2 }, right: { kind: "added", text: "2", number: 2 } },
      { left: { kind: "same", text: "three", number: 3 }, right: { kind: "same", text: "three", number: 3 } },
    ]);
  });

  it("leaves a side empty where the other version has more lines", () => {
    expect(sideBySide(lineDiff("a\n", "a\nb\nc\n"))).toEqual([
      { left: { kind: "same", text: "a", number: 1 }, right: { kind: "same", text: "a", number: 1 } },
      { left: undefined, right: { kind: "added", text: "b", number: 2 } },
      { left: undefined, right: { kind: "added", text: "c", number: 3 } },
    ]);
  });
});

describe("foldUnchanged", () => {
  const lines = (text: string) => lineDiff(text.replaceAll("|", "\n"), text.replaceAll("|", "\n").replace("x", "X"));
  const unchanged = (line: DiffLine) => line.kind === "same";

  it("keeps the given number of lines around a change and folds the rest", () => {
    const text = "1|2|3|4|5|6|7|x|9|10|11|12|13|14|15|";
    const folded = foldUnchanged(lines(text), unchanged, 2);
    expect(folded.map((row) => (isFold(row) ? `fold ${String(row.fold)}` : row.text))).toEqual(["fold 5", "6", "7", "x", "X", "9", "10", "fold 5"]);
  });

  it("does not fold a single line, which takes as much room as its fold", () => {
    const text = "1|2|3|x|5|";
    const folded = foldUnchanged(lines(text), unchanged, 2);
    expect(folded.some(isFold)).toBe(false);
  });

  it("folds unchanged runs between two changes beyond the context of each", () => {
    const rows = ["c", "s", "s", "s", "s", "s", "s", "s", "c"];
    const folded = foldUnchanged(rows, (row) => row === "s", 2);
    expect(folded).toEqual(["c", "s", "s", { fold: 3 }, "s", "s", "c"]);
  });
});

describe("revertChange", () => {
  it("undoes one version's change and keeps a later change elsewhere", () => {
    const previous = "title\nfirst\nsecond\n";
    const changed = "title\nFIRST\nsecond\n";
    const current = "title\nFIRST\nsecond\nlater\n";
    expect(revertChange(changed, previous, current)).toBe("title\nfirst\nsecond\nlater\n");
  });

  it("brings back the previous text when nothing changed since", () => {
    expect(revertChange("new\n", "old\n", "new\n")).toBe("old\n");
  });

  it("refuses when a later change touches the same lines", () => {
    expect(revertChange("title\nFIRST\n", "title\nfirst\n", "title\nFIRST again\n")).toBeNull();
  });
});

describe("matchingDocuments", () => {
  const documents = [
    { documentId: "1", path: "Notes/Zebra.md", deleted: false },
    { documentId: "2", path: "Archive/old zebra.md", deleted: true },
    { documentId: "3", path: "Notes/apple.md", deleted: false },
    { documentId: "4", path: "Daily/2026-11-01.md", deleted: false },
  ];

  it("lists every document for an empty query, live ones first, each by path", () => {
    expect(matchingDocuments(documents, "  ").map((document) => document.documentId)).toEqual(["4", "3", "1", "2"]);
  });

  it("matches every word of the query anywhere in the path, ignoring case", () => {
    expect(matchingDocuments(documents, "zebra").map((document) => document.documentId)).toEqual(["1", "2"]);
    expect(matchingDocuments(documents, "notes ZEB").map((document) => document.documentId)).toEqual(["1"]);
    expect(matchingDocuments(documents, "missing")).toEqual([]);
  });
});

describe("wordDiff", () => {
  it("marks only the text appended to a line, also within its last word", () => {
    expect(wordDiff("fasfsd", "fasfsdf sadf stgest adfsa")).toEqual({
      before: [{ text: "fasfsd", changed: false }],
      after: [
        { text: "fasfsd", changed: false },
        { text: "f sadf stgest adfsa", changed: true },
      ],
    });
    expect(wordDiff("the quick fox", "the quick fox jumps over")).toEqual({
      before: [{ text: "the quick fox", changed: false }],
      after: [
        { text: "the quick fox", changed: false },
        { text: " jumps over", changed: true },
      ],
    });
  });

  it("marks a replaced word on both sides and keeps the rest", () => {
    expect(wordDiff("the quick brown fox", "the quick red fox")).toEqual({
      before: [
        { text: "the quick ", changed: false },
        { text: "brown", changed: true },
        { text: " fox", changed: false },
      ],
      after: [
        { text: "the quick ", changed: false },
        { text: "red", changed: true },
        { text: " fox", changed: false },
      ],
    });
  });

  it("keeps every character of both lines, including punctuation and other scripts", () => {
    const before = "Grüße, 世界! a_b=1";
    const after = "Grüße, 世界? a_b=2 ✓";
    const words = wordDiff(before, after);
    expect(words?.before.map((segment) => segment.text).join("")).toBe(before);
    expect(words?.after.map((segment) => segment.text).join("")).toBe(after);
  });

  it("does not compare within a very long line", () => {
    expect(wordDiff("a".repeat(10_001), "b")).toBeUndefined();
  });
});

describe("withWordChanges", () => {
  it("pairs each removed line with the added line that replaced it", () => {
    const lines = withWordChanges(lineDiff("keep\nold line\n", "keep\nold line, longer\n"));
    expect(lines.map((line) => line.segments)).toEqual([
      undefined,
      [{ text: "old line", changed: false }],
      [
        { text: "old line", changed: false },
        { text: ", longer", changed: true },
      ],
    ]);
  });

  it("leaves lines without a partner whole", () => {
    const lines = withWordChanges(lineDiff("a\n", "b\nc\n"));
    expect(lines.map((line) => [line.kind, line.text, line.segments !== undefined])).toEqual([
      ["removed", "a", true],
      ["added", "b", true],
      ["added", "c", false],
    ]);
  });

  it("carries the segments into the side-by-side rows", () => {
    const rows = sideBySide(withWordChanges(lineDiff("the red fox\n", "the blue fox\n")));
    expect(rows[0]?.left?.segments?.find((segment) => segment.changed)?.text).toBe("red");
    expect(rows[0]?.right?.segments?.find((segment) => segment.changed)?.text).toBe("blue");
  });
});
