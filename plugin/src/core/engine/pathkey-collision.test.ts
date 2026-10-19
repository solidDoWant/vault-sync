import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { pathKey } from "../pathkey/pathkey";
import type { PushSummary } from "./engine";
import { threeWayMerge, type MergeHook } from "./merge";
import { copyOf, files, harness, moveHeadBeforeCommit, type Harness } from "./testing";

// Collisions by path key (SPEC.md §5, §6.3, §7): the server refuses a
// document whose path equals another live document's ignoring case and
// Unicode form. The engine then keeps both versions, each under its own
// document id, and never deletes or moves the other device's document.
// Regressions of the simulation's seeds 1 and 2 (#242, macOS engine) and
// seed 5 (#243, POSIX engine).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** Pairs of paths the server takes for one: by case, and by full case folding (ß folds to ss). */
const collisions = [
  { local: "Notes/C.md", remote: "notes/c.md" },
  { local: "straße.md", remote: "STRASSE.md" },
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
  expect(await files(h.vault)).toEqual(h.server.liveFiles());
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
      for (const { local, remote } of collisions) {
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
          expect(await files(h.vault)).toEqual(h.server.liveFiles());
          expect(await h.journal.listPending()).toEqual([]);
          expect(await h.journal.listDeferred()).toEqual([]);
          expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
          expect(h.localChanges).toEqual([
            { type: "create", path: local },
            { type: "modify", path: remote },
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
          expect(await files(h.vault)).toEqual(h.server.liveFiles());
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
});
