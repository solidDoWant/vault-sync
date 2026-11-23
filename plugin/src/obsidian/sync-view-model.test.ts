import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "../core/sync/activity-log";
import type { IncomingChange, PendingChange } from "../core/sync/engine";
import type { SyncStatus } from "./status";
import { syncViewContent, viewListLimit } from "./sync-view-model";

const time = (at: number) => `t${String(at)}`;

function pending(count: number): PendingChange[] {
  return Array.from({ length: count }, (_, index) => ({ documentId: `d${String(index)}`, path: `p${String(index)}.md`, kind: "edited", folder: false }));
}

describe("syncViewContent", () => {
  it("shows the status icon and line, so the tab icon follows the status", () => {
    const idle = syncViewContent({ state: "idle", conflicts: 0, pending: 0 }, [], time);
    expect(idle.icon).toBe("check-circle");
    expect(idle.title).toBe("Vault Sync: idle");
    const reconnecting = syncViewContent({ state: "reconnecting", conflicts: 0, pending: 0 }, [], time);
    expect(reconnecting.icon).toBe("wifi");
    expect(reconnecting.title).toBe("Vault Sync: reconnecting");
    expect(syncViewContent({ state: "syncing", conflicts: 0, pending: 0, incoming: [{ documentId: "d", path: "a.md", kind: "edited", folder: false, conflict: false }] }, [], time).icon).toBe(
      "download-cloud",
    );
  });

  it("says when the next attempt is while offline, and offers Sync now only then", () => {
    const offline = syncViewContent({ state: "offline", conflicts: 0, pending: 0, nextAttemptAt: 42 }, [], time);
    expect(offline.nextAttempt).toBe("t42");
    expect(offline.offerSyncNow).toBe(true);
    const unscheduled = syncViewContent({ state: "offline", conflicts: 0, pending: 0 }, [], time);
    expect(unscheduled.nextAttempt).toBeUndefined();
    expect(unscheduled.offerSyncNow).toBe(true);
    const reconnecting = syncViewContent({ state: "reconnecting", conflicts: 0, pending: 0, nextAttemptAt: 42 }, [], time);
    expect(reconnecting.nextAttempt).toBeUndefined();
    expect(reconnecting.offerSyncNow).toBe(false);
    expect(syncViewContent({ state: "idle", conflicts: 0, pending: 0 }, [], time).offerSyncNow).toBe(false);
  });

  it("shows the progress and the file being worked on while syncing", () => {
    const pull = syncViewContent({ state: "syncing", conflicts: 0, pending: 0, progress: { phase: "pull", done: 40, total: 312, path: "notes/a.md" } }, [], time);
    expect(pull.progress).toBe("Receiving 40 of 312 changes");
    expect(pull.currentFile).toBe("notes/a.md");
    const push = syncViewContent({ state: "syncing", conflicts: 0, pending: 0, progress: { phase: "push", done: 0, total: 1, path: undefined } }, [], time);
    expect(push.progress).toBe("Sending 0 of 1 change");
    expect(push.currentFile).toBeUndefined();
    const idle = syncViewContent({ state: "idle", conflicts: 0, pending: 0, progress: { phase: "pull", done: 1, total: 2, path: "a.md" } }, [], time);
    expect(idle.progress).toBeUndefined();
    expect(idle.currentFile).toBeUndefined();
  });

  it("lists the pending files with what changed", () => {
    const status: SyncStatus = {
      state: "idle",
      conflicts: 0,
      pending: 2,
      pendingFiles: [
        { documentId: "a", path: "notes/a.md", kind: "created", folder: false },
        { documentId: "b", path: "old", kind: "deleted", folder: true },
      ],
    };
    expect(syncViewContent(status, [], time).pending).toEqual({
      rows: [
        { path: "notes/a.md", detail: "created", conflict: false },
        { path: "old/", detail: "deleted", conflict: false },
      ],
      more: 0,
    });
  });

  it("lists the incoming files and marks those also changed here as likely conflicts", () => {
    const incoming: IncomingChange[] = [
      { documentId: "a", path: "a.md", kind: "renamed", folder: false, conflict: false },
      { documentId: "b", path: "b.md", kind: "edited", folder: false, conflict: true },
      { documentId: "c", path: undefined, kind: "created", folder: false, conflict: false },
    ];
    expect(syncViewContent({ state: "syncing", conflicts: 0, pending: 1, incoming }, [], time).incoming).toEqual({
      rows: [
        { path: "a.md", detail: "renamed", conflict: false },
        { path: "b.md", detail: "edited, also changed here: likely conflict", conflict: true },
        { path: "a file not yet decrypted", detail: "created", conflict: false },
      ],
      more: 0,
    });
  });

  it(`shows at most ${String(viewListLimit)} rows of a list and says how many more there are`, () => {
    const exact = syncViewContent({ state: "idle", conflicts: 0, pending: 100, pendingFiles: pending(100) }, [], time).pending;
    expect(exact.rows).toHaveLength(100);
    expect(exact.more).toBe(0);
    const over = syncViewContent({ state: "idle", conflicts: 0, pending: 101, pendingFiles: pending(101) }, [], time).pending;
    expect(over.rows).toHaveLength(100);
    expect(over.rows[99]?.path).toBe("p99.md");
    expect(over.more).toBe(1);
  });

  it("shows the activity log newest first, with the action, file and time", () => {
    const activity: ActivityEntry[] = [
      { kind: "connection-problem", time: 9 },
      { kind: "conflict", path: "a (conflict).md", time: 8 },
      { kind: "deleted-here", path: "gone", folder: true, time: 7 },
      { kind: "deleted-on-server", path: "x.md", time: 6 },
      { kind: "downloaded", path: "b.md", time: 5 },
      { kind: "uploaded", path: "c.md", time: 4 },
    ];
    expect(syncViewContent({ state: "idle", conflicts: 0, pending: 0 }, activity, time).activity).toEqual({
      rows: [
        { action: "Connection problem", time: "t9" },
        { action: "Conflict copy made", path: "a (conflict).md", time: "t8" },
        { action: "Deleted here", path: "gone/", time: "t7" },
        { action: "Deleted on the server", path: "x.md", time: "t6" },
        { action: "Downloaded", path: "b.md", time: "t5" },
        { action: "Uploaded", path: "c.md", time: "t4" },
      ],
      more: 0,
    });
  });
});
