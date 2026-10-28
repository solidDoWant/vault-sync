import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// Document identity across renames, deletes and pulls (#409). Identity
// follows the file (design PO-1, PO-2; SPEC.md §8): a rename moves the
// document's binding in one journal transaction when its event is handled,
// whatever path it names; a delete makes the document user-deleted; and a
// file at a path a document's file left is untracked, so it is pushed as a
// new document. A deleted document comes back only as PO-13 allows: an
// untracked file at a *pulled* tombstone's path, never after the user's own
// delete. Nothing here may lose content (SPEC.md §2 principle 1).

const bytes = (content: string) => new TextEncoder().encode(content);
const decoder = new TextDecoder();

/** The paths of `documentId`'s revisions on the server, oldest first, with "-" for a tombstone. */
function pathsOf(
  server: ReturnType<typeof harness>["server"],
  documentId: string,
): string[] {
  return server
    .history(documentId)
    .map((revision) =>
      revision.deleted ? "-" : decoder.decode(revision.path),
    );
}

describe("document identity (#409)", () => {
  // Item 1 (#293, #296).
  it.each(["a\\b.md", "C:x.md", "1:x.md"])(
    "keeps the document's id when a rename to the refused path %s is followed by a rename to a valid path",
    async (refused) => {
      const h = harness({ merge: "default" });
      await h.vault.write("x.md", bytes("x\n"));
      await h.engine.push();
      const id = h.server.liveDocuments().get("x.md");
      expect(id).toBeDefined();

      await h.vault.rename("x.md", refused);
      const rejected = await h.engine.push();
      expect(rejected.rejected.map(({ operation }) => operation.path)).toEqual([
        refused,
      ]);
      await h.vault.rename(refused, "y.md");
      await h.engine.push();

      expect(h.server.liveDocuments()).toEqual(new Map([["y.md", id]]));
      expect(h.server.deletedDocuments()).toEqual([]);
      expect(pathsOf(h.server, id ?? "")).toEqual(["x.md", "y.md"]);
      expect(await files(h.vault)).toEqual(new Map([["y.md", "x\n"]]));
    },
  );

  // Item 2 (#349 item 2): a rename the engine never saw is found by a unique content match at start-up (E7).
  it("commits a rename made while the app was not running as a rename of the same document", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("x.md", bytes("x\n"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("x.md");
    h.engine.dispose();
    await h.vault.rename("x.md", "y.md");

    h.restart();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["y.md", id]]));
    expect(h.server.deletedDocuments()).toEqual([]);
    expect(pathsOf(h.server, id ?? "")).toEqual(["x.md", "y.md"]);
  });

  it("falls back to a delete and a create, losing no content, when an offline rename's content match is ambiguous", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("x.md", bytes("same\n"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("x.md");
    h.engine.dispose();
    await h.vault.rename("x.md", "y.md");
    await h.vault.write("z.md", bytes("same\n"));

    h.restart();
    await h.engine.push();

    const live = h.server.liveDocuments();
    expect([...live.keys()].sort()).toEqual(["y.md", "z.md"]);
    expect([...live.values()]).not.toContain(id);
    expect(h.server.deletedDocuments()).toEqual([id]);
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["y.md", "same\n"],
        ["z.md", "same\n"],
      ]),
    );
  });

  // Item 3 (#338): PO-13 brings a tombstone back only for a pulled delete, never after this device's user deleted it.
  it.each(["posix", "macos", "windows"] as const)(
    "pushes a file at another spelling of a path whose delete this device pushed as a new document on %s",
    async (platform) => {
      const h = harness({ merge: "default", pathRules: { platform } });
      await h.vault.write("a.md", bytes("a\n"));
      await h.engine.push();
      const id = h.server.liveDocuments().get("a.md");
      await h.vault.delete("a.md");
      await h.engine.push();

      await h.vault.write("A.md", bytes("again\n"));
      await h.engine.push();

      const live = h.server.liveDocuments();
      expect([...live.keys()]).toEqual(["A.md"]);
      expect(live.get("A.md")).not.toBe(id);
      expect(h.server.deletedDocuments()).toEqual([id]);
      expect(await files(h.vault)).toEqual(new Map([["A.md", "again\n"]]));
    },
  );

  it.each(["macos", "windows"] as const)(
    "pushes a re-created file renamed to another spelling before the push as a new document on %s, converging the spellings",
    async (platform) => {
      const h = harness({ merge: "default", pathRules: { platform } });
      await h.vault.write("a.md", bytes("a\n"));
      await h.engine.push();
      const id = h.server.liveDocuments().get("a.md");
      await h.vault.delete("a.md");
      await h.engine.push();

      await h.vault.write("a.md", bytes("again\n"));
      await h.vault.rename("a.md", "A.md");
      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["A.md", "again\n"]]));
      expect(h.server.liveDocuments().get("A.md")).not.toBe(id);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    },
  );

  // Item 4 (#314 item 3): the user's delete lasts; the file put back is untracked (E3, E5).
  it("pushes a file deleted with an unpushed edit and put back with that edit as a delete and a new document, losing nothing", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("x.md", bytes("x\n"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("x.md");

    await h.vault.write("x.md", bytes("x\nedited\n"));
    await h.vault.delete("x.md");
    await h.vault.write("x.md", bytes("x\nedited\n"));
    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["x.md", "x\nedited\n"]]));
    expect(h.server.liveDocuments().get("x.md")).not.toBe(id);
    expect(h.server.deletedDocuments()).toEqual([id]);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  // Item 5 (#347 item 4): a rename is durable once its event is handled (E2), so a kill before the push keeps it.
  it("keeps the document's id when the app is killed between a handled rename and the push", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("x.md", bytes("x\n"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("x.md");

    // A new file with the same content makes the start-up scan's content match ambiguous: only the durable rename keeps the id.
    await h.vault.rename("x.md", "y.md");
    await h.vault.write("z.md", bytes("x\n"));
    await h.engine.settled();
    h.engine.dispose();
    h.restart();
    await h.engine.push();

    expect(h.server.liveDocuments().get("y.md")).toBe(id);
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["y.md", "x\n"],
        ["z.md", "x\n"],
      ]),
    );
    expect(h.server.deletedDocuments()).toEqual([]);
    expect(pathsOf(h.server, id ?? "")).toEqual(["x.md", "y.md"]);
  });

  // Item 6 (#308 item 2): a delete during the push that commits the rename is the document's delete.
  it("pushes a delete during the push that commits a rename as a tombstone, and the file then made there as a new document", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("x.md", bytes("x\n"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("x.md");
    await h.vault.rename("x.md", "c.md");
    await h.engine.settled();

    let changes: Promise<void> | undefined;
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision" || changes !== undefined) return;
      changes = (async () => {
        await h.vault.delete("c.md");
        await h.vault.write("c.md", bytes("unrelated\n"));
        await h.vault.rename("c.md", "d.md");
      })();
    };
    await h.engine.push();
    await changes;
    h.server.interceptor = undefined;
    await h.engine.push();
    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["d.md", "unrelated\n"]]));
    expect(h.server.liveDocuments().get("d.md")).not.toBe(id);
    expect(h.server.deletedDocuments()).toEqual([id]);
    expect(pathsOf(h.server, id ?? "")).toEqual(["x.md", "c.md", "-"]);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
