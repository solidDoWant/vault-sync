import { describe, expect, it } from "vitest";

import type { InMemoryJournal } from "../journal/memory";
import type { InMemoryServer } from "./memory-server";
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
      // The reference resync did hand the documents with lost revisions over.
      expect(handedToMerge).toEqual(new Set(["a", "b"]));

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
});
