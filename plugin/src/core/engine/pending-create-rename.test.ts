import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { PathPlatform } from "../vaultpath/platform";
import type { PushSummary } from "./engine";
import { copyOf, files, harness, type Harness } from "./testing";

// A renamed pending create (#286): the user creates a file, a push uploads
// its content and records the create as pending, and its commit is not
// acknowledged (lost, or the app was killed). The user then renames the file,
// and another device's document arrives at the new path before the next push.
// The file is the pending create's: it moves aside under that document's id
// as `path-taken`, and is committed there, never at the path it left, and
// never deleted and created again (SPEC.md §2 principle 1, §6.3).

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value);

const platforms: readonly PathPlatform[] = ["posix", "macos", "windows"];

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

/** Creates `e.md` and pushes it, with every CommitRevision failing before the server sees it: the create stays pending, its content uploaded. */
async function pendingCreate(h: Harness): Promise<string> {
  await h.vault.write("e.md", bytes("mine\n"));
  h.server.interceptor = (method) => {
    if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
  };
  await expect(h.engine.push()).rejects.toThrow();
  h.server.interceptor = undefined;
  const pending = await h.journal.listPending();
  expect(pending).toMatchObject([{ path: "e.md", baseRevisionId: "", deleted: false }]);
  return pending[0]?.documentId ?? "";
}

/**
 * Creates `e.md` and pushes it; the create lands, but its response is lost,
 * so it stays pending. `before` runs just before the create reaches the
 * server (another device's commit the engine has not pulled, say).
 */
async function landedCreate(h: Harness, before?: () => void): Promise<string> {
  await h.vault.write("e.md", bytes("mine\n"));
  h.server.interceptor = (method) => {
    if (method !== "CommitRevision" || before === undefined) return;
    before();
    before = undefined;
  };
  h.server.responseInterceptor = (method) => {
    if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
  };
  await expect(h.engine.push()).rejects.toThrow();
  h.server.responseInterceptor = undefined;
  h.server.interceptor = undefined;
  const pending = await h.journal.listPending();
  expect(pending).toMatchObject([{ path: "e.md", baseRevisionId: "", deleted: false }]);
  return pending[0]?.documentId ?? "";
}

const copy = copyOf("d", ".md");

/** The outcome #286 requires: the user's file keeps its document id at the path-taken copy, with nothing of it deleted. */
async function expectMovedAside(h: Harness, mine: string, summaries: PushSummary[]): Promise<void> {
  expect(h.server.liveDocuments()).toEqual(
    new Map([
      ["d.md", "D"],
      [copy, mine],
    ]),
  );
  expect(h.server.liveFiles()).toEqual(
    new Map([
      ["d.md", "theirs\n"],
      [copy, "mine\n"],
    ]),
  );
  const history = h.server.history(mine);
  expect(history.some((revision) => revision.deleted)).toBe(false);
  expect(history.map((revision) => decoder.decode(h.server.contentOf(revision)))).toEqual(history.map(() => "mine\n"));
  expect(await files(h.vault)).toEqual(h.server.liveFiles());
  expect(await h.journal.listPending()).toEqual([]);
  const conflicts = await h.journal.listConflicts();
  expect(conflicts).toMatchObject([{ documentId: mine, path: "d.md", reason: "path-taken", copyPath: copy }]);
  expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
}

describe("SyncEngine pull onto the new path of a renamed pending create (#286)", () => {
  for (const platform of platforms) {
    for (const restart of [false, true]) {
      describe(`under ${platform} rules${restart ? ", after a restart" : ""}`, () => {
        it("moves the file aside under the pending create's id and commits the create only at the copy's path", async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          const mine = await pendingCreate(h);
          if (restart) h.restart();
          await h.vault.rename("e.md", "d.md");
          h.server.commit({ documentId: "D", path: "d.md", content: "theirs\n" });

          const summaries = await pushUntilQuiet(h);

          await expectMovedAside(h, mine, summaries);
          // Never committed where its file no longer was.
          expect(h.server.history(mine).map((revision) => decoder.decode(revision.path))).toEqual([copy]);
        });

        it("keeps the document id when the create had landed after the other document, its response lost", async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          // The engine has not pulled D: its create lands after D.
          const mine = await landedCreate(h, () => h.server.commit({ documentId: "D", path: "d.md", content: "theirs\n" }));
          if (restart) h.restart();
          await h.vault.rename("e.md", "d.md");

          const summaries = await pushUntilQuiet(h);

          await expectMovedAside(h, mine, summaries);
          expect(h.server.history(mine).map((revision) => decoder.decode(revision.path))).toEqual(["e.md", copy]);
        });

        it("keeps the document id when the create had landed before the other document, its response lost", async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          const mine = await landedCreate(h);
          if (restart) h.restart();
          await h.vault.rename("e.md", "d.md");
          h.server.commit({ documentId: "D", path: "d.md", content: "theirs\n" });

          const summaries = await pushUntilQuiet(h);

          await expectMovedAside(h, mine, summaries);
          expect(h.server.history(mine).map((revision) => decoder.decode(revision.path))).toEqual(["e.md", copy]);
        });
      });
    }
  }
});

