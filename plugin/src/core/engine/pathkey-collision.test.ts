import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { pathKey } from "../pathkey/pathkey";
import type { PushSummary } from "./engine";
import { threeWayMerge, type MergeHook } from "./merge";
import { byFolderCase, copyOf, files, harness, moveHeadBeforeCommit, type Harness } from "./testing";

// Collisions by path key (SPEC.md §5, §6.3, §7): the server refuses a
// document whose path equals another live document's ignoring case and
// Unicode form. The engine then keeps both versions, each under its own
// document id, and never deletes or moves the other device's document.
// Regressions of the simulation's seeds 1 and 2 (#242, macOS engine) and
// seed 5 (#243, POSIX engine).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/**
 * Pairs of paths the server takes for one: by case, and by full case folding
 * (ß folds to ss). `held` is where the vault holds the remote document once
 * the local file has made its folder: a folder has one spelling on disk, so
 * notes/c.md is held in Notes/ (INV-9, #737, #659).
 */
const collisions = [
  { local: "Notes/C.md", remote: "notes/c.md", held: "Notes/c.md" },
  { local: "straße.md", remote: "STRASSE.md", held: "STRASSE.md" },
] as const;

/** The live documents, by path, that are not `documentId`: what the local version became. */
function others(h: Harness, documentId: string): Map<string, string> {
  const live = h.server.liveFiles();
  const documents = h.server.liveDocuments();
  return new Map([...live].filter(([path]) => documents.get(path) !== documentId));
}

/** Pushes until a push commits nothing, at most `limit` times. */
async function pushUntilQuiet(h: Harness, limit = 5): Promise<PushSummary[]> {
  const summaries: PushSummary[] = [];
  for (let push = 0; push < limit; push++) {
    const summary = await h.engine.push();
    summaries.push(summary);
    if (summary.committed === 0 && summary.conflicts === 0) break;
  }
  return summaries;
}

/** Asserts that the other device's document is untouched at its path, and that the vault shows what the server holds. */
async function expectRemoteKept(h: Harness, remotePath: string, summaries: PushSummary[]): Promise<void> {
  expect(h.server.liveDocuments().get(remotePath)).toBe("theirs");
  // Never deleted, moved or overwritten: its only revision is the other device's.
  expect(h.server.history("theirs")).toHaveLength(1);
  // A folder has one spelling on disk, so the vault may hold the server's
  // notes/c.md in the Notes/ folder the local file made (INV-9, #737, #659).
  expect(byFolderCase(await files(h.vault))).toEqual(byFolderCase(h.server.liveFiles()));
  expect(await h.journal.listPending()).toEqual([]);
  expect(await h.journal.listDeferred()).toEqual([]);
  expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
  expect(summaries.at(-1)).toMatchObject({ committed: 0, conflicts: 0, pending: 0 });
  // No two live documents share a path key.
  const keys = [...h.server.liveFiles().keys()].map(pathKey);
  expect(new Set(keys).size).toBe(keys.length);
}

describe("SyncEngine collisions by path key", () => {
  describe("on a case-insensitive platform, given a local file that collides with another device's document (#242)", () => {
    for (const platform of ["macos", "windows"] as const) {
      for (const { local, remote, held } of collisions) {
        it(`keeps the other device's document at ${remote} when a create at ${local} is refused (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write(local, bytes("mine\n"));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: remote, content: "theirs\n" }));

          const summaries = await pushUntilQuiet(h);

          await expectRemoteKept(h, remote, summaries);
          expect([...others(h, "theirs").values()]).toEqual(["mine\n"]);
          // The engine's own moves and writes are not the user's changes.
          expect(h.localChanges).toEqual([{ type: "create", path: local }]);
        });

        it(`keeps the other device's document at ${remote} when a known document's rename to ${local} is refused (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write("draft.md", bytes("mine\n"));
          await h.engine.push();
          const mine = h.server.liveDocuments().get("draft.md");
          await h.vault.rename("draft.md", local);
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: remote, content: "theirs\n" }));

          const summaries = await pushUntilQuiet(h);

          await expectRemoteKept(h, remote, summaries);
          // The renamed document keeps its id, at a conflict-copy path of its own name.
          const copy = [...h.server.liveDocuments()].find(([, documentId]) => documentId === mine)?.[0];
          expect(copy).toBe(copyOf(local.slice(0, -".md".length), ".md"));
          expect(h.server.liveFiles().get(copy ?? "")).toBe("mine\n");
          expect(h.server.history(mine ?? "").every((revision) => !revision.deleted)).toBe(true);
          expect(h.localChanges).toEqual([
            { type: "create", path: "draft.md" },
            { type: "rename", path: local, oldPath: "draft.md" },
          ]);
        });

        it(`keeps the other device's document at ${remote} when it arrives before a known document's rename to ${local} is pushed (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write("draft.md", bytes("mine\n"));
          await h.engine.push();
          const mine = h.server.liveDocuments().get("draft.md");
          await h.vault.rename("draft.md", local);
          h.server.commit({ documentId: "theirs", path: remote, content: "theirs\n" });

          await h.engine.pull();
          const summaries = await pushUntilQuiet(h);

          await expectRemoteKept(h, remote, summaries);
          const copy = [...h.server.liveDocuments()].find(([, documentId]) => documentId === mine)?.[0];
          expect(copy).toBe(copyOf(local.slice(0, -".md".length), ".md"));
          expect(h.server.liveFiles().get(copy ?? "")).toBe("mine\n");
          expect(h.server.history(mine ?? "").every((revision) => !revision.deleted)).toBe(true);
          expect(h.localChanges).toEqual([
            { type: "create", path: "draft.md" },
            { type: "rename", path: local, oldPath: "draft.md" },
          ]);
        });

        it(`drops the pending create at ${local} once a pull keeps its file as a conflict copy of ${remote}, without committing it again (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write(local, bytes("mine\n"));
          // The create's content is uploaded, but its commit never gets through.
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          h.server.commit({ documentId: "theirs", path: remote, content: "theirs\n" });

          await h.engine.pull();
          const summaries = await pushUntilQuiet(h);

          await expectRemoteKept(h, remote, summaries);
          expect([...others(h, "theirs").values()]).toEqual(["mine\n"]);
          // The conflict copy holds the create's content, so the create is never sent again.
          expect(summaries.reduce((total, summary) => total + summary.conflicts, 0)).toBe(0);
          expect(h.localChanges).toEqual([{ type: "create", path: local }]);
        });

        it(`keeps the other device's document at ${remote}, and the user's later edit of it, when a pull takes a refused create's identical file at ${local} for it (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write(local, bytes("same\n"));
          // The create's content is uploaded, but its commit never gets through.
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          h.server.commit({ documentId: "theirs", path: remote, content: "same\n" });

          await h.engine.pull();
          // The file is now the other device's document, so the create is superseded.
          expect(await h.journal.listPending()).toEqual([]);
          await h.vault.write(remote, bytes("edited\n"));
          const summaries = await pushUntilQuiet(h);

          // The edit is committed as the other device's document's, never tombstoning or moving it.
          expect(h.server.liveFiles()).toEqual(new Map([[remote, "edited\n"]]));
          expect(h.server.liveDocuments().get(remote)).toBe("theirs");
          expect(h.server.history("theirs").map((revision) => revision.deleted)).toEqual([false, false]);
          expect(byFolderCase(await files(h.vault))).toEqual(byFolderCase(h.server.liveFiles()));
          expect(await h.journal.listPending()).toEqual([]);
          expect(await h.journal.listDeferred()).toEqual([]);
          expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
          expect(h.localChanges).toEqual([
            { type: "create", path: local },
            { type: "modify", path: held },
          ]);
        });

        it(`keeps the other device's document at ${remote}, and the user's edit of it, when a journal from an earlier version still holds the create at ${local} (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write(local, bytes("same\n"));
          // The create's content is uploaded, but its commit never gets through.
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          const stale = await h.journal.listPending();
          h.server.commit({ documentId: "theirs", path: remote, content: "same\n" });
          await h.engine.pull();
          // The journal as an engine without the fix above left it: the
          // superseded create still pending at the other document's file.
          for (const operation of stale) await h.journal.addPending(operation);
          await h.vault.write(remote, bytes("edited\n"));

          const summaries = await pushUntilQuiet(h);

          // The refused create is dropped, and the edit is the other device's document's.
          expect(h.server.liveFiles()).toEqual(new Map([[remote, "edited\n"]]));
          expect(h.server.liveDocuments().get(remote)).toBe("theirs");
          expect(h.server.history("theirs").map((revision) => revision.deleted)).toEqual([false, false]);
          expect(byFolderCase(await files(h.vault))).toEqual(byFolderCase(h.server.liveFiles()));
          expect(await h.journal.listPending()).toEqual([]);
          expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
          expect(summaries.at(-1)).toMatchObject({ committed: 0, conflicts: 0, pending: 0 });
        });

        it(`keeps the other device's document at ${remote} when a known document's rename to ${local} holds the same content (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write("draft.md", bytes("same\n"));
          await h.engine.push();
          const mine = h.server.liveDocuments().get("draft.md");
          await h.vault.rename("draft.md", local);
          h.server.commit({ documentId: "theirs", path: remote, content: "same\n" });

          await h.engine.pull();
          const summaries = await pushUntilQuiet(h);

          await expectRemoteKept(h, remote, summaries);
          // The renamed document keeps its id and content, at a conflict-copy path of its own name.
          const copy = [...h.server.liveDocuments()].find(([, documentId]) => documentId === mine)?.[0];
          expect(copy).toBe(copyOf(local.slice(0, -".md".length), ".md"));
          expect(h.server.liveFiles().get(copy ?? "")).toBe("same\n");
          expect(h.server.history(mine ?? "").every((revision) => !revision.deleted)).toBe(true);
          expect(h.localChanges).toEqual([
            { type: "create", path: "draft.md" },
            { type: "rename", path: local, oldPath: "draft.md" },
          ]);
        });

        it(`never moves the other device's document at ${remote} for a refused create at ${local} whose file the user deleted (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          await h.vault.write(local, bytes("mine\n"));
          // The create's content is uploaded, but its commit never gets through.
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          await h.vault.delete(local);
          h.server.commit({ documentId: "theirs", path: remote, content: "theirs\n" });

          const summaries = await pushUntilQuiet(h);

          expect(h.server.liveFiles()).toEqual(new Map([[remote, "theirs\n"]]));
          expect(h.server.history("theirs")).toHaveLength(1);
          expect(await files(h.vault)).toEqual(new Map([[remote, "theirs\n"]]));
          // The create, whose file is gone, is dropped rather than refused on every push.
          expect(await h.journal.listPending()).toEqual([]);
          expect(summaries.at(-1)).toMatchObject({ committed: 0, conflicts: 0, pending: 0 });
        });
      }
    }
  });

  describe("given a known document's edited file at the path of another device's new document with the same content (#264)", () => {
    const cases = [
      { platform: "posix", remote: "d.md" },
      { platform: "macos", remote: "D.md" },
      { platform: "windows", remote: "D.md" },
    ] as const;
    for (const { platform, remote } of cases) {
      it(`keeps both documents live when the known document's remote rename was deferred and the new document arrives at ${remote} (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "d", path: "d.md", content: "base\n" });
        await h.engine.pull();
        await h.vault.write("d.md", bytes("same\n"));
        // A folder of the user's is in the way of the document's remote rename.
        await h.vault.write("moved.md/x.md", bytes("x\n"));
        // The edit's content is uploaded, but its commit never gets through.
        h.server.interceptor = (method) => {
          if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
        };
        await expect(h.engine.push()).rejects.toThrow();
        h.server.interceptor = undefined;
        h.server.commit({ documentId: "d", path: "moved.md", content: "base\n" });
        h.server.commit({ documentId: "theirs", path: remote, content: "same\n" });

        await h.engine.pull();
        await h.vault.delete("moved.md/x.md");
        const summaries = await pushUntilQuiet(h);

        // The known document moved with its edit; the other device's document is untouched.
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["moved.md", "d"],
            [remote, "theirs"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["moved.md", "same\n"],
            [remote, "same\n"],
          ]),
        );
        expect(h.server.history("theirs")).toHaveLength(1);
        expect(h.server.history("d").every((revision) => !revision.deleted)).toBe(true);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
        expect(summaries.at(-1)).toMatchObject({ committed: 0, conflicts: 0, pending: 0 });
      });
    }
  });

  describe("given a known document with no local edit at the path of another device's new document with the same content (#269 item 1)", () => {
    const cases = [
      { platform: "posix", remote: "d.md" },
      { platform: "macos", remote: "D.md" },
    ] as const;
    for (const { platform, remote } of cases) {
      it(`keeps both documents live when the known document's remote rename was refused by a folder and the new document arrives at ${remote} (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "d", path: "d.md", content: "base\n" });
        await h.engine.pull();
        // A folder of the user's is in the way of the document's remote rename,
        // so the rename is deferred with nothing edited locally.
        await h.vault.write("moved.md/x.md", bytes("x\n"));
        h.server.commit({ documentId: "d", path: "moved.md", content: "base\n" });
        await h.engine.pull();
        expect(await h.journal.listDeferred()).toMatchObject([{ revision: { documentId: "d" }, reason: "path-conflict" }]);
        h.server.commit({ documentId: "theirs", path: remote, content: "base\n" });

        await h.engine.pull();
        // The file at the path is still the known document's, so the new
        // document waits rather than taking it.
        expect(await h.journal.findDocumentByPath("d.md")).toMatchObject({ documentId: "d" });
        await h.vault.delete("moved.md/x.md");
        // The first push moves the known document once nothing is in the way;
        // the new document's merge, asked before that move, waits for the next.
        await h.engine.push();
        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["moved.md", "d"],
            [remote, "theirs"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["moved.md", "base\n"],
            [remote, "base\n"],
          ]),
        );
        expect(h.server.history("theirs")).toHaveLength(1);
        expect(h.server.history("d").every((revision) => !revision.deleted)).toBe(true);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });

  describe("given a known document's revision at a path a pending rename of another document holds, with the same content (#267)", () => {
    const cases = [
      { platform: "posix", held: "a.md" },
      { platform: "macos", held: "A.md" },
    ] as const;
    for (const { platform, held } of cases) {
      it(`moves the renamed document to a path-taken copy and tombstones nothing (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
        h.server.commit({ documentId: "B", path: "b.md", content: "b\n" });
        await h.engine.pull();
        await h.vault.rename("a.md", "z.md");
        await h.engine.push();
        expect(h.server.liveDocuments().get("z.md")).toBe("A");
        await h.vault.rename("b.md", held);
        // The rename's commit never gets through, so it stays pending.
        h.server.interceptor = (method) => {
          if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
        };
        await expect(h.engine.push()).rejects.toThrow();
        h.server.interceptor = undefined;
        await h.vault.delete("z.md");
        // Another device moves A back, with content identical to B's.
        h.server.commit({ documentId: "A", path: "a.md", content: "b\n" });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        const copy = copyOf(held.slice(0, -3), ".md");
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["a.md", "A"],
            [copy, "B"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["a.md", "b\n"],
            [copy, "b\n"],
          ]),
        );
        expect(h.server.history("A").every((revision) => !revision.deleted)).toBe(true);
        expect(h.server.history("B").every((revision) => !revision.deleted)).toBe(true);
        expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "B", reason: "path-taken", path: held, copyPath: copy }]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
        expect(summaries.at(-1)).toMatchObject({ committed: 0, conflicts: 0, pending: 0 });
      });
    }
  });

  describe("given a known document's revision at its own synced path, which it moved away from and another document's local rename took (#267)", () => {
    // The journal still has A at a.md, but A's file was moved away (and then
    // deleted), and B's file is at a.md now.
    const cases = [
      { push: "not pushed", content: "b\n" },
      { push: "pending", content: "b\n" },
      { push: "not pushed", content: "c\n" },
      { push: "pending", content: "c\n" },
    ] as const;
    for (const { push, content } of cases) {
      it(`moves the renamed document to a path-taken copy when the remote edit brings ${content === "b\n" ? "its" : "other"} content and the local renames are ${push}`, async () => {
        const h = harness({ merge: "default" });
        h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
        h.server.commit({ documentId: "B", path: "b.md", content: "b\n" });
        await h.engine.pull();
        await h.vault.rename("a.md", "z.md");
        await h.vault.rename("b.md", "a.md");
        if (push === "pending") {
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          expect(await h.journal.listPending()).not.toEqual([]);
        } else {
          await h.engine.settled();
        }
        await h.vault.delete("z.md");
        h.server.commit({ documentId: "A", path: "a.md", content });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        const copy = copyOf("a", ".md");
        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["a.md", "A"],
            [copy, "B"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["a.md", content],
            [copy, "b\n"],
          ]),
        );
        expect(h.server.history("A").every((revision) => !revision.deleted)).toBe(true);
        expect(h.server.history("B").every((revision) => !revision.deleted)).toBe(true);
        expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "B", reason: "path-taken", path: "a.md", copyPath: copy }]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }

    it("never takes a file the journal has for another document, whose remote rename away is deferred, for a known document moved there", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "d", path: "d.md", content: "base\n" });
      h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
      await h.engine.pull();
      // A folder of the user's is in the way of d's remote rename.
      await h.vault.write("moved.md/x.md", bytes("x\n"));
      h.server.commit({ documentId: "d", path: "moved.md", content: "base\n" });
      await h.engine.pull();
      await h.vault.delete("a.md");
      // Another device moves A to d.md, with d's content.
      h.server.commit({ documentId: "A", path: "d.md", content: "base\n" });

      await h.engine.pull();
      expect(await h.journal.findDocumentByPath("d.md")).toMatchObject({ documentId: "d" });
      await h.vault.delete("moved.md/x.md");
      await h.engine.push();
      const summaries = await pushUntilQuiet(h);

      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["d.md", "A"],
          ["moved.md", "d"],
        ]),
      );
      expect(h.server.history("A").every((revision) => !revision.deleted)).toBe(true);
      expect(h.server.history("d").every((revision) => !revision.deleted)).toBe(true);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
    });

    it("leaves the renamed document at the path when the remote revision deletes the known document", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
      h.server.commit({ documentId: "B", path: "b.md", content: "b\n" });
      await h.engine.pull();
      await h.vault.rename("a.md", "z.md");
      await h.vault.rename("b.md", "a.md");
      await h.engine.settled();
      await h.vault.delete("z.md");
      h.server.commit({ documentId: "A", path: "a.md", deleted: true });

      await h.engine.pull();
      const summaries = await pushUntilQuiet(h);

      expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "B"]]));
      expect(h.server.history("B").every((revision) => !revision.deleted)).toBe(true);
      expect(await h.journal.listConflicts()).toEqual([]);
      expect(await files(h.vault)).toEqual(new Map([["a.md", "b\n"]]));
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
    });
  });

  describe("given a swap of two documents' names by local renames, with a concurrent remote edit of the renamed-away document (review of #278)", () => {
    // A local rename wins over a remote edit (SPEC.md §7): A's edit follows
    // it to z.md, so a.md is never needed for A and B keeps it.
    const cases = [
      { push: "not pushed", content: "b\n" },
      { push: "pending", content: "b\n" },
      // B's file holds A's synced content, so only the rename tells it apart.
      { push: "not pushed", content: "a\n" },
      { push: "pending", content: "a\n" },
    ] as const;
    for (const { push, content } of cases) {
      it(`keeps the user's renames when the renames are ${push} and the renamed-in document holds ${content === "a\n" ? "the other's synced" : "its own"} content`, async () => {
        const h = harness({ merge: "default" });
        h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
        h.server.commit({ documentId: "B", path: "b.md", content });
        await h.engine.pull();
        await h.vault.rename("a.md", "z.md");
        await h.vault.rename("b.md", "a.md");
        if (push === "pending") {
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          expect(await h.journal.listPending()).not.toEqual([]);
        } else {
          await h.engine.settled();
        }
        h.server.commit({ documentId: "A", path: "a.md", content: "a remote\n" });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(
          new Map([
            ["z.md", "A"],
            ["a.md", "B"],
          ]),
        );
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["z.md", "a remote\n"],
            ["a.md", content],
          ]),
        );
        expect(h.server.history("A").every((revision) => !revision.deleted)).toBe(true);
        expect(h.server.history("B").every((revision) => !revision.deleted)).toBe(true);
        expect(await h.journal.listConflicts()).toEqual([]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      it(`keeps both documents, each at the path the user gave it, when the renames are ${push}, the renamed-in document holds ${content === "a\n" ? "the other's synced" : "its own"} content and the remote revision deletes the renamed-away document`, async () => {
        const h = harness({ merge: "default" });
        h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
        h.server.commit({ documentId: "B", path: "b.md", content });
        await h.engine.pull();
        await h.vault.rename("a.md", "z.md");
        await h.vault.rename("b.md", "a.md");
        if (push === "pending") {
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
        } else {
          await h.engine.settled();
        }
        h.server.commit({ documentId: "A", path: "a.md", deleted: true });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        // A rename wins over a concurrent delete (SPEC.md §7): A's file stays
        // at z.md (under a new id, as for any rename of a document deleted
        // remotely), and B is never touched.
        const documents = h.server.liveDocuments();
        expect(documents.get("a.md")).toBe("B");
        expect(documents.get("z.md")).toEqual(expect.any(String));
        expect(documents.get("z.md")).not.toBe("B");
        expect(documents.size).toBe(2);
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["z.md", "a\n"],
            ["a.md", content],
          ]),
        );
        expect(h.server.history("B").every((revision) => !revision.deleted)).toBe(true);
        expect(await h.journal.listConflicts()).toEqual([]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });

  describe("on a case-insensitive platform, given a note renamed and then deleted locally, while another device creates a note at the rename's target in another case and edits the first note (#323)", () => {
    // The file at the rename's target is the other note's, not this note's
    // local version: the user's delete stands against the remote edit, which
    // wins (SPEC.md §7), so the note comes back at its path.
    for (const platform of ["macos", "windows"] as const) {
      it(`applies the edit at the note's path and leaves the other note untouched under ${platform} rules`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "C", path: "notes/c.md", content: "c\n" });
        await h.engine.pull();
        await h.vault.rename("notes/c.md", "a.md");
        await h.vault.delete("a.md");
        h.server.commit({ documentId: "A", path: "A.md", content: "A\n" });
        h.server.commit({ documentId: "C", path: "notes/c.md", content: "c\nedited\n" });

        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["A.md", "A\n"],
            ["notes/c.md", "c\nedited\n"],
          ]),
        );
        expect(h.server.history("A")).toHaveLength(1);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });

  describe("given a note renamed onto the path another note was renamed away from, with a concurrent remote edit of the first note (#323)", () => {
    // The file at the rename's target is the renamed note's: the other note
    // the journal has there moved away. The edit follows the rename.
    const cases = [
      { platform: "posix", target: "a.md" },
      { platform: "windows", target: "a.md" },
      { platform: "windows", target: "A.md" },
    ] as const;
    for (const { platform, target } of cases) {
      it(`merges the edit into the renamed file at ${target} under ${platform} rules`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
        h.server.commit({ documentId: "B", path: "b.md", content: "b\n" });
        await h.engine.pull();
        await h.vault.rename("a.md", "z.md");
        await h.vault.rename("b.md", target);
        h.server.commit({ documentId: "B", path: "b.md", content: "b\nedited\n" });

        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["z.md", "a\n"],
            [target, "b\nedited\n"],
          ]),
        );
        expect(h.server.liveDocuments().get(target)).toBe("B");
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });

  describe("given conflict copies whose names collide by path key (#243)", () => {
    it("gives two local files that collide with one remote document copies free by path key, and syncs both (posix)", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("Notes/C.md", bytes("mine 1\n"));
      await h.vault.write("notes/c.md", bytes("mine 2\n"));
      h.server.commit({ documentId: "theirs", path: "Notes/C.md", content: "theirs\n" });

      const summaries = await pushUntilQuiet(h);

      await expectRemoteKept(h, "Notes/C.md", summaries);
      expect([...others(h, "theirs").values()].sort()).toEqual(["mine 1\n", "mine 2\n"]);
      // Refused once, for notes/c.md itself: its copy's name was free by path key the first time.
      expect(summaries.reduce((total, summary) => total + summary.conflicts, 0)).toBe(1);
      expect(h.localChanges).toEqual([
        { type: "create", path: "Notes/C.md" },
        { type: "create", path: "notes/c.md" },
      ]);
    });

    it("never names a copy after the path, by path key, of a document whose remote revision the merge path holds (posix)", async () => {
      // The merge hook holds back the remote rename of d.md to a name that
      // collides by path key with the copy a refused create would get first.
      const holdD: MergeHook = (request) => (request.remote.documentId === "d" ? Promise.resolve({ status: "deferred" }) : threeWayMerge(request));
      const h = harness({ merge: holdD });
      h.server.commit({ documentId: "d", path: "d.md", content: "base\n" });
      await h.engine.pull();
      await h.vault.write("d.md", bytes("edited\n"));
      h.server.commit({ documentId: "d", path: copyOf("NEW", ".md"), content: "remote\n" });
      await h.vault.write("new.md", bytes("mine\n"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "NEW.md", content: "theirs\n" }));

      const summaries = await pushUntilQuiet(h);

      const copy = copyOf("new", ".md").replace(")", " 2)");
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["NEW.md", "theirs\n"],
          [copyOf("NEW", ".md"), "remote\n"],
          [copy, "mine\n"],
        ]),
      );
      // Refused once, for new.md itself: the copy's first name was taken by d's held revision.
      expect(summaries.reduce((total, summary) => total + summary.conflicts, 0)).toBe(1);
      expect(await files(h.vault)).toEqual(
        new Map([
          ["NEW.md", "theirs\n"],
          [copy, "mine\n"],
          ["d.md", "edited\n"],
        ]),
      );
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("moves a conflict copy on to a new free name when another device's document takes its path by path key first (posix)", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("new.md", bytes("mine\n"));
      let commits = 0;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision") return;
        commits++;
        // Before the create, another device creates NEW.md; before the
        // create's retry at its conflict-copy path, one creates that path in
        // another case.
        if (commits === 1) h.server.commit({ documentId: "theirs", path: "NEW.md", content: "theirs\n" });
        if (commits === 2) h.server.commit({ documentId: "other", path: copyOf("NEW", ".md"), content: "other\n" });
      };

      const summaries = await pushUntilQuiet(h);

      await expectRemoteKept(h, "NEW.md", summaries);
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["NEW.md", "theirs\n"],
          [copyOf("NEW", ".md"), "other\n"],
          [copyOf("new", ".md").replace(")", " 2)"), "mine\n"],
        ]),
      );
    });
  });

  describe("given a remote rename out of a file whose path key names the destination's folder (#319)", () => {
    // Simulation seed-24-drift (POSIX engine): another device creates the
    // file NOTES and renames it to notes/c.md, while the user creates
    // notes/c.md here. The renamed document takes the path and the user's
    // file becomes a conflict copy in notes/. NOTES is the document's own
    // file, which the rename moves away, so it never makes notes/ a file's
    // path by path key that no copy can go in.
    it("keeps the user's file as a conflict copy next to the renamed document, and syncs both (posix)", async () => {
      const h = harness({ merge: "default", pathRules: { platform: "posix" } });
      h.server.commit({ documentId: "N", path: "NOTES", content: "theirs\n" });
      await h.engine.pull();
      h.server.commit({ documentId: "N", path: "notes/c.md" });
      await h.vault.write("notes/c.md", bytes("mine\n"));

      const pulled = await h.engine.pull();
      const summaries = await pushUntilQuiet(h);

      expect(pulled.merged).toBe(1);
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["notes/c.md", "theirs\n"],
          [`notes/${copyOf("c", ".md")}`, "mine\n"],
        ]),
      );
      expect(h.server.liveDocuments().get("notes/c.md")).toBe("N");
      expect(h.server.history("N").every((revision) => !revision.deleted)).toBe(true);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
    });

    it("takes the path for the renamed document when the user's file arrived in the same pull (posix)", async () => {
      // The seed's pull: the create at NOTES and its rename come in one feed.
      const h = harness({ merge: "default", pathRules: { platform: "posix" } });
      h.server.commit({ documentId: "N", path: "NOTES", content: "theirs\n" });
      h.server.commit({ documentId: "N", path: "notes/c.md" });
      await h.vault.write("notes/c.md", bytes("mine\n"));

      await h.engine.pull();
      await pushUntilQuiet(h);

      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["notes/c.md", "theirs\n"],
          [`notes/${copyOf("c", ".md")}`, "mine\n"],
        ]),
      );
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listDeferred()).toEqual([]);
    });
  });

  describe("given a merge that moves a document away from a synced path whose path key names a folder of the copy (#299)", () => {
    // Simulation retention seeds 1 (Windows engine) and 5 (macOS engine) of
    // #229: the journal still has the document at its synced path NOTES, but
    // the merge puts it elsewhere, so NOTES never makes notes/ a file's path
    // by path key that no conflict copy can go in.
    for (const platform of ["posix", "macos", "windows"] as const) {
      it(`keeps the user's file in the way as a conflict copy when the user deleted the document's file (${platform})`, async () => {
        // Seed 1: the user's delete of NOTES loses to the remote edit, which
        // also renames the document to notes/f.md, where the user created a file.
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "N", path: "NOTES", content: "theirs\n" });
        await h.engine.pull();
        await h.vault.delete("NOTES");
        h.server.commit({ documentId: "N", path: "notes/f.md", content: "theirs, edited\n" });
        await h.vault.write("notes/f.md", bytes("mine\n"));

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["notes/f.md", "theirs, edited\n"],
            [`notes/${copyOf("f", ".md")}`, "mine\n"],
          ]),
        );
        expect(h.server.liveDocuments().get("notes/f.md")).toBe("N");
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      it(`keeps the local version as a conflict copy when a local rename moved the document's file into the folder (${platform})`, async () => {
        // Seed 5: the user renamed NOTES to notes/f.md and edited it, while
        // another device renamed and edited it too. The local rename wins,
        // and the two edits conflict.
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "N", path: "NOTES", content: "base\n" });
        await h.engine.pull();
        await h.vault.rename("NOTES", "notes/f.md");
        await h.vault.write("notes/f.md", bytes("mine\n"));
        h.server.commit({ documentId: "N", path: "notes/c.md", content: "theirs\n" });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        const live = h.server.liveFiles();
        expect([...live.values()].sort()).toEqual(["mine\n", "theirs\n"]);
        expect([...live.keys()].every((path) => path.startsWith("notes/"))).toBe(true);
        expect(h.server.history("N").every((revision) => !revision.deleted)).toBe(true);
        expect(await files(h.vault)).toEqual(live);
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });

  describe("given a merge that keeps a local rename into a folder named like the remote revision's path by path key (#344)", () => {
    // Simulation retention seed 5 of #229 (macOS engine), with overlapping
    // edits for its purged merge base: the user renamed a.md to Notes/C.md
    // and edited it, while another device renamed it to NOTES and edited it.
    // The local rename wins, so the result goes to Notes/C.md, and the
    // remote revision held for the merge at NOTES, a file named like the
    // result's folder by path key, never leaves Notes/ without a free
    // conflict-copy name. Fixed by #352's change.
    for (const platform of ["posix", "macos", "windows"] as const) {
      it(`keeps the local version as a conflict copy next to the renamed document (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "N", path: "a.md", content: "base\n" });
        await h.engine.pull();
        await h.vault.rename("a.md", "Notes/C.md");
        await h.vault.write("Notes/C.md", bytes("mine\n"));
        h.server.commit({ documentId: "N", path: "NOTES", content: "theirs\n" });

        await h.engine.pull();
        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["Notes/C.md", "theirs\n"],
            [`Notes/${copyOf("C", ".md")}`, "mine\n"],
          ]),
        );
        expect(h.server.liveDocuments().get("Notes/C.md")).toBe("N");
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    }
  });
});
