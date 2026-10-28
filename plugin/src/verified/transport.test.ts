import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../core/hash";
import { InMemoryServer } from "../core/engine/memory-server";
import { createProtocolClient } from "../core/protocol/client";
import { emptyJournal, type CoreJournal, type CoreOutbox } from "./journal-store";
import { CoreTransport, ShellSync, type CommitRequest, type FeedEntry, type PushResult, type SyncCore } from "./transport";

const encoder = new TextEncoder();

/**
 * A stand-in for the core's sync steps that records what the shell hands it
 * and keeps a journal the way the core does for these cases: a step moves
 * the cursor to the last entry it read (with that entry's anchor), and an
 * accepted commit becomes the row's base, moving the cursor only when it is
 * the next position (SPEC.md §6.1, #261). It is not the component under
 * test; the transport and ShellSync are.
 */
class RecordingCore implements SyncCore {
  current: CoreJournal = emptyJournal();
  readonly calls: string[] = [];
  /** Commits the next round or resync requests. */
  queued: CommitRequest[] = [];

  journal(): CoreJournal {
    return this.current;
  }

  round(entries: FeedEntry[]): Promise<CommitRequest[]> {
    this.calls.push(`round ${entries.map((entry) => entry.revision.id).join(",")}`);
    for (const entry of entries) this.read(entry);
    return Promise.resolve(this.take());
  }

  resync(feed: FeedEntry[]): Promise<CommitRequest[]> {
    this.calls.push(`resync ${String(feed.length)}`);
    this.current = { ...this.current, documents: {}, cursor: 0n, anchor: null };
    for (const entry of feed) this.read(entry);
    return Promise.resolve(this.take());
  }

  remote(entry: FeedEntry): Promise<void> {
    this.calls.push(`remote ${entry.revision.id}`);
    this.read(entry);
    return Promise.resolve();
  }

  pushed(request: CommitRequest, result: PushResult): Promise<void> {
    this.calls.push(`pushed ${request.doc} ${result.kind}`);
    if (result.kind === "accepted") {
      const { revision, anchor } = result.entry;
      this.setBase(request.doc, revision);
      if (revision.position === this.current.cursor + 1n) this.current = { ...this.current, cursor: revision.position, anchor };
    }
    return Promise.resolve();
  }

  private read(entry: FeedEntry): void {
    this.setBase(entry.revision.doc, entry.revision);
    this.current = { ...this.current, cursor: entry.revision.position, anchor: entry.anchor };
  }

  private setBase(doc: string, revision: FeedEntry["revision"]): void {
    const { id: rev, position, path, content, kind, deleted } = revision;
    this.current = {
      ...this.current,
      documents: { ...this.current.documents, [doc]: { base: { rev, position, path, content, kind, deleted }, ahead: null, binding: null, absence: "never", outbox: null } },
    };
  }

  private take(): CommitRequest[] {
    const queued = this.queued;
    this.queued = [];
    return queued;
  }
}

function outbox(rev: string, path: string, content: string, baseRev: string | null = null): CoreOutbox {
  return { rev, baseRev, path, content: sha256Hex(encoder.encode(content)), kind: "note", deleted: false, sealed: true, rejected: false };
}

interface Setup {
  server: InMemoryServer;
  core: RecordingCore;
  shell: ShellSync;
  transport: CoreTransport;
  /** Contents the vault holds, by hash, for uploads. */
  contents: Map<string, Uint8Array>;
}

function setup(pageSize = 0): Setup {
  const server = new InMemoryServer({ maxPageSize: 2 });
  const api = createProtocolClient({ transport: server.transport });
  const contents = new Map<string, Uint8Array>();
  const transport = new CoreTransport({
    api,
    vaultId: server.vaultId,
    deviceId: "device-a",
    pageSize,
    readContent: (_doc, out) => Promise.resolve(contents.get(out.content) ?? null),
  });
  const core = new RecordingCore();
  return { server, core, shell: new ShellSync(core, transport), transport, contents };
}

/** Queues a commit of `content` at `path` for the core's next round, with the content in the vault. */
function queue(s: Setup, doc: string, rev: string, path: string, content: string, baseRev: string | null = null): void {
  s.contents.set(sha256Hex(encoder.encode(content)), encoder.encode(content));
  s.core.queued.push({ doc, outbox: outbox(rev, path, content, baseRev) });
}

