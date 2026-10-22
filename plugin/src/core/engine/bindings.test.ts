import { Code, ConnectError } from "@connectrpc/connect";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../hash";
import type { DocumentState, JournalChanges } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryVault } from "../vault/memory";
import type { PathPlatform } from "../vaultpath/platform";
import { Bindings } from "./bindings";
import { PathSpace } from "./pathspace";
import { Crash, CrashingJournal, CrashPoints, harness, type Harness } from "./testing";

// The engine maintains every document's binding (docs/design/engine-path-ownership.md
// §4.1) from vault events (§4.3 E1–E5), its own changes and the start-up
// scan (E7). Since refactor step R7 it decides by them alone.

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

describe("Bindings", () => {
  it("binds a pulled document to the file the pull wrote", async () => {
    const h = await synced();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.md", fileKey: "a.md", seen: hash("a1") }, absence: null });
  });

  it("moves the binding with a user's rename before any push (E1)", async () => {
    const h = await synced();

    await h.vault.rename("a.md", "b.md");

    expect(await row(h, "A")).toEqual({ binding: { spelling: "b.md", fileKey: "b.md", seen: hash("a1") }, absence: null });
  });

  it("follows a rename chain and keeps the binding when the commit is acknowledged", async () => {
    const h = await synced();

    await h.vault.rename("a.md", "b.md");
    await h.vault.rename("b.md", "c.md");
    expect((await row(h, "A"))?.binding?.spelling).toBe("c.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["c.md", "A"]]));
    expect((await row(h, "A"))?.binding?.spelling).toBe("c.md");
  });

  it("moves the binding with a case-only rename on Windows, where the file key decides (E1)", async () => {
    const h = await synced("windows");

    await h.vault.rename("a.md", "A.md");

    expect((await row(h, "A"))?.binding?.spelling).toBe("A.md");
  });

  it("leaves the document user-deleted when the user deletes its file (E3)", async () => {
    const h = await synced();

    await h.vault.delete("a.md");

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
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
  });

  it("moves the binding with a remote rename the pull applies", async () => {
    const h = await synced();

    h.server.commit({ documentId: "A", path: "moved.md", content: "a1" });
    await h.engine.pull();

    expect((await row(h, "A"))?.binding?.spelling).toBe("moved.md");
  });

  it("leaves a document whose tombstone was applied with no file it ever had here (never)", async () => {
    const h = await synced();

    h.server.commit({ documentId: "A", path: "a.md", deleted: true });
    await h.engine.pull();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "never" });
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

  it("finds at start-up a user's case-only rename of a file the engine moved aside, which is the user's move then (#802)", async () => {
    const h = await synced("windows");
    await h.engine.settled();
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state?.binding == null) throw new Error("no binding");
    // As rule W's displace leaves it (design §4.1).
    await h.journal.putDocument({ ...state, binding: { ...state.binding, displaced: true } });

    await h.vault.rename("a.md", "A.md");
    h.restart();

    const found = await row(h, "A");
    expect(found?.binding?.spelling).toBe("A.md");
    expect(found?.binding?.displaced).toBeUndefined();
  });

  it("keeps at start-up the record that the engine moved a file it finds where it left it (#802)", async () => {
    const h = await synced("windows");
    await h.engine.settled();
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state?.binding == null) throw new Error("no binding");
    await h.journal.putDocument({ ...state, binding: { ...state.binding, displaced: true } });

    h.restart();

    expect((await row(h, "A"))?.binding?.displaced).toBe(true);
  });

  it("re-keys at start-up a binding recorded under another filesystem key than the platform's (#699)", async () => {
    // An Android journal from before its shared storage got a case-insensitive file key holds the spelling itself.
    const h = harness({ merge: "default", pathRules: { platform: "android" }, vault: new InMemoryVault({ pathRules: { platform: "android" } }) });
    h.server.commit({ documentId: "A", path: "Notes/a.md", content: "a1" });
    await h.engine.pull();
    await h.engine.settled();
    h.engine.dispose();
    const state = await h.journal.getDocument("A");
    if (state?.binding == null) throw new Error("no binding");
    await h.journal.putDocument({ ...state, binding: { ...state.binding, fileKey: "Notes/a.md" } });
    expect(await h.journal.documentByFileKey("NOTES/A.MD")).toBeUndefined();

    h.restart();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "Notes/a.md", fileKey: "NOTES/A.MD", seen: hash("a1") }, absence: null });
    expect((await h.journal.documentByFileKey("NOTES/A.MD"))?.documentId).toBe("A");
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

  // #802 (design §4.1): an engine write into the file rule W's displace moved aside keeps the record that the engine
  // put it there; a write that moves the document to another file is a new binding, which has none.
  it("keeps the displaced record through an engine write into the same file, not into another (#802)", async () => {
    const journal = new InMemoryJournal();
    const copy = "s (conflict laptop 1).md";
    const tombstone = { ...base("D", "s.md", "s1"), deleted: true };
    await journal.putDocument({ ...tombstone, binding: { spelling: copy, fileKey: space.filesystemKey(copy), seen: hash("s1"), displaced: true }, absence: null });
    const owner = await bindings(journal);

    await owner.put({ ...tombstone, revisionId: "D2", seq: 2n }, { kind: "merged", path: copy, hash: hash("merged") });
    expect((await binding(journal, "D")).binding).toEqual({ spelling: copy, fileKey: space.filesystemKey(copy), seen: hash("merged"), displaced: true });

    await owner.put({ ...tombstone, revisionId: "D3", seq: 3n }, { kind: "merged", path: "back.md", hash: hash("back") });
    expect((await binding(journal, "D")).binding).toEqual({ spelling: "back.md", fileKey: space.filesystemKey("back.md"), seen: hash("back") });
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

  // A v2 journal's migration may bind two documents to one file key (indexeddb.ts deriveV3Records).
  async function duplicated(journal: InMemoryJournal): Promise<void> {
    await journal.putDocument(bound(base("Y1", "y.md", "y1")));
    await journal.putDocument(bound(base("Y2", "Y.md", "y2"), "y.md"));
  }

  const neither = { binding: null };

  it("unbinds every document bound to the file an engine write binds another document to, not only the first found (C1)", async () => {
    const journal = new InMemoryJournal();
    await duplicated(journal);
    const owner = await bindings(journal);

    await owner.put(base("X", "y.md", "x1"), { kind: "applied" });

    expect(await binding(journal, "Y1")).toEqual({ ...neither, absence: "released" });
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "released" });
  });

  it.each([
    ["kept", { kind: "kept" }],
    ["applied", { kind: "applied" }],
  ] as const)("unbinds the other document of two bound to one file when an engine write (%s) binds the one a probe finds there (C1)", async (_name, change) => {
    const journal = new InMemoryJournal();
    await duplicated(journal);
    const owner = await bindings(journal);

    await owner.put({ ...base("Y1", "y.md", "y1"), revisionId: "Y1-2", seq: 2n }, change);

    expect((await binding(journal, "Y1")).binding).toEqual({ spelling: "y.md", fileKey: "y.md", seen: hash("y1") });
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "released" });
  });

  it("unbinds every document bound at a rename's target, not only the first found", async () => {
    const journal = new InMemoryJournal();
    await journal.putDocument(bound(base("A", "a.md", "a1")));
    await duplicated(journal);
    const owner = await bindings(journal);

    await owner.renamed("a.md", "y.md");

    expect((await binding(journal, "A")).binding?.spelling).toBe("y.md");
    expect(await binding(journal, "Y1")).toEqual({ ...neither, absence: "user-deleted" });
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "user-deleted" });
  });

  it("moves the first of two documents bound to a renamed file and releases the other (C1, #641)", async () => {
    const points = new CrashPoints();
    const journal = new CrashingJournal(points);
    await duplicated(journal);
    const owner = await bindings(journal);

    points.count = 0;
    await owner.renamed("y.md", "z.md");

    expect(points.count).toBe(1);
    expect(await binding(journal, "Y1")).toEqual({ binding: { spelling: "z.md", fileKey: "z.md", seen: hash("y1") }, absence: null });
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "released" });
    expect(await journal.documentsByFileKey("y.md")).toEqual([]);
  });

  it("releases the other of two documents bound to a file the user renames case-only on Windows (C1, #641)", async () => {
    const windows = new PathSpace({ platform: "windows" });
    const journal = new InMemoryJournal();
    const y1 = base("Y1", "y.md", "y1");
    const y2 = base("Y2", "Y.md", "y2");
    await journal.putDocument({ ...y1, binding: { spelling: "y.md", fileKey: windows.filesystemKey("y.md"), seen: y1.baseHash }, absence: null });
    await journal.putDocument({ ...y2, binding: { spelling: "y.md", fileKey: windows.filesystemKey("y.md"), seen: y2.baseHash }, absence: null });
    const vault = new InMemoryVault({ pathRules: { platform: "windows" } });
    await vault.write("y.md", bytes("y1"));
    const owner = new Bindings(journal, vault, windows);
    await owner.idle();

    await owner.renamed("y.md", "Y.md");

    expect((await binding(journal, "Y1")).binding?.spelling).toBe("Y.md");
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "released" });
  });

  it("unbinds every document bound to a deleted file in one journal transaction (E3, §4.3)", async () => {
    const points = new CrashPoints();
    const journal = new CrashingJournal(points);
    await duplicated(journal);
    const owner = await bindings(journal);

    points.count = 0;
    await owner.deleted("y.md", "user");

    expect(points.count).toBe(1);
    expect(await binding(journal, "Y1")).toEqual({ ...neither, absence: "user-deleted" });
    expect(await binding(journal, "Y2")).toEqual({ ...neither, absence: "user-deleted" });
  });

  it("writes every row the start-up scan changes in one journal transaction (E7, §4.3)", async () => {
    const points = new CrashPoints();
    const journal = new CrashingJournal(points);
    // Both files were deleted while the app was closed; neither is in the vault.
    await journal.putDocument(bound(base("A", "a.md", "a1")));
    await journal.putDocument(bound(base("B", "b.md", "b1")));
    points.count = 0;

    await new Bindings(journal, new InMemoryVault(), space).idle();

    expect(points.count).toBe(1);
    expect(await binding(journal, "A")).toEqual({ ...neither, absence: "user-deleted" });
    expect(await binding(journal, "B")).toEqual({ ...neither, absence: "user-deleted" });
  });

  it("settles after a user's rename whose transition failed, with no unhandled rejection, while a push still rejects", async () => {
    class FailingJournal extends InMemoryJournal {
      fail = false;
      override async transact(changes: JournalChanges): Promise<void> {
        if (this.fail) throw new Error("journal write failed");
        await super.transact(changes);
      }
    }
    // The global type of Node's process, which the plugin's tsconfig leaves out.
    const process = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const journal = new FailingJournal();
      const h = harness({ journal });
      h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
      await h.engine.pull();

      journal.fail = true;
      await h.vault.rename("a.md", "b.md");
      // The rename is reported even though its transition failed.
      await vi.waitFor(() => {
        expect(h.localChanges).toHaveLength(1);
      });
      // Unhandled rejections are reported once the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      await expect(h.engine.settled()).resolves.toBeUndefined();
      await expect(h.engine.push()).rejects.toThrow("journal write failed");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("rejects a push after a user's delete whose transition failed, instead of pushing without it", async () => {
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
    await h.vault.delete("a.md");
    await expect(h.engine.push()).rejects.toThrow("journal write failed");
    expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "A"]]));
  });

  it("keeps rejecting pushes when a later user event follows a failed transition, whose transition the later one does not clear", async () => {
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
    await h.engine.settled();
    // The journal works again; the later event's own transition would succeed.
    journal.fail = false;
    await h.vault.write("c.md", bytes("c1"));
    await h.engine.settled();

    await expect(h.engine.push()).rejects.toThrow("journal write failed");
    expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "A"]]));
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

