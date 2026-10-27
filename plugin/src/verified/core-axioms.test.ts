// The axioms and the contract-only function the verified core assumes of the
// shell, beyond the path model (docs/design/verified-core.md §3.8 and §4, the
// #952 row; Contracts.dfy `ShellStep`), hold for the TypeScript
// implementations behind them (#1045). Paths.dfy's axioms are checked by
// plugin/src/core/pathkey/path-axioms.test.ts.
//
//   PathBefore, DocBefore     pathBefore, docBefore (./order.ts)
//   Merge3 (Guarantees.dfy)   mergeText (core/merge/text-merge.ts)
//
// Each `lemma {:axiom}` of plugin/verified/core/Push.dfy has exactly one
// property test named after it (scripts/path-axioms_check_test.sh fails
// `make test` otherwise). `Merge3` has no axiom: its contract is its comment,
// "the combined content, or None when the two changes touch the same lines",
// and the core's `Merge` ensures it returns `Merge3`. An axiom an
// implementation turns out to violate is a finding for the specification's
// design process, not something to patch here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mergeText } from "../core/merge/text-merge";
import { docBefore, pathBefore } from "./order";

const runs = { numRuns: 2000, seed: 1045 };

// Strings that are easy to confuse: case, NFC and NFD, ß and SS, dotted and
// dotless i, a lone surrogate, and code points past the BMP (two code units,
// which compare differently by code unit than by code point).
const hardPieces = ["a", "A", "é", "é", "ß", "SS", "ı", "I", "İ", "\uD800", "\uDFFF", "😀", "￿", "/", ".md", ""];

const piece = fc.oneof(fc.constantFrom(...hardPieces), fc.string({ unit: "binary", maxLength: 2 }));
const text = fc.array(piece, { maxLength: 4 }).map((pieces) => pieces.join(""));

// Paths and document ids drawn so that equal, prefix-related and differently
// spelled strings are common, and triples often chain.
const path = text;
const docId = fc.oneof(fc.uuid(), text);

type Before = (a: string, b: string) => boolean;

/**
 * `StrictTotal(before)` of Push.dfy: irreflexive, transitive, and any two
 * distinct values are ordered one way. Counts how often transitivity's and
 * totality's premises held so that the property cannot pass vacuously.
 */
function assertStrictTotal(before: Before, value: fc.Arbitrary<string>) {
  let chained = 0;
  let distinct = 0;
  fc.assert(
    fc.property(value, value, value, (a, b, c) => {
      if (before(a, a)) return false;
      if (before(a, b) && before(b, c)) {
        chained++;
        if (!before(a, c)) return false;
      }
      if (a !== b) {
        distinct++;
        if (!before(a, b) && !before(b, a)) return false;
      }
      return true;
    }),
    runs,
  );
  expect(chained).toBeGreaterThan(runs.numRuns / 10);
  expect(distinct).toBeGreaterThan(runs.numRuns / 10);
}

describe("order axioms (plugin/verified/core/Push.dfy)", () => {
  it("PathOrder", () => {
    assertStrictTotal(pathBefore, path);
  });

  it("DocOrder", () => {
    assertStrictTotal(docBefore, docId);
  });
});

// A note as unique lines, each ended by "\n", so that a line-level diff has
// exactly one alignment and the expected merge can be computed by hand. Each
// side, per base line, keeps it, replaces it with a line of its own, or
// deletes it, and may insert a line of its own before it (or at the end).
type LineEdit = "keep" | "replace" | "delete";

interface Side {
  edits: LineEdit[];
  inserts: boolean[];
}

const lineText = fc.string({ unit: "binary", maxLength: 6 }).map((value) => value.replace(/[\r\n]/g, ""));

const scenario = fc.integer({ min: 0, max: 8 }).chain((count) =>
  fc.record({
    base: fc.array(lineText, { minLength: count, maxLength: count }),
    local: side(count),
    remote: side(count),
  }),
);

function side(count: number): fc.Arbitrary<Side> {
  return fc.record({
    edits: fc.array(fc.constantFrom<LineEdit>("keep", "keep", "replace", "delete"), { minLength: count, maxLength: count }),
    inserts: fc.array(fc.boolean(), { minLength: count + 1, maxLength: count + 1 }),
  });
}

function baseLine(base: readonly string[], index: number): string {
  return `b${String(index)}|${base[index] ?? ""}\n`;
}

/** The text one or both sides' edits make of the base; a side's own lines are tagged with its name. */
function render(base: readonly string[], sides: ReadonlyArray<readonly [string, Side]>): string {
  let result = "";
  for (let index = 0; index <= base.length; index++) {
    for (const [name, edits] of sides) {
      if (edits.inserts[index] === true) result += `${name}+${String(index)}\n`;
    }
    if (index === base.length) break;
    const changed = sides.find(([, edits]) => edits.edits[index] !== "keep");
    if (changed === undefined) {
      result += baseLine(base, index);
    } else if (changed[1].edits[index] === "replace") {
      result += `${changed[0]}=${String(index)}\n`;
    }
  }
  return result;
}

function touched(edits: Side, index: number): boolean {
  const edit = edits.edits[index];
  return edit === "replace" || edit === "delete";
}

describe("Merge3 (plugin/verified/spec/Guarantees.dfy), as mergeText", () => {
  it("is a function of the three contents", () => {
    fc.assert(
      fc.property(text, text, text, (base, local, remote) => mergeText(base, local, remote) === mergeText(base, local, remote)),
      runs,
    );
  });

  it("takes the changed side whole when only one side changed", () => {
    fc.assert(
      fc.property(text, text, (base, changed) => mergeText(base, base, changed) === changed && mergeText(base, changed, base) === changed),
      runs,
    );
  });

  it("combines two changes that touch different lines", () => {
    let disjoint = 0;
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        const lineCount = base.length;
        for (let index = 0; index < lineCount; index++) {
          if (touched(local, index) && touched(remote, index)) return true;
        }
        for (let index = 0; index <= lineCount; index++) {
          if (local.inserts[index] === true && remote.inserts[index] === true) return true;
          // A line inserted between two lines the other side both changed
          // lands inside that side's change, so it touches it.
          if (local.inserts[index] === true && index > 0 && touched(remote, index - 1) && touched(remote, index)) return true;
          if (remote.inserts[index] === true && index > 0 && touched(local, index - 1) && touched(local, index)) return true;
        }
        disjoint++;
        const merged = mergeText(render(base, []), render(base, [["L", local]]), render(base, [["R", remote]]));
        return merged === render(base, [["L", local], ["R", remote]]);
      }),
      runs,
    );
    expect(disjoint).toBeGreaterThan(runs.numRuns / 10);
  });

  it("gives None when the two changes touch the same line differently", () => {
    let overlapping = 0;
    fc.assert(
      fc.property(scenario, ({ base, local, remote }) => {
        const lineCount = base.length;
        let same = false;
        for (let index = 0; index < lineCount; index++) {
          // A delete on both sides is the same change, and counts once.
          if (touched(local, index) && touched(remote, index) && !(local.edits[index] === "delete" && remote.edits[index] === "delete")) same = true;
        }
        if (!same) return true;
        overlapping++;
        return mergeText(render(base, []), render(base, [["L", local]]), render(base, [["R", remote]])) === null;
      }),
      runs,
    );
    expect(overlapping).toBeGreaterThan(runs.numRuns / 10);
  });
});
