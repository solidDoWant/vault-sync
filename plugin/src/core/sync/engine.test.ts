import { describe, expect, it } from "vitest";

import { DocumentKind } from "../../gen/vaultsync/v1/types_pb";

import { InMemoryServer } from "./memory-server";
import { Device, settle } from "./testing";

const encoder = new TextEncoder();

function setup(): { server: InMemoryServer; a: Device; b: Device } {
  const server = new InMemoryServer();
  return { server, a: new Device(server, "device-a"), b: new Device(server, "device-b") };
}

/** Every revision of a file on the server (folder documents' are left out), as [document id, path, deleted]. */
function revisions(server: InMemoryServer): [string, string, boolean][] {
  const all: [string, string, boolean][] = [];
  for (let seq = 1n; ; seq++) {
    let revision;
    try {
      revision = server.revisionAt(seq);
    } catch {
      return all;
    }
    if (revision.kind === DocumentKind.FOLDER) continue;
    all.push([revision.documentId, new TextDecoder().decode(revision.path), revision.deleted]);
  }
}

describe("pull rows", () => {
  it("A1: an absent document's live revision is written at its path", async () => {
    const { server, b } = setup();
    server.commit({ documentId: "doc-1", path: "notes/a.md", content: "hello" });
    await b.sync();
    expect(await b.files()).toEqual({ "notes/a.md": "hello" });
    const state = await b.journal.load();
    expect(state.docs.get("doc-1")).toMatchObject({ path: "notes/a.md", baseRevId: server.head("doc-1")?.id });
    expect(state.pending).toEqual([]);
  });

  it("A2: an absent document's tombstone changes nothing", async () => {
    const { server, b } = setup();
    const created = server.commit({ documentId: "doc-1", path: "a.md", content: "hello" });
    server.commit({ documentId: "doc-1", path: "a.md", deleted: true });
    // Retention purged the create, so the device meets the tombstone with no document.
    server.purge(created.id);
    await b.sync();
    expect(await b.files()).toEqual({});
    const state = await b.journal.load();
    expect(state.docs.size).toBe(0);
    expect(state.cursor.seq).toBe(2n);
  });

  it("A3: a clean document is overwritten with a live revision at the same path", async () => {
    const { server, b } = setup();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    await b.sync();
    const edit = server.commit({ documentId: "doc-1", path: "a.md", content: "two" });
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "two" });
    expect((await b.journal.load()).docs.get("doc-1")?.baseRevId).toBe(edit.id);
  });

  it("A4: a clean document is moved to a live revision's new path, and gets its content", async () => {
    const { server, b } = setup();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    server.commit({ documentId: "doc-2", path: "b.md", content: "keep" });
    await b.sync();
    server.commit({ documentId: "doc-1", path: "moved/a.md", content: "two" });
    server.commit({ documentId: "doc-2", path: "c.md" });
    await b.sync();
    expect(await b.files()).toEqual({ "moved/a.md": "two", "c.md": "keep" });
    expect((await b.journal.load()).docs.get("doc-1")?.path).toBe("moved/a.md");
    expect(revisions(server)).toHaveLength(4);
  });

  it("A5: a clean document's tombstone deletes the file and drops the document", async () => {
    const { server, b } = setup();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    await b.sync();
    server.commit({ documentId: "doc-1", path: "a.md", deleted: true });
    await b.sync();
    expect(await b.files()).toEqual({});
    expect((await b.journal.load()).docs.has("doc-1")).toBe(false);
    expect(revisions(server)).toHaveLength(2);
  });

  it("a clean document edited after detection is not overwritten", async () => {
    const { server, b } = setup();
    server.commit({ documentId: "doc-1", path: "a.md", content: "one" });
    await b.sync();
    server.commit({ documentId: "doc-1", path: "a.md", content: "remote" });
    let edited = false;
    server.interceptor = (method) => {
      if (method !== "DownloadBlob" || edited) return;
      edited = true;
      void b.write("a.md", "local");
    };
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "local" });
  });
});