// Refactor step R5a (design §9.2, #622): a create not acknowledged yet is a
// journal row bound to its file (§4.3, E2 note), written with its pending
// operation in one transaction, so it survives a crash and a restart, and a
// local rename of its file is a binding change like any other (E1).
describe("pending creates as bindings (refactor step R5a)", () => {
  /** Writes e.md and pushes it with every CommitRevision failing: the create stays pending. Returns its document id. */
  async function pendingCreate(h: Harness): Promise<string> {
    await h.vault.write("e.md", bytes("mine"));
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
    };
    await expect(h.engine.push()).rejects.toThrow();
    h.server.interceptor = undefined;
    const [operation] = await h.journal.listPending();
    if (operation === undefined) throw new Error("no pending create");
    return operation.documentId;
  }

  const created = { revisionId: "", deleted: true, binding: { spelling: "e.md", fileKey: "e.md", seen: hash("mine") }, absence: null };

  it("records a create not acknowledged yet with a row bound to its file, and keeps both over a restart", async () => {
    const h = harness({ merge: "default" });
    const mine = await pendingCreate(h);

    expect(await h.journal.getDocument(mine)).toMatchObject({ ...created, path: "e.md" });
    h.restart();
    await h.engine.settled();
    expect(await h.journal.getDocument(mine)).toMatchObject({ ...created, path: "e.md" });
    expect(await h.journal.listPending()).toMatchObject([{ documentId: mine, path: "e.md", baseRevisionId: "" }]);

    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["e.md", mine]]));
    expect(await row(h, mine)).toEqual({ binding: created.binding, absence: null });
  });

  it("writes a create's pending operation and its row in one journal transaction, so a crash right after keeps both", async () => {
    let armed = true;
    class CrashAfterCreate extends InMemoryJournal {
      override async transact(changes: JournalChanges): Promise<void> {
        await super.transact(changes);
        if (armed && (changes.addPending?.length ?? 0) > 0) {
          armed = false;
          throw new Crash("crash after the create is recorded");
        }
      }
    }
    const journal = new CrashAfterCreate();
    const h = harness({ merge: "default", journal });
    await h.vault.write("e.md", bytes("mine"));
    await expect(h.engine.push()).rejects.toBeInstanceOf(Crash);
    const [operation] = await journal.listPending();
    expect(operation).toBeDefined();
    const mine = operation?.documentId ?? "";
    expect(await journal.getDocument(mine)).toMatchObject({ ...created, path: "e.md" });

    h.restart();
    await h.engine.settled();
    expect(await journal.getDocument(mine)).toMatchObject({ ...created, path: "e.md" });
    await h.engine.push();

    // The create is committed once, under its own id.
    expect(h.server.liveDocuments()).toEqual(new Map([["e.md", mine]]));
    expect(h.server.history(mine)).toHaveLength(1);
    expect(await journal.listPending()).toEqual([]);
  });

  it("gives a create recorded without a row (before refactor step R5a) one at start-up", async () => {
    const journal = new InMemoryJournal();
    const vault = new InMemoryVault();
    await vault.write("e.md", bytes("mine"));
    await journal.addPending({ revisionId: "r", documentId: "N", baseRevisionId: "", path: "e.md", contentHash: hash("mine"), size: 4n, kind: "text", deleted: false });

    await new Bindings(journal, vault, new PathSpace()).idle();

    expect(await journal.getDocument("N")).toMatchObject({ ...created, path: "e.md" });
  });

  it("follows a rename of a create's file made while the start-up scan runs", async () => {
    const h = harness({ merge: "default" });
    const mine = await pendingCreate(h);

    h.restart();
    await h.vault.rename("e.md", "f.md");
    await h.engine.settled();

    expect(await row(h, mine)).toEqual({ binding: { ...created.binding, spelling: "f.md", fileKey: "f.md" }, absence: null });
  });

  it("removes a create's row with its pending operation when a pull supersedes the create", async () => {
    const h = harness({ merge: "default" });
    const mine = await pendingCreate(h);
    h.server.commit({ documentId: "D", path: "e.md", content: "mine" });

    await h.engine.pull();

    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.getDocument(mine)).toBeUndefined();
    expect(await row(h, "D")).toEqual({ binding: created.binding, absence: null });
  });
});

