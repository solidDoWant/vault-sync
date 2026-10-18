import { describe, expect, it } from "vitest";

import { applyChanges, mergeUnsaved } from "./text-merge";

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
