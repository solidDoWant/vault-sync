// Line-level three-way merge: the one merge both the sync engine's text
// merge (SPEC.md §7) and the Obsidian adapter's editor-safe writes (§8) use,
// so a change one refuses as overlapping the other refuses too. Pure, so
// vitest covers it directly.

/** A replacement of `local[from, to)` by `insert`, in character offsets of the local text. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface UnsavedMerge {
  /** The local text with the remote changes applied. */
  merged: string;
  /**
   * The remote changes, in ascending, non-overlapping offsets of the local
   * text. Applying them all at once to the local text yields `merged`.
   */
  changes: TextChange[];
}

/** A changed region: lines [baseStart, baseEnd) of the base became `lines`. */
interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/**
 * Above this many differences between two texts, diff stops searching for a
 * minimal edit script and reports the whole differing middle as one change.
 * That is never wrong, only coarser (more merges are refused as overlapping),
 * and it bounds time and memory for large, very different notes.
 */
const maxEditDistance = 4000;

/**
 * Merges `remote` into `local`, both derived from `base`: the editor case,
 * where `base` is the file on disk, `local` the editor buffer with unsaved
 * keystrokes and `remote` new content to apply. Works on whole lines (each
 * with its line terminator). Returns null if a remote change touches a line
 * the local side changed too, or both insert at the same place, since then
 * one side would overwrite or reorder the other. A change identical on both
 * sides is kept once.
 */
export function mergeUnsaved(base: string, local: string, remote: string): UnsavedMerge | null {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const localHunks = diffLines(baseLines, localLines);
  const remoteHunks = diffLines(baseLines, splitLines(remote));
  const localOffsets = lineOffsets(localLines);
  const changes: TextChange[] = [];
  for (const hunk of remoteHunks) {
    if (localHunks.some((other) => sameChange(hunk, other))) continue;
    if (localHunks.some((other) => overlaps(hunk, other))) return null;
    // The hunk's base lines are untouched locally; shift them by the local
    // hunks that end at or before it (a local insertion right where the
    // remote hunk starts stays before it).
    let shift = 0;
    for (const other of localHunks) {
      if (other.baseEnd <= hunk.baseStart) shift += other.lines.length - (other.baseEnd - other.baseStart);
    }
    const fromLine = hunk.baseStart + shift;
    const toLine = hunk.baseEnd + shift;
    changes.push({ from: offsetAt(localOffsets, fromLine), to: offsetAt(localOffsets, toLine), insert: hunk.lines.join("") });
  }
  return { merged: applyChanges(local, changes), changes };
}

/**
 * Three-way merge of two concurrent versions of a text document (SPEC.md §7):
 * the merged text, or null if the edits overlap (a line changed on both sides,
 * or both sides inserted at the same place), in which case the caller keeps
 * both versions whole. Never produces conflict markers.
 *
 * If only one side changed, that side is returned byte for byte. Otherwise
 * lines are compared without their terminators, so a side that only converted
 * line endings (CRLF and LF) or only added or removed the final newline does
 * not conflict with an edit on the other side. The line-ending style and the
 * final newline are each merged as one field: a side that changed it from the
 * base wins, the local side first.
 */
export function mergeText(base: string, local: string, remote: string): string | null {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const [baseText, localText, remoteText] = [base, local, remote].map(analyzeText) as [AnalyzedText, AnalyzedText, AnalyzedText];
  const merged = mergeUnsaved(baseText.lines, localText.lines, remoteText.lines);
  if (merged === null) return null;
  const eol = mergeField(baseText.eol, localText.eol, remoteText.eol) ?? "\n";
  const finalNewline = mergeField(baseText.finalNewline, localText.finalNewline, remoteText.finalNewline);
  const body = finalNewline ? merged.merged : merged.merged.slice(0, -1);
  return eol === "\n" ? body : body.replaceAll("\n", eol);
}

interface AnalyzedText {
  /** Every line terminated by "\n", whatever its terminator was and whether or not the last one had one. */
  lines: string;
  /** The text's prevailing line terminator; null if it has none. */
  eol: "\n" | "\r\n" | null;
  finalNewline: boolean;
}

function analyzeText(text: string): AnalyzedText {
  if (text === "") return { lines: "", eol: null, finalNewline: false };
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  return {
    lines: lines.map((line) => `${line}\n`).join(""),
    eol: crlf === 0 && lf === 0 ? null : crlf > lf ? "\r\n" : "\n",
    finalNewline,
  };
}