// Design §10.1 fix rule (#641): a property over Bindings that generates the
// class, journals a v2 migration left with several documents bound at one
// file key (indexeddb.ts deriveV3Records), followed by user renames and
// deletes, and checks C1 (INV-1) after every transition: no file key a
// transition touched has two bound documents, and every binding names a file
// the vault holds. A duplicate no transition touched is the migration's.
describe("Bindings keep one document per file key over v2 duplicates (C1, #641)", () => {
  const pool = ["a.md", "A.md", "b.md", "y.md", "Y.md", "z.md"];
  type Step = { type: "rename"; from: number; to: number } | { type: "delete"; path: number };
  const path = fc.nat({ max: pool.length - 1 });
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.tuple(path, path).map(([from, to]): Step => ({ type: "rename", from, to })),
    path.map((at): Step => ({ type: "delete", path: at })),
  );

  it("binds at most one document to each file key a transition touched, and only to files the vault holds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<PathPlatform>("posix", "windows"), fc.array(path, { minLength: 1, maxLength: 5 }), fc.array(step, { maxLength: 8 }), async (platform, bound, steps) => {
        const space = new PathSpace({ platform });
        const journal = new InMemoryJournal();
        const vault = new InMemoryVault({ pathRules: { platform } });
        // The disk as the user changes it: file key → spelling.
        const disk = new Map<string, string>();
        for (const [index, at] of bound.entries()) {
          const spelling = pool[at] ?? "";
          const key = space.filesystemKey(spelling);
          if (!disk.has(key)) {
            disk.set(key, spelling);
            await vault.write(spelling, bytes(spelling));
          }
          const content = `d${String(index)}`;
          await journal.putDocument({ documentId: `D${String(index)}`, path: spelling, revisionId: `D${String(index)}-1`, seq: 1n, baseHash: hash(content), size: 2n, kind: "text", deleted: false, binding: { spelling, fileKey: key, seen: hash(content) }, absence: null });
        }
        const owner = new Bindings(journal, vault, space);
        await owner.idle();
        const touched = new Set<string>();
        for (const next of steps) {
          if (next.type === "rename") {
            const from = pool[next.from] ?? "";
            const to = pool[next.to] ?? "";
            const [fromKey, toKey] = [space.filesystemKey(from), space.filesystemKey(to)];
            // The vault renames only an existing file, and never onto another one.
            if (from === to || !disk.has(fromKey) || (fromKey !== toKey && disk.has(toKey))) continue;
            disk.delete(fromKey);
            disk.set(toKey, to);
            touched.add(fromKey).add(toKey);
            await owner.renamed(from, to);
          } else {
            const at = pool[next.path] ?? "";
            if (!disk.delete(space.filesystemKey(at))) continue;
            touched.add(space.filesystemKey(at));
            await owner.deleted(at, "user");
          }
          const holders = new Map<string, string[]>();
          for (const state of await journal.listDocuments()) {
            if (state.binding === undefined || state.binding === null) continue;
            holders.set(state.binding.fileKey, [...(holders.get(state.binding.fileKey) ?? []), state.documentId]);
          }
          for (const [key, documents] of holders) {
            if (touched.has(key)) expect(documents.length, `documents bound at ${key}: ${documents.join(", ")}`).toBe(1);
            expect(disk.has(key), `${documents.join(", ")} bound at ${key}, which the vault does not hold`).toBe(true);
          }
        }
      }),
      { seed: 641, numRuns: 500 },
    );
  });
});

