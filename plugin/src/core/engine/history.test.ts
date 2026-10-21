import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { RestoreError, type HistoryEntry } from "./history";
import { InMemoryServer } from "./memory-server";
import { files, harness, moveHeadBeforeCommit, testDeviceId, type Harness } from "./testing";

// History browsing and restore (SPEC.md §11, #26): a document's retained
// revisions with time and device, any revision's content, and a restore that
// commits the old content as a new head revision.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value);

/** A server whose clock starts at 2026-01-01T00:00Z and moves on one minute per revision. */
function clockedServer(options: { maxHistoryPageSize?: number } = {}): { server: InMemoryServer; at: (minute: number) => Date } {
  const start = Date.UTC(2026, 0, 1);
  const at = (minute: number) => new Date(start + minute * 60_000);
  let minute = 0;
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5, ...options, now: () => at(minute++) });
  return { server, at };
}

/** Writes and pushes each version of `path` in turn; returns the document id. */
async function pushVersions(h: Harness, path: string, ...versions: string[]): Promise<string> {
  for (const version of versions) {
    await h.vault.write(path, bytes(version));
    await h.engine.push();
  }
  const document = await h.journal.findDocumentByPath(path);
  if (document === undefined) throw new Error(`no document at ${path}`);
  return document.documentId;
}

/** Every history entry of a document, newest first, across pages. */
async function allEntries(h: Harness, documentId: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  let pageToken = "";
  for (let page = 0; page < 100; page++) {
    const result = await h.engine.history(documentId, pageToken);
    entries.push(...result.entries);
    if (result.nextPageToken === "") return entries;
    pageToken = result.nextPageToken;
  }
  throw new Error("history did not end");
}

/** Records each DownloadBlob range the server returns to `h`'s engine. */
function recordDownloads(h: Harness): { ranges: { offset: bigint; length: number }[]; bytes: () => number } {
  const ranges: { offset: bigint; length: number }[] = [];
  h.server.responseInterceptor = (method, request, response) => {
    if (method === "DownloadBlob") ranges.push({ offset: (request as { offset: bigint }).offset, length: (response as { data: Uint8Array }).data.length });
  };
  return { ranges, bytes: () => ranges.reduce((total, range) => total + range.length, 0) };
}

function entryAt(entries: HistoryEntry[], index: number): HistoryEntry {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`no history entry ${String(index)}`);
  return entry;
}

