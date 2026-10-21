import type { HistoryEntry, RestoreError } from "../core/engine/history";
import { quotedName, shownName, visiblePath } from "./display-text";

// What the history views show for a revision (SPEC.md §11). No Obsidian
// import, so it is unit-tested; history-modal.ts renders it.

/** Previews longer than this many bytes show only their start. */
export const maxPreviewBytes = 256 * 1024;

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export type Preview =
  /** UTF-8 text; `truncated` if only the first maxPreviewBytes are shown. */
  | { kind: "text"; text: string; truncated: boolean }
  /** Content that is not text (not UTF-8, or containing NUL), shown by size only. */
  | { kind: "binary"; size: number };

/** How a revision's content is previewed. */
export function previewOf(content: Uint8Array): Preview {
  const truncated = content.length > maxPreviewBytes;
  let shown = truncated ? content.subarray(0, maxPreviewBytes) : content;
  // A cut through a multi-byte character is not a reason to call text binary.
  for (let trim = 0; trim < 4; trim++) {
    try {
      const text = strictDecoder.decode(shown);
      if (text.includes("\u0000")) break;
      return { kind: "text", text, truncated };
    } catch {
      if (!truncated) break;
      shown = shown.subarray(0, shown.length - 1);
    }
  }
  return { kind: "binary", size: content.length };
}

/**
 * Who committed a revision: this device, or another one by the name the
 * server reports (quoted, so another user's name cannot pass for "this
 * device"), or by id when it reports none. The name is shown as shownName
 * shows it and isolated (quotedName), so it cannot reorder, hide or end the
 * label early (#548, #557).
 */
export function deviceLabel(entry: Pick<HistoryEntry, "deviceId" | "deviceName" | "thisDevice">): string {
  if (entry.thisDevice) return "this device";
  const name = shownName(entry.deviceName ?? "");
  if (name !== "") return `device ${quotedName(name)}`;
  if (entry.deviceId === "") return "an unknown device";
  return `device ${entry.deviceId.slice(0, 8)}`;
}

/**
 * A path to suggest for restoring a document at `path` when another file
 * took that (#420): the same folder and extension, the name marked
 * `(restored)`, numbered past every path `taken` reports.
 */
export function alternativePath(path: string, taken: (path: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const candidate = (attempt: number) => `${folder}${stem} (restored${attempt === 1 ? "" : ` ${String(attempt)}`})${extension}`;
  // Bounded: past that the user edits the suggestion, and the restore still checks it.
  for (let attempt = 1; attempt < 1000; attempt++) {
    if (!taken(candidate(attempt))) return candidate(attempt);
  }
  return candidate(1000);
}

/**
 * What the "Restore at another path" field offers after a restore failed
 * with `failure` (#420, #548): a free path beside the document's own path
 * when that was taken (`typed` undefined), the user's own text, to correct,
 * when the path they typed cannot be used, and a free path beside theirs
 * when another file has taken it too.
 */
export function otherPathValue(failure: Pick<RestoreError, "reason" | "path">, typed: string | undefined, taken: (path: string) => boolean): string {
  if (typed !== undefined && failure.reason === "invalid-path") return typed;
  return alternativePath(failure.path, taken);
}

/** A byte count for people. */
export function sizeLabel(size: bigint | number): string {
  const bytes = Number(size);
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** One line per revision in the history list: when, by which device, and what happened. */
export function entryLabel(entry: HistoryEntry, previous: HistoryEntry | undefined, formatTime: (date: Date) => string): string {
  const when = entry.createdAt === undefined ? "unknown time" : formatTime(entry.createdAt);
  return `${when} · ${deviceLabel(entry)} · ${changeLabel(entry, previous)}`;
}

/**
 * What a revision changed relative to the one before it (`previous`, the next
 * older entry). Paths are another member's text: shown as visiblePath shows
 * them (#555).
 */
export function changeLabel(entry: HistoryEntry, previous: HistoryEntry | undefined): string {
  const path = visiblePath(entry.path);
  if (entry.deleted) return `deleted ${path}`;
  // The document's first revision, or the oldest that retention kept.
  if (previous === undefined) return `earliest kept version of ${path} (${sizeLabel(entry.size)})`;
  if (previous.deleted) return `restored ${path} (${sizeLabel(entry.size)})`;
  if (previous.path !== entry.path) return previous.contentHash === entry.contentHash ? `moved to ${path}` : `moved to ${path} and edited (${sizeLabel(entry.size)})`;
  return `edited (${sizeLabel(entry.size)})`;
}