// Refactor step R7b (design §6.2 as amended): `deleted` no longer doubles as
// "released". An in-memory journal has no schema migrations, so the start-up
// scan gives a released row its live base back, as journal v5 does for
// IndexedDB, and keeps every document.
describe("the start-up scan of a journal written before R7b", () => {
  it("keeps every document and gives a released row its live base back", async () => {
    const journal = new InMemoryJournal();
    const base = { seq: 1n, size: 2n, kind: "text" as const };
    const released: DocumentState = { ...base, documentId: "released", path: "con.md", revisionId: "r-released", baseHash: hash("c1"), deleted: true, binding: null, absence: "released" };
    const live: DocumentState = { ...base, documentId: "live", path: "a.md", revisionId: "r-live", baseHash: hash("a1"), deleted: false, binding: { spelling: "a.md", fileKey: "a.md", seen: hash("a1") }, absence: null };
    const tombstone: DocumentState = { ...base, documentId: "tombstone", path: "t.md", revisionId: "r-tombstone", baseHash: hash("t1"), deleted: true, binding: null, absence: "never" };
    // Released-looking, but with no deferral: not a release, left as it is.
    const undeferred: DocumentState = { ...base, documentId: "undeferred", path: "old.md", revisionId: "r-undeferred", baseHash: hash("o1"), deleted: true, binding: null, absence: "released" };
    for (const state of [released, live, tombstone, undeferred]) await journal.putDocument(state);
    await journal.putDeferred({
      revision: { revisionId: "r-released-2", documentId: "released", seq: 2n, parentRevisionId: "r-released", kind: "text", path: "con.md", deleted: false, contentHash: hash("c2"), size: 2n },
      reason: "unmaterializable",
      unmaterializable: "reserved-name",
    });
    const vault = new InMemoryVault();
    await vault.write("a.md", bytes("a1"));

    const h = harness({ journal, vault, pathRules: { platform: "windows" } });
    await h.engine.settled();

    const documents = new Map((await journal.listDocuments()).map((state) => [state.documentId, state]));
    expect([...documents.keys()].sort()).toEqual(["live", "released", "tombstone", "undeferred"]);
    expect(documents.get("released")).toMatchObject({ deleted: false, binding: null, absence: "released", revisionId: "r-released" });
    expect(documents.get("live")).toMatchObject({ deleted: false, revisionId: "r-live", binding: { spelling: "a.md" } });
    expect(documents.get("tombstone")).toMatchObject({ deleted: true, revisionId: "r-tombstone" });
    expect(documents.get("undeferred")).toMatchObject({ deleted: true, absence: "released" });
    expect(await journal.getDeferred("released")).toBeDefined();
  });
});

