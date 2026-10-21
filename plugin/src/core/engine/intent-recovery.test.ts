import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { harness, type Harness } from "./testing";

// Intents.recover (design §4.4): a displace or detach intent whose file the
// user deleted from both of its paths before the restart finishes as the
// user's delete (E3). The document ends user-deleted, its delete is pushed,
// and no outbox of the move is left (#671 item 6).

const bytes = (value: string) => new TextEncoder().encode(value);

/** A synced at a.md, edited, with the edit's outbox recorded and a rule-W intent open, as a crash leaves them; then the user deletes the file while the app is closed. */
async function crashedWithIntent(kind: "displace" | "detach"): Promise<Harness> {
  const h = harness({ merge: "default" });
  h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
  await h.engine.pull();
  await h.vault.write("a.md", bytes("a2"));
  await h.engine.settled();
  const state = await h.journal.getDocument("A");
  if (state === undefined) throw new Error("A not synced");
  h.engine.dispose();
  // The crash: the edit's outbox and the intent are recorded, and the rename to the copy name never happened.
  await h.journal.addPending({ revisionId: "edit", documentId: "A", baseRevisionId: state.revisionId, path: "a.md", contentHash: sha256Hex(bytes("a2")), size: 2n, kind: state.kind, deleted: false });
  const copy = "a (conflict).md";
  const record = { id: "record", documentId: "A", path: "a.md", reason: "path-taken" as const, copyPath: copy, copyHash: sha256Hex(bytes("a2")), remoteRevisionId: "", at: 0 };
  await h.journal.putIntent({ kind, documentId: "A", steps: { from: "a.md", to: copy, hash: sha256Hex(bytes("a2")), record, recreate: false } });
  // While the app is closed, the user deletes the file.
  await h.vault.delete("a.md");
  h.restart();
  return h;
}

describe("Intents.recover of a file gone from both paths", () => {
  for (const kind of ["displace", "detach"] as const) {
    it(`finishes a ${kind} intent as the user's delete: user-deleted, pushed, no outbox`, async () => {
      const h = await crashedWithIntent(kind);

      await h.engine.pull();
      // Recovery itself finishes the delete: nothing of the move is left to push.
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.getDocument("A")).toMatchObject({ binding: null, absence: "user-deleted" });
      await h.engine.push();
      await h.engine.settled();

      expect(await h.journal.listIntents()).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(h.server.liveDocuments().has("a.md")).toBe(false);
      expect((await h.journal.getDocument("A"))?.deleted).toBe(true);
      expect(await h.vault.list()).toEqual([]);
    });
  }

  for (const kind of ["displace", "detach"] as const) {
    it(`leaves no outbox of a finished ${kind} intent to take a new file the user creates at the path`, async () => {
      const h = await crashedWithIntent(kind);

      await h.engine.pull();
      await h.vault.write("a.md", bytes("unrelated"));
      await h.engine.push();
      await h.engine.settled();

      expect(await h.journal.listPending()).toEqual([]);
      expect(h.server.liveDocuments().get("a.md")).not.toBe("A");
      expect((await h.journal.getDocument("A"))?.deleted).toBe(true);
    });
  }

  it("finishes a displace intent of a create not acknowledged yet as the user's delete: no row, nothing pushed, no outbox", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("n.md", bytes("n1"));
    await h.engine.settled();
    h.engine.dispose();
    // The crash: the create's outbox and the intent are recorded, and the rename to the copy name never happened.
    const hash = sha256Hex(bytes("n1"));
    await h.journal.addPending({ revisionId: "create", documentId: "N", baseRevisionId: "", path: "n.md", contentHash: hash, size: 2n, kind: "text", deleted: false });
    const copy = "n (conflict).md";
    const record = { id: "record", documentId: "N", path: "n.md", reason: "path-taken" as const, copyPath: copy, copyHash: hash, remoteRevisionId: "", at: 0 };
    await h.journal.putIntent({ kind: "displace", documentId: "N", steps: { from: "n.md", to: copy, hash, record, recreate: false } });
    await h.vault.delete("n.md");
    h.restart();

    await h.engine.pull();
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument("N")).toBeUndefined();
    await h.engine.push();
    await h.engine.settled();

    expect(await h.journal.listIntents()).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument("N")).toBeUndefined();
    expect(h.server.liveDocuments().size).toBe(0);
  });

  it("leaves no outbox of a create's finished intent to take a new file the user creates at the path", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("n.md", bytes("n1"));
    await h.engine.settled();
    h.engine.dispose();
    const hash = sha256Hex(bytes("n1"));
    await h.journal.addPending({ revisionId: "create", documentId: "N", baseRevisionId: "", path: "n.md", contentHash: hash, size: 2n, kind: "text", deleted: false });
    const record = { id: "record", documentId: "N", path: "n.md", reason: "path-taken" as const, copyPath: "n (conflict).md", copyHash: hash, remoteRevisionId: "", at: 0 };
    await h.journal.putIntent({ kind: "displace", documentId: "N", steps: { from: "n.md", to: "n (conflict).md", hash, record, recreate: false } });
    await h.vault.delete("n.md");
    h.restart();

    await h.engine.pull();
    await h.vault.write("n.md", bytes("unrelated"));
    await h.engine.push();
    await h.engine.settled();

    expect(await h.journal.listPending()).toEqual([]);
    expect(h.server.liveDocuments().get("n.md")).not.toBe("N");
    expect(await h.journal.getDocument("N")).toBeUndefined();
  });
});
