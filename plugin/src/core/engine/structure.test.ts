import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

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
          return { status: "merged", path: request.local.path, content: (await request.readRemoteContent()) ?? new Uint8Array() };
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
});

/** Two devices over a server that also refuses file/folder path collisions (#134). */
function twoDevicesWithFolderRule() {
  return twoDevices();
}
