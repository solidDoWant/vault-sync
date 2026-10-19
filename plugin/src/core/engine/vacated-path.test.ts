import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import type { PathPlatform } from "../vaultpath/platform";
import type { PushSummary } from "./engine";
import { files, harness, syncedOnBoth, twoDevices, type Harness } from "./testing";

// A new file at a path the user just vacated (#254): the user deletes a
// synced document's file, or renames it away, and before the next push puts
// another file at that path (a new one, or another document's by a rename).
// The push keeps the user's intent: the old document is deleted (or renamed)
// under its own id, and the new file is a new document (or the other
// document, renamed under its own id). It is never committed as the old
// document's edit (SPEC.md §2 principle 1, §8 push).

const encoder = new TextEncoder();
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

/** Whether the server ever committed a tombstone of `documentId`. */
function everDeleted(h: Harness, documentId: string): boolean {
  return h.server.history(documentId).some((revision) => revision.deleted);
}

/** The distinct contents `documentId`'s live revisions ever held: whether it took another file's content. */
function contentsOf(h: Harness, documentId: string): string[] {
  const decoder = new TextDecoder();
  const contents = h.server
    .history(documentId)
    .filter((revision) => !revision.deleted)
    .map((revision) => decoder.decode(h.server.contentOf(revision)));
  return [...new Set(contents)];
}

/** Makes the next push's CommitRevision calls fail, so its operations stay pending, then lets later ones through. */
async function pushWithCommitsLost(h: Harness): Promise<void> {
  h.server.interceptor = (method) => {
    if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
  };
  await expect(h.engine.push()).rejects.toThrow();
  h.server.interceptor = undefined;
}

