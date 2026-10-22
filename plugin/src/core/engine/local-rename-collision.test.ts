import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { copyOf, files, harness, type Harness } from "./testing";

// #846 (seeds 100163, 100198): a remote revision of a document D goes to the
// merge path, and the path merge keeps D's local rename onto a path that
// collides under the server's key with another live document H's synced
// path (`straße.md` beside `STRASSE.md`, two files on disk). The server will
// never give D that path, and H keeps it (its newest server claim is the
// path under K), so D's local rename moves on to a conflict-copy name under
// D's own id (PO-4(a) from D's side, design §4.5), as a commit refused with
// ALREADY_EXISTS would. Before the fix the revision waited as
// `path-conflict` forever (INV-9).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** Pulls and pushes until a push commits nothing, at most `limit` rounds. */
async function syncUntilQuiet(h: Harness, limit = 6): Promise<PushSummary[]> {
  const summaries: PushSummary[] = [];
  for (let round = 0; round < limit; round++) {
    await h.engine.pull();
    const summary = await h.engine.push();
    summaries.push(summary);
    if (summary.committed === 0 && summary.conflicts === 0 && summary.pending === 0) break;
  }
  return summaries;
}

describe("SyncEngine merge result at a local rename that collides under the server's key (#846)", () => {
  for (const platform of ["posix", "macos", "windows"] as const) {
    for (const { holder, renamed } of [
      { holder: "STRASSE.md", renamed: "straße.md" },
      { holder: "straße.md", renamed: "STRASSE.md" },
    ]) {
      it(`moves the local rename to ${renamed} on to a copy name under its own id when a remote edit of it arrives while ${holder} is another document's (${platform})`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "theirs", path: holder, content: "theirs\n" });
        await h.vault.write("draft.md", bytes("mine\n"));
        await h.engine.pull();
        await h.engine.push();
        const mine = h.server.liveDocuments().get("draft.md");
        expect(mine).toBeDefined();
        const documentId = mine ?? "";

        // The user renames the document onto the other document's path under
        // the server's key, a file of its own on disk, before the push; another
        // device edits it meanwhile.
        await h.vault.rename("draft.md", renamed);
        h.server.commit({ documentId, path: "draft.md", content: "mine\nedited elsewhere\n" });

        await h.engine.pull();
        const summaries = await syncUntilQuiet(h);

        // The other document is untouched.
        expect(h.server.liveDocuments().get(holder)).toBe("theirs");
        expect(h.server.history("theirs")).toHaveLength(1);
        // The renamed document keeps its id and the remote edit, at a copy name of its local rename.
        const copy = copyOf(renamed.slice(0, -".md".length), ".md");
        expect(h.server.liveDocuments().get(copy)).toBe(documentId);
        expect(h.server.liveFiles().get(copy)).toBe("mine\nedited elsewhere\n");
        expect(h.server.history(documentId).every((revision) => !revision.deleted)).toBe(true);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listDeferred()).toEqual([]);
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
        expect((await h.journal.listConflicts()).some((record) => record.documentId === documentId && record.reason === "path-taken" && record.copyPath === copy)).toBe(true);
      });
    }
  }
});

describe("SyncEngine merge result at a local rename onto a path its holder is leaving (#846)", () => {
  for (const platform of ["macos", "windows"] as const) {
    it(`keeps the local rename to straße.md once the holder at STRASSE.md follows its own refused revision away (${platform})`, async () => {
      const h = harness({ merge: "default", pathRules: { platform } });
      h.server.commit({ documentId: "theirs", path: "STRASSE.md", content: "theirs\n" });
      await h.vault.write("draft.md", bytes("mine\n"));
      await h.engine.pull();
      await h.engine.push();
      const documentId = h.server.liveDocuments().get("draft.md") ?? "";
      expect(documentId).not.toBe("");

      // The holder moves away on the server, to a path an untracked folder of
      // another spelling is in the way of here, so the vault refuses its
      // revision for now; the user renames the document onto the holder's
      // old path under the server's key, and another device edits it.
      await h.vault.write("notes/c.md", bytes("untracked\n"));
      h.server.commit({ documentId: "theirs", path: "NOTES", content: "theirs\n" });
      await h.vault.rename("draft.md", "straße.md");
      h.server.commit({ documentId, path: "draft.md", content: "mine\nedited elsewhere\n" });

      await h.engine.pull();
      await syncUntilQuiet(h);

      // The holder's path is free once it moves, so the local rename stands.
      expect(h.server.liveDocuments().get("straße.md")).toBe(documentId);
      expect(h.server.liveFiles().get("straße.md")).toBe("mine\nedited elsewhere\n");
      expect(h.server.liveDocuments().get("NOTES")).toBe("theirs");
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
    });
  }
});
