import { describe, expect, it } from "vitest";

import { DocumentKind } from "../../gen/vaultsync/v1/types_pb";
import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

/**
 * Folder documents (docs/design/engine.md §2): every folder is a document,
 * and the rows of §5 apply to it with the path rules only (rule M). Device A
 * makes the remote change and B the local one; both engines watch their
 * vaults, so a folder rename is a live event.
 */

async function setup(): Promise<{ server: InMemoryServer; a: Device; b: Device }> {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  return { server, a, b };
}

async function folders(device: Device): Promise<string[]> {
  return (await device.vault.listFolders()).sort();
}

/** The live folder documents on the server: path → document id. */
function serverFolders(server: InMemoryServer): Map<string, string> {
  const heads = new Map<string, { path: string; deleted: boolean; folder: boolean }>();
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) {
    const revision = server.revisionAt(seq);
    heads.set(revision.documentId, { path: new TextDecoder().decode(revision.path), deleted: revision.deleted, folder: revision.kind === DocumentKind.FOLDER });
  }
  const live = new Map<string, string>();
  for (const [id, head] of heads) if (head.folder && !head.deleted) live.set(head.path, id);
  return live;
}

/** Syncs both devices until they are idle, then checks they converged on the server's heads. */
async function converge(server: InMemoryServer, a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
  expect(await folders(b)).toEqual(await folders(a));
  expect(await b.files()).toEqual(await a.files());
  expect(new Map(Object.entries(await a.files()))).toEqual(server.liveFiles());
  expect([...serverFolders(server).keys()].sort()).toEqual(await folders(a));
  expect((await a.journal.load()).pending).toEqual([]);
  expect((await b.journal.load()).pending).toEqual([]);
}