function other(s: Setup, doc: string, content: string): void {
  s.server.commit({ documentId: doc, path: `${doc}.md`, content, deviceId: "device-b" });
}

describe("the verified core's transport", () => {
  it("hands a round every revision after the cursor, in feed order, across pages", async () => {
    const s = setup();
    for (const doc of ["a", "b", "c", "d", "e"]) other(s, doc, `${doc}1`);
    await s.shell.round();
    other(s, "f", "f1");
    other(s, "a", "a2");
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBeNull();
    expect(s.core.calls).toEqual([
      `round ${[1n, 2n, 3n, 4n, 5n].map((seq) => s.server.revisionAt(seq).id).join(",")}`,
      `round ${s.server.revisionAt(6n).id},${s.server.revisionAt(7n).id}`,
    ]);
    expect(s.core.journal().cursor).toBe(7n);
  });

  it("commits an outbox and reports the accepted revision with its position and anchor", async () => {
    const s = setup();
    queue(s, "a", "rev-a1", "a.md", "hello");
    const outcome = await s.shell.round();

    expect(outcome.results).toHaveLength(1);
    const result = outcome.results[0];
    if (result?.kind !== "accepted") throw new Error(`expected accepted, got ${String(result?.kind)}`);
    const stored = s.server.revisionAt(1n);
    expect(result.entry.revision).toMatchObject({ id: "rev-a1", doc: "a", position: 1n, path: "a.md", content: sha256Hex(encoder.encode("hello")), kind: "note", deleted: false, device: "device-a" });
    expect(result.entry.anchor).toEqual(stored.anchor);
    expect(s.server.contentOf(stored)).toEqual(encoder.encode("hello"));
  });

  it("reports each refusal as its push result", async () => {
    const s = setup();
    other(s, "x", "x1");
    await s.shell.round();
    other(s, "x", "x2"); // the head moves past the base the commit names
    queue(s, "x", "rev-x", "x.md", "mine", s.server.revisionAt(1n).id);
    queue(s, "y", "rev-y", "x.md", "taken path");
    queue(s, "z", "rev-z", "../outside.md", "bad path");
    s.server.interceptor = (method, request) => {
      if (method === "CommitRevision" && (request as { documentId: string }).documentId === "w") throw new ConnectError("down", Code.Unavailable);
    };
    queue(s, "w", "rev-w", "w.md", "w1");
    // The round pulls x2 first; the commit of x still names x1.
    const outcome = await s.shell.round();

    expect(outcome.results.map((result) => result.kind)).toEqual(["head-moved", "already-exists", "invalid-argument", "unavailable"]);
  });

  it("delivers revisions outside a round to the core one by one", async () => {
    const s = setup();
    other(s, "a", "a1");
    other(s, "b", "b1");
    await s.shell.pullRemote();
    expect(s.core.calls).toEqual([`remote ${s.server.revisionAt(1n).id}`, `remote ${s.server.revisionAt(2n).id}`]);
  });
});

