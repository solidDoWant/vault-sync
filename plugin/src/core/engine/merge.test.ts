import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { ConflictRecord, DeferredRevision, DocumentState } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import type { WritePrecondition } from "../vault/adapter";
import { threeWayMerge, type MergeHook } from "./merge";
import { InMemoryServer } from "./memory-server";
import { classifyByExtensions } from "./remote";
import { copyOf, Crash, CrashingJournal, CrashingVault, CrashPoints, files, harness, moveHeadBeforeCommit, syncedOnBoth, testStamp, text, twoDevices, type Harness } from "./testing";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
const crlf = (...values: string[]) => values.map((value) => `${value}\r\n`).join("");

const conflictMarkers = /^(<{7}|={7}|>{7})/m;

describe("SyncEngine merge (SPEC.md §7)", () => {
  describe("given non-overlapping concurrent edits of a note", () => {
    const base = lines("# Plan", "", "one", "two", "three", "four", "five");
    const edited = (first: string, last: string) => lines("# Plan", "", first, "two", "three", "four", last);

    it("has both edits on every device after sync, and no conflict copy", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "plan.md", base);
      await devices.a.vault.write("plan.md", bytes(edited("one (from a)", "five")));
      await devices.b.vault.write("plan.md", bytes(edited("one", "five (from b)")));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      const merged = edited("one (from a)", "five (from b)");
      expect(devices.server.liveFiles()).toEqual(new Map([["plan.md", merged]]));
      expect(await files(devices.a.vault)).toEqual(new Map([["plan.md", merged]]));
      expect(await files(devices.b.vault)).toEqual(new Map([["plan.md", merged]]));
      expect(await devices.a.journal.listConflicts()).toEqual([]);
      expect(await devices.b.journal.listConflicts()).toEqual([]);
      expect(await devices.b.journal.listPending()).toEqual([]);
      expect(await devices.b.journal.listDeferred()).toEqual([]);
      // B's merge is committed on top of A's revision: one chain, nothing overwritten.
      const [document] = await devices.a.journal.listDocuments();
      const history = devices.server.history(document?.documentId ?? "");
      expect(history).toHaveLength(3);
      expect(history[2]?.parentRevId).toBe(history[1]?.id);
    });

    it("merges when the head moves between the pull and the commit", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "plan.md", content: base });
      await h.engine.pull();
      await h.vault.write("plan.md", bytes(edited("one (local)", "five")));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "plan.md", content: edited("one", "five (remote)") }));

      const summary = await h.engine.push();

      const merged = edited("one (local)", "five (remote)");
      expect(summary).toMatchObject({ conflicts: 1, committed: 1, pending: 0 });
      expect(h.server.liveFiles()).toEqual(new Map([["plan.md", merged]]));
      expect(await files(h.vault)).toEqual(new Map([["plan.md", merged]]));
      expect(await h.journal.listConflicts()).toEqual([]);
      // The engine's own merge write is not reported as a user edit.
      expect(h.localChanges.map((event) => event.type)).toEqual(["modify"]);
    });
  });

  describe("given overlapping concurrent edits of a note", () => {
    it("keeps the remote version in place and the local version as a conflict copy, without conflict markers", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "notes/plan.md", lines("one", "two", "three"));
      await devices.a.vault.write("notes/plan.md", bytes(lines("one", "two (from a)", "three")));
      await devices.b.vault.write("notes/plan.md", bytes(lines("one", "two (from b)", "three")));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      const copy = `notes/${copyOf("plan", ".md", "device-b")}`;
      const expected = new Map([
        ["notes/plan.md", lines("one", "two (from a)", "three")],
        [copy, lines("one", "two (from b)", "three")],
      ]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      for (const content of expected.values()) expect(content).not.toMatch(conflictMarkers);
      expect(await devices.b.journal.listPending()).toEqual([]);
      expect(await devices.b.journal.listDeferred()).toEqual([]);
    });

    it("records the conflict in the conflict log", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "plan.md", lines("one", "two"));
      await devices.a.vault.write("plan.md", bytes(lines("one (a)", "two")));
      await devices.b.vault.write("plan.md", bytes(lines("one (b)", "two")));
      await devices.a.engine.push();

      await devices.b.engine.push();

      const [document] = await devices.b.journal.listDocuments();
      const remote = devices.server.history(document?.documentId ?? "")[1];
      expect(await devices.b.journal.listConflicts()).toEqual([
        {
          id: expect.any(String) as unknown,
          documentId: document?.documentId,
          path: "plan.md",
          reason: "overlapping-edits",
          copyPath: copyOf("plan", ".md", "device-b"),
          copyHash: sha256Hex(bytes(lines("one (b)", "two"))),
          remoteRevisionId: remote?.id,
          at: Date.UTC(2026, 9, 18, 4, 5, 6),
        } satisfies Record<keyof ConflictRecord, unknown>,
      ]);
      expect(await devices.a.journal.listConflicts()).toEqual([]);
    });

    it("numbers the copy when a file already has the copy's name", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("x") });
      await h.engine.pull();
      await h.vault.write(copyOf("a", ".md"), bytes("unrelated"));
      await h.vault.write("a.md", bytes(lines("local")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("remote") });

      await h.engine.push();

      expect(text(await h.vault.read(`a (conflict laptop ${testStamp} 2).md`))).toBe(lines("local"));
      expect(text(await h.vault.read(copyOf("a", ".md")))).toBe("unrelated");
      expect(text(await h.vault.read("a.md"))).toBe(lines("remote"));
    });

    it("numbers the copy when a folder already has the copy's name", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("x") });
      await h.engine.pull();
      await h.vault.write(`${copyOf("a", ".md")}/inside.md`, bytes("in a folder"));
      await h.vault.write("a.md", bytes(lines("local")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("remote") });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(
        new Map([
          ["a.md", lines("remote")],
          [`a (conflict laptop ${testStamp} 2).md`, lines("local")],
          [`${copyOf("a", ".md")}/inside.md`, "in a folder"],
        ]),
      );
      expect(await h.journal.listDeferred()).toEqual([]);
    });

    it("leaves the local version in place, logged, when no conflict-copy name fits the path limits", async () => {
      const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/${"g".repeat(60)}`;
      const path = `${folder}/a.md`;
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path, content: lines("x") });
      await h.engine.pull();
      await h.vault.write(path, bytes(lines("local")));
      const remote = h.server.commit({ documentId: "a", path, content: lines("remote") });

      await h.engine.push();
      await h.engine.push();

      expect(await files(h.vault)).toEqual(new Map([[path, lines("local")]]));
      expect(await h.journal.listDeferred()).toMatchObject([{ reason: "local-changes", revision: { revisionId: remote.id } }]);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "a", reason: "overlapping-edits", copyPath: null, copyHash: sha256Hex(bytes(lines("local"))) }]);
      expect(h.server.history("a")).toHaveLength(2);
    });
  });

  describe("given concurrent edits of a binary file", () => {
    it("keeps the remote version in place and the local version as a conflict copy", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "image.png", new Uint8Array([1, 2, 3]));
      await devices.a.vault.write("image.png", new Uint8Array([4, 5, 6]));
      await devices.b.vault.write("image.png", new Uint8Array([7, 8, 9]));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      const copy = copyOf("image", ".png", "device-b");
      for (const device of [devices.a, devices.b]) {
        expect((await device.vault.list()).sort()).toEqual([copy, "image.png"].sort());
        expect([...(await device.vault.read("image.png"))]).toEqual([4, 5, 6]);
        expect([...(await device.vault.read(copy))]).toEqual([7, 8, 9]);
      }
      expect(await devices.b.journal.listConflicts()).toMatchObject([{ reason: "binary", path: "image.png", copyPath: copy }]);
    });

    it("does not line-merge a non-text document even when its edits do not overlap", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "board.canvas", lines("{", '  "a": 1,', '  "b": 2', "}"));
      await devices.a.vault.write("board.canvas", bytes(lines("{", '  "a": 10,', '  "b": 2', "}")));
      await devices.b.vault.write("board.canvas", bytes(lines("{", '  "a": 1,', '  "b": 20', "}")));

      await devices.a.engine.push();
      await devices.b.engine.push();

      expect(text(await devices.b.vault.read("board.canvas"))).toBe(lines("{", '  "a": 10,', '  "b": 2', "}"));
      expect(text(await devices.b.vault.read(copyOf("board", ".canvas", "device-b")))).toBe(lines("{", '  "a": 1,', '  "b": 20', "}"));
      expect(await devices.b.journal.listConflicts()).toMatchObject([{ reason: "binary" }]);
    });

    it("line-merges a document whose extension the configured classification makes text", async () => {
      const devices = twoDevices({ classify: classifyByExtensions(["md", "canvas"]) });
      await syncedOnBoth(devices, "board.canvas", lines("{", '  "a": 1,', '  "b": 2', "}"));
      await devices.a.vault.write("board.canvas", bytes(lines("{", '  "a": 10,', '  "b": 2', "}")));
      await devices.b.vault.write("board.canvas", bytes(lines("{", '  "a": 1,', '  "b": 20', "}")));

      await devices.a.engine.push();
      await devices.b.engine.push();

      expect(await files(devices.b.vault)).toEqual(new Map([["board.canvas", lines("{", '  "a": 10,', '  "b": 20', "}")]]));
      expect(await devices.b.journal.listConflicts()).toEqual([]);
    });
  });

  describe("given line-ending and trailing-newline differences", () => {
    it("does not create a conflict copy when one side converted LF to CRLF and the other edited a line", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one", "two", "three"));
      await devices.a.vault.write("a.md", bytes(lines("one", "two (edited)", "three")));
      await devices.b.vault.write("a.md", bytes(crlf("one", "two", "three")));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      const expected = new Map([["a.md", crlf("one", "two (edited)", "three")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await devices.b.journal.listConflicts()).toEqual([]);
    });

    it("does not create a conflict copy when one side only added the trailing newline", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", "one\ntwo\nthree");
      await devices.a.vault.write("a.md", bytes("one\ntwo\nthree (edited)"));
      await devices.b.vault.write("a.md", bytes("one\ntwo\nthree\n"));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      expect(await files(devices.a.vault)).toEqual(new Map([["a.md", "one\ntwo\nthree (edited)\n"]]));
      expect(await devices.b.journal.listConflicts()).toEqual([]);
    });
  });

  describe("given an edit concurrent with a delete or rename", () => {
    it("keeps a remote edit of a document deleted locally", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one"));
      await devices.a.vault.write("a.md", bytes(lines("one", "edited")));
      await devices.b.vault.delete("a.md");

      await devices.a.engine.push();
      await devices.b.engine.push();

      expect(devices.server.liveFiles()).toEqual(new Map([["a.md", lines("one", "edited")]]));
      expect(await files(devices.b.vault)).toEqual(new Map([["a.md", lines("one", "edited")]]));
      expect(await devices.b.journal.listPending()).toEqual([]);
    });

    it("brings a document deleted remotely back with the local edit", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one"));
      await devices.a.vault.delete("a.md");
      await devices.b.vault.write("a.md", bytes(lines("one", "edited")));

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      expect(devices.server.liveFiles()).toEqual(new Map([["a.md", lines("one", "edited")]]));
      expect(await files(devices.a.vault)).toEqual(new Map([["a.md", lines("one", "edited")]]));
      const [document] = await devices.a.journal.listDocuments();
      expect(devices.server.history(document?.documentId ?? "").map((revision) => revision.deleted)).toEqual([false, true, false]);
    });

    it("keeps a local rename and a remote edit in one document", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one"));
      await devices.a.vault.write("a.md", bytes(lines("one", "edited")));
      await devices.b.vault.rename("a.md", "renamed.md");

      await devices.a.engine.push();
      await devices.b.engine.push();
      await devices.a.engine.pull();

      expect(devices.server.liveFiles()).toEqual(new Map([["renamed.md", lines("one", "edited")]]));
      expect(await files(devices.a.vault)).toEqual(new Map([["renamed.md", lines("one", "edited")]]));
      expect(await files(devices.b.vault)).toEqual(new Map([["renamed.md", lines("one", "edited")]]));
      expect(await devices.a.journal.listDocuments()).toHaveLength(1);
    });

    it("keeps a local rename as a rename of the document when the head moves before its commit", async () => {
      const h = harness({ merge: "default" });
      const base = h.server.commit({ documentId: "a", path: "a.md", content: lines("one") });
      await h.engine.pull();
      await h.vault.rename("a.md", "renamed.md");
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "remote") }));

      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["renamed.md", lines("one", "remote")]]));
      expect(await files(h.vault)).toEqual(new Map([["renamed.md", lines("one", "remote")]]));
      expect(h.server.history("a").map((revision) => revision.parentRevId)).toEqual(["", base.id, h.server.history("a")[1]?.id]);
      expect(await h.journal.listDocuments()).toMatchObject([{ documentId: "a", path: "renamed.md" }]);
    });
  });

  describe("given a remote rename onto a path an unsynced local file holds", () => {
    // The local file is not the renamed document's: it is a concurrent create
    // at the rename's target. The remote document lands in place and the local
    // file is kept as a logged conflict copy (SPEC.md §7).
    const mine = lines("my own new note");

    it("keeps the local file whole as a logged conflict copy and the renamed document in place", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
      await h.engine.pull();
      await h.vault.write("c.md", bytes(mine));
      const remote = h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });

      await h.engine.pull();
      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b line", "appended remotely")],
        [copyOf("c", ".md"), mine],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      // The renamed document keeps its id and the other device's revision is its head.
      expect(h.server.head("b")?.id).toBe(remote.id);
      expect(await h.journal.listConflicts()).toMatchObject([
        { documentId: "b", path: "c.md", reason: "concurrent-create", copyPath: copyOf("c", ".md"), copyHash: sha256Hex(bytes(mine)), remoteRevisionId: remote.id },
      ]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
    });

    it("keeps the local file when the remote rename does not change the content", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
      await h.engine.pull();
      await h.vault.write("c.md", bytes(mine));
      h.server.commit({ documentId: "b", path: "c.md" });

      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b line")],
        [copyOf("c", ".md"), mine],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(h.server.history("b")).toHaveLength(2);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "b", reason: "concurrent-create", copyHash: sha256Hex(bytes(mine)) }]);
    });

    it("keeps the local file when the renamed document was also edited locally", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)", "two")));
      await h.vault.write("c.md", bytes(mine));
      h.server.commit({ documentId: "b", path: "c.md", content: lines("one", "two (remote)") });

      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("one (local)", "two (remote)")],
        [copyOf("c", ".md"), mine],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "b", reason: "concurrent-create", copyHash: sha256Hex(bytes(mine)) }]);
    });

    it("keeps the local file when the renamed document was deleted locally", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
      await h.engine.pull();
      await h.vault.delete("a.md");
      await h.vault.write("c.md", bytes(mine));
      h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });

      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b line", "appended remotely")],
        [copyOf("c", ".md"), mine],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "b", reason: "concurrent-create", copyHash: sha256Hex(bytes(mine)) }]);
    });

    it("keeps the local file when its create was pushed but not yet committed", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
      await h.engine.pull();
      await h.vault.write("c.md", bytes(mine));
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("down", Code.Internal);
      };
      await expect(h.engine.push()).rejects.toThrow();
      h.server.interceptor = undefined;
      expect(await h.journal.listPending()).toMatchObject([{ path: "c.md" }]);
      h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });

      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b line", "appended remotely")],
        [copyOf("c", ".md"), mine],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await h.journal.listPending()).toEqual([]);
    });

    it("keeps an edit the user makes to the local file while it is being copied", async () => {
      let edited = false;
      const h = harness({
        merge: "default",
        wrapVault: (vault) =>
          new Proxy(vault, {
            get(target, property, receiver) {
              if (property === "write") {
                return async (path: string, data: Uint8Array, precondition?: WritePrecondition) => {
                  await target.write(path, data, precondition);
                  if (path === copyOf("c", ".md") && !edited) {
                    edited = true;
                    await target.write("c.md", bytes(lines("my own new note", "typed meanwhile")));
                  }
                };
              }
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          }),
      });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
      await h.engine.pull();
      await h.vault.write("c.md", bytes(mine));
      h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });

      await h.engine.pull();
      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b line", "appended remotely")],
        [copyOf("c", ".md"), mine],
        [`c (conflict laptop ${testStamp} 2).md`, lines("my own new note", "typed meanwhile")],
      ]);
      expect(edited).toBe(true);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
    });
  });

  describe("given another document's file or pending operation in the merge's way", () => {
    it("never replaces the edited file of another document with a remote create at its path", async () => {
      // d's move to y.md is held back (a local folder is in the way), so d's
      // edited file still stands at x.md when e is created there remotely.
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "d", path: "x.md", content: lines("d") });
      await h.engine.pull();
      await h.vault.write("y.md/child.md", bytes("blocks y.md"));
      await h.vault.write("x.md", bytes(lines("d", "local edit")));
      h.server.commit({ documentId: "d", path: "y.md" });
      h.server.commit({ documentId: "e", path: "x.md", content: lines("e") });

      await h.engine.pull();

      expect(text(await h.vault.read("x.md"))).toBe(lines("d", "local edit"));
      expect(await files(h.vault)).toEqual(new Map([["x.md", lines("d", "local edit")], ["y.md/child.md", "blocks y.md"]]));
      expect(await h.journal.listConflicts()).toEqual([]);
      expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId).sort()).toEqual(["d", "e"]);
    });

    it("never moves another document's file aside for a remote rename onto its path", async () => {
      // d's move away from c.md is held back (a local folder is in the way),
      // so d's file still stands at c.md when b is renamed there remotely.
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b") });
      h.server.commit({ documentId: "d", path: "c.md", content: lines("d") });
      await h.engine.pull();
      await h.vault.write("y.md/child.md", bytes("blocks y.md"));
      h.server.commit({ documentId: "d", path: "y.md" });
      h.server.commit({ documentId: "b", path: "c.md" });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(new Map([["a.md", lines("b")], ["c.md", lines("d")], ["y.md/child.md", "blocks y.md"]]));
      expect(await h.journal.listConflicts()).toEqual([]);
      expect(await h.journal.listDocuments()).toMatchObject([{ documentId: "b", path: "a.md" }, { documentId: "d", path: "c.md" }]);
    });

    it("moves a document's file that a local rename not yet pushed put at the remote rename's target aside as that document's", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b") });
      h.server.commit({ documentId: "d", path: "d.md", content: lines("d") });
      await h.engine.pull();
      await h.vault.rename("d.md", "c.md");
      await h.engine.settled();
      h.server.commit({ documentId: "b", path: "c.md" });

      await h.engine.pull();
      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("b")],
        [copyOf("c", ".md"), lines("d")],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["c.md", "b"],
          [copyOf("c", ".md"), "d"],
        ]),
      );
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "d", reason: "path-taken", path: "c.md", copyPath: copyOf("c", ".md") }]);
    });

    it("moves a document's file that a pending rename put at the remote rename's target aside as that document's", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b") });
      h.server.commit({ documentId: "d", path: "d.md", content: lines("d") });
      await h.engine.pull();
      await h.vault.rename("d.md", "c.md");
      // b's rename to c.md lands first, so d's rename is refused.
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "b", path: "c.md" }));

      await h.engine.push();
      await h.engine.push();

      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["c.md", "b"],
          [copyOf("c", ".md"), "d"],
        ]),
      );
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
    });

    it("does not hand the merge hook a file created where a renamed document was as that document's local version", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two") });
      await h.engine.pull();
      await h.vault.rename("a.md", "b2.md");
      // b's rename is recorded as pending, but its commit fails.
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("down", Code.Internal);
      };
      await expect(h.engine.push()).rejects.toThrow();
      h.server.interceptor = undefined;
      await h.vault.write("a.md", bytes(lines("a new note")));
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two (remote)") });

      await h.engine.pull();

      expect(text(await h.vault.read("b2.md"))).toBe(lines("one", "two (remote)"));
      expect(text(await h.vault.read("a.md"))).toBe(lines("a new note"));
      expect(await h.journal.listConflicts()).toEqual([]);
    });

    it("does not drop another document's pending operation at the path of a document it merges", async () => {
      // x's create at b2.md was uploaded but not committed; the user then
      // deleted x and renamed b onto b2.md. Merging b does not decide x's operation.
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two") });
      await h.engine.pull();
      await h.vault.write("b2.md", bytes(lines("x")));
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("down", Code.Internal);
      };
      await expect(h.engine.push()).rejects.toThrow();
      h.server.interceptor = undefined;
      const [created] = await h.journal.listPending();
      await h.vault.delete("b2.md");
      await h.vault.rename("a.md", "b2.md");
      await h.engine.settled();
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two (remote)") });

      await h.engine.pull();

      expect(text(await h.vault.read("b2.md"))).toBe(lines("one", "two (remote)"));
      expect(await h.journal.listPending()).toEqual([created]);
    });

    it("does not reuse a logged copy's name once the file there has changed", async () => {
      // Crashes right after the copy is written, before the merge result is.
      const points = new CrashPoints();
      const h = harness({ merge: "default", journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote)") });
      h.vault.watch((event) => {
        if (event.path === copyOf("a", ".md") && points.crashAfter === 0) points.crashAfter = points.count + 1;
      });
      points.count = 0;
      await expect(h.engine.pull()).rejects.toThrow(Crash);
      points.crashAfter = -1;
      await h.engine.settled();
      expect(text(await h.vault.read(copyOf("a", ".md")))).toBe(lines("one (local)"));
      expect(text(await h.vault.read("a.md"))).toBe(lines("one (local)"));
      // The user edits the copy before the engine runs again.
      await h.vault.write(copyOf("a", ".md"), bytes(lines("one (local)", "copy edited")));
      h.restart();

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(
        new Map([
          ["a.md", lines("one (remote)")],
          [copyOf("a", ".md"), lines("one (local)", "copy edited")],
          [`a (conflict laptop ${testStamp} 2).md`, lines("one (local)")],
        ]),
      );
    });

    it("does not give a new conflict copy a name the conflict log already gave another", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote)") });
      await h.engine.pull();
      // The user discards the first copy before it is pushed.
      await h.vault.delete(copyOf("a", ".md"));
      await h.vault.write("a.md", bytes(lines("one (local 2)")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote 2)") });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(
        new Map([
          ["a.md", lines("one (remote 2)")],
          [`a (conflict laptop ${testStamp} 2).md`, lines("one (local 2)")],
        ]),
      );
      expect((await h.journal.listConflicts()).map((conflict) => conflict.copyPath)).toEqual([copyOf("a", ".md"), `a (conflict laptop ${testStamp} 2).md`]);
    });
  });

  describe("given two devices create a file at the same path", () => {
    it("keeps the other device's file in place and the local one as a conflict copy, when the local commit is refused", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("new.md", bytes("mine"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "new.md", content: "theirs" }));

      const summary = await h.engine.push();

      const expected = new Map([["new.md", "theirs"], [copyOf("new", ".md"), "mine"]]);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await files(h.vault)).toEqual(expected);
      expect(summary).toMatchObject({ pending: 0, rejected: [] });
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "theirs", reason: "concurrent-create", path: "new.md", copyPath: copyOf("new", ".md") }]);
    });

    it("moves the local document to a conflict-copy path when another document holds the path in another case", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("new.md", bytes("mine"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "NEW.md", content: "theirs" }));

      const summary = await h.engine.push();
      const again = await h.engine.push();

      const expected = new Map([["NEW.md", "theirs"], [copyOf("new", ".md"), "mine"]]);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await files(h.vault)).toEqual(expected);
      expect(summary).toMatchObject({ pending: 0, rejected: [] });
      expect(again.committed).toBe(0);
      expect(await h.journal.listPending()).toEqual([]);
      const [conflict] = await h.journal.listConflicts();
      expect(conflict).toMatchObject({ reason: "path-taken", path: "new.md", copyPath: copyOf("new", ".md"), copyHash: sha256Hex(bytes("mine")) });
      // The local document kept its id at its new path.
      expect(h.server.head(conflict?.documentId ?? "")).toMatchObject({ parentRevId: "" });
      expect(new TextDecoder().decode(h.server.head(conflict?.documentId ?? "")?.path)).toBe(copyOf("new", ".md"));
    });

    it("keeps a refused create pending and reports it when no conflict-copy name fits", async () => {
      const folder = `${Array.from({ length: 16 }, () => "f".repeat(250)).join("/")}/${"g".repeat(60)}`;
      const h = harness({ merge: "default" });
      await h.vault.write(`${folder}/new.md`, bytes("mine"));
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: `${folder}/NEW.md`, content: "theirs" }));

      const summary = await h.engine.push();

      expect(summary.rejected.map((rejected) => rejected.operation.path)).toEqual([`${folder}/new.md`]);
      expect(text(await h.vault.read(`${folder}/new.md`))).toBe("mine");
      expect(await h.journal.listPending()).toHaveLength(1);
      expect(await h.journal.listConflicts()).toMatchObject([{ reason: "path-taken", copyPath: null }]);
    });
  });

  describe("given a document deleted on this device and brought back on both", () => {
    it("hands the merge hook no base content for the tombstone instead of failing", async () => {
      const h = harness();
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.delete("a.md");
      await h.engine.push();
      h.server.commit({ documentId: "a", path: "a.md", content: "remote back" });
      await h.vault.write("a.md", bytes("local back"));

      await h.engine.pull();

      expect(h.merges).toHaveLength(1);
      expect(h.merges[0]?.base?.deleted).toBe(true);
      await expect(h.merges[0]?.readBaseContent()).resolves.toBeNull();
    });

    it("keeps both versions", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "a.md", content: "a1" });
      await h.engine.pull();
      await h.vault.delete("a.md");
      await h.engine.push();
      h.server.commit({ documentId: "a", path: "a.md", content: "remote back" });
      await h.vault.write("a.md", bytes("local back"));

      await h.engine.push();

      const expected = new Map([["a.md", "remote back"], [copyOf("a", ".md"), "local back"]]);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await files(h.vault)).toEqual(expected);
    });
  });

  describe("given a merge the hook first deferred", () => {
    it("commits the merge on top of the remote head on a later push", async () => {
      // Defers until it is ready, as a hook waiting for the user would.
      let ready = false;
      const merge: MergeHook = async (request) => {
        if (!ready) return { status: "deferred" };
        const remote = text(await request.readRemoteContent()) ?? "";
        return { status: "merged", path: request.remote.path, content: bytes(`${remote}+${text(request.local.content) ?? ""}`) };
      };
      const h = harness({ merge });
      h.server.commit({ documentId: "a", path: "a.md", content: "base" });
      await h.engine.pull();
      await h.vault.write("a.md", bytes("local"));
      const remote = h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
      await h.engine.push();
      expect(await h.journal.listDeferred()).toHaveLength(1);
      ready = true;

      // Nothing new to pull: only the deferral brings the hook back.
      await h.engine.push();

      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "remote+local"]]));
      expect(h.server.head("a")?.parentRevId).toBe(remote.id);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
    });
  });

  describe("given a local rename onto the path a remote create takes", () => {
    // The file at the path is a known document's, moved there locally: it is
    // not the remote document's local version, and not a new file. It moves
    // on to a conflict-copy path under its own id, like a refused create (SPEC.md §6.3).
    it("moves the renamed document to a conflict-copy path under its own id when the remote create arrives first", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "x.md", content: lines("b") });
      await h.engine.pull();
      await h.vault.rename("x.md", "p.md");
      await h.engine.settled();
      h.server.commit({ documentId: "r", path: "p.md", content: lines("r") });

      await h.engine.push();

      const expected = new Map([
        ["p.md", lines("r")],
        [copyOf("p", ".md"), lines("b")],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["p.md", "r"],
          [copyOf("p", ".md"), "b"],
        ]),
      );
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "b", reason: "path-taken", path: "p.md", copyPath: copyOf("p", ".md") }]);
      expect(await h.journal.listPending()).toEqual([]);
      expect(await h.journal.listDeferred()).toEqual([]);
    });

    it("moves the renamed document to a conflict-copy path under its own id when its pushed rename was refused", async () => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "b", path: "x.md", content: lines("b") });
      await h.engine.pull();
      await h.vault.rename("x.md", "p.md");
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "r", path: "p.md", content: lines("r") }));

      await h.engine.push();
      await h.engine.push();

      const expected = new Map([
        ["p.md", lines("r")],
        [copyOf("p", ".md"), lines("b")],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["p.md", "r"],
          [copyOf("p", ".md"), "b"],
        ]),
      );
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await h.journal.listPending()).toEqual([]);
    });
  });

  describe("given a remote document arriving at the path of a document the merge path holds", () => {
    it("resolves the held document first, so neither waits", async () => {
      // The hook defers b's move once, as a hook waiting for the user would.
      let deferred = false;
      const merge: MergeHook = (request) => {
        if (request.remote.documentId === "b" && !deferred) {
          deferred = true;
          return Promise.resolve({ status: "deferred" });
        }
        return threeWayMerge(request);
      };
      const h = harness({ merge });
      h.server.commit({ documentId: "b", path: "p.md", content: lines("one", "two") });
      await h.engine.pull();
      await h.vault.write("p.md", bytes(lines("one (local)", "two")));
      h.server.commit({ documentId: "b", path: "q.md", content: lines("one", "two (remote)") });
      h.server.commit({ documentId: "r", path: "p.md", content: lines("r") });

      await h.engine.pull();

      expect(await files(h.vault)).toEqual(
        new Map([
          ["p.md", lines("r")],
          ["q.md", lines("one (local)", "two (remote)")],
        ]),
      );
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(await h.journal.listConflicts()).toEqual([]);
    });

    it("ends, keeping both local edits, when a remote swap meets two held documents", async () => {
      // Each document arrives at the other's path, so resolving either first
      // asks to resolve the other first.
      const h = harness({ server: new InMemoryServer({ maxPageSize: 10, maxDownloadBytes: 1000 }) });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("a") });
      h.server.commit({ documentId: "b", path: "b.md", content: lines("b") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("a (local)")));
      await h.vault.write("b.md", bytes(lines("b (local)")));
      h.server.commit({ documentId: "a", path: "t.md" });
      h.server.commit({ documentId: "b", path: "a.md" });
      h.server.commit({ documentId: "a", path: "b.md" });

      await h.engine.pull();
      await h.engine.push();

      // The hook defers both: nothing is moved or written, and both wait.
      expect(await files(h.vault)).toEqual(
        new Map([
          ["a.md", lines("a (local)")],
          ["b.md", lines("b (local)")],
        ]),
      );
      expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId).sort()).toEqual(["a", "b"]);
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["a.md", "b"],
          ["b.md", "a"],
        ]),
      );
    });
  });

  describe("given a move aside interrupted after its name was logged", () => {
    it("does not reuse the logged name for a file created there since", async () => {
      // d's rename to c.md is pending when b's rename to c.md arrives; the
      // engine logs d's conflict-copy name, then stops before moving the file.
      let crash = true;
      class StopAfterLogging extends InMemoryJournal {
        override async putConflict(conflict: ConflictRecord): Promise<void> {
          await super.putConflict(conflict);
          if (crash && conflict.reason === "path-taken") {
            crash = false;
            throw new Crash("stopped after logging the move aside");
          }
        }
      }
      const h = harness({ merge: "default", journal: new StopAfterLogging() });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("b") });
      h.server.commit({ documentId: "d", path: "d.md", content: lines("d") });
      await h.engine.pull();
      await h.vault.rename("d.md", "c.md");
      moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "b", path: "c.md" }));
      await expect(h.engine.push()).rejects.toThrow(Crash);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: "d", reason: "path-taken", copyPath: copyOf("c", ".md") }]);
      // The user creates a file at exactly that name before the engine restarts.
      await h.vault.write(copyOf("c", ".md"), bytes(lines("the user's own note")));

      h.restart();
      await h.engine.push();
      await h.engine.push();

      expect(text(await h.vault.read(copyOf("c", ".md")))).toBe(lines("the user's own note"));
      const live = h.server.liveDocuments();
      expect(live.get("c.md")).toBe("b");
      expect(live.get(copyOf("c", ".md"))).not.toBe("d");
      // d keeps its identity and content at another conflict-copy name.
      const dPath = [...live].find(([, documentId]) => documentId === "d")?.[0];
      expect(dPath).toBeDefined();
      expect(dPath).not.toBe(copyOf("c", ".md"));
      expect(h.server.liveFiles().get(dPath ?? "")).toBe(lines("d"));
      expect([...h.server.liveFiles().values()].sort()).toEqual([lines("b"), lines("d"), lines("the user's own note")]);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.journal.listPending()).toEqual([]);
    });
  });

  describe("given a merge interrupted after it was recorded", () => {
    it("does not take a file created at the merge's target before the document moved there for the document's local version", async () => {
      let crashed = false;
      class CrashAfterMergeRecord extends InMemoryJournal {
        override async putDeferred(deferred: DeferredRevision): Promise<void> {
          await super.putDeferred(deferred);
          if (deferred.merging !== undefined && !crashed) {
            crashed = true;
            throw new Crash("after the merge record");
          }
        }
      }
      const h = harness({ merge: "default", journal: new CrashAfterMergeRecord() });
      h.server.commit({ documentId: "b", path: "a.md", content: lines("one", "two") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)", "two")));
      h.server.commit({ documentId: "b", path: "c.md", content: lines("one", "two (remote)") });
      await expect(h.engine.pull()).rejects.toThrow(Crash);
      expect(await files(h.vault)).toEqual(new Map([["a.md", lines("one (local)", "two")]]));
      await h.vault.write("c.md", bytes(lines("unrelated new note")));
      h.restart();

      await h.engine.push();
      await h.engine.push();

      const expected = new Map([
        ["c.md", lines("one (local)", "two (remote)")],
        [copyOf("c", ".md"), lines("unrelated new note")],
      ]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(h.server.liveDocuments().get("c.md")).toBe("b");
      expect((await h.journal.listConflicts()).map((conflict) => [conflict.reason, conflict.copyPath])).toEqual([["concurrent-create", copyOf("c", ".md")]]);
    });

    it("finishes the recorded merge before merging a newer remote revision based on it", async () => {
      // The merge of r1 reached the disk; the crash came before the rebase,
      // and r2 (made on top of r1) arrived before the merge resumed.
      let deferredOnce = false;
      const merge: MergeHook = (request) => {
        if (!deferredOnce) {
          deferredOnce = true;
          return Promise.resolve({ status: "deferred" });
        }
        return threeWayMerge(request);
      };
      class CrashBeforeRebase extends InMemoryJournal {
        crashBefore: string | undefined;
        override async putDocument(state: DocumentState): Promise<void> {
          if (state.revisionId === this.crashBefore) {
            this.crashBefore = undefined;
            throw new Crash("before the rebase");
          }
          await super.putDocument(state);
        }
      }
      const journal = new CrashBeforeRebase();
      const h = harness({ merge, journal });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two", "three") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)", "two", "three")));
      const r1 = h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two (remote)", "three") });
      await h.engine.pull();
      expect(await h.journal.listDeferred()).toHaveLength(1);
      journal.crashBefore = r1.id;
      await expect(h.engine.push()).rejects.toThrow(Crash);
      expect(text(await h.vault.read("a.md"))).toBe(lines("one (local)", "two (remote)", "three"));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two (remote)", "three (remote 2)") });
      h.restart();

      await h.engine.push();

      const expected = new Map([["a.md", lines("one (local)", "two (remote)", "three (remote 2)")]]);
      expect(await files(h.vault)).toEqual(expected);
      expect(h.server.liveFiles()).toEqual(expected);
      expect(await h.journal.listConflicts()).toEqual([]);
    });
  });

  describe("given a crash at any point", () => {
    interface Scenario {
      name: string;
      /** Prepares the device (and the server); the push under test follows. */
      prepare(h: Harness): Promise<void>;
      /** The server; defaults to the harness's. */
      server?: () => InMemoryServer;
      /** At least this many crash points are exercised. */
      crashes: number;
    }
    const scenarios: Scenario[] = [
      {
        name: "an overlapping edit merged from a pull",
        crashes: 6,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two") });
          await h.engine.pull();
          await h.vault.write("a.md", bytes(lines("one (local)", "two")));
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote)", "two") });
        },
      },
      {
        name: "an overlapping edit merged after the head moved",
        crashes: 6,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two") });
          await h.engine.pull();
          await h.vault.write("a.md", bytes(lines("one (local)", "two")));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote)", "two") }));
        },
      },
      {
        name: "a non-overlapping edit merged after the head moved",
        crashes: 5,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two", "three") });
          await h.engine.pull();
          await h.vault.write("a.md", bytes(lines("one (local)", "two", "three")));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two", "three (remote)") }));
        },
      },
      {
        // Merging the result again would conflict (the local side's change now spans the remote one), so this needs the journaled merge.
        name: "edits of adjacent lines merged from a pull",
        crashes: 5,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two") });
          await h.engine.pull();
          await h.vault.write("a.md", bytes(lines("one (local)", "two")));
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two (remote)") });
        },
      },
      {
        name: "edits of adjacent lines merged after the head moved",
        crashes: 5,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two") });
          await h.engine.pull();
          await h.vault.write("a.md", bytes(lines("one (local)", "two")));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "two (remote)") }));
        },
      },
      {
        name: "a local rename merged with a remote edit after the head moved",
        crashes: 5,
        prepare: async (h) => {
          h.server.commit({ documentId: "a", path: "a.md", content: lines("one") });
          await h.engine.pull();
          await h.vault.rename("a.md", "renamed.md");
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "remote") }));
        },
      },
      {
        name: "a remote rename onto a path an unsynced local file holds",
        crashes: 6,
        prepare: async (h) => {
          h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
          await h.engine.pull();
          await h.vault.write("c.md", bytes(lines("my own new note")));
          h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });
        },
      },
      {
        name: "a remote rename onto a path a local create not yet committed holds",
        crashes: 6,
        prepare: async (h) => {
          h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
          await h.engine.pull();
          await h.vault.write("c.md", bytes(lines("my own new note")));
          h.server.interceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("down", Code.Internal);
          };
          await expect(h.engine.push()).rejects.toThrow();
          h.server.interceptor = undefined;
          h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });
        },
      },
      {
        name: "a remote rename onto a path an unsynced local file holds, of a document deleted locally",
        crashes: 6,
        prepare: async (h) => {
          h.server.commit({ documentId: "b", path: "a.md", content: lines("b line") });
          await h.engine.pull();
          await h.vault.delete("a.md");
          await h.vault.write("c.md", bytes(lines("my own new note")));
          h.server.commit({ documentId: "b", path: "c.md", content: lines("b line", "appended remotely") });
        },
      },
      {
        name: "a create refused because another document holds the path",
        crashes: 6,
        prepare: async (h) => {
          await h.vault.write("new.md", bytes("mine"));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "new.md", content: "theirs" }));
        },
      },
      {
        name: "a create refused because another document holds the path in another case",
        crashes: 5,
        prepare: async (h) => {
          await h.vault.write("new.md", bytes("mine"));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "NEW.md", content: "theirs" }));
        },
      },
      {
        name: "a local rename refused because a remote create took its path",
        crashes: 5,
        prepare: async (h) => {
          h.server.commit({ documentId: "b", path: "x.md", content: lines("b") });
          await h.engine.pull();
          await h.vault.rename("x.md", "p.md");
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "r", path: "p.md", content: lines("r") }));
        },
      },
      {
        name: "a rename chain on one device",
        crashes: 3,
        prepare: async (h) => {
          h.server.commit({ documentId: "x", path: "a.md", content: lines("x") });
          h.server.commit({ documentId: "y", path: "b.md", content: lines("y") });
          await h.engine.pull();
          await h.vault.rename("b.md", "c.md");
          await h.vault.rename("a.md", "b.md");
        },
      },
      {
        name: "a create refused because another document is a file where it needs a folder",
        crashes: 5,
        server: () => new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 }),
        prepare: async (h) => {
          await h.vault.write("notes/c.md", bytes("mine"));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "notes", content: "theirs" }));
        },
      },
      {
        name: "a create refused because another document needs its path as a folder",
        crashes: 5,
        server: () => new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 }),
        prepare: async (h) => {
          await h.vault.write("notes", bytes("mine"));
          moveHeadBeforeCommit(h, () => h.server.commit({ documentId: "theirs", path: "notes/c.md", content: "theirs" }));
        },
      },
    ];

    it.each(scenarios)("reaches the same state after $name", async (scenario) => {
      const setup = async (points: CrashPoints | undefined) => {
        const h =
          points === undefined
            ? harness({ merge: "default", server: scenario.server?.() })
            : harness({ merge: "default", server: scenario.server?.(), journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        await scenario.prepare(h);
        // The prepared changes' binding transitions are durable changes of their own, before the push's.
        await h.engine.settled();
        return h;
      };
      const state = async (h: Harness) => ({
        server: h.server.liveFiles(),
        files: await files(h.vault),
        pending: await h.journal.listPending(),
        deferred: await h.journal.listDeferred(),
        conflicts: (await h.journal.listConflicts()).map((conflict) => [conflict.reason, conflict.path, conflict.copyPath, conflict.copyHash]),
      });
      const reference = await setup(undefined);
      await reference.engine.push();
      const expected = await state(reference);
      expect(expected.server.size).toBeGreaterThan(0);

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = await setup(points);
        points.count = 0;
        points.crashAfter = crashAfter;
        const outcome = await h.engine.push().then(
          () => "finished",
          (error: unknown) => {
            if (!(error instanceof Crash)) throw error;
            return "crashed";
          },
        );
        if (outcome === "finished") break;
        crashed++;
        points.crashAfter = 0;
        await h.engine.settled();
        h.restart();
        await h.engine.push();
        await h.engine.push();

        expect(await state(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      expect(crashed).toBeGreaterThanOrEqual(scenario.crashes);
    });

    it("reaches the same state after a merge the hook first deferred", async () => {
      // Defers until it is ready; then merges idempotently.
      let ready = false;
      const merge: MergeHook = async (request) => {
        if (!ready) return { status: "deferred" };
        const remote = text(await request.readRemoteContent()) ?? "";
        const local = text(request.local.content) ?? "";
        return { status: "merged", path: request.remote.path, content: bytes(local.startsWith(`${remote}+`) ? local : `${remote}+${local}`) };
      };
      const setup = async (points: CrashPoints | undefined) => {
        ready = false;
        const h = points === undefined ? harness({ merge }) : harness({ merge, journal: new CrashingJournal(points), wrapVault: (vault) => new CrashingVault(vault, points) });
        h.server.commit({ documentId: "a", path: "a.md", content: "base" });
        await h.engine.pull();
        await h.vault.write("a.md", bytes("local"));
        h.server.commit({ documentId: "a", path: "a.md", content: "remote" });
        await h.engine.push();
        ready = true;
        return h;
      };
      const state = async (h: Harness) => ({ server: h.server.liveFiles(), files: await files(h.vault), pending: await h.journal.listPending(), deferred: await h.journal.listDeferred() });
      const reference = await setup(undefined);
      await reference.engine.push();
      const expected = await state(reference);
      expect(expected).toMatchObject({ server: new Map([["a.md", "remote+local"]]), pending: [], deferred: [] });

      let crashed = 0;
      for (let crashAfter = 1; ; crashAfter++) {
        const points = new CrashPoints();
        const h = await setup(points);
        points.count = 0;
        points.crashAfter = crashAfter;
        const outcome = await h.engine.push().then(
          () => "finished",
          (error: unknown) => {
            if (!(error instanceof Crash)) throw error;
            return "crashed";
          },
        );
        if (outcome === "finished") break;
        crashed++;
        points.crashAfter = 0;
        await h.engine.settled();
        h.restart();
        await h.engine.push();
        await h.engine.push();

        expect(await state(h), `crash after durable change ${String(crashAfter)}`).toEqual(expected);
      }
      expect(crashed).toBeGreaterThanOrEqual(4);
    });
  });
});

