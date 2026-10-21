import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import type { VaultEvent } from "../vault/adapter";
import { copyOf, files, harness, syncedOnBoth, twoDevices, type Harness } from "./testing";

// Structural operations across devices (SPEC.md §6.3): renames, deletes,
// creates at one path, folder renames and rename chains. Each case runs two
// (or three) real engines over one in-memory server and checks that every
// device and the server end with the same files, each document once, and
// nothing lost.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/** Records the server calls made while `run` runs, by method name. */
async function callsDuring(h: Harness, run: () => Promise<unknown>): Promise<string[]> {
  const calls: string[] = [];
  const previous = h.server.interceptor;
  h.server.interceptor = (method, request) => {
    previous?.(method, request);
    calls.push(method);
  };
  try {
    await run();
  } finally {
    h.server.interceptor = previous;
  }
  return calls;
}

/** The vault events of `h`'s vault while `run` runs. */
async function eventsDuring(h: Harness, run: () => Promise<unknown>): Promise<VaultEvent[]> {
  const events: VaultEvent[] = [];
  const stop = h.vault.watch((event) => events.push(event));
  try {
    await run();
  } finally {
    stop();
  }
  return events;
}

/** Both devices pull until neither has anything left to push: what every device shows once sync settles. */
async function settle(...devices: Harness[]): Promise<void> {
  for (let round = 0; round < 3; round++) for (const device of devices) await device.engine.push();
}