// Refactor step R11 (design §4.3 E7, decision 4): the start-up scan finds a
// rename the engine never saw (made while the app was not running, or lost
// to a kill before its event was persisted) by a unique content match.
describe("the start-up content match (E7, decision 4)", () => {
  /** A harness whose server and device sync `files` (path, content) as documents named by `ids`. */
  async function syncedFiles(files: [string, string, string][], vault?: InMemoryVault): Promise<Harness> {
    const h = harness({ merge: "default", ...(vault === undefined ? {} : { vault }) });
    for (const [documentId, path, content] of files) h.server.commit({ documentId, path, content });
    await h.engine.pull();
    await h.engine.settled();
    h.engine.dispose();
    return h;
  }

  it("transfers the binding of a missing file to the one untracked file with its content, and pushes a rename", async () => {
    const h = await syncedFiles([["A", "a.md", "a1"]]);

    await h.vault.rename("a.md", "b.md");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "b.md", fileKey: "b.md", seen: hash("a1") }, absence: null });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "A"]]));
    expect(h.server.deletedDocuments()).toEqual([]);
  });

  it("transfers no binding when two untracked files hold the missing file's content (delete plus create)", async () => {
    const h = await syncedFiles([["A", "a.md", "a1"]]);

    await h.vault.rename("a.md", "b.md");
    await h.vault.write("c.md", bytes("a1"));
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("transfers no binding when two missing files had the untracked file's content", async () => {
    const h = await syncedFiles([
      ["A", "a.md", "same"],
      ["B", "b.md", "same"],
    ]);

    await h.vault.rename("a.md", "c.md");
    await h.vault.delete("b.md");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
    expect(await row(h, "B")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("transfers no binding to a file of another kind with the same content", async () => {
    const h = await syncedFiles([["A", "a.md", "a1"]]);

    await h.vault.rename("a.md", "a.bin");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("matches kinds by the engine's own classifier", async () => {
    // A classifier that takes `.bin` files for text, as a user's text-extension setting may.
    const h = harness({ merge: "default", classify: (path) => (path.endsWith(".md") || path.endsWith(".bin") ? "text" : "blob") });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    await h.engine.settled();
    h.engine.dispose();

    await h.vault.rename("a.md", "a.bin");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "a.bin", fileKey: "a.bin", seen: hash("a1") }, absence: null });
  });

  it("transfers no binding to a file the vault does not sync", async () => {
    class ScopedVault extends InMemoryVault {
      isSynced(path: string): boolean {
        return !path.startsWith("private/");
      }
    }
    const h = await syncedFiles([["A", "a.md", "a1"]], new ScopedVault());

    await h.vault.rename("a.md", "private/a.md");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("transfers no binding to a file whose content changed after the rename", async () => {
    const h = await syncedFiles([["A", "a.md", "a1"]]);

    await h.vault.rename("a.md", "b.md");
    await h.vault.write("b.md", bytes("a2"));
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("transfers a missing file's binding to another document's bound file that now holds its content and not its own (E7b, #793)", async () => {
    const h = await syncedFiles([
      ["N", "note.md", "note"],
      ["O", "moved.md", "other"],
    ]);

    // The user deletes O's file and renames N's onto its path, while the app is not running.
    await h.vault.delete("moved.md");
    await h.vault.rename("note.md", "moved.md");
    h.restart();

    expect(await row(h, "N")).toEqual({ binding: { spelling: "moved.md", fileKey: "moved.md", seen: hash("note") }, absence: null });
    expect(await row(h, "O")).toEqual({ binding: null, absence: "user-deleted" });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["moved.md", "N"]]));
    expect(h.server.deletedDocuments()).toEqual(["O"]);
  });

  it("keeps a bound file that still holds its own content, even when it equals a missing file's (E7b)", async () => {
    const h = await syncedFiles([
      ["N", "note.md", "same"],
      ["O", "other.md", "same"],
    ]);

    await h.vault.delete("note.md");
    h.restart();

    expect(await row(h, "N")).toEqual({ binding: null, absence: "user-deleted" });
    expect(await row(h, "O")).toEqual({ binding: { spelling: "other.md", fileKey: "other.md", seen: hash("same") }, absence: null });
  });

  it("follows a rename chain made while the app was not running (E7 after E7b)", async () => {
    const h = await syncedFiles([
      ["A", "a.md", "a1"],
      ["B", "b.md", "b1"],
    ]);

    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("a.md", "b.md");
    h.restart();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "b.md", fileKey: "b.md", seen: hash("a1") }, absence: null });
    expect(await row(h, "B")).toEqual({ binding: { spelling: "c.md", fileKey: "c.md", seen: hash("b1") }, absence: null });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(
      new Map([
        ["b.md", "A"],
        ["c.md", "B"],
      ]),
    );
    expect(h.server.deletedDocuments()).toEqual([]);
  });
});