describe("SyncEngine history (SPEC.md §11)", () => {
  it("lists a document's revisions newest first, with the time, device and path of each", async () => {
    const { server, at } = clockedServer();
    const h = harness({ server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n");
    server.commit({ documentId, path: "renamed.md", content: "three\n", deviceId: "phone" });
    await h.engine.pull();

    const page = await h.engine.history(documentId);

    expect(page.documentId).toBe(documentId);
    expect(page.headRevisionId).toBe(server.head(documentId)?.id);
    expect(page.nextPageToken).toBe("");
    expect(page.entries.map(({ path, deviceId, thisDevice, createdAt, deleted }) => ({ path, deviceId, thisDevice, createdAt, deleted }))).toEqual([
      { path: "renamed.md", deviceId: "phone", thisDevice: false, createdAt: at(2), deleted: false },
      { path: "plan.md", deviceId: testDeviceId, thisDevice: true, createdAt: at(1), deleted: false },
      { path: "plan.md", deviceId: testDeviceId, thisDevice: true, createdAt: at(0), deleted: false },
    ]);
    expect(page.entries.map((entry) => entry.revisionId)).toEqual(
      server
        .history(documentId)
        .map((revision) => revision.id)
        .reverse(),
    );
  });

  it("names the devices that made the revisions, as the server reports them (#420)", async () => {
    const { server } = clockedServer({ maxHistoryPageSize: 2 });
    const h = harness({ server });
    server.deviceNames.set(testDeviceId, "Laptop");
    server.deviceNames.set("phone", "Phone");
    const documentId = await pushVersions(h, "plan.md", "one\n");
    server.commit({ documentId, path: "plan.md", content: "two\n", deviceId: "phone" });
    server.commit({ documentId, path: "plan.md", content: "three\n", deviceId: "tablet" });

    const entries = await allEntries(h, documentId);

    expect(entries.map(({ deviceId, deviceName, thisDevice }) => ({ deviceId, deviceName, thisDevice }))).toEqual([
      // A device the server does not name.
      { deviceId: "tablet", deviceName: undefined, thisDevice: false },
      { deviceId: "phone", deviceName: "Phone", thisDevice: false },
      { deviceId: testDeviceId, deviceName: "Laptop", thisDevice: true },
    ]);
  });

  it("pages through a long history, newest first, every revision once", async () => {
    const { server } = clockedServer({ maxHistoryPageSize: 2 });
    const h = harness({ server });
    const documentId = await pushVersions(h, "plan.md", "1\n", "2\n", "3\n", "4\n", "5\n");

    const first = await h.engine.history(documentId);
    const entries = await allEntries(h, documentId);

    expect(first.entries).toHaveLength(2);
    expect(first.nextPageToken).not.toBe("");
    expect(entries.map((entry) => entry.revisionId)).toEqual(
      server
        .history(documentId)
        .map((revision) => revision.id)
        .reverse(),
    );
  });

  it("shows a deleted document's tombstone as the newest entry", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "gone.md", "kept in history\n");
    await h.vault.delete("gone.md");
    await h.engine.push();

    const entries = await allEntries(h, documentId);

    expect(entries.map(({ path, deleted }) => ({ path, deleted }))).toEqual([
      { path: "gone.md", deleted: true },
      { path: "gone.md", deleted: false },
    ]);
  });

  it("previews any revision's exact content", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "the first version, long enough for several ranges\n", "second\n");
    const entries = await allEntries(h, documentId);

    expect(decoder.decode(await h.engine.readRevision(entryAt(entries, 1)))).toBe("the first version, long enough for several ranges\n");
    expect(decoder.decode(await h.engine.readRevision(entryAt(entries, 0)))).toBe("second\n");
  });

  it("previews only the first bytes up to a limit of a revision larger than it, in ranges (#656)", async () => {
    const h = harness({ server: clockedServer().server });
    const content = "0123456789abcdefghij\n";
    const documentId = await pushVersions(h, "plan.md", content);
    const entry = entryAt(await allEntries(h, documentId), 0);
    const received = recordDownloads(h);

    // One byte under the revision's size: only that many bytes are downloaded.
    const limit = content.length - 1;
    const preview = await h.engine.readRevision(entry, limit);

    expect(decoder.decode(preview)).toBe(content.slice(0, limit));
    expect(received.ranges.length).toBeGreaterThan(1);
    expect(received.bytes()).toBe(limit);
    expect(received.ranges.every((range) => range.length <= limit)).toBe(true);
  });

  it("downloads and verifies the whole revision when it is no larger than the limit (#656)", async () => {
    const h = harness({ server: clockedServer().server });
    const content = "0123456789abcdefghij\n";
    const documentId = await pushVersions(h, "plan.md", content);
    const entry = entryAt(await allEntries(h, documentId), 0);
    const received = recordDownloads(h);

    expect(decoder.decode(await h.engine.readRevision(entry, content.length))).toBe(content);
    expect(received.bytes()).toBe(content.length);
    // Complete content is checked against its hash, as without a limit.
    const head = h.server.head(documentId);
    if (head === undefined) throw new Error("no head");
    h.server.corruptBlob(head, bytes(content.toUpperCase()));
    await expect(h.engine.readRevision(entry, content.length)).rejects.toThrow(/does not match its content hash/);
  });
});