/**
 * Edits `path` to `content` once the operation for its `size`-byte content is
 * pending and the engine reads the file to upload that content: the edit
 * lands before the upload reads it, so the operation's content is gone.
 */
function editDuringUpload(h: Harness, size: number, path: string, content: string): void {
  let done = false;
  h.server.interceptor = undefined;
  const read = h.vault.read.bind(h.vault);
  h.vault.read = async (target) => {
    if (!done && target === path) {
      const pending = await h.journal.listPending();
      if (pending.some((operation) => operation.path === path && operation.size === BigInt(size))) {
        done = true;
        await h.vault.write(path, bytes(content));
      }
    }
    return read(target);
  };
}

describe("SyncEngine push of a renamed and edited file edited again while its content uploads (#286, seed 20)", () => {
  for (const platform of platforms) {
    describe(`under ${platform} rules`, () => {
      it("keeps the rename of a synced note, committing it with the newest content and tombstoning nothing", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "N", path: "n.md", content: "n\n" });
        await h.engine.pull();
        await h.vault.rename("n.md", "d.md");
        await h.vault.write("d.md", bytes("n\nmore\n"));
        editDuringUpload(h, "n\nmore\n".length, "d.md", "n\nmore\nlast\n");

        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(new Map([["d.md", "N"]]));
        expect(h.server.liveFiles()).toEqual(new Map([["d.md", "n\nmore\nlast\n"]]));
        expect(h.server.history("N").some((revision) => revision.deleted)).toBe(false);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      it("renames a create that landed while the user renamed and edited its file, never leaving it at the old path", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        await h.vault.write("e.md", bytes("mine\n"));
        let renamed: Promise<void> | undefined;
        h.server.interceptor = (method) => {
          if (method !== "CommitRevision" || renamed !== undefined) return;
          renamed = (async () => {
            await h.vault.write("e.md", bytes("mine\nmore\n"));
            await h.vault.rename("e.md", "d.md");
          })();
          editDuringUpload(h, "mine\nmore\n".length, "d.md", "mine\nmore\nlast\n");
        };

        const summaries = await pushUntilQuiet(h);
        await renamed;

        const documents = h.server.liveDocuments();
        expect([...documents.keys()]).toEqual(["d.md"]);
        const mine = documents.get("d.md") ?? "";
        expect(h.server.history(mine).map((revision) => decoder.decode(revision.path))).toEqual(["e.md", "d.md"]);
        expect(h.server.history(mine).some((revision) => revision.deleted)).toBe(false);
        expect(h.server.liveFiles()).toEqual(new Map([["d.md", "mine\nmore\nlast\n"]]));
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });
    });
  }
});

describe("SyncEngine push of a pending create renamed while its commit was in flight (#286)", () => {
  for (const platform of platforms) {
    it(`under ${platform} rules renames the created document, never leaving it at the old path or creating another`, async () => {
      const h = harness({ merge: "default", pathRules: { platform } });
      await h.vault.write("e.md", bytes("mine\n"));
      let renamed: Promise<void> | undefined;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || renamed !== undefined) return;
        renamed = (async () => {
          await h.vault.write("e.md", bytes("mine\nmore\n"));
          await h.vault.rename("e.md", "d.md");
          await h.vault.write("d.md", bytes("mine\nmore\nlast\n"));
        })();
      };
      await h.engine.push();
      h.server.interceptor = undefined;
      await renamed;

      const summaries = await pushUntilQuiet(h);

      const documents = h.server.liveDocuments();
      expect([...documents.keys()]).toEqual(["d.md"]);
      const mine = documents.get("d.md") ?? "";
      expect(h.server.history(mine)[0]?.parentRevId ?? "").toBe("");
      expect(h.server.history(mine).some((revision) => revision.deleted)).toBe(false);
      expect(h.server.liveFiles()).toEqual(new Map([["d.md", "mine\nmore\nlast\n"]]));
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listPending()).toEqual([]);
      expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
    });
  }
});
