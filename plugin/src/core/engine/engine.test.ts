import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import { RemoteContentError } from "./remote";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, LateEventsVault, text, type Harness } from "./testing";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** A feed exercising every kind of change: creates, edits, renames, a rename with an edit, a delete, a resurrection, a multi-chunk file. */
function commitMixedFeed(server: InMemoryServer): void {
  server.commit({ documentId: "a", path: "a.md", content: "a1" });
  server.commit({ documentId: "b", path: "b.md", content: "b1" });
  server.commit({ documentId: "c", path: "notes/c.md", content: "c1" });
  server.commit({ documentId: "a", path: "a.md", content: "a2" });
  server.commit({ documentId: "b", path: "renamed/b.md" });
  server.commit({ documentId: "c", path: "notes/c.md", deleted: true });
  server.commit({ documentId: "d", path: "d.md", content: "a long note that spans several download ranges" });
  server.commit({ documentId: "b", path: "b2.md", content: "b2" });
  server.commit({ documentId: "c", path: "c-again.md", content: "c2" });
  server.commit({ documentId: "a", path: "a.md", content: "a3" });
}

async function documentsById(journal: InMemoryJournal) {
  return new Map((await journal.listDocuments()).map((state) => [state.documentId, state]));
}

describe("SyncEngine pull", () => {
  describe("given remote revisions after the cursor", () => {
    it("makes the local vault match the remote heads and advances the cursor to the head", async () => {
      const h = harness();
      commitMixedFeed(h.server);

      const summary = await h.engine.pull();

      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(summary.cursor).toBe(h.server.currentHeadSeq);
      expect(await h.journal.getCursor()).toBe(h.server.currentHeadSeq);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(h.merges).toEqual([]);
      const documents = await documentsById(h.journal);
      for (const id of ["a", "b", "c", "d"]) {
        expect(documents.get(id)?.revisionId).toBe(h.server.head(id)?.id);
      }
      expect(documents.get("b")).toMatchObject({ path: "b2.md", baseHash: sha256Hex(bytes("b2")), deleted: false });
    });

    it("pulls only revisions after the cursor on the next pull", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      h.server.commit({ documentId: "a", path: "a.md", content: "a2" });
      h.server.commit({ documentId: "b", path: "b.md", content: "b1" });
      const sinceSeqs: bigint[] = [];
      h.server.interceptor = (method, request) => {
        if (method === "ListChanges") sinceSeqs.push((request as { sinceSeq: bigint }).sinceSeq);
      };

      await h.engine.pull();

      expect(sinceSeqs[0]).toBe(1n);
      expect(await files(h.vault)).toEqual(new Map([["a.md", "a2"], ["b.md", "b1"]]));
    });

    it("advances the cursor past a revision only once its disk and journal changes are in place", async () => {
      const server = new InMemoryServer({ maxPageSize: 3, maxDownloadBytes: 4 });
      commitMixedFeed(server);
      const vault = new InMemoryVault();
      const problems: string[] = [];
      class CheckingJournal extends InMemoryJournal {
        override async setCursor(seq: bigint): Promise<void> {
          const revision = server.revisionAt(seq);
          const state = await this.getDocument(revision.documentId);
          if (state?.revisionId !== revision.id) problems.push(`seq ${String(seq)}: journal holds ${String(state?.revisionId)}`);
          const path = new TextDecoder().decode(revision.path);
          const onDisk = await vault.read(path).then(sha256Hex, () => null);
          const expected = revision.deleted ? null : sha256Hex(server.contentOf(revision));
          if (onDisk !== expected) problems.push(`seq ${String(seq)}: ${path} holds ${String(onDisk)}, expected ${String(expected)}`);
          return super.setCursor(seq);
        }
      }
      const h = harness({ server, vault, journal: new CheckingJournal() });

      await h.engine.pull();

      expect(problems).toEqual([]);
      expect(await h.journal.getCursor()).toBe(server.currentHeadSeq);
    });

    it("leaves the cursor at the last applied revision when a pull fails midway, and resumes from it", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      h.server.commit({ documentId: "b", path: "b.md", content: "b1" });
      const failing = h.server.commit({ documentId: "c", path: "c.md", content: "c1" });
      h.server.commit({ documentId: "d", path: "d.md", content: "d1" });
      h.server.interceptor = (method, request) => {
        const blobId = (request as { blobId?: Uint8Array }).blobId;
        if (method === "DownloadBlob" && blobId !== undefined && sha256Hex(bytes("c1")) === bytesToHex(blobId)) {
          throw new ConnectError("unavailable", Code.Unavailable);
        }
      };

      await expect(h.engine.pull()).rejects.toThrow(ConnectError);

      expect(await h.journal.getCursor()).toBe(failing.seq - 1n);
      expect(await files(h.vault)).toEqual(new Map([["a.md", "a1"], ["b.md", "b1"]]));
      expect(await h.journal.getDocument("c")).toBeUndefined();

      h.server.interceptor = undefined;
      await h.engine.pull();
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.getCursor()).toBe(h.server.currentHeadSeq);
    });

    it("rejects content that does not match its hash without writing it or advancing the cursor", async () => {
      const h = harness();
      const revision = h.server.commit({ documentId: "a", path: "a.md", content: "genuine" });
      // Same length, so only the hash check can catch it.
      h.server.corruptBlob(revision, bytes("genuinX"));

      await expect(h.engine.pull()).rejects.toThrow(RemoteContentError);

      expect(await files(h.vault)).toEqual(new Map());
      expect(await h.journal.getCursor()).toBe(0n);
    });

    it.each([
      ["a parent-directory segment", "../outside.md"],
      ["an absolute path", "/etc/passwd"],
      ["a drive prefix", "C:\\notes.md"],
    ])("never writes a path with %s, recording the revision as deferred instead", async (_name, path) => {
      const h = harness();
      const revision = h.server.commit({ documentId: "x", path, content: "evil" });
      h.server.commit({ documentId: "a", path: "a.md", content: "fine" });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["a.md", "fine"]]));
      expect(await h.journal.getDeferred("x")).toEqual({ reason: "invalid-path", revision: expect.objectContaining({ revisionId: revision.id }) as unknown });
      expect(await h.journal.getCursor()).toBe(h.server.currentHeadSeq);
    });

    it("applies a deferred document once a later revision moves it to a valid path", async () => {
      const h = harness();
      h.server.commit({ documentId: "x", path: "../outside.md", content: "x1" });
      await h.engine.pull();

      h.server.commit({ documentId: "x", path: "inside.md" });
      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["inside.md", "x1"]]));
      expect(await h.journal.getDeferred("x")).toBeUndefined();
      expect(h.merges).toEqual([]);
    });

    it("records a revision whose path the vault refuses as deferred and leaves the file in the way alone", async () => {
      const h = harness();
      h.server.commit({ documentId: "n", path: "notes", content: "a file named like a folder" });
      h.server.commit({ documentId: "c", path: "notes/c.md", content: "c1" });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["notes", "a file named like a folder"]]));
      expect((await h.journal.getDeferred("c"))?.reason).toBe("path-conflict");
      expect(await h.journal.getCursor()).toBe(h.server.currentHeadSeq);
    });

    it("never writes a path that is not valid UTF-8", async () => {
      const h = harness();
      h.server.commitRawPath("x", new Uint8Array([0x61, 0xff, 0x2e, 0x6d, 0x64]), "evil");

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map());
      expect((await h.journal.getDeferred("x"))?.reason).toBe("invalid-path");
    });

    it("applies each revision once when pulls overlap", async () => {
      const h = harness();
      commitMixedFeed(h.server);

      const [first, second] = await Promise.all([h.engine.pull(), h.engine.pull()]);

      expect(first.applied + second.applied).toBe(h.server.revisionCount);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });
  });

  describe("given a local file edited since its last sync", () => {
    async function syncedThenEdited(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
      const h = harness(options);
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("local edit"));
      return h;
    }

    it("does not overwrite it and hands the remote revision to the merge hook with the local content and the base", async () => {
      const h = await syncedThenEdited();
      const base = h.server.head("a");
      const remote = h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });

      const summary = await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("local edit");
      expect(h.merges).toHaveLength(1);
      const request = h.merges[0];
      expect(request?.remote).toMatchObject({ revisionId: remote.id, documentId: "a", seq: remote.seq, path: "a.md" });
      expect(request?.base).toMatchObject({ revisionId: base?.id, baseHash: sha256Hex(bytes("base")) });
      expect(text(request?.local.content ?? null)).toBe("local edit");
      expect(text((await request?.readRemoteContent()) ?? null)).toBe("remote edit");
      expect(text((await request?.readBaseContent()) ?? null)).toBe("base");
      expect(summary).toMatchObject({ deferred: 1, cursor: remote.seq });
    });

    it("by default leaves the local file untouched and keeps the remote revision pending in the journal", async () => {
      const h = await syncedThenEdited({ merge: "default" });
      const remote = h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });

      await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("local edit");
      expect(await h.journal.getDeferred("a")).toEqual({ reason: "local-changes", revision: expect.objectContaining({ revisionId: remote.id }) as unknown });
      expect((await h.journal.getDocument("a"))?.baseHash).toBe(sha256Hex(bytes("base")));
      expect(await h.journal.getCursor()).toBe(remote.seq);
    });

    it.each([
      ["a remote rename", { path: "moved.md" }, new Map([["a.md", "local edit"]])],
      ["a remote rename with an edit", { path: "moved.md", content: "remote" }, new Map([["a.md", "local edit"]])],
      ["a remote delete", { path: "a.md", deleted: true }, new Map([["a.md", "local edit"]])],
    ])("does not overwrite it on %s", async (_name, change, expected) => {
      const h = await syncedThenEdited();

      h.server.commit({ documentId: "a", ...change });
      await h.engine.pull();

      expect(await files(h.vault)).toEqual(expected);
      expect(h.merges).toHaveLength(1);
      expect((await h.journal.getDeferred("a"))?.reason).toBe("local-changes");
    });

    it("hands a remote edit of a locally deleted file to the merge hook instead of recreating it", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.delete("a.md");

      h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });
      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map());
      expect(h.merges[0]?.local).toEqual({ path: "a.md", content: null });
    });

    it.each([
      ["a remote create", { documentId: "new", path: "local.md", content: "remote" }],
      ["a remote rename", { documentId: "other", path: "local.md" }],
      ["a remote rename with an edit", { documentId: "other", path: "local.md", content: "remote 2" }],
    ])("never overwrites an unsynced local file whose path %s takes", async (_name, change) => {
      const h = harness();
      h.server.commit({ documentId: "other", path: "other.md", content: "remote" });
      await h.engine.pull();
      await h.vault.write("local.md", bytes("unsynced local note"));

      h.server.commit(change);
      await h.engine.pull();

      expect(text(await h.vault.read("local.md"))).toBe("unsynced local note");
      expect(h.merges).toHaveLength(1);
      expect(text(h.merges[0]?.local.content ?? null)).toBe("unsynced local note");
    });

    it("keeps handing later remote revisions of the document to the merge hook", async () => {
      const h = await syncedThenEdited();
      h.server.commit({ documentId: "a", path: "a.md", content: "remote 1" });
      await h.engine.pull();
      // Even once the disk shows the base again, the merge path owns the document.
      await h.vault.write("a.md", bytes("base"));
      const latest = h.server.commit({ documentId: "a", path: "a.md", content: "remote 2" });

      await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("base");
      expect(h.merges.map((request) => request.remote.revisionId)).toEqual([h.merges[0]?.remote.revisionId, latest.id]);
      expect((await h.journal.getDeferred("a"))?.revision.revisionId).toBe(latest.id);
    });

    it("treats a document with an unpushed local operation as edited", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.journal.addPending({ revisionId: "local-1", documentId: "a", baseRevisionId: h.server.head("a")?.id ?? "", path: "a.md", contentHash: sha256Hex(bytes("base")), size: 4n, kind: "text", deleted: false });

      h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });
      await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("base");
      expect(h.merges).toHaveLength(1);
    });

    it("detects the edit by content hash even when the modification time is unchanged", async () => {
      const vault = new InMemoryVault({ now: () => 1000 });
      const h = await syncedThenEdited({ vault });

      h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });
      await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("local edit");
      expect(h.merges).toHaveLength(1);
    });

    it("applies the remote revision when the file was only rewritten with its synced content (a newer modification time is not an edit)", async () => {
      let clock = 1000;
      const h = harness({ vault: new InMemoryVault({ now: () => clock++ }) });
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("base"));

      h.server.commit({ documentId: "a", path: "a.md", content: "remote edit" });
      await h.engine.pull();

      expect(text(await h.vault.read("a.md"))).toBe("remote edit");
      expect(h.merges).toEqual([]);
    });
  });

  describe("given the engine crashes mid-apply", () => {
    type Scenario = (server: InMemoryServer) => void;
    const scenarios: [string, Scenario, Scenario][] = [
      ["a first pull", () => undefined, commitMixedFeed],
      [
        "a pull on top of synced documents",
        (server) => {
          server.commit({ documentId: "a", path: "a.md", content: "a1" });
          server.commit({ documentId: "b", path: "b.md", content: "b1" });
          server.commit({ documentId: "c", path: "c.md", content: "c1" });
        },
        (server) => {
          server.commit({ documentId: "a", path: "moved/a.md", content: "a2" });
          server.commit({ documentId: "b", path: "b.md", deleted: true });
          server.commit({ documentId: "c", path: "c2.md" });
          server.commit({ documentId: "b", path: "b.md", content: "b2" });
          server.commit({ documentId: "a", path: "a.md", content: "a3" });
          server.commit({ documentId: "x", path: "../x.md", content: "x1" });
          server.commit({ documentId: "x", path: "x.md" });
        },
      ],
    ];

    async function finalState(h: Harness) {
      return { files: await files(h.vault), documents: await documentsById(h.journal), cursor: await h.journal.getCursor(), deferred: await h.journal.listDeferred() };
    }

    it.each(scenarios)("resumes from the journal and reaches the same final state, wherever %s is interrupted", async (_name, before, after) => {
      const reference = harness();
      before(reference.server);
      await reference.engine.pull();
      after(reference.server);
      await reference.engine.pull();
      const expected = await finalState(reference);

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = harness({ journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        before(h.server);
        await h.engine.pull();
        after(h.server);
        points.count = 0;
        points.crashAfter = crashAfter;
        const outcome = await h.engine.pull().then(
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
        h.localChanges.length = 0;
        const restarted = h.restart();
        await restarted.pull();
        await restarted.settled();

        expect(await finalState(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
        expect(h.merges, `crash after durable change ${String(crashAfter)}`).toEqual([]);
        expect(h.localChanges, `crash after durable change ${String(crashAfter)}`).toEqual([]);
      }
      // Every durable change of the pull was a crash point.
      expect(crashed).toBeGreaterThan(10);
    });
  });

  describe("given engine-originated writes", () => {
    it("does not report the vault events they cause as local changes", async () => {
      const h = harness();
      commitMixedFeed(h.server);

      await h.engine.pull();
      await h.engine.settled();

      expect(h.localChanges).toEqual([]);
    });

    it("still reports the user's own changes, including ones to files the engine just wrote", async () => {
      const h = harness();
      commitMixedFeed(h.server);
      await h.engine.pull();

      await h.vault.write("a.md", bytes("user edit"));
      await h.vault.rename("b2.md", "user-renamed.md");
      await h.vault.delete("d.md");
      await h.vault.write("user.md", bytes("user note"));
      await h.engine.settled();

      expect(h.localChanges).toEqual([
        { type: "modify", path: "a.md" },
        { type: "rename", path: "user-renamed.md", oldPath: "b2.md" },
        { type: "delete", path: "d.md" },
        { type: "create", path: "user.md" },
      ]);
    });

    it("does not report events that arrive late, after several engine writes to the same file", async () => {
      let late: LateEventsVault | undefined;
      const h = harness({
        wrapVault: (vault) => {
          late = new LateEventsVault(vault);
          return late;
        },
      });
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      h.server.commit({ documentId: "a", path: "a.md", content: "a2" });
      h.server.commit({ documentId: "a", path: "a.md", content: "a3" });

      await h.engine.pull();
      late?.flush();
      await h.engine.settled();

      expect(h.localChanges).toEqual([]);
    });

    it("reports a user edit that a debouncing watcher folds into the event of the engine's write", async () => {
      let late: LateEventsVault | undefined;
      const h = harness({
        wrapVault: (vault) => {
          late = new LateEventsVault(vault, true);
          return late;
        },
      });
      h.server.commit({ documentId: "a", path: "a.md", content: "remote" });

      await h.engine.pull();
      await h.vault.write("a.md", bytes("user edit"));
      late?.flush();
      await h.engine.settled();

      expect(h.localChanges).toEqual([{ type: "create", path: "a.md" }]);
    });
  });

  describe("given the server's head_seq is below the cursor", () => {
    async function syncedThenRestored() {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      h.server.commit({ documentId: "b", path: "b.md", content: "b1" });
      h.server.commit({ documentId: "a", path: "a.md", content: "a2" });
      h.server.commit({ documentId: "c", path: "c.md", content: "c1" });
      await h.engine.pull();
      // A database restore loses seq 3 and 4, which this device already applied.
      h.server.restoreTo(2n);
      return h;
    }

    it("resyncs instead of treating it as nothing new, so later revisions are not skipped", async () => {
      const h = await syncedThenRestored();

      const restored = await h.engine.pull();
      expect(restored).toMatchObject({ resynced: true, cursor: 2n });

      const after = h.server.commit({ documentId: "d", path: "d.md", content: "after the restore" });
      expect(after.seq).toBe(3n);
      await h.engine.pull();

      expect(text(await h.vault.read("d.md"))).toBe("after the restore");
      expect(await h.journal.getCursor()).toBe(3n);
    });

    it("keeps content the server lost and hands those documents to the merge hook", async () => {
      const h = await syncedThenRestored();

      await h.engine.pull();

      // a2 and c1 exist only on this device now: nothing is overwritten or deleted.
      expect(await files(h.vault)).toEqual(new Map([["a.md", "a2"], ["b.md", "b1"], ["c.md", "c1"]]));
      expect(h.merges.map((request) => request.remote.documentId)).toEqual(["a"]);
      expect(text(h.merges[0]?.local.content ?? null)).toBe("a2");
      expect((await h.journal.getDocument("b"))?.revisionId).toBe(h.server.head("b")?.id);
    });

    it("applies documents the restored server has and this device does not", async () => {
      const h = await syncedThenRestored();
      // Committed after the restore: head_seq 3 is still below the cursor (4).
      h.server.commit({ documentId: "e", path: "e.md", content: "e1" });

      const summary = await h.engine.pull();

      expect(summary.resynced).toBe(true);
      expect(text(await h.vault.read("e.md"))).toBe("e1");
      expect(await h.journal.getCursor()).toBe(3n);
    });
  });
});