describe("SyncEngine restore (SPEC.md §11)", () => {
  it("commits the old content as a new head revision based on the current head, and the disk shows it", async () => {
    const { server } = clockedServer();
    const h = harness({ server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n", "three\n");
    const before = server.history(documentId).map((revision) => revision.id);
    const localChanges = h.localChanges.length;
    const oldest = entryAt(await allEntries(h, documentId), 2);

    const restored = await h.engine.restore(oldest);

    const history = server.history(documentId);
    expect(history.map((revision) => revision.id).slice(0, 3)).toEqual(before);
    expect(history).toHaveLength(4);
    const head = history[3];
    expect(head?.id).toBe(restored.revisionId);
    expect(head?.parentRevId).toBe(before[2]);
    expect(head?.deviceId).toBe(testDeviceId);
    expect(head?.deleted).toBe(false);
    expect(bytesToHex(head?.contentRef?.blobId ?? new Uint8Array())).toBe(oldest.contentHash);
    expect(server.liveFiles()).toEqual(new Map([["plan.md", "one\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\n"]]));
    expect(await h.journal.listPending()).toEqual([]);
    expect((await h.journal.getDocument(documentId))?.revisionId).toBe(restored.revisionId);
    // The engine's own write is not taken for a user edit.
    await h.engine.settled();
    expect(h.localChanges).toHaveLength(localChanges);
  });

  it("keeps the document at its current path", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n");
    await h.vault.rename("plan.md", "moved.md");
    await h.engine.push();
    const original = entryAt(await allEntries(h, documentId), 2);

    await h.engine.restore(original);

    expect(h.server.liveFiles()).toEqual(new Map([["moved.md", "one\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["moved.md", "one\n"]]));
  });

  it("pushes unsynced local edits first, so they stay in history, never overwritten", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n");
    const oldest = entryAt(await allEntries(h, documentId), 1);
    await h.vault.write("plan.md", bytes("an edit not pushed yet\n"));

    await h.engine.restore(oldest);

    const contents = h.server.history(documentId).map((revision) => decoder.decode(h.server.contentOf(revision)));
    expect(contents).toEqual(["one\n", "two\n", "an edit not pushed yet\n", "one\n"]);
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\n"]]));
  });

  it("lands on the newest head when another device moves it during the restore, losing neither", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n");
    const oldest = entryAt(await allEntries(h, documentId), 1);
    moveHeadBeforeCommit(h, () => h.server.commit({ documentId, path: "plan.md", content: "from another device\n", deviceId: "phone" }));

    await h.engine.restore(oldest);

    const contents = h.server.history(documentId).map((revision) => decoder.decode(h.server.contentOf(revision)));
    expect(contents).toEqual(["one\n", "two\n", "from another device\n", "one\n"]);
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\n"]]));
  });

  it("uploads the previewed content again when blob garbage collection removed it", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n", "three\n");
    const oldest = entryAt(await allEntries(h, documentId), 2);
    const preview = await h.engine.readRevision(oldest);
    // Retention purges the revision, and the collector its blob, after the preview.
    h.server.purge(oldest.revisionId);
    h.server.collectBlob(oldest.contentHash);

    await h.engine.restore(oldest, preview);

    expect(h.server.hasBlob(oldest.contentHash)).toBe(true);
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "one\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\n"]]));
  });

  it("restores a revision previewed only in part from its whole content, downloaded on demand (#656)", async () => {
    const h = harness({ server: clockedServer().server });
    const content = "the first version, long enough for several ranges\n";
    const documentId = await pushVersions(h, "plan.md", content, "two\n");
    const oldest = entryAt(await allEntries(h, documentId), 1);
    const preview = await h.engine.readRevision(oldest, 8);
    // The first commit races a collection of the blob, so the restore needs the content.
    let refused = false;
    const received = recordDownloads(h);
    let beforeCommit: number | undefined;
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision") return;
      if (refused) {
        // The pull after the restore downloads the content again; only the restore's own reads count.
        beforeCommit ??= received.bytes();
        return;
      }
      refused = true;
      throw new ConnectError("content_ref is not a complete blob", Code.FailedPrecondition);
    };

    await h.engine.restore(oldest, preview);

    expect(refused).toBe(true);
    expect(beforeCommit).toBeGreaterThanOrEqual(content.length);
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", content]]));
    expect(await files(h.vault)).toEqual(new Map([["plan.md", content]]));
  });

  it("downloads the content and uploads it again when the commit finds the blob not complete", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n");
    const oldest = entryAt(await allEntries(h, documentId), 1);
    // The first commit races a collection of the blob, which then completes again.
    let refused = false;
    let probed = false;
    const methods: string[] = [];
    h.server.interceptor = (method, request) => {
      methods.push(method);
      if (method === "CommitRevision" && !refused) {
        refused = true;
        throw new ConnectError("content_ref is not a complete blob", Code.FailedPrecondition);
      }
      // The upload's look-up of the blob (a range at its end) still finds it collected.
      if (refused && !probed && method === "DownloadBlob" && (request as { offset: bigint }).offset === oldest.size) {
        probed = true;
        throw new ConnectError("blob not found", Code.NotFound);
      }
    };

    await h.engine.restore(oldest);

    expect(methods.filter((method) => method === "CommitRevision")).toHaveLength(2);
    expect(methods).toContain("DownloadBlob");
    expect(methods).toContain("BeginBlob");
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "one\n"]]));
  });

  it("reports a revision whose content neither the server nor a preview has any more, committing nothing", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n", "three\n");
    const oldest = entryAt(await allEntries(h, documentId), 2);
    h.server.purge(oldest.revisionId);
    h.server.collectBlob(oldest.contentHash);

    const failure = h.engine.restore(oldest);

    await expect(failure).rejects.toThrow(RestoreError);
    await expect(failure).rejects.toMatchObject({ reason: "unavailable" });
    expect(h.server.history(documentId)).toHaveLength(2);
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "three\n"]]));
  });

  it("ignores previewed content that does not match the revision", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "one\n", "two\n", "three\n");
    const oldest = entryAt(await allEntries(h, documentId), 2);
    h.server.purge(oldest.revisionId);
    h.server.collectBlob(oldest.contentHash);

    await expect(h.engine.restore(oldest, bytes("not what the revision held\n"))).rejects.toMatchObject({ reason: "unavailable" });
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "three\n"]]));
    expect(h.server.hasBlob(sha256Hex(bytes("not what the revision held\n")))).toBe(false);
  });
});