describe("folder documents", () => {
  it("A1: an empty folder created on A is created on B", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Empty");
    await a.sync();
    await b.sync();
    expect(await folders(b)).toEqual(["Empty"]);
    await converge(server, a, b);
    expect(serverFolders(server).size).toBe(1);
  });

  it("A1, rule W: a folder already on B is bound to the arriving folder document", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Same");
    await a.sync();
    await b.vault.createFolder("Same");
    await b.sync();
    await converge(server, a, b);
    expect(await folders(b)).toEqual(["Same"]);
    expect(serverFolders(server).size).toBe(1);
  });

  it("P2: a folder document refused because another device created the same folder first is bound to that one, not refused", async () => {
    const server = new InMemoryServer();
    const b = new Device(server, "device-b");
    // A note in a folder that has no folder document yet, as a vault synced before folders were documents.
    server.commit({ documentId: "note", path: "Projects/Plan.md", content: "the plan\n" });
    let raced = false;
    server.interceptor = (method, request) => {
      if (method !== "CommitRevision" || raced || (request as { kind: DocumentKind }).kind !== DocumentKind.FOLDER) return;
      raced = true;
      // Another device's folder document for the same folder lands first.
      server.commit({ documentId: "other-folder", path: "Projects", kind: DocumentKind.FOLDER, content: "" });
    };
    // One sync: the refused commit is resolved by a pull at once (P2), with no refused name left waiting.
    await b.sync();
    expect(raced).toBe(true);
    expect((await b.journal.load()).pending).toEqual([]);
    expect(serverFolders(server)).toEqual(new Map([["Projects", "other-folder"]]));
    expect(await folders(b)).toEqual(["Projects"]);
  });

  it("A1, rule W: a file where the folder must go moves to a conflict copy name", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Name");
    await a.sync();
    await b.write("Name", "a file\n");
    await b.sync();
    await converge(server, a, b);
    expect(await folders(b)).toEqual(["Name"]);
    const files = await b.files();
    expect(Object.values(files)).toEqual(["a file\n"]);
    expect(Object.keys(files)[0]).toMatch(/^Name \(Conflicted copy user device-b \d{12}\)$/u);
  });

  it("A4: a folder renamed on A, with and without files, is renamed on B, and the old folder goes", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Empty");
    await a.write("Projects/Plan.md", "the plan\n");
    await converge(server, a, b);
    const ids = serverFolders(server);

    await a.vault.handle("user").renameFolder("Projects", "Archive");
    await a.vault.handle("user").renameFolder("Empty", "Still empty");
    await converge(server, a, b);
    expect(await folders(b)).toEqual(["Archive", "Still empty"]);
    expect(await b.files()).toEqual({ "Archive/Plan.md": "the plan\n" });
    // A rename keeps the folder's document.
    expect(serverFolders(server).get("Archive")).toBe(ids.get("Projects"));
    expect(serverFolders(server).get("Still empty")).toBe(ids.get("Empty"));
  });

  it("A5: an empty folder deleted on A is deleted on B and stays deleted", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Empty");
    await converge(server, a, b);
    await a.vault.deleteFolder("Empty");
    await a.sync();
    await b.sync();
    expect(await folders(b)).toEqual([]);
    await converge(server, a, b);
    // Further syncs, with other changes, bring nothing back.
    await a.write("Nudge A.md", "a change\n");
    await b.write("Nudge B.md", "a change\n");
    await converge(server, a, b);
    expect(await folders(a)).toEqual([]);
    expect(await folders(b)).toEqual([]);
  });

  it("A5: a folder deleted on A with its files is deleted on B", async () => {
    const { server, a, b } = await setup();
    await a.write("Archive/Plan.md", "the plan\n");
    await a.write("Archive/Sub/Note.md", "a note\n");
    await converge(server, a, b);
    await a.vault.delete("Archive/Sub/Note.md");
    await a.vault.deleteFolder("Archive/Sub");
    await a.vault.delete("Archive/Plan.md");
    await a.vault.deleteFolder("Archive");
    await converge(server, a, b);
    expect(await folders(b)).toEqual([]);
    expect(await b.files()).toEqual({});
  });

  it("A5, a live item keeps its folders live: a file edited on B in a folder A deleted brings the folder back as the same document", async () => {
    const { server, a, b } = await setup();
    await a.write("Projects/Plan.md", "the plan\n");
    await converge(server, a, b);
    const folderId = serverFolders(server).get("Projects");
    await a.vault.delete("Projects/Plan.md");
    await a.vault.deleteFolder("Projects");
    await a.sync();
    await b.write("Projects/Plan.md", "the plan, edited\n");
    await converge(server, a, b);
    expect(await a.files()).toEqual({ "Projects/Plan.md": "the plan, edited\n" });
    expect(await folders(a)).toEqual(["Projects"]);
    expect(serverFolders(server).get("Projects")).toBe(folderId);
  });

  it("A8: a folder deleted on B and renamed on A comes back at A's path", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Old");
    await converge(server, a, b);
    await a.vault.handle("user").renameFolder("Old", "New");
    await a.sync();
    await b.vault.deleteFolder("Old");
    await converge(server, a, b);
    expect(await folders(b)).toEqual(["New"]);
  });

  it("A9: a folder renamed on both devices takes the server's path", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Old");
    await converge(server, a, b);
    await a.vault.handle("user").renameFolder("Old", "From A");
    await a.sync();
    await b.vault.handle("user").renameFolder("Old", "From B");
    await converge(server, a, b);
    expect(await folders(b)).toEqual(["From A"]);
  });

  it("A9: a folder renamed on B while A kept its path is renamed on A", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Old");
    await converge(server, a, b);
    await b.vault.handle("user").renameFolder("Old", "From B");
    await converge(server, a, b);
    expect(await folders(a)).toEqual(["From B"]);
  });

  it("A10: a folder renamed on B and deleted on A stays at B's path", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Old");
    await converge(server, a, b);
    const folderId = serverFolders(server).get("Old");
    await a.vault.deleteFolder("Old");
    await a.sync();
    await b.vault.handle("user").renameFolder("Old", "Kept");
    await converge(server, a, b);
    expect(await folders(a)).toEqual(["Kept"]);
    expect(serverFolders(server).get("Kept")).toBe(folderId);
  });

  it("A11: a folder deleted on both devices is gone, with nothing left to push", async () => {
    const { server, a, b } = await setup();
    await a.vault.createFolder("Old");
    await converge(server, a, b);
    await a.vault.deleteFolder("Old");
    await a.sync();
    await b.vault.deleteFolder("Old");
    await converge(server, a, b);
    expect(await folders(b)).toEqual([]);
  });
});