describe("divergence detection (ShellRun)", () => {
  /** A device synced to seq 3 of another device's revisions. */
  async function syncedToThree(s: Setup): Promise<void> {
    for (const doc of ["a", "b", "c"]) other(s, doc, `${doc}1`);
    await s.shell.round();
    expect(s.core.journal().cursor).toBe(3n);
    s.core.calls.length = 0;
  }

  it("resyncs instead of a round when a restore put the head below the cursor", async () => {
    const s = setup();
    await syncedToThree(s);
    s.server.restoreTo(1n);
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("head-below-cursor");
    expect(s.core.calls).toEqual(["resync 1"]);
  });

  it("resyncs a cursor stored without an anchor when the head is below it", async () => {
    const s = setup();
    await syncedToThree(s);
    s.core.current = { ...s.core.current, anchor: null };
    s.server.restoreTo(2n);
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("head-below-cursor");
    expect(s.core.calls).toEqual(["resync 2"]);
  });

  it("resyncs when the feed was cut below the cursor and grew back past it", async () => {
    const s = setup();
    await syncedToThree(s);
    s.server.restoreTo(1n);
    other(s, "d", "d1");
    other(s, "e", "e1");
    other(s, "f", "f1");
    expect(s.server.currentHeadSeq).toBe(4n);
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("anchor");
    expect(s.core.calls).toEqual(["resync 4"]);
  });

  it("resyncs when the feed was restored between two pages of one pull", async () => {
    const s = setup();
    await syncedToThree(s);
    for (const doc of ["d", "e", "f"]) other(s, doc, `${doc}1`);
    let pages = 0;
    s.server.interceptor = (method) => {
      if (method !== "ListChanges" || ++pages !== 2) return;
      // After the first page (seq 4 and 5): restored to seq 4, grown back past 5.
      s.server.restoreTo(4n);
      other(s, "g", "g1");
      other(s, "h", "h1");
    };
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("anchor");
    expect(s.core.calls).toEqual(["resync 6"]);
  });

  it("resyncs before a diverged device takes a revision outside a round", async () => {
    const s = setup();
    await syncedToThree(s);
    s.server.restoreTo(2n);
    other(s, "d", "d1");
    other(s, "e", "e1");
    const outcome = await s.shell.pullRemote();

    expect(outcome.resynced).toBe("anchor");
    expect(s.core.calls).toEqual(["resync 4"]);
  });

  it("resyncs only once: the round after the resync pulls as usual", async () => {
    const s = setup();
    await syncedToThree(s);
    s.server.restoreTo(1n);
    other(s, "d", "d1");
    other(s, "e", "e1");
    other(s, "f", "f1");
    await s.shell.round();
    other(s, "g", "g1");
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBeNull();
    expect(s.core.calls).toEqual(["resync 4", `round ${s.server.revisionAt(5n).id}`]);
  });

  it("runs no resync for a device that only lags the restored feed", async () => {
    const s = setup();
    other(s, "a", "a1");
    await s.shell.round();
    other(s, "b", "b1");
    other(s, "c", "c1");
    s.core.calls.length = 0;
    // Restored to seq 2: the device's cursor (1) and everything it names are still there.
    s.server.restoreTo(2n);
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBeNull();
    expect(s.core.calls).toEqual([`round ${s.server.revisionAt(2n).id}`]);
  });

  /** A device at cursor 1 whose own commit is accepted at seq 3, above another device's seq 2 it has not pulled. */
  async function ownCommitAboveCursor(s: Setup): Promise<void> {
    other(s, "a", "a1");
    await s.shell.round();
    s.server.interceptor = (method) => {
      if (method === "CommitRevision" && s.server.currentHeadSeq === 1n) other(s, "b", "b1");
    };
    queue(s, "m", "rev-mine", "mine.md", "mine");
    // The round pulls nothing new; seq 2 lands while its commit is in flight.
    await s.shell.round();
    s.server.interceptor = undefined;
    expect(s.core.journal().cursor).toBe(1n);
    expect(s.core.journal().documents.m?.base?.position).toBe(3n);
    s.core.calls.length = 0;
  }

  it("resyncs when a restore lost the device's own commit above its cursor", async () => {
    const s = setup();
    await ownCommitAboveCursor(s);
    s.server.restoreTo(2n);
    other(s, "c", "c1"); // seq 3 again, another revision
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("named-revision-lost");
    expect(s.core.calls).toEqual(["resync 3"]);
  });

  it("resyncs when a restore put the head below the device's own commit above its cursor", async () => {
    const s = setup();
    await ownCommitAboveCursor(s);
    s.server.restoreTo(2n);
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBe("named-revision-lost");
    expect(s.core.calls).toEqual(["resync 2"]);
  });

  it("keeps pulling when the device's own commit above its cursor is still on the feed", async () => {
    const s = setup();
    await ownCommitAboveCursor(s);
    other(s, "c", "c1");
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBeNull();
    expect(s.core.calls).toEqual([`round ${[2n, 3n, 4n].map((seq) => s.server.revisionAt(seq).id).join(",")}`]);
  });
  it("runs no resync when retention purged the device's own commit above its cursor", async () => {
    const s = setup();
    await ownCommitAboveCursor(s);
    s.server.commit({ documentId: "m", path: "mine.md", content: "edited elsewhere", deviceId: "device-b" }); // seq 4
    s.server.purge("rev-mine");
    const outcome = await s.shell.round();

    expect(outcome.resynced).toBeNull();
    expect(s.core.calls).toEqual([`round ${[2n, 4n].map((seq) => s.server.revisionAt(seq).id).join(",")}`]);
  });
});
