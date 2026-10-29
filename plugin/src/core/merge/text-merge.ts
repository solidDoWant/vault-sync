// Line-level three-way merge: the one merge both the sync engine's text
// merge (SPEC.md §7) and the Obsidian adapter's editor-safe writes (§8) use,
// so a change one refuses as overlapping the other refuses too. Pure, so
// vitest covers it directly.

import DiffMatchPatch from "diff-match-patch";

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
 * Above this many line differences between two texts, the merge reports the
 * whole differing middle as one change instead of the diff's. That is never wrong, only coarser (more merges are refused as overlapping),
 * and it bounds time and memory for large, very different notes.
 */
const maxEditDistance = 4000;

/**
 * A differing middle longer than this many lines on either side is not diffed
 * and counts as one change, like one past maxEditDistance. The diff takes time
 * proportional to the lines times their differences, and it runs on the UI
 * thread for editor writes. Being deterministic, the limit makes whether a
 * merge is clean independent of the device's speed.
 */
const maxDiffedLines = 10_000;

/**
 * Merges `remote` into `local`, both derived from `base`: the editor case,
 * where `base` is the file on disk, `local` the editor buffer with unsaved
 * keystrokes and `remote` new content to apply. Works on whole lines (each
 * with its line terminator). Returns null if a remote change touches a line
 * the local side changed too, or both insert at the same place, since then
 * one side would overwrite or reorder the other, or if applying the remote
 * changes would join two lines into one (a change right after a last line
 * without a line terminator, or one ending in such a line and followed by
 * more text). A change identical on both sides is kept once.
 */
export function mergeUnsaved(base: string, local: string, remote: string): UnsavedMerge | null {
  const localLines = splitLines(local);
  const localHunks = diffLines(base, local);
  const remoteHunks = diffLines(base, remote);
  const localOffsets = lineOffsets(localLines);
  const changes: TextChange[] = [];
  // How many lines the merged text has, if no change joins two lines.
  let lineCount = localLines.length;
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
    lineCount += hunk.lines.length - (toLine - fromLine);
  }
  const merged = applyChanges(local, changes);
  // A change next to a last line without a terminator (the local one, or one
  // the change inserts) would run two lines into one, rewriting a line of
  // either side (#750): refused like an overlap.
  if (splitLines(merged).length !== lineCount) return null;
  return { merged, changes };
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
  // Neither side converted the line endings: merged as they are, so every
  // line keeps the terminator it has (a note with mixed line endings stays
  // mixed). Falls back to comparing lines without their terminators if that
  // finds an overlap, which a terminator-only change can cause, or would join
  // two lines because one side has no final newline (#750): there the final
  // newline is merged as a field.
  if (!changedField(baseText.eol, localText.eol) && !changedField(baseText.eol, remoteText.eol)) {
    const exact = mergeUnsaved(base, local, remote);
    if (exact !== null) return exact.merged;
  }
  const merged = mergeUnsaved(baseText.lines, localText.lines, remoteText.lines);
  if (merged === null) return null;
  const eol = mergeField(baseText.eol, localText.eol, remoteText.eol) ?? "\n";
  const finalNewline = mergeField(baseText.finalNewline, localText.finalNewline, remoteText.finalNewline) === true;
  const body = finalNewline ? merged.merged : merged.merged.slice(0, -1);
  return eol === "\n" ? body : body.replaceAll("\n", eol);
}

interface AnalyzedText {
  /** Every line terminated by "\n", whatever its terminator was and whether or not the last one had one. */
  lines: string;
  /** The text's prevailing line terminator; null if it has none. */
  eol: "\n" | "\r\n" | null;
  /** Whether the text ends with a line terminator; null (unknown) for an empty text, which has no last line to end. */
  finalNewline: boolean | null;
}

/** Whether a side changed a field from the base; null (unknown) never counts as a change. */
function changedField<T>(base: T | null, side: T | null): boolean {
  return base !== null && side !== null && side !== base;
}

function analyzeText(text: string): AnalyzedText {
  if (text === "") return { lines: "", eol: null, finalNewline: null };
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

/**
 * The changed regions between two texts, line by line, in ascending order of
 * the `before` lines. The diff is diff-match-patch's, in line mode, run on
 * the differing middle between the common first and last lines.
 */
function diffLines(before: string, after: string): Hunk[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const left = beforeLines.slice(prefix, beforeLines.length - suffix);
  const right = afterLines.slice(prefix, afterLines.length - suffix);
  if (left.length === 0 && right.length === 0) return [];
  const wholeMiddle: Hunk[] = [{ baseStart: prefix, baseEnd: prefix + left.length, lines: right }];
  if (left.length > maxDiffedLines || right.length > maxDiffedLines) return wholeMiddle;

  const lineDiff = new DiffMatchPatch();
  // No time limit: the result must not depend on how fast the device is.
  lineDiff.Diff_Timeout = 0;
  const { chars1, chars2, lineArray } = lineDiff.diff_linesToChars_(left.join(""), right.join(""));
  // Every line only one side has is at least one difference, so past
  // maxEditDistance of them no diff is needed to know the answer.
  if (unmatchedLines(chars1, chars2) > maxEditDistance) return wholeMiddle;
  const diffs = lineDiff.diff_main(chars1, chars2, false);
  lineDiff.diff_charsToLines_(diffs, lineArray);

  const hunks: Hunk[] = [];
  let baseLine = prefix;
  let distance = 0;
  let open: Hunk | null = null;
  for (const [operation, text] of diffs) {
    const changed = splitLines(text);
    if (operation === DiffMatchPatch.DIFF_EQUAL) {
      if (open !== null) hunks.push(open);
      open = null;
      baseLine += changed.length;
      continue;
    }
    distance += changed.length;
    open ??= { baseStart: baseLine, baseEnd: baseLine, lines: [] };
    if (operation === DiffMatchPatch.DIFF_DELETE) {
      baseLine += changed.length;
      open.baseEnd = baseLine;
    } else {
      open.lines.push(...changed);
    }
  }
  if (open !== null) hunks.push(open);
  return distance > maxEditDistance ? wholeMiddle : hunks;
}

/** How many lines (as diff_linesToChars_ characters) one text has more of than the other, summed over all lines. */
function unmatchedLines(left: string, right: string): number {
  const counts = new Map<string, number>();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of right) counts.set(line, (counts.get(line) ?? 0) - 1);
  let unmatched = 0;
  for (const count of counts.values()) unmatched += Math.abs(count);
  return unmatched;
}