describe("two devices", () => {
  it("a note created on A appears on B", async () => {
    const { server, a, b } = setup();
    await a.write("notes/new.md", "hello");
    await a.write("image.png", "\x89PNG");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "image.png": "\x89PNG", "notes/new.md": "hello" });
    expect(revisions(server)).toHaveLength(2);
    expect((await a.journal.load()).pending).toEqual([]);
  });

  it("an edit on A appears on B", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    await b.sync();
    await a.write("a.md", "two");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "two" });
    const [created, edited] = revisions(server);
    expect(edited?.[0]).toBe(created?.[0]);
    expect(revisions(server)).toHaveLength(2);
  });

  it("a delete on A is applied on B", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.write("b.md", "two");
    await a.sync();
    await b.sync();
    await a.vault.delete("a.md");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "b.md": "two" });
    expect(revisions(server).at(-1)?.[2]).toBe(true);
    expect(server.liveFiles()).toEqual(new Map([["b.md", "two"]]));
  });

  it("a rename on A is applied on B and keeps the document", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    await b.sync();
    void a.engine.start();
    await a.vault.rename("a.md", "b.md");
    // A live rename keeps the document even when the file is edited too.
    await a.write("b.md", "one, edited");
    await a.sync();
    a.engine.stop();
    await b.sync();
    expect(await b.files()).toEqual({ "b.md": "one, edited" });
    const all = revisions(server);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual([all[0]?.[0], "b.md", false]);
  });

  it("a rename made while the app was closed is detected by hash", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    await b.sync();
    await a.vault.rename("a.md", "folder/b.md");
    await a.restart().sync();
    await b.sync();
    expect(await b.files()).toEqual({ "folder/b.md": "one" });
    const all = revisions(server);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual([all[0]?.[0], "folder/b.md", false]);
  });

  it("an unobserved rename whose content matches two files syncs as a delete plus creates", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "same");
    await a.sync();
    await a.vault.rename("a.md", "b.md");
    await a.write("c.md", "same");
    await a.restart().sync();
    await b.sync();
    expect(await b.files()).toEqual({ "b.md": "same", "c.md": "same" });
    const all = revisions(server);
    expect(all[1]).toEqual([all[0]?.[0], "a.md", true]);
    expect(new Set(all.map(([id]) => id)).size).toBe(3);
  });

  it("folder changes on A are applied on B: files created in, moved with and deleted with a folder", async () => {
    const { server, a, b } = setup();
    await a.write("projects/one.md", "1");
    await a.write("projects/sub/two.md", "2");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({ "projects/one.md": "1", "projects/sub/two.md": "2" });

    void a.engine.start();
    await a.vault.handle("user").renameFolder("projects", "archive");
    await a.sync();
    a.engine.stop();
    await b.sync();
    expect(await b.files()).toEqual({ "archive/one.md": "1", "archive/sub/two.md": "2" });
    expect(new Set(revisions(server).map(([id]) => id)).size).toBe(2);

    await a.vault.delete("archive/one.md");
    await a.vault.delete("archive/sub/two.md");
    await a.sync();
    await b.sync();
    expect(await b.files()).toEqual({});
    expect(server.liveFiles().size).toBe(0);
  });

  it("an engine restart resumes from the journal and pulls only what is new", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    await b.sync();
    await a.write("b.md", "two");
    await a.sync();
    let pulledFrom: bigint | undefined;
    server.interceptor = (method, request) => {
      if (method === "ListChanges") pulledFrom ??= (request as { sinceSeq: bigint }).sinceSeq;
    };
    await b.restart().sync();
    expect(pulledFrom).toBe(1n);
    expect(await b.files()).toEqual({ "a.md": "one", "b.md": "two" });
  });
});

describe("idempotent commits", () => {
  it("a commit retried after a lost reply leaves one revision on the server", async () => {
    const { server, a, b } = setup();
    let lost = 0;
    server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && lost++ === 0) throw new Error("reply lost");
    };
    await a.write("a.md", "one");
    await expect(a.sync()).rejects.toThrow();
    // The app restarts with the commit unacknowledged.
    await a.restart().sync();
    expect(revisions(server)).toHaveLength(1);
    expect((await a.journal.load()).pending).toEqual([]);
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "one" });
  });
});

describe("the engine's own writes", () => {
  it("are not pushed back, and start no cycle", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    void b.engine.start();
    await b.sync();
    await settle();
    expect(b.timers.delays()).not.toContain(2_000);
    await a.write("a.md", "two");
    await a.sync();
    b.engine.notifyRemoteChange();
    await b.sync();
    await settle();
    expect(b.timers.delays()).not.toContain(2_000);
    b.timers.fire(60_000);
    await b.sync();
    b.engine.stop();
    expect(await b.files()).toEqual({ "a.md": "two" });
    expect(revisions(server)).toHaveLength(2);
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("a user edit right after an engine write is pushed", async () => {
    const { server, a, b } = setup();
    await a.write("a.md", "one");
    await a.sync();
    await b.sync();
    void b.engine.start();
    await a.write("a.md", "two");
    await a.sync();
    // The user saves the moment the engine has written the remote edit.
    b.vault.watch((event) => {
      if (event.type === "modify" && event.path === "a.md") {
        void b.vault.read("a.md").then((data) => {
          if (new TextDecoder().decode(data) === "two") void b.vault.write("a.md", encoder.encode("two, then mine"));
        });
      }
    });
    await b.sync();
    await settle();
    expect(b.timers.delays()).toContain(2_000);
    b.timers.fire(2_000);
    await settle();
    await b.sync();
    b.engine.stop();
    expect(server.liveFiles()).toEqual(new Map([["a.md", "two, then mine"]]));
    await a.sync();
    expect(await a.files()).toEqual({ "a.md": "two, then mine" });
  });
});
