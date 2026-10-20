import { describe, expect, it } from "vitest";


import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import type { UnmaterializableDocument } from "./engine";
import { copyOf, Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, type Harness } from "./testing";

// Platform path rules (SPEC.md §8): a remote document whose path the local
// platform cannot hold is tracked as unmaterializable and reported, never
// written, dropped or renamed on the server, and materializes once a later
// revision gives it a path the platform can hold.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

const windows = { platform: "windows" } as const;
/** Over MAX_PATH (259 UTF-16 code units without the terminator) with no name over 255. */
const longPath = `${"a".repeat(200)}/${"b".repeat(56)}.md`;

const illegal = [
  { path: "CON.md", reason: "reserved-name" },
  { path: "notes/a:b.md", reason: "forbidden-character" },
  { path: "trailing.", reason: "trailing-dot-or-space" },
  { path: longPath, reason: "path-too-long" },
] as const;

/** A Windows device: the engine and its in-memory vault follow Windows' rules. */
function windowsDevice(options: { onUnmaterializable?: (document: UnmaterializableDocument) => void } = {}): Harness {
  return harness({ merge: "default", pathRules: windows, ...options });
}

/** The engine's unmaterializable documents as path and reason, sorted by path. */
async function reported(h: Harness): Promise<{ path: string; reason: string; localPath: string | undefined }[]> {
  return (await h.engine.unmaterializable()).map(({ path, reason, localPath }) => ({ path, reason, localPath })).sort((left, right) => (left.path < right.path ? -1 : 1));
}