describe("SyncEngine push of a new file at a just-vacated path (#254)", () => {
  for (const platform of platforms) {
    describe(`under ${platform} rules`, () => {
      it("deletes the old document and creates a new one when the user deletes a file and creates another at its path", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "H", path: "h.md", content: "old\n" });
        await h.engine.pull();
        await h.vault.delete("h.md");
        await h.vault.write("h.md", bytes("new\n"));

        const summaries = await pushUntilQuiet(h);

        expect(h.server.head("H")?.deleted).toBe(true);
        const documents = h.server.liveDocuments();
        expect(documents.size).toBe(1);
        expect(documents.get("h.md")).toEqual(expect.any(String));
        expect(documents.get("h.md")).not.toBe("H");
        expect(h.server.liveFiles()).toEqual(new Map([["h.md", "new\n"]]));
        expect(contentsOf(h, "H")).toEqual(["old\n"]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      it("keeps the old document when the user deletes a file and puts the same content back", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "H", path: "h.md", content: "old\n" });
        await h.engine.pull();
        await h.vault.delete("h.md");
        await h.vault.write("h.md", bytes("old\n"));

        await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(new Map([["h.md", "H"]]));
        expect(everDeleted(h, "H")).toBe(false);
      });

      it("renames the other document onto the path and deletes the old one when the user deletes a file and renames another onto its path", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "H", path: "h.md", content: "h\n" });
        h.server.commit({ documentId: "D", path: "d.md", content: "d\n" });
        await h.engine.pull();
        await h.vault.delete("h.md");
        await h.vault.rename("d.md", "h.md");

        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(new Map([["h.md", "D"]]));
        expect(h.server.liveFiles()).toEqual(new Map([["h.md", "d\n"]]));
        expect(h.server.head("H")?.deleted).toBe(true);
        expect(everDeleted(h, "D")).toBe(false);
        expect(contentsOf(h, "H")).toEqual(["h\n"]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(await h.journal.listPending()).toEqual([]);
        expect(await h.journal.listConflicts()).toEqual([]);
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      it("renames the document and creates a new one when the user renames a file away and creates another at its old path", async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "N", path: "n.md", content: "n\n" });
        await h.engine.pull();
        await h.vault.rename("n.md", "b.md");
        await h.vault.write("n.md", bytes("new\n"));

        await pushUntilQuiet(h);

        const documents = h.server.liveDocuments();
        expect(documents.get("b.md")).toBe("N");
        expect(documents.get("n.md")).toEqual(expect.any(String));
        expect(documents.get("n.md")).not.toBe("N");
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["b.md", "n\n"],
            ["n.md", "new\n"],
          ]),
        );
        expect(everDeleted(h, "N")).toBe(false);
        expect(contentsOf(h, "N")).toEqual(["n\n"]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
      });
    });
  }

  describe("on a case-insensitive platform", () => {
    for (const platform of ["macos", "windows"] as const) {
      it(`renames the other document onto a case variant of the path the user deleted (${platform}, seed 24)`, async () => {
        const h = harness({ merge: "default", pathRules: { platform } });
        h.server.commit({ documentId: "H", path: "A.md", content: "a\n" });
        h.server.commit({ documentId: "D", path: "NOTES", content: "notes\n" });
        await h.engine.pull();
        await h.vault.delete("A.md");
        await h.vault.rename("NOTES", "a.md");

        const summaries = await pushUntilQuiet(h);

        expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "D"]]));
        expect(h.server.liveFiles()).toEqual(new Map([["a.md", "notes\n"]]));
        expect(h.server.head("H")?.deleted).toBe(true);
        expect(everDeleted(h, "D")).toBe(false);
        expect(contentsOf(h, "H")).toEqual(["a\n"]);
        expect(await files(h.vault)).toEqual(h.server.liveFiles());
        expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
      });

      for (const push of ["settled", "pending"] as const) {
        it(`keeps both ids when the user renames a.md away and another file onto A.md, with the renames ${push} (${platform})`, async () => {
          const h = harness({ merge: "default", pathRules: { platform } });
          h.server.commit({ documentId: "A", path: "a.md", content: "a\n" });
          h.server.commit({ documentId: "B", path: "b.md", content: "b\n" });
          await h.engine.pull();
          await h.vault.rename("a.md", "z.md");
          await h.vault.rename("b.md", "A.md");
          if (push === "pending") await pushWithCommitsLost(h);
          else await h.engine.settled();

          const summaries = await pushUntilQuiet(h);

          expect(h.server.liveDocuments()).toEqual(
            new Map([
              ["z.md", "A"],
              ["A.md", "B"],
            ]),
          );
          expect(h.server.liveFiles()).toEqual(
            new Map([
              ["z.md", "a\n"],
              ["A.md", "b\n"],
            ]),
          );
          expect(everDeleted(h, "A")).toBe(false);
          expect(everDeleted(h, "B")).toBe(false);
          expect(await files(h.vault)).toEqual(h.server.liveFiles());
          expect(await h.journal.listConflicts()).toEqual([]);
          expect(summaries.flatMap((summary) => summary.rejected)).toEqual([]);
        });
      }
    }

    it("renames a new document away and creates another at a case variant of its path while its create is committing (macos, seed 22)", async () => {
      const h = harness({ merge: "default", pathRules: { platform: "macos" } });
      await h.vault.write("STRASSE.md", bytes("first\n"));
      let created: string | undefined;
      let changed: Promise<void> | undefined;
      h.server.responseInterceptor = (method, request) => {
        if (method !== "CommitRevision" || created !== undefined) return;
        created = (request as CommitRevisionRequest).documentId;
        // The user renames the file and creates another while the create's response is on its way.
        changed = h.vault.rename("STRASSE.md", "b.md").then(() => h.vault.write("straße.md", bytes("second\n")));
      };
      await h.engine.push();
      h.server.responseInterceptor = undefined;
      await changed;
      expect(created).toEqual(expect.any(String));

      await pushUntilQuiet(h);

      const documents = h.server.liveDocuments();
      expect(documents.get("b.md")).toBe(created);
      expect(documents.get("straße.md")).toEqual(expect.any(String));
      expect(documents.get("straße.md")).not.toBe(created);
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["b.md", "first\n"],
          ["straße.md", "second\n"],
        ]),
      );
      expect(everDeleted(h, created ?? "")).toBe(false);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });
  });

  describe("given the engine writes the document's file again after the user deleted it", () => {
    it("pushes the user's later edit of the file as the document's edit", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "h.md", "h\n");
      const id = devices.server.liveDocuments().get("h.md");
      await devices.b.vault.delete("h.md");
      await devices.a.vault.write("h.md", bytes("h\nremote\n"));
      await devices.a.engine.push();
      // The remote edit wins over the local delete: the engine writes the file back.
      await devices.b.engine.pull();
      expect(await files(devices.b.vault)).toEqual(new Map([["h.md", "h\nremote\n"]]));
      await devices.b.vault.write("h.md", bytes("h\nremote\nlocal\n"));

      await devices.b.engine.push();

      expect(devices.server.liveDocuments()).toEqual(new Map([["h.md", id]]));
      expect(devices.server.liveFiles()).toEqual(new Map([["h.md", "h\nremote\nlocal\n"]]));
      expect(devices.server.history(id ?? "").some((revision) => revision.deleted)).toBe(false);
    });
  });

  describe("given the document's own commit is in flight", () => {
    it("deletes the document and creates a new one when the user deletes the file and creates another before the commit lands", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "H", path: "h.md", content: "h\n" });
      await h.engine.pull();
      await h.vault.write("h.md", bytes("h\nedited\n"));
      let changed: Promise<void> | undefined;
      h.server.responseInterceptor = (method) => {
        if (method !== "CommitRevision" || changed !== undefined) return;
        // The user replaces the file while the edit's response is on its way.
        changed = h.vault.delete("h.md").then(() => h.vault.write("h.md", bytes("new\n")));
      };
      await h.engine.push();
      h.server.responseInterceptor = undefined;
      await changed;

      await pushUntilQuiet(h);

      expect(h.server.head("H")?.deleted).toBe(true);
      expect(contentsOf(h, "H")).toEqual(["h\n", "h\nedited\n"]);
      const documents = h.server.liveDocuments();
      expect(documents.get("h.md")).toEqual(expect.any(String));
      expect(documents.get("h.md")).not.toBe("H");
      expect(h.server.liveFiles()).toEqual(new Map([["h.md", "new\n"]]));
    });
  });

  describe("given another device's concurrent edit of the deleted document", () => {
    it("moves the renamed-in document to a copy under its own id and brings the edited one back, never merging unrelated content", async () => {
      const devices = twoDevices();
      await devices.a.vault.write("h.md", bytes("h\n"));
      await devices.a.vault.write("d.md", bytes("d\n"));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      const ids = devices.server.liveDocuments();
      await devices.a.vault.delete("h.md");
      await devices.a.vault.rename("d.md", "h.md");
      await devices.b.vault.write("h.md", bytes("h\nedited\n"));
      await devices.b.engine.push();

      for (let round = 0; round < 3; round++) for (const device of [devices.a, devices.b]) await device.engine.push();

      // The edit wins over the delete (SPEC.md §6.3), so H stays at h.md;
      // D keeps its id and content at a path-taken copy.
      const documents = devices.server.liveDocuments();
      const live = devices.server.liveFiles();
      expect(documents.get("h.md")).toBe(ids.get("h.md"));
      expect(live.get("h.md")).toBe("h\nedited\n");
      const copies = [...documents].filter(([, id]) => id === ids.get("d.md"));
      expect(copies).toHaveLength(1);
      expect(live.get(copies[0]?.[0] ?? "")).toBe("d\n");
      expect(documents.size).toBe(2);
      expect(await files(devices.a.vault)).toEqual(live);
      expect(await files(devices.b.vault)).toEqual(live);
    });
  });
});
