import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device, encryptedServer } from "./testing";
import type { IncomingChange, SyncEngineOptions, SyncProgress } from "./engine";

/** What an observer saw at one `onActivity` call. */
interface Seen {
  incoming: IncomingChange[];
  progress: SyncProgress | undefined;
}

/** A device whose engine records every activity it reports. */
function observed(server: InMemoryServer, deviceId: string, pageSize = 0, options: Partial<SyncEngineOptions> = {}): { device: Device; seen: Seen[] } {
  const seen: Seen[] = [];
  const device: Device = new Device(server, deviceId, {
    ...options,
    pageSize,
    onActivity: () => {
      seen.push({ incoming: device.engine.incoming(), progress: device.engine.progress() });
    },
  });
  return { device, seen };
}

/** The progress values seen, each change once. */
function progressSeen(seen: Seen[]): SyncProgress[] {
  const all: SyncProgress[] = [];
  for (const { progress } of seen) {
    if (progress === undefined) continue;
    const last = all.at(-1);
    if (last !== undefined && JSON.stringify(last) === JSON.stringify(progress)) continue;
    all.push(progress);
  }
  return all;
}

function failCommits(server: InMemoryServer): void {
  server.interceptor = (method) => {
    if (method === "CommitRevision") throw new Error("offline");
  };
}

describe("pending local changes", () => {
  it("lists each document waiting to be pushed with its path and kind", async () => {
    const server = new InMemoryServer();
    const { device: a } = observed(server, "device-a");
    await a.write("edited.md", "one");
    await a.write("moved.md", "two");
    await a.write("gone.md", "three");
    await a.sync();
    expect(await a.engine.pendingChanges()).toEqual([]);

    await a.write("new.md", "four");
    await a.write("edited.md", "one, edited");
    await a.vault.rename("moved.md", "folder/moved.md");
    await a.vault.delete("gone.md");
    failCommits(server);
    await expect(a.sync()).rejects.toThrow();

    const pending = await a.engine.pendingChanges();
    expect([...pending].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      expect.objectContaining({ path: "edited.md", kind: "edited", folder: false }),
      expect.objectContaining({ path: "folder", kind: "created", folder: true }),
      expect.objectContaining({ path: "folder/moved.md", kind: "renamed", folder: false }),
      expect.objectContaining({ path: "gone.md", kind: "deleted", folder: false }),
      expect.objectContaining({ path: "new.md", kind: "created", folder: false }),
    ]);

    server.interceptor = undefined;
    await a.sync();
    expect(await a.engine.pendingChanges()).toEqual([]);
  });

  it("reports a new file that was edited again before its push as created, at its latest path", async () => {
    const server = new InMemoryServer();
    const { device: a } = observed(server, "device-a");
    failCommits(server);
    // Watching the vault, so the rename is seen as one.
    await a.engine.start();
    await a.write("draft.md", "one");
    await expect(a.sync()).rejects.toThrow();
    await a.write("draft.md", "two");
    await a.vault.rename("draft.md", "final.md");
    await expect(a.sync()).rejects.toThrow();
    a.engine.stop();
    expect(await a.engine.pendingChanges()).toEqual([expect.objectContaining({ path: "final.md", kind: "created" })]);
  });
});

