import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PutBlobChunkRequest } from "../../gen/vaultsync/v1/blob_pb";
import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import { DocumentKind } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import { deferMerge, type MergeHook, type MergeRequest } from "./merge";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, testDeviceId, text } from "./testing";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const decoder = new TextDecoder();

const unavailable = () => new ConnectError("connection lost", Code.Unavailable);

/** Every request of `method` the server received from now on. */
function record<T>(server: InMemoryServer, method: string): T[] {
  const requests: T[] = [];
  const previous = server.interceptor;
  server.interceptor = (called, request) => {
    previous?.(called, request);
    if (called === method) requests.push(request as T);
  };
  return requests;
}

/** A merge hook that keeps both sides: the remote content, then the local content, at the remote path. */
const concatenate: MergeHook = async (request: MergeRequest) => {
  const remote = (await request.readRemoteContent()) ?? new Uint8Array();
  const local = request.local.content ?? new Uint8Array();
  return { status: "merged", path: request.remote.path, content: bytes(`${decoder.decode(remote)}+${decoder.decode(local)}`) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncEngine push", () => {
  describe("given a local create or edit", () => {
    it("commits a new file so that the server's head holds the local content", async () => {
      const h = harness();
      await h.vault.write("notes/new.md", bytes("hello"));

      const summary = await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["notes/new.md", "hello"]]));
      expect(summary).toMatchObject({ committed: 1, conflicts: 0, pending: 0, rejected: [] });
      const [document] = await h.journal.listDocuments();
      const head = h.server.head(document?.documentId ?? "");
      expect(head).toMatchObject({ parentRevId: "", kind: DocumentKind.TEXT, deviceId: testDeviceId, deleted: false });
      expect(document).toMatchObject({ path: "notes/new.md", revisionId: head?.id, seq: head?.seq, baseHash: sha256Hex(bytes("hello")), kind: "text" });
      expect(await h.journal.listPending()).toEqual([]);
      expect(h.acknowledged.map((revision) => revision.revisionId)).toEqual([head?.id]);
    });

    it("commits an edit of a synced document against the head it was synced at", async () => {
      const h = harness();
      const base = h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("a2, edited here"));

      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "a2, edited here"]]));
      const head = h.server.head("a");
      expect(head?.parentRevId).toBe(base.id);
      expect(await h.journal.getDocument("a")).toMatchObject({ revisionId: head?.id, baseHash: sha256Hex(bytes("a2, edited here")) });
    });

    it("commits renames and deletes as revisions of the same document with its content", async () => {
      const h = harness();
      const a = h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      h.server.commit({ documentId: "b", path: "b.md", content: "b1" });
      await h.engine.pull();
      await h.vault.rename("a.md", "folder/renamed.md");
      await h.vault.delete("b.md");

      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["folder/renamed.md", "a1"]]));
      expect(h.server.head("a")).toMatchObject({ parentRevId: a.id, contentRef: a.contentRef, deleted: false });
      expect(h.server.head("b")).toMatchObject({ deleted: true });
      expect(h.server.history("a")).toHaveLength(2);
      expect(h.server.history("b")).toHaveLength(2);
    });

    it("classifies a new document by its extension", async () => {
      const h = harness();
      await h.vault.write("image.png", new Uint8Array([1, 2, 3]));
      await h.vault.write("note.md", bytes("text"));

      await h.engine.push();

      const kinds = new Map([...h.server.liveFiles().keys()].map((path) => [path, kindAt(h.server, path)]));
      expect(kinds).toEqual(new Map([["image.png", DocumentKind.BLOB], ["note.md", DocumentKind.TEXT]]));
    });

    it("commits nothing for a file rewritten with its synced content", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "same" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("same"));
      const commits = record(h.server, "CommitRevision");

      const summary = await h.engine.push();

      expect(summary.committed).toBe(0);
      expect(commits).toEqual([]);
    });

    it("keeps the operation pending and the base unchanged until the commit is acknowledged", async () => {
      const h = harness();
      const base = h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("a2"));
      const seen: unknown[] = [];
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision") return;
        // Snapshot the journal at the moment the commit reaches the server.
        seen.push(h.journal.listPending(), h.journal.getDocument("a"));
        throw new ConnectError("refused", Code.PermissionDenied);
      };

      await expect(h.engine.push()).rejects.toThrow(/refused/);

      const [pendingAtCommit, stateAtCommit] = await Promise.all(seen);
      expect(pendingAtCommit).toMatchObject([{ documentId: "a", baseRevisionId: base.id, contentHash: sha256Hex(bytes("a2")) }]);
      expect(stateAtCommit).toMatchObject({ revisionId: base.id });
      // Refused: still pending, base unchanged, nothing on the server.
      const pending = await h.journal.listPending();
      expect(pending).toHaveLength(1);
      expect(await h.journal.getDocument("a")).toMatchObject({ revisionId: base.id, baseHash: sha256Hex(bytes("a1")) });
      expect(h.server.history("a")).toHaveLength(1);
      expect(h.acknowledged).toEqual([]);

      h.server.interceptor = undefined;
      await h.engine.push();

      expect(h.server.head("a")?.id).toBe(pending[0]?.revisionId);
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.getDocument("a")).toMatchObject({ revisionId: pending[0]?.revisionId, baseHash: sha256Hex(bytes("a2")) });
    });

    it("brings a deleted document back when a file reappears at its path", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.delete("a.md");
      await h.engine.push();
      const tombstone = h.server.head("a");
      expect(tombstone?.deleted).toBe(true);
      await h.vault.write("a.md", bytes("back again"));

      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "back again"]]));
      const head = h.server.head("a");
      expect(head).toMatchObject({ deleted: false, parentRevId: tombstone?.id });
      expect(h.server.history("a")).toHaveLength(3);
      expect((await h.journal.listDocuments()).map((document) => document.documentId)).toEqual(["a"]);
    });

    it("pushes an edit made while an earlier operation of the document was pending on top of it", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("a2"));
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("refused", Code.PermissionDenied);
      };
      await expect(h.engine.push()).rejects.toThrow(/refused/);
      h.server.interceptor = undefined;
      await h.vault.write("a.md", bytes("a3"));

      await h.engine.push();

      const contents = h.server.history("a").map((revision) => decoder.decode(h.server.contentOf(revision)));
      expect(contents).toEqual(["a1", "a2", "a3"]);
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("leaves a document whose remote revision is deferred alone, so nothing local is overwritten", async () => {
      const h = harness({ merge: deferMerge });
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("local"));
      h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
      const commits = record(h.server, "CommitRevision");

      await h.engine.push();

      expect(commits).toEqual([]);
      expect(text(await h.vault.read("a.md"))).toBe("local");
      expect((await h.journal.listDeferred()).map((deferred) => deferred.reason)).toEqual(["local-changes"]);
    });
  });

  describe("given the commit response is lost", () => {
    it("retries with the same revision id, and the server holds exactly one new revision", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("a2"));
      const commits = record<CommitRevisionRequest>(h.server, "CommitRevision");
      let lost = 0;
      h.server.responseInterceptor = (method) => {
        if (method === "CommitRevision" && lost++ === 0) throw unavailable();
      };

      const summary = await h.engine.push();

      expect(commits.length).toBe(2);
      expect(commits[1]?.revisionId).toBe(commits[0]?.revisionId);
      expect(h.server.history("a")).toHaveLength(2);
      expect(h.server.head("a")?.id).toBe(commits[0]?.revisionId);
      expect(summary.committed).toBe(1);
      expect(h.acknowledged.map((revision) => revision.revisionId)).toEqual([commits[0]?.revisionId]);
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("recognizes its own revision after a restart instead of committing it again", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("a2"));
      h.server.responseInterceptor = (method) => {
        if (method === "CommitRevision") throw unavailable();
      };
      await expect(h.engine.push()).rejects.toThrow(/connection lost/);
      const [pending] = await h.journal.listPending();
      h.server.responseInterceptor = undefined;

      h.restart();
      await h.engine.push();
      // Another device commits on top of it; this device's pull must apply that.
      h.server.commit({ documentId: "a", path: "a.md", content: "a3" });
      await h.engine.pull();

      expect(h.server.history("a").map((revision) => revision.id)).toEqual([h.server.history("a")[0]?.id, pending?.revisionId, h.server.head("a")?.id]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(text(await h.vault.read("a.md"))).toBe("a3");
    });

    it("reaches the same server and journal state wherever the push is interrupted", async () => {
      const setup = async (crashing: boolean) => {
        const points = new CrashPoints();
        const h = crashing ? harness({ journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) }) : harness();
        h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
        h.server.commit({ documentId: "b", path: "b.md", content: "b1" });
        await h.engine.pull();
        await h.vault.write("a.md", bytes("a2"));
        await h.vault.rename("b.md", "b2.md");
        await h.vault.write("c.md", bytes("c1"));
        return { h, points };
      };
      const state = async (h: Awaited<ReturnType<typeof setup>>["h"]) => ({
        server: h.server.liveFiles(),
        revisions: h.server.revisionCount,
        files: await files(h.vault),
        pending: await h.journal.listPending(),
        documents: (await h.journal.listDocuments()).map((document) => [document.path, document.baseHash]).sort(),
      });
      const reference = await setup(false);
      await reference.h.engine.push();
      const expected = await state(reference.h);

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const { h, points } = await setup(true);
        points.count = 0;
        points.crashAfter = crashAfter;
        const outcome = await h.engine.push().then(
          () => "finished",
          (error: unknown) => {
            if (!(error instanceof Crash)) throw error;
            return "crashed";
          },
        );
        if (outcome === "finished") break;
        crashed++;
        points.crashAfter = 0;
        await h.engine.settled();
        h.restart();
        await h.engine.push();

        expect(await state(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      expect(crashed).toBeGreaterThanOrEqual(6);
    });
  });

  describe("given the head moved", () => {
    it("pulls the new head, merges, and commits the merge with the new head as its base", async () => {
      const h = harness({ merge: concatenate });
      const base = h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("local"));
      const commits = record<CommitRevisionRequest>(h.server, "CommitRevision");
      let moved: ReturnType<InMemoryServer["commit"]> | undefined;
      const recording = h.server.interceptor;
      h.server.interceptor = (method, request) => {
        recording?.(method, request);
        // Another device commits between this device's pull and its commit.
        if (method === "CommitRevision" && moved === undefined) moved = h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
      };

      const summary = await h.engine.push();

      expect(summary).toMatchObject({ conflicts: 1, committed: 1, pending: 0 });
      expect(commits.map((commit) => commit.baseRevId)).toEqual([base.id, moved?.id]);
      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "remote+local"]]));
      const head = h.server.head("a");
      expect(head?.parentRevId).toBe(moved?.id);
      expect(h.server.history("a").map((revision) => revision.id)).toEqual([base.id, moved?.id, head?.id]);
      expect(text(await h.vault.read("a.md"))).toBe("remote+local");
      expect(await h.journal.getDocument("a")).toMatchObject({ revisionId: head?.id, baseHash: sha256Hex(bytes("remote+local")) });
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(h.localChanges.map((event) => event.type)).toEqual(["modify"]);
    });

    it("with a deferring merge hook keeps the local edit on disk and pending, and overwrites nothing", async () => {
      const h = harness({ merge: deferMerge });
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("local"));
      let moved: ReturnType<InMemoryServer["commit"]> | undefined;
      h.server.interceptor = (method) => {
        if (method === "CommitRevision" && moved === undefined) moved = h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
      };

      const summary = await h.engine.push();
      const commits = record(h.server, "CommitRevision");
      await h.engine.push();

      expect(summary).toMatchObject({ conflicts: 1, committed: 0, pending: 1 });
      expect(text(await h.vault.read("a.md"))).toBe("local");
      expect(await h.journal.listPending()).toMatchObject([{ documentId: "a", contentHash: sha256Hex(bytes("local")) }]);
      expect(await h.journal.listDeferred()).toMatchObject([{ reason: "local-changes", revision: { revisionId: moved?.id } }]);
      expect(h.server.head("a")?.id).toBe(moved?.id);
      // Parked with the merge path: not retried against a head it cannot win.
      expect(commits).toEqual([]);
    });

    it("recovers and pushes the merge result wherever the merge is interrupted", async () => {
      // An idempotent merge (as the hook contract requires): a local side that
      // already contains the remote side is the merge result itself.
      const merge: MergeHook = async (request) => {
        const remote = decoder.decode((await request.readRemoteContent()) ?? new Uint8Array());
        const local = decoder.decode(request.local.content ?? new Uint8Array());
        const content = local.startsWith(`${remote}+`) ? local : `${remote}+${local}`;
        return { status: "merged", path: request.remote.path, content: bytes(content) };
      };
      const setup = async (points: CrashPoints | undefined) => {
        const h = points === undefined ? harness({ merge }) : harness({ merge, journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        h.server.commit({ documentId: "a", path: "a.md", content: "base" });
        await h.engine.pull();
        await h.vault.write("a.md", bytes("local"));
        let moved = false;
        h.server.interceptor = (method) => {
          if (method === "CommitRevision" && !moved) {
            moved = true;
            h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
          }
        };
        return h;
      };
      const state = async (h: Awaited<ReturnType<typeof setup>>) => ({
        server: h.server.liveFiles(),
        files: await files(h.vault),
        pending: await h.journal.listPending(),
        deferred: await h.journal.listDeferred(),
        base: (await h.journal.getDocument("a"))?.revisionId === h.server.head("a")?.id,
      });
      const reference = await setup(undefined);
      await reference.engine.push();
      const expected = await state(reference);
      expect(expected).toMatchObject({ server: new Map([["a.md", "remote+local"]]), pending: [], deferred: [], base: true });

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = await setup(points);
        points.count = 0;
        points.crashAfter = crashAfter;
        const outcome = await h.engine.push().then(
          () => "finished",
          (error: unknown) => {
            if (!(error instanceof Crash)) throw error;
            return "crashed";
          },
        );
        if (outcome === "finished") break;
        crashed++;
        points.crashAfter = 0;
        await h.engine.settled();
        h.restart();
        await h.engine.push();
        await h.engine.push();

        expect(await state(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      // Every durable change of the push was a crash point, the merged write and the rebase among them.
      expect(crashed).toBeGreaterThanOrEqual(5);
    });
  });

  describe("given an interrupted upload", () => {
    it("resumes after a restart without re-sending the chunks the server stored", async () => {
      const server = new InMemoryServer({ maxChunkBytes: 4 });
      const h = harness({ server });
      const content = "0123456789abcdefghij"; // five chunks of four bytes
      await h.vault.write("big.md", bytes(content));
      let failed = false;
      server.interceptor = (method, request) => {
        if (method === "PutBlobChunk" && (request as PutBlobChunkRequest).offset === 8n && !failed) {
          failed = true;
          throw unavailable();
        }
      };
      await expect(h.engine.push()).rejects.toThrow(/connection lost/);
      expect(server.liveFiles()).toEqual(new Map());

      h.restart();
      const chunks = record<PutBlobChunkRequest>(server, "PutBlobChunk");
      await h.engine.push();

      expect(chunks.map((chunk) => chunk.offset)).toEqual([8n, 12n, 16n]);
      expect(chunks.every((chunk) => chunk.data.length <= 4)).toBe(true);
      expect(server.liveFiles()).toEqual(new Map([["big.md", content]]));
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("skips the upload of content the server already holds", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "shared" });
      const chunks = record(h.server, "PutBlobChunk");
      const blobCommits = record(h.server, "CommitBlob");
      await h.vault.write("copy.md", bytes("shared"));

      await h.engine.push();

      expect(chunks).toEqual([]);
      expect(blobCommits).toEqual([]);
      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "shared"], ["copy.md", "shared"]]));
    });

    it("pushes the newest content when the file changed while its upload was interrupted", async () => {
      const server = new InMemoryServer({ maxChunkBytes: 4 });
      const h = harness({ server });
      await h.vault.write("a.md", bytes("first version"));
      server.interceptor = (method, request) => {
        if (method === "PutBlobChunk" && (request as PutBlobChunkRequest).offset === 4n) throw unavailable();
      };
      await expect(h.engine.push()).rejects.toThrow(/connection lost/);
      server.interceptor = undefined;
      await h.vault.write("a.md", bytes("second version"));

      h.restart();
      await h.engine.push();

      expect(server.liveFiles()).toEqual(new Map([["a.md", "second version"]]));
      expect(server.revisionCount).toBe(1);
      expect(await h.journal.listPending()).toEqual([]);
    });
  });

  describe("given rapid successive edits", () => {
    it("pushes once, after the burst, with the last edit", async () => {
      vi.useFakeTimers();
      const h = harness({ pushDebounceMs: 1000 });
      const commits = record(h.server, "CommitRevision");

      for (const version of ["v1", "v2", "v3"]) {
        await h.vault.write("a.md", bytes(version));
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.advanceTimersByTimeAsync(499);
      expect(commits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await h.engine.settled();

      expect(commits).toHaveLength(1);
      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "v3"]]));
    });

    it("pushes an edit made while a push is running with a later push", async () => {
      vi.useFakeTimers();
      const h = harness({ pushDebounceMs: 1000 });
      await h.vault.write("a.md", bytes("v1"));
      let edited = false;
      h.server.interceptor = (method) => {
        if (method === "CommitRevision" && !edited) {
          edited = true;
          void h.vault.write("a.md", bytes("v2, typed during the push"));
        }
      };

      await vi.advanceTimersByTimeAsync(1000);
      await h.engine.settled();
      await vi.advanceTimersByTimeAsync(1000);
      await h.engine.settled();

      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "v2, typed during the push"]]));
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("reports a failed automatic push and keeps its operation pending", async () => {
      vi.useFakeTimers();
      const errors: unknown[] = [];
      const h = harness({ pushDebounceMs: 1000, onPushError: (error) => errors.push(error) });
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("refused", Code.PermissionDenied);
      };
      await h.vault.write("a.md", bytes("v1"));

      await vi.advanceTimersByTimeAsync(1000);
      await h.engine.settled();

      expect(errors).toHaveLength(1);
      expect(await h.journal.listPending()).toHaveLength(1);
    });
  });
});

function kindAt(server: InMemoryServer, path: string): DocumentKind | undefined {
  for (let seq = server.currentHeadSeq; seq > 0n; seq--) {
    const revision = server.revisionAt(seq);
    if (decoder.decode(revision.path) === path) return revision.kind;
  }
  return undefined;
}

