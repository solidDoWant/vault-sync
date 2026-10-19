import { describe, expect, it } from "vitest";

import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import { pathKey } from "../pathkey/pathkey";
import type { PushSummary } from "./engine";
import { InMemoryServer } from "./memory-server";
import { files, harness, type Harness } from "./testing";

// The server's file/folder rule (SPEC.md §5): no live document at, or under,
// a folder another live document's path names, ignoring case and Unicode
// form. On a case-insensitive platform a remote rename onto the name of a
// folder a local, unpushed note created can be merged only once the folder
// is gone, and the server refuses the note's create while the renamed note
// holds its folder's name. Neither may wait on the other forever, and
// neither the user's edit nor the new note may be lost (#307, SPEC.md §2
// principle 1).

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value);

/** Pushes until a push commits nothing and has no conflict, at most `limit` times. */
async function pushUntilQuiet(h: Harness, limit = 6): Promise<PushSummary[]> {
  const summaries: PushSummary[] = [];
  for (let push = 0; push < limit; push++) {
    const summary = await h.engine.push();
    summaries.push(summary);
    if (summary.committed === 0 && summary.conflicts === 0) break;
  }
  return summaries;
}

/** One summary per push, as `committed/conflicts/pending`, for failure messages. */
function described(summaries: PushSummary[]): string {
  return summaries.map(({ committed, conflicts, pending }) => `${String(committed)}/${String(conflicts)}/${String(pending)}`).join(" ");
}

/**
 * The synced note `a.md` (the document `note`), edited on a
 * Windows or macOS device, and a new local note `Notes/C.md` there, written
 * at that path or first written as the file `NOTES` and renamed. Another
 * (POSIX) device has renamed `a.md` to `NOTES` and pushed. Every
 * CommitRevision the server receives from then on is recorded.
 */
async function renamedOntoFolder(platform: "macos" | "windows", shape: "created" | "renamed-from-file" = "created") {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 });
  const posix = harness({ merge: "default", server, idPrefix: "p", deviceName: "posix" });
  const local = harness({ merge: "default", server, idPrefix: "l", deviceName: "local", pathRules: { platform } });
  await local.vault.write("a.md", bytes("a\n"));
  await local.engine.push();
  await posix.engine.pull();
  const note = server.liveDocuments().get("a.md") ?? "";

  if (shape === "created") {
    await local.vault.write("Notes/C.md", bytes("new note\n"));
  } else {
    await local.vault.write("NOTES", bytes("new note\n"));
    await local.vault.rename("NOTES", "Notes/C.md");
  }
  await local.vault.write("a.md", bytes("a\nlocal edit\n"));
  await posix.vault.rename("a.md", "NOTES");
  await posix.engine.push();

  const commits: { revisionId: string; path: string }[] = [];
  server.interceptor = (method, request) => {
    if (method !== "CommitRevision") return;
    const commit = request as CommitRevisionRequest;
    commits.push({ revisionId: commit.revisionId, path: decoder.decode(commit.path) });
  };
  return { server, posix, local, commits, note };
}

describe("SyncEngine and the server's file/folder rule", () => {
  for (const platform of ["macos", "windows"] as const) {
    for (const shape of ["created", "renamed-from-file"] as const) {
      it(`stops pushing within two pushes and keeps both the edit of a note another device renamed onto a local folder's name and the new note in that folder (${platform}, ${shape}, #307)`, async () => {
        const { server, posix, local, note } = await renamedOntoFolder(platform, shape);

        const summaries = await pushUntilQuiet(local);
        await posix.engine.pull();

        expect(summaries.length, described(summaries)).toBeLessThanOrEqual(2);
        expect(summaries.at(-1), described(summaries)).toMatchObject({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
        const live = server.liveFiles();
        const documents = server.liveDocuments();
        // The note keeps its id and the remote rename, with the local edit merged in.
        expect(live.get("NOTES")).toBe("a\nlocal edit\n");
        expect(documents.get("NOTES")).toBe(note);
        // The new note's content is live once, as another document, outside the folder the renamed note's name takes.
        const newNotes = [...live].filter(([, content]) => content === "new note\n");
        expect(newNotes).toHaveLength(1);
        const [newPath] = newNotes[0] ?? [""];
        expect(documents.get(newPath)).not.toBe(note);
        expect(pathKey(newPath).startsWith("notes/")).toBe(false);
        expect(live.size).toBe(2);
        // Both vaults show what the server holds, with nothing left over.
        expect(await files(local.vault)).toEqual(live);
        expect(await files(posix.vault)).toEqual(live);
        expect(await local.journal.listPending()).toEqual([]);
        expect(await local.journal.listDeferred()).toEqual([]);
        // Nothing was ever deleted.
        for (const document of documents.values()) expect(server.history(document).every((revision) => !revision.deleted)).toBe(true);
      });
    }

    it(`never sends a create the server refused by the rule again, push after push (${platform}, #307)`, async () => {
      const { local, commits } = await renamedOntoFolder(platform);

      for (let push = 0; push < 4; push++) await local.engine.push();

      // The refused create was sent once; each commit after it is a different revision.
      expect(commits.filter((commit) => commit.path === "Notes/C.md"), JSON.stringify(commits)).toHaveLength(1);
      expect(new Set(commits.map((commit) => commit.revisionId)).size, JSON.stringify(commits)).toBe(commits.length);
    });
  }
});