describe("the start-up content match races with events (E7, decision 4)", () => {
  async function syncedFiles(files: [string, string, string][]): Promise<Harness> {
    const h = harness({ merge: "default" });
    for (const [documentId, path, content] of files) h.server.commit({ documentId, path, content });
    await h.engine.pull();
    await h.engine.settled();
    return h;
  }

  it("keeps the binding the scan matched when the delete and rename it saw arrive as events while it runs (E7b)", async () => {
    const h = await syncedFiles([
      ["N", "note.md", "note"],
      ["O", "moved.md", "other"],
    ]);

    h.restart();
    await h.vault.delete("moved.md");
    await h.vault.rename("note.md", "moved.md");
    await h.engine.settled();

    expect(await row(h, "N")).toEqual({ binding: { spelling: "moved.md", fileKey: "moved.md", seen: hash("note") }, absence: null });
    expect(await row(h, "O")).toEqual({ binding: null, absence: "user-deleted" });
  });

  it("keeps the bindings the scan matched when a rename chain's events arrive while it runs", async () => {
    const h = await syncedFiles([
      ["A", "a.md", "a1"],
      ["B", "b.md", "b1"],
    ]);

    h.restart();
    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(await row(h, "A")).toEqual({ binding: { spelling: "b.md", fileKey: "b.md", seen: hash("a1") }, absence: null });
    expect(await row(h, "B")).toEqual({ binding: { spelling: "c.md", fileKey: "c.md", seen: hash("b1") }, absence: null });
  });

  it("unbinds the matched document when the user deletes its new file while the scan runs", async () => {
    const h = await syncedFiles([["A", "a.md", "a1"]]);

    h.restart();
    await h.vault.rename("a.md", "b.md");
    await h.vault.delete("b.md");
    await h.engine.settled();

    expect(await row(h, "A")).toEqual({ binding: null, absence: "user-deleted" });
  });
});