describe("incoming remote changes", () => {
  it("reports the changes learned page by page, with kinds, and marks those also changed locally", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "doc-edit", path: "edit.md", content: "base\n" });
    server.commit({ documentId: "doc-move", path: "move.md", content: "move" });
    server.commit({ documentId: "doc-gone", path: "gone.md", content: "gone" });
    const { device: b, seen } = observed(server, "device-b", 2);
    await b.sync();

    await b.write("edit.md", "base\nlocal\n");
    server.commit({ documentId: "doc-edit", path: "edit.md", content: "remote\nbase\n" });
    server.commit({ documentId: "doc-new", path: "new.md", content: "new" });
    server.commit({ documentId: "doc-move", path: "moved.md", content: "move" });
    server.commit({ documentId: "doc-gone", path: "gone.md", deleted: true });
    seen.length = 0;
    await b.sync();

    // The first page (two changes) is reported before any of it is applied.
    expect(seen).toContainEqual({
      incoming: [
        { documentId: "doc-edit", path: "edit.md", kind: "edited", folder: false, conflict: true },
        { documentId: "doc-new", path: "new.md", kind: "created", folder: false, conflict: false },
      ],
      progress: { phase: "pull", done: 0, total: 2, path: undefined },
    });
    // The second page adds to the total; the applied changes have left the list.
    expect(seen).toContainEqual({
      incoming: [
        { documentId: "doc-move", path: "moved.md", kind: "renamed", folder: false, conflict: false },
        { documentId: "doc-gone", path: "gone.md", kind: "deleted", folder: false, conflict: false },
      ],
      progress: { phase: "pull", done: 2, total: 4, path: undefined },
    });
    expect(b.engine.incoming()).toEqual([]);
    expect(b.engine.progress()).toBeUndefined();
    // The sync itself is unchanged: the edits merged, and the remote changes applied.
    expect(await b.files()).toEqual({ "edit.md": "remote\nbase\nlocal\n", "moved.md": "move", "new.md": "new" });
  });

  it("does not list a tombstone of a document this device never had", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    const created = server.commit({ documentId: "doc-2", path: "b.md", content: "two" });
    server.commit({ documentId: "doc-2", path: "b.md", deleted: true });
    server.purge(created.id);
    const { device: b, seen } = observed(server, "device-b");
    await b.sync();
    expect(seen).toContainEqual({
      incoming: [{ documentId: "doc-1", path: "a.md", kind: "created", folder: false, conflict: false }],
      progress: { phase: "pull", done: 0, total: 2, path: undefined },
    });
  });
});

describe("incoming remote changes in an encrypted vault", () => {
  it("lists the paths of a page before its revisions are decrypted", async () => {
    const { server, keys } = encryptedServer();
    const a = new Device(server, "device-a", { keys });
    await a.write("x.md", "one");
    await a.write("y.md", "two");
    await a.sync();
    const { device: b, seen } = observed(server, "device-b", 0, { keys });
    await b.sync();
    expect(seen).toContainEqual({
      incoming: [
        expect.objectContaining({ path: "x.md", kind: "created", conflict: false }),
        expect.objectContaining({ path: "y.md", kind: "created", conflict: false }),
      ],
      progress: { phase: "pull", done: 0, total: 2, path: undefined },
    });
    expect(await b.files()).toEqual({ "x.md": "one", "y.md": "two" });
  });
});

describe("progress", () => {
  it("reports a pull as changes done out of the total, with the path being applied", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    server.commit({ documentId: "doc-2", path: "b.md", content: "two" });
    server.commit({ documentId: "doc-3", path: "c.md", content: "three" });
    const { device: b, seen } = observed(server, "device-b");
    await b.sync();
    const progress = progressSeen(seen);
    expect(progress).toEqual([
      { phase: "pull", done: 0, total: 3, path: undefined },
      { phase: "pull", done: 0, total: 3, path: "a.md" },
      { phase: "pull", done: 1, total: 3, path: "b.md" },
      { phase: "pull", done: 2, total: 3, path: "c.md" },
      { phase: "pull", done: 3, total: 3, path: undefined },
    ]);
    expect(b.engine.progress()).toBeUndefined();
  });

  it("reports a push as operations done out of the total, with the path being pushed", async () => {
    const server = new InMemoryServer();
    const { device: a, seen } = observed(server, "device-a");
    await a.write("a.md", "one");
    await a.write("b.md", "two");
    await a.write("c.md", "three");
    await a.sync();
    const pushed = progressSeen(seen).filter((entry) => entry.phase === "push");
    expect(pushed).toEqual([
      { phase: "push", done: 0, total: 3, path: "a.md" },
      { phase: "push", done: 1, total: 3, path: "b.md" },
      { phase: "push", done: 2, total: 3, path: "c.md" },
      { phase: "push", done: 3, total: 3, path: undefined },
    ]);
    expect(a.engine.progress()).toBeUndefined();
    expect(server.liveFiles()).toEqual(new Map([["a.md", "one"], ["b.md", "two"], ["c.md", "three"]]));
  });
});
