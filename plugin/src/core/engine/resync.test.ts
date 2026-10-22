import { describe, expect, it } from "vitest";

import type { InMemoryJournal } from "../journal/memory";
import type { InMemoryServer } from "./memory-server";
import { threeWayMerge } from "./merge";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, text, type Harness } from "./testing";

// A server restored from a backup has lost history this device already
// applied (SPEC.md §8). The resync must hand every document the server lost
// revisions of to the merge path, survive a crash anywhere, and leave no
// journal state that makes the restored server's later revisions look applied.

async function documentsById(journal: InMemoryJournal) {
  return new Map((await journal.listDocuments()).map((state) => [state.documentId, state]));
}

async function finalState(h: Harness) {
  return { files: await files(h.vault), documents: await documentsById(h.journal), cursor: await h.journal.getCursor(), deferred: await h.journal.listDeferred() };
}

describe("SyncEngine resync after a server restore", () => {
  describe("given the engine crashes mid-resync", () => {
    const before = (server: InMemoryServer) => {
      server.commit({ documentId: "a", path: "a.md", content: "a1" }); // 1
      server.commit({ documentId: "b", path: "b.md", content: "b1" }); // 2
      server.commit({ documentId: "a", path: "a.md", content: "a2" }); // 3
      server.commit({ documentId: "c", path: "c.md", content: "c1" }); // 4
      server.commit({ documentId: "a", path: "a.md", content: "a3" }); // 5
      server.commit({ documentId: "d", path: "d.md", content: "d1" }); // 6
      server.commit({ documentId: "d", path: "d.md", deleted: true }); // 7
    };
    const restore = (server: InMemoryServer) => {
      // The restore loses seq 3 to 7, which this device already applied.
      server.restoreTo(2n);
      server.commit({ documentId: "e", path: "e.md", content: "e1" }); // 3
      server.commit({ documentId: "b", path: "b.md", content: "b2" }); // 4
    };

    it("finishes the reconcile after a restart, wherever the resync is interrupted", async () => {
      const reference = harness();
      before(reference.server);
      await reference.engine.pull();
      restore(reference.server);
      expect(await reference.engine.pull()).toMatchObject({ resynced: true });
      const expected = await finalState(reference);
      const handedToMerge = new Set(reference.merges.map((request) => request.remote.documentId));
      // Every lost revision is another device's, which this device only pulled under files it never changed (#874,
      // design §4.6): the reference resync pulls each restored head, merging nothing, and sends nothing the writer
      // must send again.
      expect(handedToMerge).toEqual(new Set());
      expect(expected.documents.get("a")?.revisionId).toBe(reference.server.head("a")?.id);
      expect(expected.files.get("a.md")).toBe("a1");
      expect(expected.files.get("b.md")).toBe("b2");

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = harness({ journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        before(h.server);
        await h.engine.pull();
        restore(h.server);
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
        const restarted = h.restart();
        await restarted.pull();
        await restarted.settled();

        const label = `crash after durable change ${String(crashAfter)}`;
        expect(await finalState(h), label).toEqual(expected);
        expect(new Set(h.merges.map((request) => request.remote.documentId)), label).toEqual(handedToMerge);
      }
      // Every durable change of the resync, including the cursor reset, was a crash point.
      expect(crashed).toBeGreaterThanOrEqual(4);
    });
  });

  describe("given a document the restored server lacks entirely", () => {
    async function syncedThenRestored(h: Harness) {
      h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
      h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
      h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 3
      h.server.commit({ documentId: "x", path: "x.md", content: "x3" }); // 4
      await h.engine.pull();
      // x exists only on this device now.
      h.server.restoreTo(1n);
      expect(await h.engine.pull()).toMatchObject({ resynced: true, cursor: 1n });
    }

    it("hands a later revision of it, numbered by the restored server, to the merge path instead of skipping it", async () => {
      const h = harness();
      await syncedThenRestored(h);
      // Another device commits the document again; the restored server numbers it 2 and 3.
      h.server.commit({ documentId: "x", path: "x.md", content: "other device" }); // 2
      h.server.commit({ documentId: "x", path: "x.md", content: "other device again" }); // 3

      await h.engine.pull();

      expect(await h.journal.getCursor()).toBe(3n);
      // Content only this device holds is neither overwritten nor dropped.
      expect(text(await h.vault.read("x.md"))).toBe("x3");
      expect(h.merges.map((request) => request.remote.documentId)).toContain("x");
      expect(text(h.merges[0]?.local.content ?? null)).toBe("x3");
      expect((await h.journal.getDeferred("x"))?.revision.revisionId).toBe(h.server.head("x")?.id);
    });

    it("keeps both versions with the default merge hook", async () => {
      const h = harness({ merge: "default" });
      await syncedThenRestored(h);
      h.server.commit({ documentId: "x", path: "x.md", content: "other device" }); // 2

      await h.engine.pull();

      const contents = [...(await files(h.vault)).values()];
      expect(contents).toContain("x3");
      expect(contents).toContain("other device");
    });

    // #719 (design §4.6): a revision deferred before the restore proves nothing about a base the restore lost, so it
    // never overwrites the file at the lost base. #848 (PO-12, INV-9, principle 1; decision log #52): the restored
    // server lost that revision, so the resync drops its deferral rather than merge a revision no server holds; this
    // device's file is re-created under the document's own id, and the lost revision is its writer's to send again.
    it("keeps this device's file at the lost base and drops a revision deferred before the restore", async () => {
      let deferring = true;
      const h = harness({ merge: (request) => (deferring ? Promise.resolve({ status: "deferred" }) : threeWayMerge(request)) });
      h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
      h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
      await h.engine.pull();
      await h.vault.write("x.md", new TextEncoder().encode("local edit"));
      await h.engine.settled();
      const lost = h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 3
      await h.engine.pull();
      expect((await h.journal.getDeferred("x"))?.revision.revisionId).toBe(lost.id);
      await h.vault.write("x.md", new TextEncoder().encode("x1"));
      await h.engine.settled();
      h.server.restoreTo(1n);
      const before = h.merges.length;
      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      expect(await h.journal.getDeferred("x")).toBeUndefined();
      deferring = false;

      await h.engine.push();

      expect(text(await h.vault.read("x.md"))).toBe("x1");
      const head = h.server.head("x");
      expect(head).toBeDefined();
      if (head !== undefined) expect(text(h.server.contentOf(head))).toBe("x1");
      expect(await h.journal.getDeferred("x")).toBeUndefined();
      expect(h.merges.slice(before).map((request) => request.remote.revisionId)).not.toContain(lost.id);
    });

    it("applies a later revision of one this device had deleted", async () => {
      const h = harness();
      h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
      h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
      h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 3
      h.server.commit({ documentId: "x", path: "x.md", deleted: true }); // 4
      await h.engine.pull();
      h.server.restoreTo(1n);
      await h.engine.pull();
      h.server.commit({ documentId: "x", path: "x.md", content: "back again" }); // 2

      await h.engine.pull();

      expect(text(await h.vault.read("x.md"))).toBe("back again");
      expect((await h.journal.getDocument("x"))?.revisionId).toBe(h.server.head("x")?.id);
      expect(h.merges).toEqual([]);
    });
  });

  // Design §4.6 (restore resync): a restore that rolled a document back along this device's own history has nothing
  // concurrent to merge; this device's version is the document's next revision, under its own id (principle 1).
  describe("given a restore that rolled a document back to a revision this device synced before", () => {
    async function rolledBack(h: Harness) {
      h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
      h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
      await h.engine.pull();
      // This device's own edits, acknowledged (#874: a revision it only pulled is its writer's to send again).
      for (const content of ["x2", "x3"]) {
        await h.vault.write("x.md", new TextEncoder().encode(content)); // 3, 4
        await h.engine.settled();
        await h.engine.push();
      }
      // The restore keeps x1 only: x2 and x3 exist only on this device now.
      h.server.restoreTo(2n);
      return h.server.head("x")?.id;
    }

    // #874 (design §4.6): a lost revision this device only pulled, under a file it never changed, is no write of its
    // own: the restored head is pulled over it, and the writer sends the lost revision again.
    it("pulls the restored head over an unchanged file at a lost revision another device wrote", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "k", path: "k.md", content: "k1" }); // 1
      h.server.commit({ documentId: "x", path: "x.md", content: "x1" }); // 2
      h.server.commit({ documentId: "y", path: "y.md", content: "y1" }); // 3
      await h.engine.pull();
      h.server.commit({ documentId: "x", path: "x.md", content: "x2" }); // 4
      h.server.commit({ documentId: "y", path: "y.md", content: "y2" }); // 5
      await h.engine.pull();
      await h.vault.rename("x.md", "renamed.md");
      await h.engine.settled();
      h.server.restoreTo(3n);
      // The other device's edit of x on the restored server, and its delete of y.
      h.server.commit({ documentId: "x", path: "x.md", content: "other device" }); // 4
      h.server.commit({ documentId: "y", path: "y.md", deleted: true }); // 5

      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      await h.engine.push();

      expect(await h.journal.listConflicts()).toEqual([]);
      expect(await files(h.vault)).toEqual(new Map([["k.md", "k1"], ["renamed.md", "other device"]]));
      expect(h.server.liveFiles()).toEqual(new Map([["k.md", "k1"], ["renamed.md", "other device"]]));
    });

    it("commits the lost revision on the restored head under the document's own id, without a conflict copy", async () => {
      const h = harness({ merge: "default" });
      const restoredHead = await rolledBack(h);

      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      await h.engine.push();

      expect(h.merges).toEqual([]);
      expect(await h.journal.listConflicts()).toEqual([]);
      expect(await files(h.vault)).toEqual(new Map([["k.md", "k1"], ["x.md", "x3"]]));
      expect(h.server.head("x")).toMatchObject({ parentRevId: restoredHead, deleted: false });
      expect(h.server.liveFiles()).toEqual(new Map([["k.md", "k1"], ["x.md", "x3"]]));
    });

    it("commits a local edit made on the lost revision the same way", async () => {
      const h = harness({ merge: "default" });
      const restoredHead = await rolledBack(h);
      await h.vault.write("x.md", new TextEncoder().encode("x3 and a local edit"));
      await h.engine.settled();

      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      await h.engine.push();

      expect(await h.journal.listConflicts()).toEqual([]);
      expect(h.server.head("x")).toMatchObject({ documentId: "x" });
      expect(h.server.liveFiles()).toEqual(new Map([["k.md", "k1"], ["x.md", "x3 and a local edit"]]));
      expect(h.server.history("x").map((revision) => revision.id)).toContain(restoredHead);
    });

    it("keeps both versions when another device committed on the restored server, overwriting neither", async () => {
      const h = harness({ merge: "default" });
      await rolledBack(h);
      // Another device that was at x1 commits after the restore: its revision is concurrent with x3.
      h.server.commit({ documentId: "x", path: "x.md", content: "other device" }); // 3

      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      await h.engine.push();

      const contents = [...(await files(h.vault)).values()];
      expect(contents).toContain("x3");
      expect(contents).toContain("other device");
      expect([...h.server.liveFiles().values()]).toEqual(expect.arrayContaining(["x3", "other device"]));
    });

    // #719: a revision that follows a restored head this device never merged proves nothing about the lost base, so
    // the unchanged file, which holds the lost revision, is never overwritten (principle 1).
    it("keeps both versions when a later revision follows a restored head whose merge was deferred", async () => {
      let deferring = true;
      const h = harness({ merge: (request) => (deferring ? Promise.resolve({ status: "deferred" }) : threeWayMerge(request)) });
      await rolledBack(h);
      h.server.commit({ documentId: "x", path: "x.md", content: "other device" }); // 3
      expect(await h.engine.pull()).toMatchObject({ resynced: true });
      deferring = false;
      h.server.commit({ documentId: "x", path: "x.md", content: "other device again" }); // 4

      await h.engine.pull();
      await h.engine.push();

      const contents = [...(await files(h.vault)).values()];
      expect(contents).toContain("x3");
      expect(contents).toContain("other device again");
      expect([...h.server.liveFiles().values()]).toEqual(expect.arrayContaining(["x3", "other device again"]));
    });

    it("keeps both versions when the journal cannot prove the restored head an ancestor", async () => {
      const h = harness({ merge: "default" });
      await rolledBack(h);
      // A row an engine before R7b wrote records no earlier revisions.
      const state = await h.journal.getDocument("x");
      if (state === undefined) throw new Error("x is not in the journal");
      await h.journal.putDocument({ ...state, prior: undefined });

      expect(await h.engine.pull()).toMatchObject({ resynced: true });

      const contents = [...(await files(h.vault)).values()];
      expect(contents).toContain("x3");
      expect(contents).toContain("x1");
    });
  });
});
