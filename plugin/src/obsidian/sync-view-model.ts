import type { ActivityEntry } from "../core/sync/activity-log";
import type { ChangeKind } from "../core/sync/engine";
import { visiblePath } from "./display-text";
import { clockTime, statusIcon, statusText, type SyncStatus } from "./status";

// What the sync view in the right sidebar shows, worked out from the status
// and the activity log. No Obsidian import, so it is unit-tested directly;
// sync-view.ts only draws it.

/** How many rows a list in the sync view shows before it says how many more there are. */
export const viewListLimit = 100;

/** One file in a list: its path (or a stand-in), and what happens to it. */
export interface FileRow {
  /** The path as shown, a folder's ending in a slash. */
  path: string;
  /** e.g. `edited`, or `edited, also changed here: likely conflict`. */
  detail: string;
  /** An incoming change to a file that also changed here. */
  conflict: boolean;
}

export interface ActivityRow {
  /** e.g. `Uploaded`, `Connection problem`. */
  action: string;
  /** The file or folder, absent for a connection problem. */
  path?: string;
  /** The time of day. */
  time: string;
}

export interface FileList<Row> {
  rows: Row[];
  /** How many more there are than the rows shown. */
  more: number;
}

export interface SyncViewContent {
  /** The tab's icon: the status icon. */
  icon: string;
  /** The status line, as in the status bar. */
  title: string;
  /** While offline: when sync next tries to reach the server, as a time of day. */
  nextAttempt?: string;
  /** Whether to offer "Sync now": only while offline. */
  offerSyncNow: boolean;
  /** While syncing: e.g. `Receiving 40 of 312 changes`. */
  progress?: string;
  /** While syncing: the file being worked on. */
  currentFile?: string;
  pending: FileList<FileRow>;
  incoming: FileList<FileRow>;
  activity: FileList<ActivityRow>;
}

const activityActions: Record<ActivityEntry["kind"], string> = {
  uploaded: "Uploaded",
  downloaded: "Downloaded",
  "deleted-on-server": "Deleted on the server",
  "deleted-here": "Deleted here",
  conflict: "Conflict copy made",
  "connection-problem": "Connection problem",
};

/** What the sync view shows for `status` and `activity` (newest first). `formatTime` writes a time of day. */
export function syncViewContent(status: SyncStatus, activity: readonly ActivityEntry[], formatTime: (at: number) => string = clockTime): SyncViewContent {
  const offline = status.state === "offline";
  const progress = status.state === "syncing" ? status.progress : undefined;
  return {
    icon: statusIcon(status),
    title: statusText(status),
    ...(offline && status.nextAttemptAt !== undefined ? { nextAttempt: formatTime(status.nextAttemptAt) } : {}),
    offerSyncNow: offline,
    ...(progress === undefined
      ? {}
      : {
          progress: `${progress.phase === "pull" ? "Receiving" : "Sending"} ${String(progress.done)} of ${String(progress.total)} ${progress.total === 1 ? "change" : "changes"}`,
          ...(progress.path === undefined ? {} : { currentFile: visiblePath(progress.path) }),
        }),
    pending: limited((status.pendingFiles ?? []).map((change) => fileRow(change.path, change.folder, change.kind, false))),
    incoming: limited((status.incoming ?? []).map((change) => fileRow(change.path, change.folder, change.kind, change.conflict))),
    activity: limited(
      activity.map((entry) => ({
        action: activityActions[entry.kind],
        ...(entry.path === undefined ? {} : { path: `${visiblePath(entry.path)}${entry.folder === true ? "/" : ""}` }),
        time: formatTime(entry.time),
      })),
    ),
  };
}

function limited<Row>(rows: Row[]): FileList<Row> {
  return { rows: rows.slice(0, viewListLimit), more: Math.max(0, rows.length - viewListLimit) };
}

function fileRow(path: string | undefined, folder: boolean, kind: ChangeKind, conflict: boolean): FileRow {
  return {
    path: path === undefined ? "a file not yet decrypted" : `${visiblePath(path)}${folder ? "/" : ""}`,
    detail: conflict ? `${kind}, also changed here: likely conflict` : kind,
    conflict,
  };
}