describe("SyncEngine structural operations (SPEC.md §6.3)", () => {
  describe("given a rename on one device and an edit on another", () => {
    it.each([
      { first: "the renaming device" as const },
      { first: "the editing device" as const },
    ])("has the new name and the edited content everywhere when $first pushes first", async ({ first }) => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one", "two"));
      const [document] = await devices.a.journal.listDocuments();
      await devices.a.vault.rename("a.md", "renamed.md");
      await devices.b.vault.write("a.md", bytes(lines("one", "two (edited)")));

      const order = first === "the renaming device" ? [devices.a, devices.b] : [devices.b, devices.a];
      await settle(...order);

      const expected = new Map([["renamed.md", lines("one", "two (edited)")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      // Still the same document: path and content merged as independent fields.
      expect(devices.server.liveDocuments()).toEqual(new Map([["renamed.md", document?.documentId]]));
      expect(await devices.a.journal.listConflicts()).toEqual([]);
      expect(await devices.b.journal.listConflicts()).toEqual([]);
    });
  });

  describe("given a delete on one device and an edit on another", () => {
    it.each([
      { first: "the deleting device" as const },
      { first: "the editing device" as const },
    ])("keeps the edited document everywhere when $first pushes first", async ({ first }) => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one", "two"));
      const [document] = await devices.a.journal.listDocuments();
      await devices.a.vault.delete("a.md");
      await devices.b.vault.write("a.md", bytes(lines("one", "two (edited)")));

      const order = first === "the deleting device" ? [devices.a, devices.b] : [devices.b, devices.a];
      await settle(...order);

      const expected = new Map([["a.md", lines("one", "two (edited)")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      // The edit kept the document (brought back on top of its tombstone if the delete landed first).
      expect(devices.server.liveDocuments()).toEqual(new Map([["a.md", document?.documentId]]));
    });

    it("keeps a renamed document everywhere when another device deleted it", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "a.md", lines("one"));
      await devices.a.vault.delete("a.md");
      await devices.b.vault.rename("a.md", "kept.md");

      await settle(devices.a, devices.b);

      const expected = new Map([["kept.md", lines("one")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
    });
  });

  describe("given two devices create the same path offline", () => {
    it.each([
      { name: "the same path", theirs: "new.md" },
      { name: "paths that differ only by case", theirs: "NEW.md" },
    ])("keeps both files, one as a conflict copy, for $name", async ({ theirs }) => {
      const devices = twoDevices();
      await devices.a.vault.write(theirs, bytes("from a\n"));
      await devices.b.vault.write("new.md", bytes("from b\n"));

      await settle(devices.a, devices.b);

      const expected = new Map([
        [theirs, "from a\n"],
        [copyOf("new", ".md", "device-b"), "from b\n"],
      ]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      expect(await devices.b.journal.listPending()).toEqual([]);
      expect(await devices.b.journal.listDeferred()).toEqual([]);
    });

    it("keeps both when one device created a file where the other created a folder", async () => {
      const strict = twoDevicesWithFolderRule();
      await strict.a.vault.write("notes/c.md", bytes("from a\n"));
      await strict.b.vault.write("notes", bytes("from b\n"));

      await settle(strict.a, strict.b);

      const expected = new Map([
        ["notes/c.md", "from a\n"],
        [copyOf("notes", "", "device-b"), "from b\n"],
      ]);
      expect(strict.server.liveFiles()).toEqual(expected);
      expect(await files(strict.a.vault)).toEqual(expected);
      expect(await files(strict.b.vault)).toEqual(expected);
      expect(await strict.b.journal.listDeferred()).toEqual([]);
    });

    it("keeps both when one device created a folder where the other created a file", async () => {
      const strict = twoDevicesWithFolderRule();
      await strict.a.vault.write("notes", bytes("from a\n"));
      await strict.b.vault.write("notes/c.md", bytes("from b\n"));
      await strict.b.vault.write("notes/d.md", bytes("also from b\n"));

      await settle(strict.a, strict.b);

      const folder = copyOf("notes", "", "device-b");
      const expected = new Map([
        ["notes", "from a\n"],
        [`${folder}/c.md`, "from b\n"],
        [`${folder}/d.md`, "also from b\n"],
      ]);
      expect(strict.server.liveFiles()).toEqual(expected);
      expect(await files(strict.a.vault)).toEqual(expected);
      expect(await files(strict.b.vault)).toEqual(expected);
      expect(await strict.b.journal.listDeferred()).toEqual([]);
    });
  });

  describe("given a server that keeps refusing a create's path", () => {
    it("moves the document to a conflict-copy path once, then reports it as rejected instead of trying name after name", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("new.md", bytes("mine"));
      let commits = 0;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision") return;
        commits++;
        throw new ConnectError("another live document has this path", Code.AlreadyExists);
      };

      const summary = await h.engine.push();

      expect(commits).toBe(2);
      expect(await files(h.vault)).toEqual(new Map([[copyOf("new", ".md"), "mine"]]));
      expect(summary.rejected.map((rejected) => rejected.operation.path)).toEqual([copyOf("new", ".md")]);
      expect(await h.journal.listPending()).toMatchObject([{ path: copyOf("new", ".md") }]);
    });
  });

  describe("given a folder rename with many files", () => {
    const names = Array.from({ length: 12 }, (_, index) => `note ${String(index)}.md`);

    it("syncs as renames: no content is uploaded or downloaded again", async () => {
      const devices = twoDevices();
      for (const name of names) await devices.a.vault.write(`old/${name}`, bytes(lines(name)));
      await devices.a.vault.write("old/sub/deep.md", bytes(lines("deep")));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      const before = new Map((await devices.a.journal.listDocuments()).map((document) => [document.documentId, document.revisionId]));

      // Obsidian reports a folder rename as a rename of every file in it.
      for (const name of [...names, "sub/deep.md"]) await devices.a.vault.rename(`old/${name}`, `new/${name}`);
      const pushed = await callsDuring(devices.a, () => devices.a.engine.push());
      let events: VaultEvent[] = [];
      const pulled = await callsDuring(devices.b, async () => {
        events = await eventsDuring(devices.b, () => devices.b.engine.pull());
      });

      expect(pushed.filter((method) => method === "BeginBlob" || method === "PutBlobChunk" || method === "CommitBlob")).toEqual([]);
      expect(pulled.filter((method) => method === "DownloadBlob" || method === "GetRevision")).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(Array.from({ length: names.length + 1 }, () => "rename"));
      const expected = new Map([...names.map((name) => [`new/${name}`, lines(name)] as const), ["new/sub/deep.md", lines("deep")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      // One rename revision per document, on top of its previous head, with the same content.
      for (const [documentId, revisionId] of before) {
        const history = devices.server.history(documentId);
        expect(history).toHaveLength(2);
        expect(history[1]?.parentRevId).toBe(revisionId);
        expect(history[1]?.contentRef).toEqual(history[0]?.contentRef);
      }
    });

    it("keeps an edit another device made in the folder meanwhile, in the renamed folder", async () => {
      const devices = twoDevices();
      for (const name of names.slice(0, 3)) await devices.a.vault.write(`old/${name}`, bytes(lines(name)));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      for (const name of names.slice(0, 3)) await devices.a.vault.rename(`old/${name}`, `new/${name}`);
      await devices.b.vault.write("old/note 1.md", bytes(lines("note 1.md", "edited on b")));

      await settle(devices.a, devices.b);

      const expected = new Map([
        ["new/note 0.md", lines("note 0.md")],
        ["new/note 1.md", lines("note 1.md", "edited on b")],
        ["new/note 2.md", lines("note 2.md")],
      ]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
    });
  });

  describe("given a rename chain", () => {
    it("ends with one document at the end of a chain made across devices, with an offline device's edit", async () => {
      const devices = twoDevices();
      const offline = harness({ merge: "default", server: devices.server, idPrefix: "c", deviceName: "device-c" });
      await syncedOnBoth(devices, "A.md", lines("one", "two"));
      await offline.engine.pull();
      const [document] = await devices.a.journal.listDocuments();
      await offline.vault.write("A.md", bytes(lines("one", "two (offline)")));

      await devices.a.vault.rename("A.md", "B.md");
      await devices.a.engine.push();
      await devices.b.engine.pull();
      await devices.b.vault.rename("B.md", "C.md");
      await devices.b.engine.push();
      await settle(offline, devices.a, devices.b);

      const expected = new Map([["C.md", lines("one", "two (offline)")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(devices.server.liveDocuments()).toEqual(new Map([["C.md", document?.documentId]]));
      for (const device of [devices.a, devices.b, offline]) expect(await files(device.vault)).toEqual(expected);
    });

    it("keeps each document's identity when one device moves b.md to c.md and then a.md to b.md", async () => {
      const devices = twoDevices();
      await devices.a.vault.write("a.md", bytes(lines("note x")));
      await devices.a.vault.write("b.md", bytes(lines("note y")));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      const ids = new Map((await devices.a.journal.listDocuments()).map((document) => [document.path, document.documentId]));
      await devices.a.vault.rename("b.md", "c.md");
      await devices.a.vault.rename("a.md", "b.md");
      // The other device edits both documents meanwhile.
      await devices.b.vault.write("a.md", bytes(lines("note x", "edited on b")));
      await devices.b.vault.write("b.md", bytes(lines("note y", "edited on b")));

      await settle(devices.a, devices.b);

      const expected = new Map([
        ["b.md", lines("note x", "edited on b")],
        ["c.md", lines("note y", "edited on b")],
      ]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
      expect(devices.server.liveDocuments()).toEqual(
        new Map([
          ["b.md", ids.get("a.md")],
          ["c.md", ids.get("b.md")],
        ]),
      );
      expect(await devices.a.journal.listConflicts()).toEqual([]);
      expect(await devices.b.journal.listConflicts()).toEqual([]);
    });

    it("keeps each document's identity when a document that moved out of the way moves on again", async () => {
      // b.md to c.md, a.md to b.md, then c.md to d.md: the last rename is
      // recorded after a.md's, though a.md's needs b.md to be free first.
      const devices = twoDevices();
      await devices.a.vault.write("a.md", bytes(lines("note x")));
      await devices.a.vault.write("b.md", bytes(lines("note y")));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      const ids = new Map((await devices.a.journal.listDocuments()).map((document) => [document.path, document.documentId]));
      await devices.a.vault.rename("b.md", "c.md");
      await devices.a.vault.rename("a.md", "b.md");
      await devices.a.vault.rename("c.md", "d.md");

      await settle(devices.a, devices.b);

      expect(devices.server.liveDocuments()).toEqual(
        new Map([
          ["b.md", ids.get("a.md")],
          ["d.md", ids.get("b.md")],
        ]),
      );
      expect(await files(devices.b.vault)).toEqual(
        new Map([
          ["b.md", lines("note x")],
          ["d.md", lines("note y")],
        ]),
      );
      expect(await devices.a.journal.listConflicts()).toEqual([]);
    });

    it("loses and duplicates nothing when one device swaps two names", async () => {
      const devices = twoDevices();
      await devices.a.vault.write("a.md", bytes(lines("note x")));
      await devices.a.vault.write("b.md", bytes(lines("note y")));
      await devices.a.engine.push();
      await devices.b.engine.pull();
      await devices.a.vault.rename("a.md", "t.md");
      await devices.a.vault.rename("b.md", "a.md");
      await devices.a.vault.rename("t.md", "b.md");

      await settle(devices.a, devices.b);

      // The server cannot swap two paths in one commit: one document moves
      // first and the other, refused, keeps its content at a conflict-copy path.
      expect([...devices.server.liveFiles().values()].sort()).toEqual([lines("note x"), lines("note y")]);
      expect(devices.server.liveDocuments().size).toBe(2);
      expect(await files(devices.a.vault)).toEqual(devices.server.liveFiles());
      expect(await files(devices.b.vault)).toEqual(devices.server.liveFiles());
    });

    it("keeps a rename of a document the merge path holds for later, instead of creating a new document", async () => {
      let ready = false;
      const h = harness({
        merge: async (request) => {
          if (!ready) return { status: "deferred" };
          return { status: "merged", content: (await request.readRemoteContent()) ?? new Uint8Array() };
        },
      });
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)")));
      h.server.commit({ documentId: "a", path: "a.md", content: lines("one (remote)") });
      await h.engine.push();
      await h.vault.rename("a.md", "b.md");

      await h.engine.push();

      expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "a"]]));
      ready = true;
      await h.engine.push();
      expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "a"]]));
      expect(await files(h.vault)).toEqual(new Map([["b.md", lines("one (remote)")]]));
    });

    it("pushes an untracked file renamed off a path the merge path holds", async () => {
      let ready = false;
      const h = harness({
        merge: async (request) => {
          if (!ready) return { status: "deferred" };
          return { status: "merged", content: (await request.readRemoteContent()) ?? new Uint8Array() };
        },
      });
      h.server.commit({ documentId: "d", path: "a.md", content: lines("one") });
      await h.engine.pull();
      await h.vault.write("a.md", bytes(lines("one (local)")));
      await h.vault.write("p.md", bytes(lines("untracked")));
      // The server moves d onto p.md; the hook defers, so p.md is the merge path's.
      h.server.commit({ documentId: "d", path: "p.md", content: lines("one") });
      await h.engine.push();
      await h.vault.rename("p.md", "z.md");

      await h.engine.push();

      // z.md belongs to no document, so nothing makes it wait.
      expect(h.server.liveFiles().get("z.md")).toBe(lines("untracked"));
      ready = true;
      await h.engine.push();
      await h.engine.push();
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["p.md", lines("one")],
          ["z.md", lines("untracked")],
        ]),
      );
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });

    describe("given the document's operation is still pending", () => {
      /**
       * d synced at a.md, edited, and renamed to b.md while the edit's commit
       * stays pending (the server refused it as invalid), so the rename waits.
       */
      async function renameWaitingForPendingEdit(h: Harness): Promise<void> {
        h.server.commit({ documentId: "d", path: "a.md", content: lines("one") });
        await h.engine.pull();
        await h.vault.write("a.md", bytes(lines("two")));
        h.server.interceptor = (method) => {
          if (method === "CommitRevision") throw new ConnectError("refused", Code.InvalidArgument);
        };
        await h.engine.push();
        await h.vault.rename("a.md", "b.md");
        await h.engine.push();
        expect(h.server.liveFiles()).toEqual(new Map([["a.md", lines("one")]]));
        h.server.interceptor = undefined;
      }

      it("pushes the waiting rename, and the file created at its old path meanwhile as a new document (#254)", async () => {
        const h = harness({ merge: "default" });
        await renameWaitingForPendingEdit(h);
        await h.vault.write("a.md", bytes(lines("new note")));

        await h.engine.push();
        await h.engine.push();

        // a.md holds a new file, which the user created after moving d away:
        // d moves to b.md under its own id, and a.md is a new document.
        expect(h.server.liveFiles()).toEqual(
          new Map([
            ["a.md", lines("new note")],
            ["b.md", lines("two")],
          ]),
        );
        expect(h.server.liveDocuments().get("b.md")).toBe("d");
        expect(h.server.liveDocuments().get("a.md")).not.toBe("d");
      });

      it("pushes the waiting rename once a pull acknowledges the pending edit, without another local change", async () => {
        vi.useFakeTimers();
        try {
          const h = harness({ merge: "default", pushDebounceMs: 1000 });
          await renameWaitingForPendingEdit(h);
          // The edit's commit lands, but its response is lost: still pending.
          h.server.responseInterceptor = (method) => {
            if (method === "CommitRevision") throw new ConnectError("lost", Code.InvalidArgument);
          };
          await h.engine.push();
          h.server.responseInterceptor = undefined;
          expect(await h.journal.listPending()).toHaveLength(1);
          expect(h.server.liveFiles()).toEqual(new Map([["a.md", lines("two")]]));

          // A pull alone (as a realtime notification would start) acknowledges it.
          await h.engine.pull();
          await vi.advanceTimersByTimeAsync(1000);
          await h.engine.settled();

          expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "d"]]));
          expect(h.server.liveFiles()).toEqual(new Map([["b.md", lines("two")]]));
          expect(await h.journal.listPending()).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("ends with one document when two devices rename it to different names", async () => {
      const devices = twoDevices();
      await syncedOnBoth(devices, "A.md", lines("one"));
      await devices.a.vault.rename("A.md", "B.md");
      await devices.b.vault.rename("A.md", "C.md");

      await settle(devices.a, devices.b);

      // The later push's local rename wins (SPEC.md §7).
      const expected = new Map([["C.md", lines("one")]]);
      expect(devices.server.liveFiles()).toEqual(expected);
      expect(await files(devices.a.vault)).toEqual(expected);
      expect(await files(devices.b.vault)).toEqual(expected);
    });
  });

  describe("given renames the engine has seen but not pushed yet (#280)", () => {
    it("pushes a rename of a synced file whose path an untracked file was renamed to and deleted from before", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("n.md", bytes(lines("untracked")));
      await h.vault.rename("n.md", "p.md");
      await h.vault.delete("p.md");
      // Another device's note arrives at the freed path, and the user renames it.
      h.server.commit({ documentId: "theirs", path: "p.md", content: lines("theirs") });
      await h.engine.pull();
      await h.vault.rename("p.md", "q.md");

      await h.engine.push();
      await h.engine.push();

      expect(h.server.liveDocuments()).toEqual(new Map([["q.md", "theirs"]]));
      expect(h.server.liveFiles()).toEqual(new Map([["q.md", lines("theirs")]]));
      expect(h.server.history("theirs").every((revision) => !revision.deleted)).toBe(true);
      expect(await files(h.vault)).toEqual(new Map([["q.md", lines("theirs")]]));
    });

    it("moves a file renamed in this push aside under its own id when a merge in the same push needs its new path", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("a.md", bytes(lines("a")));
      await h.vault.write("c.md", bytes(lines("c")));
      await h.engine.push();
      const ids = h.server.liveDocuments();
      const [renamed, other] = [ids.get("a.md") ?? "", ids.get("c.md") ?? ""];
      await h.vault.delete("c.md");
      await h.vault.rename("a.md", "b.md");
      // Between this push's pull and its first commit (the delete), another
      // device renames the deleted note to b.md and edits it: the edit wins
      // over the delete, and the note needs b.md, where the push's own
      // rename put the other note.
      let moved = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || moved) return;
        moved = true;
        h.server.commit({ documentId: other, path: "b.md", content: lines("c", "edited") });
      };

      for (let push = 0; push < 4; push++) await h.engine.push();

      const copy = copyOf("b", ".md");
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["b.md", other],
          [copy, renamed],
        ]),
      );
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["b.md", lines("c", "edited")],
          [copy, lines("a")],
        ]),
      );
      expect(h.server.history(renamed).every((revision) => !revision.deleted)).toBe(true);
      expect(await h.journal.listConflicts()).toMatchObject([{ documentId: renamed, reason: "path-taken", path: "b.md", copyPath: copy }]);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });

    it("never commits the rename this push found once a merge in the same push moved the file aside, even when the path is free again", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("a.md", bytes(lines("a")));
      await h.vault.write("c.md", bytes(lines("c")));
      await h.engine.push();
      const ids = h.server.liveDocuments();
      const [renamed, other] = [ids.get("a.md") ?? "", ids.get("c.md") ?? ""];
      await h.vault.delete("c.md");
      await h.vault.rename("a.md", "b.md");
      // As above, and before the push's next commit the other device moves
      // the note on from b.md, so the server would take a rename to b.md.
      let commits = 0;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision") return;
        commits++;
        if (commits === 1) h.server.commit({ documentId: other, path: "b.md", content: lines("c", "edited") });
        if (commits === 2) h.server.commit({ documentId: other, path: "d.md" });
      };

      for (let push = 0; push < 4; push++) await h.engine.push();

      const copy = copyOf("b", ".md");
      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["d.md", other],
          [copy, renamed],
        ]),
      );
      expect(h.server.history(renamed).every((revision) => !revision.deleted)).toBe(true);
      expect(h.server.history(renamed).map((revision) => new TextDecoder().decode(revision.path))).not.toContain("b.md");
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });

    it("pushes a rename of a new file the user renames while its create is being committed", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("s.md", bytes(lines("new")));
      let renamed = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || renamed) return;
        renamed = true;
        void h.vault.rename("s.md", "a.md");
      };

      for (let push = 0; push < 3; push++) await h.engine.push();

      // One document, created and renamed: never deleted and created again.
      const documents = new Set(h.acknowledged.map((revision) => revision.documentId));
      expect(documents.size).toBe(1);
      expect(h.acknowledged.filter((revision) => revision.deleted)).toEqual([]);
      expect(h.server.liveDocuments()).toEqual(new Map([["a.md", [...documents][0]]]));
      expect(await files(h.vault)).toEqual(new Map([["a.md", lines("new")]]));
    });

    it.each([
      { outcome: "lands", lost: false },
      { outcome: "is lost, so a later push retries it", lost: true },
    ])("pushes a rename on of a file whose rename this push commits, when the commit $outcome", async ({ lost }) => {
      const h = harness({ merge: "default" });
      await h.vault.write("x.md", bytes(lines("x")));
      await h.vault.write("e.md", bytes(lines("e")));
      await h.engine.push();
      const moved = h.server.liveDocuments().get("x.md") ?? "";
      await h.vault.rename("x.md", "c.md");
      await h.vault.write("e.md", bytes(lines("e", "edited in the same push")));
      // The user renames the file on while this push commits its rename.
      let renamed = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || renamed) return;
        renamed = true;
        void h.vault.rename("c.md", "b.md");
        if (lost) throw new ConnectError("unavailable", Code.Unavailable);
      };

      for (let push = 0; push < 4; push++) await h.engine.push().catch(() => undefined);

      expect(h.server.liveDocuments().get("b.md")).toBe(moved);
      expect(h.server.liveFiles()).toEqual(
        new Map([
          ["b.md", lines("x")],
          ["e.md", lines("e", "edited in the same push")],
        ]),
      );
      expect(h.server.history(moved).every((revision) => !revision.deleted)).toBe(true);
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
    });

    it("pushes a rename of a new file the user renames while a later push retries its create, without taking it for a delete", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("s.md", bytes(lines("new")));
      // The create's commit is lost, so it stays pending, and the next push
      // (still a full scan of the vault) retries it while the user renames
      // the file.
      let failing = true;
      let renamed = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision") return;
        if (failing) throw new ConnectError("unavailable", Code.Unavailable);
        if (renamed) return;
        renamed = true;
        void h.vault.rename("s.md", "a.md");
      };
      await expect(h.engine.push()).rejects.toThrow();
      failing = false;

      for (let push = 0; push < 3; push++) await h.engine.push();

      // One document, created and renamed: never deleted and created again.
      const documents = new Set(h.acknowledged.map((revision) => revision.documentId));
      expect(documents.size).toBe(1);
      expect(h.acknowledged.filter((revision) => revision.deleted)).toEqual([]);
      expect(h.server.liveDocuments()).toEqual(new Map([["a.md", [...documents][0]]]));
      expect(await files(h.vault)).toEqual(new Map([["a.md", lines("new")]]));
    });

    it("pushes a rename of a new file renamed before and after a push that failed", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("u.md", bytes(lines("new")));
      await h.vault.rename("u.md", "c.md");
      // The push records the create at c.md and loses its commit.
      h.server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("unavailable", Code.Unavailable);
      };
      await expect(h.engine.push()).rejects.toThrow();
      h.server.interceptor = undefined;
      await h.vault.rename("c.md", "b.md");

      for (let push = 0; push < 3; push++) await h.engine.push();

      // One document, created and renamed: never deleted and created again.
      const documents = new Set(h.acknowledged.map((revision) => revision.documentId));
      expect(documents.size).toBe(1);
      expect(h.acknowledged.filter((revision) => revision.deleted)).toEqual([]);
      expect(h.server.liveDocuments()).toEqual(new Map([["b.md", [...documents][0]]]));
      expect(await files(h.vault)).toEqual(new Map([["b.md", lines("new")]]));
    });

    it("pushes a rename of a file the user moved on while its earlier rename was refused for a path another document took", async () => {
      const h = harness({ merge: "default" });
      await h.vault.write("x.md", bytes(lines("x")));
      await h.engine.push();
      const moved = h.server.liveDocuments().get("x.md") ?? "";
      await h.vault.rename("x.md", "c.md");
      // While the rename's commit is on its way, another device creates c.md,
      // so the server refuses the rename, and the user renames the file on.
      let refused = false;
      h.server.interceptor = (method) => {
        if (method !== "CommitRevision" || refused) return;
        refused = true;
        h.server.commit({ documentId: "theirs", path: "c.md", content: lines("theirs") });
        void h.vault.rename("c.md", "b.md");
      };

      for (let push = 0; push < 4; push++) await h.engine.push();

      expect(h.server.liveDocuments()).toEqual(
        new Map([
          ["b.md", moved],
          ["c.md", "theirs"],
        ]),
      );
      expect(h.server.history(moved).every((revision) => !revision.deleted)).toBe(true);
      expect(await files(h.vault)).toEqual(
        new Map([
          ["b.md", lines("x")],
          ["c.md", lines("theirs")],
        ]),
      );
    });
  });
});

/** Two devices over a server that also refuses file/folder path collisions (#134). */
function twoDevicesWithFolderRule() {
  return twoDevices();
}
