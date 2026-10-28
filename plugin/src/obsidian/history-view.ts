import type { HistoryEntry, RestoreError } from "../core/engine/history";
import { quotedName, shownName, shownPath, type Shown } from "./display-text";

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

/**
 * How a revision's content is previewed. `content` may be only the start of
 * a revision of `size` bytes (#656); the preview needs no more than
 * maxPreviewBytes of it.
 */
export function previewOf(content: Uint8Array, size = content.length): Preview {
  const truncated = size > maxPreviewBytes;
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
  return { kind: "binary", size };
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
export function entryLabel(entry: HistoryEntry, previous: HistoryEntry | undefined, formatTime: (date: Date) => string): Shown {
  const when = entry.createdAt === undefined ? "unknown time" : formatTime(entry.createdAt);
  return [`${when} · ${deviceLabel(entry)} · `, ...changeLabel(entry, previous)];
}

/**
 * What a revision changed relative to the one before it (`previous`, the next
 * older entry). Paths are another member's text: shown as visiblePath shows
 * them (#555), each laid out on its own (Shown, #605).
 */
export function changeLabel(entry: HistoryEntry, previous: HistoryEntry | undefined): Shown {
  const path = shownPath(entry.path);
  if (entry.deleted) return ["deleted ", path];
  // The document's first revision, or the oldest that retention kept.
  if (previous === undefined) return ["earliest kept version of ", path, ` (${sizeLabel(entry.size)})`];
  if (previous.deleted) return ["restored ", path, ` (${sizeLabel(entry.size)})`];
  if (previous.path !== entry.path) return previous.contentHash === entry.contentHash ? ["moved to ", path] : ["moved to ", path, ` and edited (${sizeLabel(entry.size)})`];
  return [`edited (${sizeLabel(entry.size)})`];
}

/** The history view's title for the document at `path`. */
export function historyTitle(path: string): Shown {
  return ["History of ", shownPath(path)];
}

/** What the engine's RestoreError says after the path when the path cannot be used: `<path> cannot be used (<problem>); choose another path`. */
const invalidPathEnd = /^ cannot be used \(([^()]*)\); choose another path$/u;

/**
 * Why a restore failed, for the notice (#605). The engine's message holds
 * the path as it is, and the path can be another member's, so the text is
 * built here from the failure's reason and path, the path shown as
 * visiblePath shows it and laid out on its own. The reason a path cannot be
 * used is a code (pathProblem, unmaterializableReason, "not synced"), taken
 * from the message when it has the engine's form.
 */
export function restoreFailureText(failure: Pick<RestoreError, "reason" | "path" | "message">): Shown {
  switch (failure.reason) {
    case "path-taken":
      return ["another file is at ", shownPath(failure.path), " now; move it away or restore at another path"];
    case "unavailable":
      return ["this version is no longer stored on the server"];
    case "too-large":
      return ["this version is no longer stored completely on the server, and it is larger than this device can download"];
    case "invalid-path": {
      const lead = failure.path === "" ? "an empty path" : failure.path;
      const problem = failure.message.startsWith(lead) ? invalidPathEnd.exec(failure.message.slice(lead.length))?.[1] : undefined;
      const because = problem === undefined ? "" : ` (${problem})`;
      return [failure.path === "" ? lead : shownPath(failure.path), ` cannot be used${because}; choose another path`];
    }
  }
}
