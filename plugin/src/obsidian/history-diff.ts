import DiffMatchPatch from "diff-match-patch";

import type { HistoryDocument } from "../core/sync/history";
import { mergeText } from "../core/merge/text-merge";

// What the history view compares, folds, reverts and searches. No Obsidian
// import, so it is unit-tested; history-modal.ts renders it.

/** One line of a line-by-line comparison of two versions of a text. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  /** The line, without its line ending. */
  text: string;
  /** Its number in the older version; undefined for an added line. */
  before: number | undefined;
  /** Its number in the newer version; undefined for a removed line. */
  after: number | undefined;
}

/** The lines of `text` without their endings; a final line ending starts no extra line. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Compares `before` with `after` line by line: what was removed, added and kept, in order. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const differ = new DiffMatchPatch();
  const { chars1, chars2, lineArray } = differ.diff_linesToChars_(before, after);
  const diffs = differ.diff_main(chars1, chars2, false);
  differ.diff_charsToLines_(diffs, lineArray);
  const lines: DiffLine[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  for (const [operation, text] of diffs) {
    for (const line of linesOf(text)) {
      if (operation === DiffMatchPatch.DIFF_EQUAL) lines.push({ kind: "same", text: line, before: beforeNumber++, after: afterNumber++ });
      else if (operation === DiffMatchPatch.DIFF_DELETE) lines.push({ kind: "removed", text: line, before: beforeNumber++, after: undefined });
      else lines.push({ kind: "added", text: line, before: undefined, after: afterNumber++ });
    }
  }
  return lines;
}

/** How many lines `lines` adds and removes. */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

/** One side of a side-by-side row: a line of one version, or nothing opposite a line the other version has alone. */
export interface SideCell {
  kind: DiffLine["kind"];
  text: string;
  number: number;
}

/** One row of a side-by-side comparison: the older version on the left, the newer on the right. */
export interface SideRow {
  left: SideCell | undefined;
  right: SideCell | undefined;
}

/**
 * `lines` as side-by-side rows: a kept line on both sides, and each run of
 * removed lines next to the run of added lines that follows it, row by row,
 * so a changed line shows opposite its new form.
 */
export function sideBySide(lines: readonly DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === "same") {
      rows.push({ left: { kind: "same", text: line.text, number: line.before ?? 0 }, right: { kind: "same", text: line.text, number: line.after ?? 0 } });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "removed") removed.push(lines[index++] as DiffLine);
    while (lines[index]?.kind === "added") added.push(lines[index++] as DiffLine);
    for (let row = 0; row < Math.max(removed.length, added.length); row++) {
      const left = removed[row];
      const right = added[row];
      rows.push({
        left: left === undefined ? undefined : { kind: "removed", text: left.text, number: left.before ?? 0 },
        right: right === undefined ? undefined : { kind: "added", text: right.text, number: right.after ?? 0 },
      });
    }
  }
  return rows;
}

/** A run of unchanged rows left out of a comparison, shown as one line that can be expanded. */
export interface Fold {
  fold: number;
}

/**
 * `rows` with each run of unchanged rows longer than `context` lines on both
 * sides of a change replaced by a Fold, so a long note shows its changes and
 * `context` lines around each. Unchanged rows at the start and end keep only
 * the `context` lines next to a change.
 */
export function foldUnchanged<Row>(rows: readonly Row[], unchanged: (row: Row) => boolean, context = 3): (Row | Fold)[] {
  const folded: (Row | Fold)[] = [];
  let index = 0;
  while (index < rows.length) {
    if (!unchanged(rows[index] as Row)) {
      folded.push(rows[index] as Row);
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && unchanged(rows[end] as Row)) end++;
    const keepBefore = index === 0 ? 0 : context;
    const keepAfter = end === rows.length ? 0 : context;
    const hidden = end - index - keepBefore - keepAfter;
    if (hidden <= 1) {
      folded.push(...rows.slice(index, end));
    } else {
      folded.push(...rows.slice(index, index + keepBefore), { fold: hidden }, ...rows.slice(end - keepAfter, end));
    }
    index = end;
  }
  return folded;
}

export function isFold(row: unknown): row is Fold {
  return typeof row === "object" && row !== null && "fold" in row;
}

/**
 * The text `current` with the change that turned `previous` into `changed`
 * undone, keeping every later change: a three-way merge with `changed` as the
 * base, as sync merges two devices' edits. Null when a later change touches
 * the same lines, so the change cannot be undone on its own.
 */
export function revertChange(changed: string, previous: string, current: string): string | null {
  return mergeText(changed, current, previous);
}

/**
 * The documents whose path contains every word of `query`, ignoring case:
 * live documents first, then deleted ones, each by path.
 */
export function matchingDocuments(documents: readonly HistoryDocument[], query: string): HistoryDocument[] {
  const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
  return documents
    .filter((document) => {
      const path = document.path.toLowerCase();
      return words.every((word) => path.includes(word));
    })
    .sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.path.localeCompare(b.path));
}