describe("SyncEngine deleted files (SPEC.md §11)", () => {
  it("lists deleted documents, newest delete first, and restores one at its path", async () => {
    const h = harness({ server: clockedServer().server });
    const first = await pushVersions(h, "first.md", "first, deleted early\n");
    const second = await pushVersions(h, "notes/second.md", "second, edited\n", "second, deleted later\n");
    await pushVersions(h, "alive.md", "still here\n");
    await h.vault.delete("first.md");
    await h.engine.push();
    await h.vault.delete("notes/second.md");
    await h.engine.push();

    const deleted = await h.engine.deletedDocuments();

    expect(deleted.map(({ documentId, path }) => ({ documentId, path }))).toEqual([
      { documentId: second, path: "notes/second.md" },
      { documentId: first, path: "first.md" },
    ]);

    // The tombstone holds the content at the time of the delete.
    const [tombstone] = (await h.engine.history(second)).entries;
    if (tombstone === undefined) throw new Error("no tombstone");
    expect(tombstone.deleted).toBe(true);
    await h.engine.restore(tombstone);

    expect(await files(h.vault)).toEqual(
      new Map([
        ["alive.md", "still here\n"],
        ["notes/second.md", "second, deleted later\n"],
      ]),
    );
    expect(h.server.head(second)?.deleted).toBe(false);
    expect((await h.engine.deletedDocuments()).map((document) => document.documentId)).toEqual([first]);
  });

  it("restores an earlier version of a deleted document", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "the version to bring back\n", "the last version\n");
    await h.vault.delete("plan.md");
    await h.engine.push();
    const earliest = entryAt(await allEntries(h, documentId), 2);

    await h.engine.restore(earliest);

    expect(await files(h.vault)).toEqual(new Map([["plan.md", "the version to bring back\n"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "the version to bring back\n"]]));
  });

  it("reports a deleted document whose path another document now holds, committing nothing", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "the old plan\n");
    await h.vault.delete("plan.md");
    await h.engine.push();
    // Another device creates a new document at the freed path.
    h.server.commit({ documentId: "new-plan", path: "plan.md", content: "a new plan\n", deviceId: "phone" });
    await h.engine.pull();
    const [tombstone] = (await h.engine.history(documentId)).entries;
    if (tombstone === undefined) throw new Error("no tombstone");

    const failure = h.engine.restore(tombstone);

    await expect(failure).rejects.toThrow(RestoreError);
    await expect(failure).rejects.toMatchObject({ reason: "path-taken", path: "plan.md" });
    expect(h.server.head(documentId)?.deleted).toBe(true);
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "a new plan\n"]]));
  });

  describe("at another path, when its own is taken (#420)", () => {
    /** A deleted plan.md whose path a new document of another device holds; returns the tombstone's history entry. */
    async function takenPlan(h: Harness): Promise<{ documentId: string; tombstone: HistoryEntry }> {
      const documentId = await pushVersions(h, "plan.md", "the old plan\n");
      await h.vault.delete("plan.md");
      await h.engine.push();
      h.server.commit({ documentId: "new-plan", path: "plan.md", content: "a new plan\n", deviceId: "phone" });
      await h.engine.pull();
      const tombstone = entryAt(await allEntries(h, documentId), 0);
      await expect(h.engine.restore(tombstone)).rejects.toMatchObject({ reason: "path-taken", path: "plan.md" });
      return { documentId, tombstone };
    }

    it("brings the document back at the path the user chose, leaving the other file alone", async () => {
      const h = harness({ server: clockedServer().server });
      const { documentId, tombstone } = await takenPlan(h);

      const restored = await h.engine.restore(tombstone, undefined, "plans/plan (restored).md");

      expect(restored).toMatchObject({ documentId, path: "plans/plan (restored).md", deleted: false });
      expect(h.server.head(documentId)).toMatchObject({ id: restored.revisionId, deleted: false });
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["plan.md", "a new plan\n"],
          ["plans/plan (restored).md", "the old plan\n"],
        ]),
      );
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      // The document kept its id and history: the tombstone is still there.
      expect((await allEntries(h, documentId)).map(({ path, deleted }) => ({ path, deleted }))).toEqual([
        { path: "plans/plan (restored).md", deleted: false },
        { path: "plan.md", deleted: true },
        { path: "plan.md", deleted: false },
      ]);
    });

    it("reports a chosen path that is taken too, committing nothing", async () => {
      const h = harness({ server: clockedServer().server });
      const { documentId, tombstone } = await takenPlan(h);
      h.server.commit({ documentId: "other", path: "plan 2.md", content: "another\n", deviceId: "phone" });
      await h.engine.pull();
      const revisions = h.server.revisionCount;

      const failure = h.engine.restore(tombstone, undefined, "plan 2.md");

      await expect(failure).rejects.toMatchObject({ reason: "path-taken", path: "plan 2.md" });
      expect(h.server.revisionCount).toBe(revisions);
      expect(h.server.head(documentId)?.deleted).toBe(true);
    });

    it("surfaces a viewer's PERMISSION_DENIED, committing nothing and writing nothing (#548)", async () => {
      const h = harness({ server: clockedServer().server });
      const { documentId, tombstone } = await takenPlan(h);
      const revisions = h.server.revisionCount;
      const before = await files(h.vault);
      // The server refuses every write of a viewer (SPEC.md §6.2), whatever the path.
      const writes = new Set(["BeginBlob", "PutBlobChunk", "CommitBlob", "CommitRevision"]);
      const refused: string[] = [];
      h.server.interceptor = (method) => {
        if (!writes.has(method)) return;
        refused.push(method);
        throw new ConnectError("viewers cannot change this vault", Code.PermissionDenied);
      };

      const failure = h.engine.restore(tombstone, undefined, "plans/plan (restored).md");

      await expect(failure).rejects.toMatchObject({ code: Code.PermissionDenied });
      expect(refused).toContain("CommitRevision");
      expect(h.server.revisionCount).toBe(revisions);
      expect(h.server.head(documentId)?.deleted).toBe(true);
      expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "a new plan\n"]]));
      expect(await files(h.vault)).toEqual(before);
      expect(await h.journal.listPending()).toEqual([]);
    });

    it.each([
      ["an empty path", "", undefined],
      ["a backslash path", "plans\\plan.md", undefined],
      ["a drive-like path", "1:plan.md", undefined],
      ["a name Windows cannot hold, on Windows", "con.md", "windows"],
      ["a path this vault does not sync now", ".obsidian/plan.md", undefined],
    ] as const)("refuses %s before committing anything", async (_, path, platform) => {
      const h = harness({
        server: clockedServer().server,
        ...(platform === undefined ? {} : { pathRules: { platform } }),
        wrapVault: (vault) => Object.assign(Object.create(vault) as typeof vault, { isSynced: (candidate: string) => !candidate.startsWith(".obsidian/") }),
      });
      const { documentId, tombstone } = await takenPlan(h);
      const revisions = h.server.revisionCount;

      const failure = h.engine.restore(tombstone, undefined, path);

      await expect(failure).rejects.toThrow(RestoreError);
      await expect(failure).rejects.toMatchObject({ reason: "invalid-path", path });
      expect(h.server.revisionCount).toBe(revisions);
      expect(h.server.head(documentId)?.deleted).toBe(true);
    });
  });

  it.each([
    ["a backslash path (#191)", "old\\note.md"],
    ["a drive-like path (#148)", "1:note.md"],
  ])("refuses to bring a deleted document back at %s, committing nothing, its history still readable", async (_, path) => {
    // SPEC.md §11 and §6.2 (decisions #191, #148): no document may be
    // brought back at a path that may no longer be created; the server
    // refuses the restore.
    const h = harness({ server: clockedServer().server });
    h.server.commit({ documentId: "legacy", path, content: "legacy\n" });
    await h.engine.pull();
    await h.vault.delete(path);
    await h.engine.push();
    expect(h.server.head("legacy")?.deleted).toBe(true);
    const entries = await allEntries(h, "legacy");
    const tombstone = entryAt(entries, 0);
    const revisions = h.server.revisionCount;

    const failure = h.engine.restore(tombstone);

    await expect(failure).rejects.toThrow(ConnectError);
    await expect(failure).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(h.server.revisionCount).toBe(revisions);
    expect(h.server.head("legacy")?.deleted).toBe(true);
    expect(await files(h.vault)).toEqual(new Map());
    expect(await allEntries(h, "legacy")).toEqual(entries);
    expect(decoder.decode(await h.engine.readRevision(entryAt(entries, 1)))).toBe("legacy\n");
  });

  it("does not list a document this device only released because the platform cannot hold its path", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "windows" }, server: clockedServer().server });
    h.server.commit({ documentId: "doc", path: "plan.md", content: "plan\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "doc", path: "plan?.md" });
    await h.engine.pull();

    // Released, not deleted: its base stays live (design §6.4 item 5).
    expect(await h.journal.getDocument("doc")).toMatchObject({ deleted: false, binding: null, absence: "released" });
    expect(await h.engine.deletedDocuments()).toEqual([]);
  });

  it("does not list a deleted document that a local change not yet pushed brings back", async () => {
    const h = harness({ server: clockedServer().server });
    const documentId = await pushVersions(h, "plan.md", "the old plan\n");
    // Another device deletes it: a file at its path brings it back (decision #17, PO-13).
    h.server.commit({ documentId, path: "plan.md", deleted: true });
    await h.engine.pull();
    expect((await h.engine.deletedDocuments()).map((document) => document.documentId)).toEqual([documentId]);
    // The file is written again, but the server is unreachable when the push commits it.
    await h.vault.write("plan.md", bytes("the plan, back again\n"));
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("try later", Code.Unavailable);
    };
    await expect(h.engine.push()).rejects.toThrow(/try later/);
    expect((await h.journal.listPending()).map((operation) => ({ documentId: operation.documentId, deleted: operation.deleted }))).toEqual([{ documentId, deleted: false }]);

    expect(await h.engine.deletedDocuments()).toEqual([]);
  });
});
