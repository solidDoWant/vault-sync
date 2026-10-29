import { describe, expect, it } from "vitest";

import { createProtocolClient, type ProtocolClient } from "../protocol/client";
import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

/**
 * Viewer devices (docs/design/sharing.md): a read-only device never commits
 * or uploads. A local difference from `base` is kept as a local copy, the
 * shared version is restored, and the device only pulls. Device A is an
 * editor; V is the read-only device.
 */

const decoder = new TextDecoder();

interface Viewer {
  server: InMemoryServer;
  a: Device;
  v: Device;
  /** Local copies V kept: path → content. */
  copies: [string, string][];
  /** Write calls V made to the server: commits and blob uploads. */
  writes: string[];
  role: { readOnly: boolean };
}

/** Wraps the server client so every commit and upload V makes is recorded. */
function recordingClient(server: InMemoryServer, writes: string[]): ProtocolClient {
  const client = createProtocolClient({ transport: server.transport });
  const { sync, blobs } = client;
  return {
    ...client,
    sync: {
      ...sync,
      commitRevision: (request, options) => {
        writes.push("CommitRevision");
        return sync.commitRevision(request, options);
      },
    },
    blobs: {
      ...blobs,
      beginBlob: (request, options) => {
        writes.push("BeginBlob");
        return blobs.beginBlob(request, options);
      },
      putBlobChunk: (request, options) => {
        writes.push("PutBlobChunk");
        return blobs.putBlobChunk(request, options);
      },
      commitBlob: (request, options) => {
        writes.push("CommitBlob");
        return blobs.commitBlob(request, options);
      },
    },
  };
}

async function setup(files: Record<string, string>): Promise<Viewer> {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  await a.engine.start();
  for (const [path, text] of Object.entries(files)) await a.write(path, text);
  await a.sync();
  const copies: [string, string][] = [];
  const writes: string[] = [];
  const role = { readOnly: true };
  const v = new Device(server, "device-v", {
    api: recordingClient(server, writes),
    readOnly: () => Promise.resolve(role.readOnly),
    keepLocalCopy: (path, content) => {
      copies.push([path, decoder.decode(content)]);
      return Promise.resolve();
    },
  });
  await v.engine.start();
  return { server, a, v, copies, writes, role };
}

/** V's journal has nothing pending, its files are the server's, and it wrote nothing to the server. */
async function restored(viewer: Viewer): Promise<void> {
  expect(viewer.writes).toEqual([]);
  expect((await viewer.v.journal.load()).pending).toEqual([]);
  expect(new Map(Object.entries(await viewer.v.files()))).toEqual(viewer.server.liveFiles());
}

describe("read-only devices", () => {
  it("pulls the shared files", async () => {
    const viewer = await setup({ "a.md": "shared" });
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    await viewer.a.write("a.md", "shared, edited");
    await viewer.a.sync();
    await viewer.v.sync();
    expect(await viewer.v.files()).toEqual({ "a.md": "shared, edited" });
    await restored(viewer);
  });

  it("keeps an edited file as a local copy and restores the shared version", async () => {
    const viewer = await setup({ "a.md": "shared" });
    const head = viewer.server.currentHeadSeq;
    await viewer.v.write("a.md", "edited outside Obsidian");
    await viewer.v.sync();
    expect(viewer.copies).toEqual([["a.md", "edited outside Obsidian"]]);
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    expect(viewer.server.currentHeadSeq).toBe(head);
    await restored(viewer);
  });

  it("moves a new file to the local copies", async () => {
    const viewer = await setup({ "a.md": "shared" });
    await viewer.v.write("Notes/new.md", "mine");
    await viewer.v.sync();
    expect(viewer.copies).toEqual([["Notes/new.md", "mine"]]);
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    expect(await viewer.v.vault.listFolders()).toEqual([]);
    await restored(viewer);
  });

  it("undoes a delete by restoring the shared version", async () => {
    const viewer = await setup({ "a.md": "shared" });
    await viewer.v.vault.delete("a.md");
    await viewer.v.sync();
    expect(viewer.copies).toEqual([]);
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    await restored(viewer);
  });

  it("undoes a rename by restoring the shared version at its path", async () => {
    const viewer = await setup({ "a.md": "shared" });
    await viewer.v.vault.rename("a.md", "b.md");
    await viewer.v.sync();
    expect(viewer.copies).toEqual([]);
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    await restored(viewer);
  });

  it("undoes a folder rename and a folder delete", async () => {
    const viewer = await setup({ "Folder/a.md": "shared", "Other/b.md": "other" });
    await viewer.v.vault.rename("Folder/a.md", "Moved/a.md");
    await viewer.v.vault.deleteFolder("Folder");
    await viewer.v.vault.delete("Other/b.md");
    await viewer.v.vault.deleteFolder("Other");
    await viewer.v.sync();
    expect(await viewer.v.files()).toEqual({ "Folder/a.md": "shared", "Other/b.md": "other" });
    expect((await viewer.v.vault.listFolders()).sort()).toEqual(["Folder", "Other"]);
    await restored(viewer);
  });

  it("drops changes left pending from before the device became read-only, without pushing them", async () => {
    const viewer = await setup({ "a.md": "shared" });
    viewer.role.readOnly = false;
    viewer.v.engine.stop();
    await viewer.v.write("a.md", "edited while an editor, not pushed yet");
    viewer.role.readOnly = true;
    await viewer.v.restart().start();
    expect(viewer.copies).toEqual([["a.md", "edited while an editor, not pushed yet"]]);
    await restored(viewer);
  });

  it("syncs normally from the next cycle after becoming an editor", async () => {
    const viewer = await setup({ "a.md": "shared" });
    await viewer.v.write("a.md", "a viewer's edit");
    await viewer.v.sync();
    expect(await viewer.v.files()).toEqual({ "a.md": "shared" });
    viewer.role.readOnly = false;
    await viewer.v.write("a.md", "an editor's edit");
    await viewer.v.write("new.md", "new");
    await viewer.v.sync();
    expect(viewer.writes).toContain("CommitRevision");
    expect(viewer.server.liveFiles()).toEqual(
      new Map([
        ["a.md", "an editor's edit"],
        ["new.md", "new"],
      ]),
    );
    await viewer.a.sync();
    expect(await viewer.a.files()).toEqual({ "a.md": "an editor's edit", "new.md": "new" });
  });
});
