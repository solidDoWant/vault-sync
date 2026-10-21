import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { DocumentState, JournalChanges } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import { Bindings } from "./bindings";
import { PathSpace } from "./pathspace";
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

// Review follow-ups of R4 (#611): each guards a rule that bindings decide
// by once push derives from them (R5).
describe("Bindings rules", () => {
  const space = new PathSpace();

  function base(documentId: string, path: string, content: string): DocumentState {
    return { documentId, path, revisionId: `${documentId}1`, seq: 1n, baseHash: hash(content), size: BigInt(content.length), kind: "text", deleted: false };
  }

  function bound(state: DocumentState, spelling = state.path): DocumentState {
    return { ...state, binding: { spelling, fileKey: space.filesystemKey(spelling), seen: state.baseHash }, absence: null };
  }

  async function bindings(journal: InMemoryJournal): Promise<Bindings> {
    const vault = new InMemoryVault();
    for (const state of await journal.listDocuments()) if (state.binding) await vault.write(state.binding.spelling, bytes("x"));
    const owner = new Bindings(journal, vault, space);
    await owner.idle();
    return owner;
  }

  async function binding(journal: InMemoryJournal, documentId: string): Promise<Pick<DocumentState, "binding" | "absence">> {
    const state = await journal.getDocument(documentId);
    return { binding: state?.binding, absence: state?.absence };
  }

  it("never loses a user's rename to an engine write of the same row that read it before (serialization)", async () => {
    // An engine write reads the row, then the journal stalls; the user's rename of the document's file arrives meanwhile.
    class StallingJournal extends InMemoryJournal {
      stall: Promise<void> | undefined;
      entered: (() => void) | undefined;
      override async getDocument(documentId: string): Promise<DocumentState | undefined> {
        const state = await super.getDocument(documentId);
        const stall = this.stall;
        this.stall = undefined;
        if (stall !== undefined) {
          this.entered?.();
          await stall;
        }
        return state;
      }
    }
    const journal = new StallingJournal();
    const a = base("A", "a.md", "a1");
    await journal.putDocument(bound(a));
    const owner = await bindings(journal);

    let release: () => void = () => undefined;
    journal.stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      journal.entered = resolve;
    });
    const write = owner.put({ ...a, revisionId: "A2", seq: 2n }, { kind: "kept" });
    await entered;
    const rename = owner.renamed("a.md", "b.md");
    // Every microtask the rename could run without waiting for the write has run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([write, rename]);

    expect((await journal.getDocument("A"))?.revisionId).toBe("A2");
    expect((await binding(journal, "A")).binding?.spelling).toBe("b.md");
  });

  it("unbinds the document bound to a file an engine write binds another document to (C1)", async () => {
    const journal = new InMemoryJournal();
    await journal.putDocument(bound(base("Y", "y.md", "y1")));
    const owner = await bindings(journal);

    await owner.put(base("X", "y.md", "x1"), { kind: "applied" });

    expect(await binding(journal, "X")).toEqual({ binding: { spelling: "y.md", fileKey: "y.md", seen: hash("x1") }, absence: null });
    expect(await binding(journal, "Y")).toEqual({ binding: null, absence: "released" });
    expect((await journal.documentByFileKey("y.md"))?.documentId).toBe("X");
  });

  it("unbinds a stale binding at a rename's target, whose file the rename could not have moved onto", async () => {
    const journal = new InMemoryJournal();
    await journal.putDocument(bound(base("A", "a.md", "a1")));
    await journal.putDocument(bound(base("Z", "b.md", "z1")));
    const owner = await bindings(journal);

    await owner.renamed("a.md", "b.md");

    expect((await binding(journal, "A")).binding?.spelling).toBe("b.md");
    expect(await binding(journal, "Z")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("leaves a document whose file the user deleted unbound when its commit is acknowledged (E3, #254)", async () => {
    const journal = new InMemoryJournal();
    const a = base("A", "a.md", "a1");
    await journal.putDocument(bound(a));
    const owner = await bindings(journal);

    await owner.deleted("a.md", "user");
    await owner.put({ ...a, revisionId: "A2", seq: 2n, baseHash: hash("a2") }, { kind: "acknowledged", hash: hash("a2") });

    expect(await binding(journal, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("writes every row of a transition in one journal transaction, one crash point (§4.3)", async () => {
    const points = new CrashPoints();
    const journal = new CrashingJournal(points);
    await journal.putDocument(bound(base("Y", "y.md", "y1")));
    await journal.putDocument(bound(base("A", "a.md", "a1")));
    await journal.putDocument(bound(base("Z", "b.md", "z1")));
    const owner = await bindings(journal);

    points.count = 0;
    await owner.put(base("X", "y.md", "x1"), { kind: "applied" });
    expect(points.count).toBe(1);
    await owner.renamed("a.md", "b.md");
    expect(points.count).toBe(2);
  });

  it("fails every later transition once one failed to reach the journal, rather than deciding by a binding short of it", async () => {
    class FailingJournal extends InMemoryJournal {
      fail = false;
      override async transact(changes: JournalChanges): Promise<void> {
        if (this.fail) throw new Error("journal write failed");
        await super.transact(changes);
      }
    }
    const journal = new FailingJournal();
    await journal.putDocument(bound(base("A", "a.md", "a1")));
    const owner = await bindings(journal);

    journal.fail = true;
    await expect(owner.renamed("a.md", "b.md")).rejects.toThrow("journal write failed");
    journal.fail = false;

    await expect(owner.put(base("A", "a.md", "a1"), { kind: "kept" })).rejects.toThrow("journal write failed");
    expect((await binding(journal, "A")).binding?.spelling).toBe("a.md");
  });

  it("rejects a push after a user's rename whose transition failed, instead of pushing without it", async () => {
    class FailingJournal extends InMemoryJournal {
      fail = false;
      override async transact(changes: JournalChanges): Promise<void> {
        if (this.fail) throw new Error("journal write failed");
        await super.transact(changes);
      }
    }
    const journal = new FailingJournal();
    const h = harness({ journal });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();

    journal.fail = true;
    await h.vault.rename("a.md", "b.md");
    await expect(h.engine.push()).rejects.toThrow("journal write failed");
    expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "A"]]));
  });
});