/** Three-way merge of one field: the side that changed it wins, local first; null (unknown) never counts as a change. */
function mergeField<T>(base: T | null, local: T | null, remote: T | null): T | null {
  if (local !== null && local !== base && base !== null) return local;
  if (remote !== null && remote !== base && base !== null) return remote;
  return base ?? local ?? remote;
}

/** Applies ascending, non-overlapping changes to `text`. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let result = "";
  let position = 0;
  for (const change of changes) {
    result += text.slice(position, change.from) + change.insert;
    position = change.to;
  }
  return result + text.slice(position);
}

function isInsertion(hunk: Hunk): boolean {
  return hunk.baseStart === hunk.baseEnd;
}

function sameChange(left: Hunk, right: Hunk): boolean {
  return left.baseStart === right.baseStart && left.baseEnd === right.baseEnd && left.lines.join("") === right.lines.join("");
}

function overlaps(left: Hunk, right: Hunk): boolean {
  if (isInsertion(left) && isInsertion(right)) return left.baseStart === right.baseStart;
  if (isInsertion(left)) return right.baseStart < left.baseStart && left.baseStart < right.baseEnd;
  if (isInsertion(right)) return left.baseStart < right.baseStart && right.baseStart < left.baseEnd;
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd;
}

/** Splits text into lines, each keeping its terminator ("\n"); the last may have none. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

/** offsets[i] is the character offset of line i; offsets[lines.length] is the text length. */
function lineOffsets(lines: readonly string[]): number[] {
  const offsets = [0];
  let total = 0;
  for (const line of lines) {
    total += line.length;
    offsets.push(total);
  }
  return offsets;
}

function offsetAt(offsets: readonly number[], line: number): number {
  const offset = offsets[line];
  if (offset === undefined) throw new RangeError(`line ${String(line)} is outside the text`);
  return offset;
}

/** The changed regions between two line arrays (Myers' O(ND) diff), in ascending order. */
function diffLines(before: readonly string[], after: readonly string[]): Hunk[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const left = before.slice(prefix, before.length - suffix);
  const right = after.slice(prefix, after.length - suffix);
  if (left.length === 0 && right.length === 0) return [];

  const script = editScript(left, right);
  if (script === null) return [{ baseStart: prefix, baseEnd: prefix + left.length, lines: right }];

  // Group consecutive non-equal steps into hunks.
  const hunks: Hunk[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let open: Hunk | null = null;
  for (const step of script) {
    if (step === "equal") {
      if (open !== null) hunks.push(open);
      open = null;
      leftIndex++;
      rightIndex++;
      continue;
    }
    open ??= { baseStart: prefix + leftIndex, baseEnd: prefix + leftIndex, lines: [] };
    if (step === "delete") {
      leftIndex++;
      open.baseEnd = prefix + leftIndex;
    } else {
      open.lines.push(right[rightIndex] ?? "");
      rightIndex++;
    }
  }
  if (open !== null) hunks.push(open);
  return hunks;
}

type Step = "equal" | "delete" | "insert";

/** A shortest edit script from `left` to `right`, or null if it needs more than maxEditDistance steps. */
function editScript(left: readonly string[], right: readonly string[]): Step[] | null {
  const n = left.length;
  const m = right.length;
  const max = Math.min(n + m, maxEditDistance);
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let distance = 0; distance <= max; distance++) {
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && at(frontier, offset + diagonal - 1) < at(frontier, offset + diagonal + 1));
      let x = down ? at(frontier, offset + diagonal + 1) : at(frontier, offset + diagonal - 1) + 1;
      let y = x - diagonal;
      while (x < n && y < m && left[x] === right[y]) {
        x++;
        y++;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const frontier = trace[distance];
    if (frontier === undefined) break;
    const diagonal = x - y;
    const down = diagonal === -distance || (diagonal !== distance && at(frontier, offset + diagonal - 1) < at(frontier, offset + diagonal + 1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = at(frontier, offset + previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      steps.push("equal");
      x--;
      y--;
    }
    steps.push(down ? "insert" : "delete");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    steps.push("equal");
    x--;
    y--;
  }
  return steps.reverse();
}

function at(array: Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw new RangeError(`index ${String(index)} is outside the diff frontier`);
  return value;
}
