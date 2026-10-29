import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyChanges, mergeText, mergeUnsaved } from "./text-merge";

describe("diff size limits", () => {
  const numbered = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${String(index)}`);

  it("finds a minimal edit script at exactly the maximum edit distance, and one change past it", () => {
    // A line kept in the middle splits the remote change in two at 4000
    // differences; at 4001 the whole differing middle is one change.
    const base = lines(...numbered(1000, "a"), "same", ...numbered(1000, "b"));
    expect(mergeUnsaved(base, base, lines(...numbered(1000, "x"), "same", ...numbered(1000, "y")))?.changes).toHaveLength(2);
    const longer = lines(...numbered(1000, "a"), "same", ...numbered(1001, "b"));
    expect(mergeUnsaved(longer, longer, lines(...numbered(1000, "x"), "same", ...numbered(1000, "y")))?.changes).toHaveLength(1);
  });

  it("caps the edit distance of reordered lines too", () => {
    // Reversing n distinct lines keeps one of them: 2 * (n - 1) differences, in two changes around the kept line.
    const reversed = (count: number) => {
      const base = numbered(count, "line");
      return { base: lines(...base), remote: lines(...base.reverse()) };
    };
    const atLimit = reversed(2001);
    expect(mergeUnsaved(atLimit.base, atLimit.base, atLimit.remote)?.changes).toHaveLength(2);
    const pastLimit = reversed(2002);
    expect(mergeUnsaved(pastLimit.base, pastLimit.base, pastLimit.remote)?.changes).toHaveLength(1);
  });

  it("diffs a differing middle of exactly 10,000 lines on each side, and takes one of 10,001 lines on either side as one change", () => {
    // Only the first and last lines of the middle differ, so a diff finds two changes.
    const middle = (count: number, first: string, ...last: string[]) => lines(first, ...numbered(count - 1 - last.length, "kept"), ...last);
    const changes = (base: string, remote: string) => mergeUnsaved(base, base, remote)?.changes;
    expect(changes(middle(10_000, "a", "z"), middle(10_000, "A", "Z"))).toHaveLength(2);
    expect(changes(middle(10_000, "a", "z"), middle(10_001, "A", "extra", "Z"))).toHaveLength(1);
    expect(changes(middle(10_001, "a", "extra", "z"), middle(10_000, "A", "Z"))).toHaveLength(1);
  });

  it("applies the size limit to the differing middle only, so a long note still merges", () => {
    // 20,000 lines; the remote side changed lines 100 and 5,000, the local side line 2,000 between them.
    const shared = numbered(20_000, "line");
    const edit = (text: readonly string[], index: number, value: string) => text.map((line, at) => (at === index ? value : line));
    const local = edit(shared, 2000, "typed");
    const remote = edit(edit(shared, 100, "remote 1"), 5000, "remote 2");
    expect(mergeUnsaved(lines(...shared), lines(...local), lines(...remote))?.merged).toBe(lines(...edit(remote, 2000, "typed")));
  });
});

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

describe("mergeUnsaved", () => {
  it("applies remote changes unchanged when there are no local edits", () => {
    const base = lines("a", "b", "c");
    const remote = lines("a", "B", "c", "d");
    const result = mergeUnsaved(base, base, remote);
    expect(result?.merged).toBe(remote);
  });

  it("returns no changes when remote equals base", () => {
    const base = lines("a", "b");
    const local = lines("a", "b typed");
    expect(mergeUnsaved(base, local, base)).toEqual({ merged: local, changes: [] });
  });

  it("keeps unsaved local edits next to a non-overlapping remote change", () => {
    const base = lines("title", "", "one", "two", "three", "", "end");
    const local = lines("title", "", "one", "two typed", "three", "", "end");
    const remote = lines("title changed", "", "one", "two", "three", "", "end", "appended");
    const result = mergeUnsaved(base, local, remote);
    expect(result?.merged).toBe(lines("title changed", "", "one", "two typed", "three", "", "end", "appended"));
  });

  it("reports the remote changes as offsets into the local text, leaving local lines untouched", () => {
    const base = lines("a", "b", "c");
    const local = lines("a", "b!", "c");
    const remote = lines("A", "b", "c", "d");
    const result = mergeUnsaved(base, local, remote);
    expect(result?.changes).toEqual([
      { from: 0, to: 2, insert: "A\n" },
      { from: 7, to: 7, insert: "d\n" },
    ]);
    expect(applyChanges(local, result?.changes ?? [])).toBe(lines("A", "b!", "c", "d"));
  });

  it("shifts remote changes past lines the user inserted above them", () => {
    const base = lines("a", "b", "c");
    const local = lines("new 1", "new 2", "a", "b", "c");
    const remote = lines("a", "b", "C");
    const result = mergeUnsaved(base, local, remote);
    expect(result?.merged).toBe(lines("new 1", "new 2", "a", "b", "C"));
    expect(result?.changes).toEqual([{ from: 16, to: 18, insert: "C\n" }]);
  });

  it("keeps a line the user inserted directly above a line changed remotely", () => {
    const base = lines("a", "b", "c");
    const result = mergeUnsaved(base, lines("a", "new", "b", "c"), lines("a", "B", "c"));
    expect(result?.merged).toBe(lines("a", "new", "B", "c"));
  });

  it("refuses a remote change to a line the user edited", () => {
    const base = lines("a", "b", "c");
    expect(mergeUnsaved(base, lines("a", "b local", "c"), lines("a", "b remote", "c"))).toBeNull();
  });

  it("refuses insertions at the same place on both sides", () => {
    const base = lines("a", "b");
    expect(mergeUnsaved(base, lines("a", "local", "b"), lines("a", "remote", "b"))).toBeNull();
  });

  it("refuses a remote insertion inside lines the user replaced", () => {
    const base = lines("a", "b", "c", "d");
    expect(mergeUnsaved(base, lines("a", "x", "d"), lines("a", "b", "inserted", "c", "d"))).toBeNull();
  });

  it("refuses a remote deletion of a line next to which the user typed into the same line", () => {
    const base = lines("a", "b", "c");
    expect(mergeUnsaved(base, lines("a", "b typed", "c"), lines("a", "c"))).toBeNull();
  });

  it("merges changes on adjacent lines", () => {
    const base = lines("a", "b", "c");
    const result = mergeUnsaved(base, lines("a", "b typed", "c"), lines("a", "b", "c remote"));
    expect(result?.merged).toBe(lines("a", "b typed", "c remote"));
  });

  it("keeps an identical change made on both sides once", () => {
    const base = lines("a", "b", "c");
    const both = lines("a", "same", "c");
    expect(mergeUnsaved(base, both, both)).toEqual({ merged: both, changes: [] });
  });

  it("handles a last line without a line terminator", () => {
    const base = "a\nb";
    const result = mergeUnsaved(base, "a typed\nb", "a\nb\nc");
    expect(result?.merged).toBe("a typed\nb\nc");
  });

  it("handles empty texts", () => {
    expect(mergeUnsaved("", "", "new\n")?.merged).toBe("new\n");
    expect(mergeUnsaved("", "typed", "")).toEqual({ merged: "typed", changes: [] });
    expect(mergeUnsaved("x\n", "x\n", "")?.merged).toBe("");
  });

  it("merges disjoint edits spread over a long note", () => {
    const base = Array.from({ length: 2000 }, (_, index) => `line ${String(index)}\n`);
    const local = [...base];
    const remote = [...base];
    const expected = [...base];
    for (let index = 0; index < 2000; index += 100) {
      local[index] = `local ${String(index)}\n`;
      expected[index] = `local ${String(index)}\n`;
      remote[index + 50] = `remote ${String(index + 50)}\n`;
      expected[index + 50] = `remote ${String(index + 50)}\n`;
    }
    const result = mergeUnsaved(base.join(""), local.join(""), remote.join(""));
    expect(result?.merged).toBe(expected.join(""));
    expect(result?.changes).toHaveLength(20);
  });

  it("stays correct (only coarser) when the texts differ too much for a minimal diff", () => {
    const base = Array.from({ length: 6000 }, (_, index) => `b${String(index)}\n`).join("");
    const remote = Array.from({ length: 6000 }, (_, index) => `r${String(index)}\n`).join("");
    expect(mergeUnsaved(base, base, remote)?.merged).toBe(remote);
    expect(mergeUnsaved(base, base.replace("b3000\n", "typed\n"), remote)).toBeNull();
  });
});

describe("mergeText", () => {
  const crlf = (...values: string[]) => values.map((value) => `${value}\r\n`).join("");

  it("keeps both sides of non-overlapping edits", () => {
    const base = lines("one", "two", "three", "four", "five");
    const local = lines("one", "two (local)", "three", "four", "five");
    const remote = lines("one", "two", "three", "four (remote)", "five");
    expect(mergeText(base, local, remote)).toBe(lines("one", "two (local)", "three", "four (remote)", "five"));
  });

  it("refuses overlapping edits instead of choosing a side or inserting markers", () => {
    const base = lines("one", "two", "three");
    expect(mergeText(base, lines("one", "two (local)", "three"), lines("one", "two (remote)", "three"))).toBeNull();
    expect(mergeText(base, lines("one", "local", "two", "three"), lines("one", "remote", "two", "three"))).toBeNull();
  });

  it("returns the changed side byte for byte when only one side changed", () => {
    const base = "a\r\nb\nc";
    const changed = "a\r\nB\nc";
    expect(mergeText(base, base, changed)).toBe(changed);
    expect(mergeText(base, changed, base)).toBe(changed);
    expect(mergeText(base, changed, changed)).toBe(changed);
  });

  it("does not conflict when one side only converted LF to CRLF", () => {
    const base = lines("one", "two", "three");
    const converted = crlf("one", "two", "three");
    const edited = lines("one", "two (edited)", "three");
    // The line-ending change survives, and so does the edit.
    expect(mergeText(base, converted, edited)).toBe(crlf("one", "two (edited)", "three"));
    expect(mergeText(base, edited, converted)).toBe(crlf("one", "two (edited)", "three"));
  });

  it("merges edits of a CRLF note made on an LF device", () => {
    const base = crlf("one", "two", "three");
    const local = crlf("one (local)", "two", "three");
    const remote = lines("one", "two", "three (remote)");
    expect(mergeText(base, local, remote)).toBe(lines("one (local)", "two", "three (remote)"));
  });

  it("does not conflict when one side only added or removed the trailing newline", () => {
    expect(mergeText("one\ntwo\nthree", "one\ntwo\nthree\n", "one\ntwo\nthree (remote)")).toBe("one\ntwo\nthree (remote)\n");
    expect(mergeText("one\ntwo\nthree\n", "one\ntwo\nthree", "one\ntwo\nthree (remote)\n")).toBe("one\ntwo\nthree (remote)");
    expect(mergeText("one\ntwo\nthree", "one (local)\ntwo\nthree", "one\ntwo\nthree\n")).toBe("one (local)\ntwo\nthree\n");
  });

  it("keeps a change made identically on both sides once", () => {
    const base = lines("a", "b", "c");
    expect(mergeText(base, lines("a", "B", "c", "local"), lines("remote", "a", "B", "c"))).toBe(lines("remote", "a", "B", "c", "local"));
  });

  it("merges into and out of empty notes", () => {
    expect(mergeText("", "", "new\n")).toBe("new\n");
    expect(mergeText("", "local\n", "remote\n")).toBeNull();
    expect(mergeText(lines("a", "b"), lines("a"), lines("b"))).toBe("");
  });

  it("keeps the line terminators of lines neither side touched in a note with mixed line endings", () => {
    const base = "a\r\nb\nc\r\nd\r\n";
    expect(mergeText(base, "A\r\nb\nc\r\nd\r\n", "a\r\nb\nc\r\nD\r\n")).toBe("A\r\nb\nc\r\nD\r\n");
    // An edited line keeps the terminator its side gave it.
    expect(mergeText(base, "a\r\nB\r\nc\r\nd\r\n", "a\r\nb\nc\r\nD\r\n")).toBe("a\r\nB\r\nc\r\nD\r\n");
  });

  it("still converts a mixed note whole when one side converted its line endings", () => {
    const base = "a\r\nb\nc\r\nd\r\n";
    expect(mergeText(base, lines("a", "b", "c", "d"), "a\r\nb\nc\r\nD\r\n")).toBe(lines("a", "b", "c", "D"));
  });

  it("keeps the final newline of a remote append when the local side emptied the note", () => {
    expect(mergeText(lines("a"), "", lines("a", "b"))).toBe(lines("b"));
    expect(mergeText(lines("a"), lines("a", "b"), "")).toBe(lines("b"));
    // Also when the other side converted the line endings as well.
    expect(mergeText("a\r\n", "", lines("a", "b"))).toBe(lines("b"));
  });

  it("never joins the local side's unterminated last line to a remote line appended after it (#750)", () => {
    // The local side replaced the base's line and ended without a newline; the remote side appended a line.
    expect(mergeText("base\n", "local 1\nlocal 2", "base\nremote\n")).toBe("local 1\nlocal 2\nremote");
    // The truncated large create of seed 100121.
    const local = `${"e4 line 13 587226069\n".repeat(3)}e4 lin`;
    expect(mergeText("shared content 0\n", local, "shared content 0\ne6 line 17 1290208033\n")).toBe(`${local}\ne6 line 17 1290208033`);
  });

  it("never joins the remote side's unterminated last line to a local line appended after it", () => {
    expect(mergeText("a\nb\n", "a\nb\nlocal\n", "a\nremote")).toBe("a\nremote\nlocal");
  });
});

describe("line merge properties", () => {
  // Distinct lines, so a joined line ("x1" + "y2") is never a line of any version.
  const line = fc.constantFrom("x1", "y2", "z3", "w4");
  const version = fc.record({ lines: fc.array(line, { maxLength: 6 }), finalNewline: fc.boolean() }).map(({ lines: values, finalNewline }) => {
    const text = values.join("\n");
    return finalNewline && text !== "" ? `${text}\n` : text;
  });
  const linesOf = (text: string) => text.split("\n").filter((value) => value !== "");

  it("never makes a line that is in none of the three versions (#750)", () => {
    fc.assert(
      fc.property(version, version, version, (base, local, remote) => {
        const known = new Set([...linesOf(base), ...linesOf(local), ...linesOf(remote)]);
        const merged = mergeText(base, local, remote);
        if (merged !== null) for (const value of linesOf(merged)) expect(known).toContain(value);
        const unsaved = mergeUnsaved(base, local, remote);
        if (unsaved !== null) for (const value of linesOf(unsaved.merged)) expect(known).toContain(value);
      }),
      { numRuns: 2000, seed: 750 },
    );
  });
});