describe("SyncEngine platform path rules (SPEC.md §8)", () => {
  it("checks the over-long path against the right limit", () => {
    expect(longPath.length).toBe(260);
  });

  describe("given remote documents whose names Windows cannot hold", () => {
    async function pulledOnWindows() {
      const notified: UnmaterializableDocument[] = [];
      const h = windowsDevice({ onUnmaterializable: (document) => notified.push(document) });
      h.server.commit({ documentId: "ok", path: "ok.md", content: "fine\n" });
      for (const [index, { path }] of illegal.entries()) h.server.commit({ documentId: `doc-${String(index)}`, path, content: `content ${String(index)}\n` });
      const summary = await h.engine.pull();
      return { h, summary, notified };
    }

    it("writes none of them, tracks and reports each with its reason, and finishes the pull", async () => {
      const { h, summary, notified } = await pulledOnWindows();

      expect(await files(h.vault)).toEqual(new Map([["ok.md", "fine\n"]]));
      const expected = illegal.map(({ path, reason }) => ({ path, reason, localPath: undefined })).sort((left, right) => (left.path < right.path ? -1 : 1));
      expect(await reported(h)).toEqual(expected);
      expect(notified.map(({ path, reason }) => ({ path, reason })).sort((left, right) => (left.path < right.path ? -1 : 1))).toEqual(expected.map(({ path, reason }) => ({ path, reason })));
      expect(summary.cursor).toBe(h.server.currentHeadSeq);
      expect(summary.applied).toBe(1);
      expect(summary.deferred).toBe(illegal.length);
      expect(h.localChanges).toEqual([]);
    });

    it("never drops or renames them on the server, across pushes and a restart", async () => {
      const { h } = await pulledOnWindows();
      const revisions = h.server.revisionCount;
      const live = h.server.liveFiles();

      await h.engine.push();
      h.restart();
      // The first push after a start scans the whole vault and journal.
      const summary = await h.engine.push();

      expect(summary).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
      expect(h.server.revisionCount).toBe(revisions);
      expect(h.server.liveFiles()).toEqual(live);
      expect((await reported(h)).map(({ path }) => path).sort()).toEqual(illegal.map(({ path }) => path).sort());
    });

    it("materializes each once a later remote rename gives it a legal name", async () => {
      const { h } = await pulledOnWindows();
      for (const [index] of illegal.entries()) h.server.commit({ documentId: `doc-${String(index)}`, path: `fixed-${String(index)}.md` });

      await h.engine.pull();
      await h.engine.push();

      expect(await files(h.vault)).toEqual(
        new Map([
          ["fixed-0.md", "content 0\n"],
          ["fixed-1.md", "content 1\n"],
          ["fixed-2.md", "content 2\n"],
          ["fixed-3.md", "content 3\n"],
          ["ok.md", "fine\n"],
        ]),
      );
      expect(await reported(h)).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(h.acknowledged).toEqual([]);
      expect(h.localChanges).toEqual([]);
    });

    it("stops tracking one the server deletes", async () => {
      const { h } = await pulledOnWindows();
      h.server.commit({ documentId: "doc-0", path: "CON.md", deleted: true });

      await h.engine.pull();

      expect((await reported(h)).map(({ path }) => path)).not.toContain("CON.md");
      expect(await h.journal.getDeferred("doc-0")).toBeUndefined();
      expect((await h.journal.getDocument("doc-0"))?.deleted).toBe(true);
    });

    it("writes them all on a platform that can hold them", async () => {
      const h = harness({ merge: "default" });
      for (const [index, { path }] of illegal.entries()) h.server.commit({ documentId: `doc-${String(index)}`, path, content: `content ${String(index)}\n` });

      await h.engine.pull();

      expect([...(await files(h.vault)).keys()].sort()).toEqual(illegal.map(({ path }) => path).sort());
      expect(await h.engine.unmaterializable()).toEqual([]);
    });
  });

  describe("given a synced document that a remote rename gives an illegal name", () => {
    /** Synced at plan.md; then renamed (and edited) remotely to plan?.md, with `localEdit` written first if given. */
    async function renamedAway(localEdit?: string) {
      const h = windowsDevice();
      h.server.commit({ documentId: "doc", path: "plan.md", content: "one\ntwo\n" });
      await h.engine.pull();
      if (localEdit !== undefined) await h.vault.write("plan.md", bytes(localEdit));
      h.server.commit({ documentId: "doc", path: "plan?.md", content: "one\ntwo\nthree\n" });
      await h.engine.pull();
      return h;
    }

    it("removes its unchanged file, whose content the server holds, and reports it with no local file", async () => {
      const h = await renamedAway();

      expect(await files(h.vault)).toEqual(new Map());
      expect(await reported(h)).toEqual([{ path: "plan?.md", reason: "forbidden-character", localPath: undefined }]);
      // The engine's own delete is not a local change, and nothing goes to the server.
      expect(h.localChanges).toEqual([]);
      await h.engine.push();
      expect(h.server.liveFiles()).toEqual(new Map([["plan?.md", "one\ntwo\nthree\n"]]));
    });

    it("keeps a file with a local edit where it was, with the edit, and reports where it is", async () => {
      const h = await renamedAway("one (edited)\ntwo\n");

      expect(await files(h.vault)).toEqual(new Map([["plan.md", "one (edited)\ntwo\n"]]));
      expect(await reported(h)).toEqual([{ path: "plan?.md", reason: "forbidden-character", localPath: "plan.md" }]);
    });

    it("pushes nothing for it, not even the local edit, while it cannot be materialized", async () => {
      const h = await renamedAway("one (edited)\ntwo\n");
      const revisions = h.server.revisionCount;
      const calls: string[] = [];
      h.server.interceptor = (method) => calls.push(method);

      await h.engine.push();
      h.restart();
      await h.engine.push();

      // Not even tried: a commit on the old base would only be refused, push after push.
      expect(calls.filter((method) => method !== "ListChanges")).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(h.server.revisionCount).toBe(revisions);
      expect(h.server.liveFiles()).toEqual(new Map([["plan?.md", "one\ntwo\nthree\n"]]));
      // The edit is still on disk, waiting.
      expect(await files(h.vault)).toEqual(new Map([["plan.md", "one (edited)\ntwo\n"]]));
    });

    it("moves it to the legal name a later rename gives it, merging the local edit", async () => {
      const h = await renamedAway("one (edited)\ntwo\n");
      await h.engine.push();
      h.server.commit({ documentId: "doc", path: "plan 2.md" });

      await h.engine.push();

      const merged = "one (edited)\ntwo\nthree\n";
      expect(await files(h.vault)).toEqual(new Map([["plan 2.md", merged]]));
      expect(h.server.liveFiles()).toEqual(new Map([["plan 2.md", merged]]));
      expect(h.server.liveDocuments()).toEqual(new Map([["plan 2.md", "doc"]]));
      expect(await reported(h)).toEqual([]);
    });

    it("materializes it at the legal name a later rename gives it after its file was removed", async () => {
      const h = await renamedAway();
      h.server.commit({ documentId: "doc", path: "plan 2.md" });

      await h.engine.pull();
      await h.engine.push();

      expect(await files(h.vault)).toEqual(new Map([["plan 2.md", "one\ntwo\nthree\n"]]));
      expect(h.server.liveDocuments()).toEqual(new Map([["plan 2.md", "doc"]]));
      expect(h.localChanges).toEqual([]);
      expect(h.acknowledged).toEqual([]);
      expect(await h.journal.listConflicts()).toEqual([]);
    });

    it("does not take its removed file for a local delete to merge", async () => {
      // The harness's recording hook defers whatever it is given.
      const h = harness({ pathRules: windows });
      h.server.commit({ documentId: "doc", path: "plan.md", content: "one\n" });
      await h.engine.pull();
      h.server.commit({ documentId: "doc", path: "plan?.md" });
      await h.engine.pull();
      h.server.commit({ documentId: "doc", path: "plan 2.md" });

      await h.engine.pull();

      expect(h.merges).toEqual([]);
      expect(await files(h.vault)).toEqual(new Map([["plan 2.md", "one\n"]]));
    });

    it("frees the old path for a document the server puts there", async () => {
      const h = await renamedAway();
      h.server.commit({ documentId: "other", path: "plan.md", content: "another note\n" });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["plan.md", "another note\n"]]));
      expect(await h.journal.listDeferred()).toEqual([expect.objectContaining({ reason: "unmaterializable" })]);
    });

    // #379: the kept edited file used to block the other document for good,
    // deferred as local-changes although no push ever committed anything.
    describe.each([
      { name: "the same spelling", other: "plan.md" },
      { name: "another spelling", other: "PLAN.md" },
    ])("when the server puts another document at its kept edited file's path under $name", ({ other }) => {
      async function occupied() {
        const h = await renamedAway("one (edited)\ntwo\n");
        h.server.commit({ documentId: "other", path: other, content: "another note\n" });
        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        return h;
      }

      it("writes the other document at its path and keeps the edit as a conflict copy the server gets", async () => {
        const h = await occupied();

        const vault = await files(h.vault);
        expect(vault.get(other)).toBe("another note\n");
        const copies = [...vault].filter(([path]) => path !== other);
        expect(copies).toEqual([[expect.stringMatching(/^plan \(conflict .*\)\.md$/i), "one (edited)\ntwo\n"]]);
        const live = h.server.liveFiles();
        expect(live.get(other)).toBe("another note\n");
        expect(live.get(copies[0]?.[0] ?? "")).toBe("one (edited)\ntwo\n");
        expect(live.get("plan?.md")).toBe("one\ntwo\nthree\n");
      });

      it("leaves no revision deferred but the unmaterializable one, which no longer claims a file", async () => {
        const h = await occupied();

        expect((await h.journal.listDeferred()).map(({ reason, revision }) => [reason, revision.documentId])).toEqual([["unmaterializable", "doc"]]);
        expect(await reported(h)).toEqual([{ path: "plan?.md", reason: "forbidden-character", localPath: undefined }]);
        expect(await h.journal.listPending()).toEqual([]);
      });
    });
  });

  // Once its file is removed, the parked document has nothing at its old
  // path: whatever is there later (another document's file, a new local
  // file) is never taken for its file (review of #217).
  describe("given a document whose file was removed when a remote rename gave it an illegal name", () => {
    /** Synced at plan.md with `content`; then renamed remotely to plan?.md, which removes its unchanged file. */
    async function released(content: string, rename: { content?: string } = {}, h: Harness = windowsDevice()) {
      h.server.commit({ documentId: "doc", path: "plan.md", content });
      await h.engine.pull();
      h.server.commit({ documentId: "doc", path: "plan?.md", ...rename });
      await h.engine.pull();
      expect(await files(h.vault)).toEqual(new Map());
      return h;
    }

    it("keeps another document the server puts at the old path apart when it materializes", async () => {
      const h = await released("one\ntwo\n", { content: "one\ntwo\nthree\n" });
      h.server.commit({ documentId: "other", path: "plan.md", content: "another note\n" });
      await h.engine.pull();
      await h.engine.push();
      h.server.commit({ documentId: "doc", path: "plan 2.md" });

      await h.engine.pull();
      await h.engine.push();

      const expected = new Map([
        ["plan.md", "another note\n"],
        ["plan 2.md", "one\ntwo\nthree\n"],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["plan.md", "other"],
          ["plan 2.md", "doc"],
        ]),
      );
      expect(await h.journal.listConflicts()).toEqual([]);
    });

    it("never deletes another document's file of the same content at the old path, across a restart", async () => {
      const h = await released("");
      h.server.commit({ documentId: "other", path: "plan.md", content: "" });
      await h.engine.pull();
      await h.engine.push();
      h.restart();

      await h.engine.push();
      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["plan.md", ""]]));
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["plan.md", ""],
          ["plan?.md", ""],
        ]),
      );
      expect(h.localChanges).toEqual([]);
    });

    it("never deletes another document's file at the old path of a kept edited file the user deleted meanwhile", async () => {
      const h = windowsDevice();
      h.server.commit({ documentId: "doc", path: "plan.md", content: "" });
      await h.engine.pull();
      await h.vault.write("plan.md", bytes("draft\n"));
      h.server.commit({ documentId: "doc", path: "plan?.md" });
      await h.engine.pull();
      expect(await files(h.vault)).toEqual(new Map([["plan.md", "draft\n"]]));
      // The user deletes the edited file while the pull that brings another document there is under way.
      h.server.commit({ documentId: "other", path: "plan.md", content: "" });
      let deleted = false;
      h.server.interceptor = (method) => {
        if (method !== "ListChanges" || deleted) return;
        deleted = true;
        void h.vault.delete("plan.md");
      };
      await h.engine.pull();
      h.server.interceptor = undefined;

      await h.engine.push();
      h.restart();
      await h.engine.push();

      expect(await files(h.vault)).toEqual(new Map([["plan.md", ""]]));
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["plan.md", "other"],
          ["plan?.md", "doc"],
        ]),
      );
    });

    it("pushes a new local file at the old path as a new document, before and after a restart", async () => {
      for (const restart of [false, true]) {
        const h = await released("one\n");
        await h.vault.write("plan.md", bytes("brand new\n"));
        if (restart) h.restart();

        await h.engine.push();

        expect(h.server.liveFiles(), `restart: ${String(restart)}`).toEqual(
          new Map([
            ["plan.md", "brand new\n"],
            ["plan?.md", "one\n"],
          ]),
        );
        expect(h.server.liveDocuments().get("plan?.md")).toBe("doc");
        expect(h.server.liveDocuments().get("plan.md")).not.toBe("doc");
      }
    });

    it("keeps a new local file of the same content at the old path, and pushes it as a new document", async () => {
      const h = await released("one\n");
      await h.vault.write("plan.md", bytes("one\n"));
      h.restart();

      await h.engine.push();
      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\n"]]));
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["plan.md", "one\n"],
          ["plan?.md", "one\n"],
        ]),
      );
    });

    it("reaches the same state after a crash at any point of the removal", async () => {
      const finish = async (h: Harness) => {
        h.server.commit({ documentId: "other", path: "plan.md", content: "" });
        await h.engine.pull();
        await h.engine.push();
        h.server.commit({ documentId: "doc", path: "plan 2.md" });
        await h.engine.pull();
        await h.engine.push();
        return { server: h.server.liveDocuments(), files: await files(h.vault), deferred: await h.journal.listDeferred(), conflicts: await h.journal.listConflicts() };
      };
      const expected = await finish(await released(""));
      expect(expected.files).toEqual(
        new Map([
          ["plan.md", ""],
          ["plan 2.md", ""],
        ]),
      );

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = harness({ merge: "default", pathRules: windows, journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        h.server.commit({ documentId: "doc", path: "plan.md", content: "" });
        await h.engine.pull();
        h.server.commit({ documentId: "doc", path: "plan?.md" });
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
        h.restart();

        expect(await finish(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      // The deferral, the delete and the journal's record of it.
      expect(crashed).toBeGreaterThanOrEqual(3);
    });

    it("does not take the removed file for a local delete when the next revision comes before a push after a crash", async () => {
      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        // The harness's recording hook defers whatever it is given.
        const h = harness({ pathRules: windows, journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        h.server.commit({ documentId: "doc", path: "plan.md", content: "one\n" });
        await h.engine.pull();
        h.server.commit({ documentId: "doc", path: "plan?.md" });
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
        h.restart();
        h.server.commit({ documentId: "doc", path: "plan 2.md" });

        await h.engine.pull();

        expect(h.merges, `crash after durable change ${String(crashAfter)}`).toEqual([]);
        expect(await files(h.vault), `crash after durable change ${String(crashAfter)}`).toEqual(new Map([["plan 2.md", "one\n"]]));
      }
      expect(crashed).toBeGreaterThanOrEqual(3);
    });
  });

  describe("given a local edit pending when a remote rename gives its document an illegal name", () => {
    it("keeps the edit on disk and pending, then merges and commits it once the name is legal again", async () => {
      const h = windowsDevice();
      h.server.commit({ documentId: "doc", path: "plan.md", content: "one\ntwo\n" });
      await h.engine.pull();
      await h.vault.write("plan.md", bytes("one\ntwo (edited)\n"));
      // Another device renames it just before this device's commit reaches the server.
      let renamed = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || renamed) return;
        renamed = true;
        h.server.commit({ documentId: "doc", path: "plan|draft.md" });
      };

      await h.engine.push();

      expect(await files(h.vault)).toEqual(new Map([["plan.md", "one\ntwo (edited)\n"]]));
      expect(await reported(h)).toEqual([{ path: "plan|draft.md", reason: "forbidden-character", localPath: "plan.md" }]);
      expect(h.server.liveFiles()).toEqual(new Map([["plan|draft.md", "one\ntwo\n"]]));

      h.server.commit({ documentId: "doc", path: "plan draft.md" });
      await h.engine.push();

      expect(await files(h.vault)).toEqual(new Map([["plan draft.md", "one\ntwo (edited)\n"]]));
      expect(h.server.liveFiles()).toEqual(new Map([["plan draft.md", "one\ntwo (edited)\n"]]));
      expect(await reported(h)).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
    });

    // #391: the kept file, with the edit still pending at its path, used to
    // hold another document the server puts there off its path for good.
    describe("when the server then puts another document at the edited file's path", () => {
      /** The edit (or with `deleted`, a delete) pending at plan.md, `doc` renamed to plan|draft.md; then `other` committed at plan.md. */
      async function parkedWithPendingEdit(h: Harness = windowsDevice(), deleted = false) {
        h.server.commit({ documentId: "doc", path: "plan.md", content: "one\ntwo\n" });
        await h.engine.pull();
        if (deleted) await h.vault.delete("plan.md");
        else await h.vault.write("plan.md", bytes("one\ntwo (edited)\n"));
        let renamed = false;
        h.server.interceptor = (method) => {
          if (method !== "CommitRevision" || renamed) return;
          renamed = true;
          h.server.commit({ documentId: "doc", path: "plan|draft.md" });
        };
        await h.engine.push();
        h.server.interceptor = undefined;
        expect(await h.journal.listPending()).toEqual([expect.objectContaining({ documentId: "doc", path: "plan.md", deleted })]);
        h.server.commit({ documentId: "other", path: "plan.md", content: "another note\n" });
        return h;
      }

      /** Asserts the converged state: `other` at plan.md, the edit in a conflict copy on both sides, `doc` untouched on the server. */
      async function expectConverged(h: Harness, label?: string) {
        const vault = await files(h.vault);
        expect(vault.get("plan.md"), label).toBe("another note\n");
        const copies = [...vault].filter(([path]) => path !== "plan.md");
        expect(copies, label).toEqual([[expect.stringMatching(/^plan \(conflict .*\)\.md$/), "one\ntwo (edited)\n"]]);
        expect(h.server.liveFiles(), label).toEqual(
          new Map([
            ["plan.md", "another note\n"],
            [copies[0]?.[0] ?? "", "one\ntwo (edited)\n"],
            ["plan|draft.md", "one\ntwo\n"],
          ]),
        );
        expect(h.server.liveDocuments().get("plan|draft.md"), label).toBe("doc");
        expect((await h.journal.listDeferred()).map(({ reason, revision }) => [reason, revision.documentId]), label).toEqual([["unmaterializable", "doc"]]);
        expect(await reported(h), label).toEqual([{ path: "plan|draft.md", reason: "forbidden-character", localPath: undefined }]);
        expect(await h.journal.listPending(), label).toEqual([]);
      }

      it("drops the pending edit, writes the other document at its path and pushes the edit as a conflict copy", async () => {
        const h = await parkedWithPendingEdit();

        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();

        await expectConverged(h);
      });

      it("keeps a pending delete of the file, and writes the other document at the path", async () => {
        const h = await parkedWithPendingEdit(windowsDevice(), true);

        await h.engine.pull();
        await h.engine.push();

        expect(await files(h.vault)).toEqual(new Map([["plan.md", "another note\n"]]));
        // The user's delete is not dropped with the release: it waits for the document to come back.
        expect(await h.journal.listPending()).toEqual([expect.objectContaining({ documentId: "doc", deleted: true })]);
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["plan.md", "other"],
            ["plan|draft.md", "doc"],
          ]),
        );
      });

      // #398: the stale edit pending at plan.md, with the file deleted, made
      // the document take the other document's file there for its own once a
      // remote rename gave it a legal name again.
      it("never takes the other document's file for the parked document's own after the user deleted the edited file", async () => {
        const h = await parkedWithPendingEdit();
        await h.vault.delete("plan.md");

        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();

        expect(await files(h.vault)).toEqual(new Map([["plan.md", "another note\n"]]));
        expect(await h.journal.listPending()).toEqual([]);

        h.server.commit({ documentId: "doc", path: "draft.md" });
        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();

        expect(await files(h.vault)).toEqual(
          new Map([
            ["draft.md", "one\ntwo\n"],
            ["plan.md", "another note\n"],
          ]),
        );
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["draft.md", "doc"],
            ["plan.md", "other"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["draft.md", "one\ntwo\n"],
            ["plan.md", "another note\n"],
          ]),
        );
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(await reported(h)).toEqual([]);
      });

      it("lets a parked document follow its file a local rename moved, the other document untouched", async () => {
        const h = await parkedWithPendingEdit();
        await h.vault.rename("plan.md", "notes.md");

        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();
        h.server.commit({ documentId: "doc", path: "draft.md" });
        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();

        // The local rename wins over the remote one, with the edit: the other document keeps its path and id.
        expect(await files(h.vault)).toEqual(
          new Map([
            ["notes.md", "one\ntwo (edited)\n"],
            ["plan.md", "another note\n"],
          ]),
        );
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["notes.md", "doc"],
            ["plan.md", "other"],
          ]),
        );
        expect(h.server.liveFiles().get("notes.md")).toBe("one\ntwo (edited)\n");
        expect(h.server.liveFiles().get("plan.md")).toBe("another note\n");
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
      });

      it("brings the parked document back at its legal name with its pending delete, the other document untouched", async () => {
        const h = await parkedWithPendingEdit(windowsDevice(), true);

        await h.engine.pull();
        await h.engine.push();
        h.server.commit({ documentId: "doc", path: "draft.md" });
        await h.engine.pull();
        await h.engine.push();
        await h.engine.pull();
        await h.engine.push();

        // The remote rename wins over the concurrent local delete (SPEC.md §6.3): the document stays, at its new path.
        expect(await files(h.vault)).toEqual(
          new Map([
            ["draft.md", "one\ntwo\n"],
            ["plan.md", "another note\n"],
          ]),
        );
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["draft.md", "doc"],
            ["plan.md", "other"],
          ]),
        );
        expect(h.server.liveFiles().get("plan.md")).toBe("another note\n");
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
      });

      it("commits a pending local rename and edit as the document's own, and writes the other document at the old path", async () => {
        const h = windowsDevice();
        h.server.commit({ documentId: "doc", path: "plan.md", content: "one\ntwo\n" });
        await h.engine.pull();
        await h.vault.rename("plan.md", "notes.md");
        await h.vault.write("notes.md", bytes("one\ntwo (edited)\n"));
        let renamed = false;
        h.server.interceptor = (method) => {
          if (method !== "CommitRevision" || renamed) return;
          renamed = true;
          h.server.commit({ documentId: "doc", path: "plan|draft.md" });
        };
        await h.engine.push();
        h.server.interceptor = undefined;
        h.server.commit({ documentId: "other", path: "plan.md", content: "another note\n" });

        await h.engine.pull();
        await h.engine.push();

        expect(await files(h.vault)).toEqual(
          new Map([
            ["notes.md", "one\ntwo (edited)\n"],
            ["plan.md", "another note\n"],
          ]),
        );
        // The rename and the edit are the document's, committed under its id: neither became a copy.
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["notes.md", "doc"],
            ["plan.md", "other"],
          ]),
        );
        expect(h.server.liveFiles().get("notes.md")).toBe("one\ntwo (edited)\n");
        expect(await h.journal.listPending()).toEqual([]);
      });

      it("converges with the edit kept when interrupted at any durable change of the release", async () => {
        let crashed = 0;
        let released = 0;
        for (let crashAfter = 1; ; crashAfter++) {
          const points = new CrashPoints();
          const h = await parkedWithPendingEdit(harness({ merge: "default", pathRules: windows, journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) }));
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
          // The window between the release record and the conflict copy's write.
          const vault = await files(h.vault);
          if ((await h.journal.getDocument("doc"))?.deleted === true && vault.size === 1 && vault.get("plan.md") === "one\ntwo (edited)\n") released++;
          h.restart();

          await h.engine.push();
          await h.engine.pull();
          await h.engine.push();
          await h.engine.pull();

          await expectConverged(h, `crash after durable change ${String(crashAfter)}`);
        }
        // At least: the dropped operation, the release record, and the conflict copy's write.
        expect(crashed).toBeGreaterThanOrEqual(3);
        expect(released).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("given a vault that refuses a path the rules allow", () => {
    it("tracks the document as unmaterializable instead of failing the pull", async () => {
      // The engine follows POSIX rules, but the vault refuses `CON.md` as Windows does.
      const h = harness({ merge: "default", vault: new InMemoryVault({ pathRules: windows }) });
      h.server.commit({ documentId: "doc", path: "CON.md", content: "x" });
      h.server.commit({ documentId: "next", path: "next.md", content: "y" });

      const summary = await h.engine.pull();

      expect(summary.cursor).toBe(h.server.currentHeadSeq);
      expect(await files(h.vault)).toEqual(new Map([["next.md", "y"]]));
      expect(await reported(h)).toEqual([{ path: "CON.md", reason: "refused-by-vault", localPath: undefined }]);

      // Tried again after a restart, and still refused: still tracked, nothing committed.
      h.restart();
      await h.engine.push();
      expect(await reported(h)).toEqual([{ path: "CON.md", reason: "refused-by-vault", localPath: undefined }]);
      expect(h.acknowledged).toEqual([]);
    });
  });

  describe("given rules that allow a path they refused before", () => {
    it("materializes the document on the next start's push", async () => {
      // The vault moved to a shorter folder: a path over MAX_PATH there fits now.
      const journal = new InMemoryJournal();
      const vault = new InMemoryVault({ pathRules: windows });
      const path = `${"a".repeat(100)}/b.md`;
      const before = harness({ merge: "default", journal, vault, pathRules: { platform: "windows", root: `C:\\${"r".repeat(200)}` } });
      before.server.commit({ documentId: "doc", path, content: "x" });
      await before.engine.pull();
      expect(await reported(before)).toEqual([{ path, reason: "path-too-long", localPath: undefined }]);
      before.engine.dispose();

      const after = harness({ merge: "default", server: before.server, journal, vault, pathRules: { platform: "windows", root: "C:\\v" } });
      await after.engine.push();

      expect(await files(vault)).toEqual(new Map([[path, "x"]]));
      expect(await reported(after)).toEqual([]);
    });
  });

  describe("conflict copies", () => {
    it("are named so the platform can hold them", async () => {
      // A note whose path nearly fills MAX_PATH: its conflict copy's name must be shortened to fit.
      const path = `${"a".repeat(200)}/${"n".repeat(50)}.md`;
      const h = windowsDevice();
      h.server.commit({ documentId: "doc", path, content: "base\n" });
      await h.engine.pull();
      await h.vault.write(path, bytes("local\n"));
      h.server.commit({ documentId: "doc", path, content: "remote\n" });

      await h.engine.push();

      const local = [...(await files(h.vault))].filter(([candidate]) => candidate !== path);
      expect(local).toHaveLength(1);
      const [copy, content] = local[0] ?? [];
      expect(content).toBe("local\n");
      expect(copy?.length).toBeLessThanOrEqual(259);
      expect(copy).not.toBe(copyOf(`${"a".repeat(200)}/${"n".repeat(50)}`, ".md"));
      expect(h.server.liveFiles().get(copy ?? "")).toBe("local\n");
    });
  });

  describe("on a case-insensitive platform", () => {
    for (const platform of ["windows", "macos"] as const) {
      it(`keeps a local file and a remote document whose paths differ only by case apart, losing neither (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        await h.vault.write("Notes.md", bytes("local\n"));
        h.server.commit({ documentId: "remote", path: "notes.md", content: "remote\n" });

        await h.engine.push();
        await h.engine.push();

        // The remote document holds the path; the local file is a conflict copy.
        const live = h.server.liveFiles();
        expect([...live.values()].sort()).toEqual(["local\n", "remote\n"]);
        expect(live.get("notes.md")).toBe("remote\n");
        const vault = await files(h.vault);
        expect([...vault.values()].sort()).toEqual(["local\n", "remote\n"]);
        // What the vault holds is what the server holds, spelled the same, one file per document.
        expect(vault).toEqual(live);
        expect(await h.journal.listPending()).toEqual([]);
        // The engine's own writes are not taken for the user's.
        expect(h.localChanges).toEqual([{ type: "create", path: "Notes.md" }]);
      });

      it(`never writes a conflict copy over a file of another spelling (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "doc", path: "notes.md", content: "base\n" });
        await h.engine.pull();
        // An unrelated file named like the copy the conflict below would get, but for case.
        const lookalike = copyOf("NOTES", ".md");
        await h.vault.write(lookalike, bytes("unrelated\n"));
        await h.vault.write("notes.md", bytes("local\n"));
        h.server.commit({ documentId: "doc", path: "notes.md", content: "remote\n" });

        await h.engine.push();

        const vault = await files(h.vault);
        expect([...vault.values()].sort()).toEqual(["local\n", "remote\n", "unrelated\n"]);
        expect(vault.get(lookalike)).toBe("unrelated\n");
        expect([...h.server.liveFiles().values()].sort()).toEqual(["local\n", "remote\n", "unrelated\n"]);
      });

      it(`pushes a local rename that changes only letter case as a rename (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "doc", path: "notes.md", content: "text\n" });
        await h.engine.pull();
        await h.vault.rename("notes.md", "Notes.md");

        await h.engine.push();

        expect(h.server.liveDocuments()).toEqual(new Map([["Notes.md", "doc"]]));
        expect(await h.vault.list()).toEqual(["Notes.md"]);
      });

      it(`applies a remote rename that changes only letter case (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "doc", path: "notes.md", content: "text\n" });
        await h.engine.pull();
        h.server.commit({ documentId: "doc", path: "NOTES.md", content: "text 2\n" });

        await h.engine.pull();
        h.restart();
        await h.engine.push();

        expect(await files(h.vault)).toEqual(new Map([["NOTES.md", "text 2\n"]]));
        expect(h.server.liveDocuments()).toEqual(new Map([["NOTES.md", "doc"]]));
        expect(h.acknowledged).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
      });

      it(`takes a document's file under another spelling for the document's own after a restart (${platform})`, async () => {
        // A file the vault already spells differently, e.g. after the user
        // renamed it while the app was closed: it is the document's file,
        // never a new document.
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "doc", path: "notes.md", content: "text\n" });
        await h.engine.pull();
        h.engine.dispose();
        const content = await h.vault.read("notes.md");
        await h.vault.delete("notes.md");
        await h.vault.write("NOTES.md", content);

        h.restart();
        const summary = await h.engine.push();

        expect(summary.committed).toBe(0);
        expect(h.server.liveDocuments()).toEqual(new Map([["notes.md", "doc"]]));
        expect(await files(h.vault)).toEqual(new Map([["NOTES.md", "text\n"]]));
      });
    }
  });
});
