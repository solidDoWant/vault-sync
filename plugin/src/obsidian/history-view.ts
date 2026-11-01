import type { HistoryEntry, RestoreError } from "../core/sync/history";
import { isolated, quotedName, shownName, shownPath, type Shown } from "./display-text";

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
 * Which user committed a revision: the display name the server reports,
 * shown and isolated as deviceLabel shows a device's, or by id when it
 * reports none.
 */
export function userLabel(entry: Pick<HistoryEntry, "userId" | "userName">): string {
  const name = shownName(entry.userName ?? "");
  if (name !== "") return quotedName(name);
  if (entry.userId === "") return "an unknown user";
  return `user ${entry.userId.slice(0, 8)}`;
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

/** The steps of relativeTime: each unit is used up to the limit, in seconds, where the next one takes over. */
const relativeSteps: { unit: Intl.RelativeTimeFormatUnit; seconds: number; until: number }[] = [
  { unit: "second", seconds: 1, until: 45 },
  { unit: "minute", seconds: 60, until: 45 * 60 },
  { unit: "hour", seconds: 60 * 60, until: 22 * 60 * 60 },
  { unit: "day", seconds: 24 * 60 * 60, until: 26 * 24 * 60 * 60 },
  { unit: "month", seconds: 30.44 * 24 * 60 * 60, until: 320 * 24 * 60 * 60 },
  { unit: "year", seconds: 365.25 * 24 * 60 * 60, until: Infinity },
];

/**
 * How long before `now` the time `date` was, for people, the way GitHub
 * shows it: "now", "30 seconds ago", "5 minutes ago", "yesterday", "3 days
 * ago", "last month", "2 years ago", in `locale` (the user's by default).
 * A time a little in the future, from a clock that runs ahead, reads "now".
 */
export function relativeTime(date: Date, now: Date, locale?: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000);
  if (seconds < 10) return format.format(0, "second");
  const step = relativeSteps.find((candidate) => seconds < candidate.until) ?? relativeSteps[relativeSteps.length - 1];
  if (step === undefined) return format.format(0, "second");
  return format.format(-Math.round(seconds / step.seconds), step.unit);
}

/** The exact date and time of `date` in the device's time zone, named, for the tooltip of a relative time. */
export function exactTime(date: Date, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}

/** A byte count for people. */
export function sizeLabel(size: bigint | number): string {
  const bytes = Number(size);
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Who committed a revision, in parts to render: plain text, another
 * person's name (`name`, shown and isolated as quotedName shows it, `device`
 * for a device's), or this device. The history shows each name in a box,
 * which marks where it starts and ends, and this device as a box another
 * person's name cannot get.
 */
export type WhoPart = { text: string } | { name: string; device?: true } | { thisDevice: true };

export function whoParts(entry: Pick<HistoryEntry, "userId" | "userName" | "deviceId" | "deviceName" | "thisDevice">): WhoPart[] {
  const parts: WhoPart[] = [];
  const userName = shownName(entry.userName ?? "");
  if (userName !== "") parts.push({ name: isolated(userName) });
  else parts.push({ text: entry.userId === "" ? "an unknown user" : `user ${entry.userId.slice(0, 8)}` });
  parts.push({ text: " via " });
  if (entry.thisDevice) {
    parts.push({ thisDevice: true });
    return parts;
  }
  const deviceName = shownName(entry.deviceName ?? "");
  if (deviceName !== "") parts.push({ name: isolated(deviceName), device: true });
  else parts.push({ text: entry.deviceId === "" ? "an unknown device" : `device ${entry.deviceId.slice(0, 8)}` });
  return parts;
}

/** A revision in the history list, in parts: when, by which user and device, and what happened. */
export interface EntryParts {
  when: string;
  who: string;
  change: Shown;
}

export function entryParts(entry: HistoryEntry, previous: HistoryEntry | undefined, formatTime: (date: Date) => string): EntryParts {
  return {
    when: entry.createdAt === undefined ? "unknown time" : formatTime(entry.createdAt),
    who: `${userLabel(entry)}, ${deviceLabel(entry)}`,
    change: changeLabel(entry, previous),
  };
}

/** One line per revision in the history list: when, by which user and device, and what happened. */
export function entryLabel(entry: HistoryEntry, previous: HistoryEntry | undefined, formatTime: (date: Date) => string): Shown {
  const { when, who, change } = entryParts(entry, previous, formatTime);
  return [`${when} · ${who} · `, ...change];
}

/**
 * What a revision changed relative to the one before it (`previous`, the next
 * older entry). The view's title and the list show where the document is,
 * so a label names a path only for a move: where the document was before.
 * Paths are another member's text: shown as visiblePath shows them (#555),
 * each laid out on its own (Shown, #605).
 */
export function changeLabel(entry: HistoryEntry, previous: HistoryEntry | undefined): Shown {
  if (entry.deleted) return ["deleted"];
  // The document's first revision, or the oldest that retention kept: the
  // server does not say which (an empty parent_rev_id means either).
  if (previous === undefined) return ["oldest kept version"];
  const from = shownPath(previous.path);
  if (previous.deleted) return previous.path === entry.path ? ["restored"] : ["restored and moved from ", from];
  if (previous.path !== entry.path) return previous.contentHash === entry.contentHash ? ["moved from ", from] : ["moved from ", from, " and edited"];
  return ["edited"];
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
    case "invalid-path": {
      const lead = failure.path === "" ? "an empty path" : failure.path;
      const problem = failure.message.startsWith(lead) ? invalidPathEnd.exec(failure.message.slice(lead.length))?.[1] : undefined;
      const because = problem === undefined ? "" : ` (${problem})`;
      return [failure.path === "" ? lead : shownPath(failure.path), ` cannot be used${because}; choose another path`];
    }
  }
}
