import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { DocumentState } from "../journal/journal";
import { Crash, CrashingJournal, CrashPoints, harness, type Harness } from "./testing";

// Refactor step R4 (docs/design/engine-path-ownership.md §9.2): the engine
// maintains every document's binding (§4.1) from vault events (§4.3 E1–E5),
// its own changes and the start-up scan (E7), in shadow mode, and
// SyncEngine.bindingShadow compares them with the ownership it derives.

const bytes = (value: string) => new TextEncoder().encode(value);
const hash = (value: string) => sha256Hex(bytes(value));

async function row(h: Harness, documentId: string): Promise<Pick<DocumentState, "binding" | "absence"> | undefined> {
  await h.engine.settled();
  const state = await h.journal.getDocument(documentId);
  return state === undefined ? undefined : { binding: state.binding, absence: state.absence };
}

async function synced(platform: "posix" | "windows" = "posix"): Promise<Harness> {
  const h = harness({ merge: "default", pathRules: { platform } });
  h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
  await h.engine.pull();
  return h;
}

describe("Bindings in shadow mode (refactor step R4)", () => {
  it("binds a pulled document to the file the pull wrote", async () => {
    const h = await synced();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.md", fileKey: "a.md", seen: hash("a1") }, absence: null });
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("moves the binding with a user's rename before any push (E1)", async () => {
    const h = await synced();

    await h.vault.rename("a.md", "b.md");

    expect(await row(h, "A")).toEqual({ binding: { spelling: "b.md", fileKey: "b.md", seen: hash("a1") }, absence: null });
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("follows a rename chain and keeps the binding when the commit is acknowledged", async () => {
    const h = await synced();

    await h.vault.rename("a.md", "b.md");
    await h.vault.rename("b.md", "c.md");
    expect((await row(h, "A"))?.binding?.spelling).toBe("c.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["c.md", "A"]]));
    expect((await row(h, "A"))?.binding?.spelling).toBe("c.md");
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("moves the binding with a case-only rename on Windows, where the file key decides (E1)", async () => {
    const h = await synced("windows");

    await h.vault.rename("a.md", "A.md");

    expect((await row(h, "A"))?.binding?.spelling).toBe("A.md");
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("leaves the document user-deleted when the user deletes its file (E3)", async () => {
    const h = await synced();

    await h.vault.delete("a.md");

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("binds no document to a file created where a deleted one was (E3 then E5)", async () => {
    const h = await synced();

    await h.vault.delete("a.md");
    await h.vault.write("a.md", bytes("new"));

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("changes no binding for the rename of an untracked file (E2)", async () => {
    const h = await synced();
    const before = await h.journal.listDocuments();

    await h.vault.write("x.md", bytes("x"));
    await h.vault.rename("x.md", "y.md");
    await h.engine.settled();

    expect(await h.journal.listDocuments()).toEqual(before);
  });

  it("binds a new document to its file once its create is acknowledged", async () => {
    const h = await synced();

    await h.vault.write("n.md", bytes("n1"));
    await h.engine.push();
    const id = h.server.liveDocuments().get("n.md") ?? "";

    expect(await row(h, id)).toEqual({ binding: { spelling: "n.md", fileKey: "n.md", seen: hash("n1") }, absence: null });
  });

  it("records the content the engine read when an edit is acknowledged", async () => {
    const h = await synced();

    await h.vault.write("a.md", bytes("a2"));
    await h.engine.push();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.md", fileKey: "a.md", seen: hash("a2") }, absence: null });
  });

  it("moves the binding with the engine's own move of a renamed file off a path the server gave another document", async () => {
    const h = await synced();

    await h.vault.rename("a.md", "b.md");
    h.server.commit({ documentId: "B", path: "b.md", content: "theirs" });
    await h.engine.push();
    await h.engine.pull();
    await h.engine.push();

    const path = [...h.server.liveDocuments()].find(([, id]) => id === "A")?.[0];
    expect(path).toMatch(/^b \(conflict /);
    expect((await row(h, "A"))?.binding?.spelling).toBe(path);
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("moves the binding with a remote rename the pull applies", async () => {
    const h = await synced();

    h.server.commit({ documentId: "A", path: "moved.md", content: "a1" });
    await h.engine.pull();

    expect((await row(h, "A"))?.binding?.spelling).toBe("moved.md");
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("leaves a document whose tombstone was applied with no file it ever had here (never)", async () => {
    const h = await synced();

    h.server.commit({ documentId: "A", path: "a.md", deleted: true });
    await h.engine.pull();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "never" });
    expect(await h.engine.bindingShadow()).toEqual([]);
  });

  it("binds a merged document to the merge result", async () => {
    const h = await synced();

    await h.vault.write("a.md", bytes("a1\nmine\n"));
    h.server.commit({ documentId: "A", path: "a.md", content: "theirs\na1" });
    await h.engine.pull();

    const merged = await h.vault.read("a.md");
    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.md", fileKey: "a.md", seen: sha256Hex(merged) }, absence: null });
  });

  it("finds a file deleted while the app was not running at start-up (E7)", async () => {
    const h = await synced();
    h.engine.dispose();

    await h.vault.delete("a.md");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("gives a row written without a binding one at start-up, from its base", async () => {
    const h = await synced();
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state === undefined) throw new Error("no row");
    await h.journal.putDocument({ ...state, binding: undefined, absence: undefined });

    h.restart();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.md", fileKey: "a.md", seen: hash("a1") }, absence: null });
  });

  it("reports a binding that disagrees with the derived ownership", async () => {
    const h = await synced();
    await h.vault.write("other.md", bytes("o"));
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state === undefined) throw new Error("no row");
    // A binding the engine never made: another file than the document's.
    await h.journal.putDocument({ ...state, binding: { spelling: "other.md", fileKey: "other.md", seen: hash("o") }, absence: null });

    h.restart();

    expect(await h.engine.bindingShadow()).toEqual([{ documentId: "A", binding: "other.md", absence: null, derived: "a.md" }]);
  });

  it("reports a document the derived ownership has a file for but whose binding has none", async () => {
    const h = await synced();
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state === undefined) throw new Error("no row");
    await h.journal.putDocument({ ...state, binding: null, absence: "released" });

    h.restart();

    expect(await h.engine.bindingShadow()).toEqual([{ documentId: "A", binding: null, absence: "released", derived: "a.md" }]);
  });
});

describe("CrashingJournal", () => {
  it("counts transact, putIntent and removeIntent as crash points, a transact landing whole", async () => {
    const points = new CrashPoints();
    const journal = new CrashingJournal(points);
    const state: DocumentState = { documentId: "A", path: "a.md", revisionId: "r1", seq: 1n, baseHash: hash("a1"), size: 2n, kind: "text", deleted: false };

    points.crashAfter = 1;
    await expect(journal.transact({ cursor: { seq: 1n }, putDocuments: [state] })).rejects.toBeInstanceOf(Crash);
    expect(await journal.getCursor()).toBe(1n);
    expect(await journal.getDocument("A")).toEqual(state);

    points.crashAfter = 2;
    await expect(journal.putIntent({ kind: "apply", documentId: "A", steps: {} })).rejects.toBeInstanceOf(Crash);
    const [intent] = await journal.listIntents();
    expect(intent?.documentId).toBe("A");

    points.crashAfter = 3;
    await expect(journal.removeIntent(intent?.id ?? 0)).rejects.toBeInstanceOf(Crash);
    expect(await journal.listIntents()).toEqual([]);
  });
});
