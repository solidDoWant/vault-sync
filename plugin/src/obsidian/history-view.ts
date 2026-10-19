import type { HistoryEntry } from "../core/engine/history";

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

/** Who committed a revision: this device, or another one, by id (the server does not report other devices' names). */
export function deviceLabel(entry: Pick<HistoryEntry, "deviceId" | "thisDevice">): string {
  if (entry.thisDevice) return "this device";
  if (entry.deviceId === "") return "an unknown device";
  return `device ${entry.deviceId.slice(0, 8)}`;
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

/** What a revision changed relative to the one before it (`previous`, the next older entry). */
export function changeLabel(entry: HistoryEntry, previous: HistoryEntry | undefined): string {
  if (entry.deleted) return `deleted ${entry.path}`;
  // The document's first revision, or the oldest that retention kept.
  if (previous === undefined) return `earliest kept version of ${entry.path} (${sizeLabel(entry.size)})`;
  if (previous.deleted) return `restored ${entry.path} (${sizeLabel(entry.size)})`;
  if (previous.path !== entry.path) return previous.contentHash === entry.contentHash ? `moved to ${entry.path}` : `moved to ${entry.path} and edited (${sizeLabel(entry.size)})`;
  return `edited (${sizeLabel(entry.size)})`;
}
