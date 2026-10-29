import { describe, expect, it } from "vitest";

import { InMemoryServer } from "../engine/memory-server";
import { Device } from "./testing";

const decoder = new TextDecoder();

/** Each live document on the server: path → [document id, content]. */
function serverDocs(server: InMemoryServer): Record<string, [string, string]> {
  const heads = new Map<string, [string, string, boolean]>();
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) {
    const revision = server.revisionAt(seq);
    heads.set(revision.documentId, [decoder.decode(revision.path), revision.deleted ? "" : decoder.decode(server.contentOf(revision)), revision.deleted]);
  }
  const result: Record<string, [string, string]> = {};
  for (const [id, [path, content, deleted]] of heads) if (!deleted) result[path] = [id, content];
  return result;
}

function contents(docs: Record<string, [string, string]>): Record<string, string> {
  return Object.fromEntries(Object.entries(docs).map(([path, [, content]]) => [path, content]));
}

/** A device synced past a backup of the server, which the operator then restores. */
async function restoredAfter(changes: (a: Device) => Promise<void>): Promise<{ server: InMemoryServer; a: Device; b: Device; backupSeq: bigint }> {
  // A clock that moves only when the test says, so modification times and create times are ordered.
  let clock = Date.UTC(2026, 9, 29, 12, 0);
  const server = new InMemoryServer({ now: () => new Date(clock) });
  const a = new Device(server, "device-a", { now: () => clock }, { now: () => clock });
  const b = new Device(server, "device-b", { now: () => clock }, { now: () => clock });
  await a.write("same.md", "unchanged");
  await a.write("edited.md", "before");
  await a.write("renamed.md", "renaming");
  await a.write("removed.md", "removing");
  await a.write("picture.png", "picture");
  await a.sync();
  await b.sync();
  const backupSeq = server.currentHeadSeq;
  clock += 60_000;
  await changes(a);
  await a.sync();
  await b.sync();
  server.restoreTo(backupSeq);
  return { server, a, b, backupSeq };
}

describe("the resync after a server restore", () => {
  it("re-uploads a note created after the backup, with its document id", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      await a.write("new.md", "only on A");
    });
    const id = [...(await a.journal.load()).docs.values()].find((entry) => entry.path === "new.md")?.documentId;
    expect(serverDocs(server)["new.md"]).toBeUndefined();
    await a.sync();
    expect(serverDocs(server)["new.md"]).toEqual([id, "only on A"]);
    expect(await a.files()).toEqual(contents(serverDocs(server)));
    expect((await a.journal.load()).pending).toEqual([]);
  });

  it("keeps an edit the restore lost as a conflict copy, and the head at the path", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      await a.write("edited.md", "after");
    });
    await a.sync();
    const files = await a.files();
    expect(files["edited.md"]).toBe("before");
    const copies = Object.entries(files).filter(([path]) => path !== "edited.md" && path.startsWith("edited"));
    expect(copies.map(([, content]) => content)).toEqual(["after"]);
    expect(contents(serverDocs(server))).toEqual(files);
    const state = await a.journal.load();
    expect([...state.conflicts.keys()]).toEqual(copies.map(([path]) => path));
    expect(state.pending).toEqual([]);
  });

  it("keeps a newer local attachment at the path, and the head as the conflict copy", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      await a.write("picture.png", "edited after the backup");
    });
    await a.sync();
    const files = await a.files();
    expect(files["picture.png"]).toBe("edited after the backup");
    const copies = Object.entries(files).filter(([path]) => path !== "picture.png" && path.startsWith("picture"));
    expect(copies.map(([, content]) => content)).toEqual(["picture"]);
    expect(contents(serverDocs(server))).toEqual(files);
    expect((await a.journal.load()).pending).toEqual([]);
  });

  it("pushes a rename the restore lost again", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      await a.vault.rename("renamed.md", "folder/renamed.md");
    });
    const before = serverDocs(server);
    await a.sync();
    const after = serverDocs(server);
    expect(contents(after)).toEqual({ "edited.md": "before", "folder/renamed.md": "renaming", "picture.png": "picture", "removed.md": "removing", "same.md": "unchanged" });
    // The rename kept the document.
    expect(after["folder/renamed.md"]?.[0]).toBe(before["renamed.md"]?.[0]);
    expect(await a.files()).toEqual(contents(after));
    expect((await a.journal.load()).pending).toEqual([]);
  });

  it("re-applies a rename and a delete still pending at the restore", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    await a.write("renamed.md", "renaming");
    await a.write("removed.md", "removing");
    await a.write("later.md", "later");
    await a.sync();
    const backupSeq = server.currentHeadSeq;
    await a.write("later.md", "later, edited");
    await a.sync();
    server.restoreTo(backupSeq);
    // Pending when the device meets the restored server.
    await a.vault.rename("renamed.md", "moved.md");
    await a.vault.delete("removed.md");
    await a.sync();
    const files = await a.files();
    expect(files["moved.md"]).toBe("renaming");
    expect(files["removed.md"]).toBeUndefined();
    expect(contents(serverDocs(server))).toEqual(files);
    expect((await a.journal.load()).pending).toEqual([]);
  });

  it("writes a head the device holds no file for, with no pending delete", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      // Deleted after the backup: the restored server holds it again.
      await a.vault.delete("removed.md");
    });
    const state = await a.journal.load();
    expect(state.docs.has(serverDocs(server)["removed.md"]?.[0] ?? "")).toBe(false);
    await a.sync();
    expect((await a.files())["removed.md"]).toBe("removing");
    expect(contents(serverDocs(server))).toEqual(await a.files());
  });

  it("leaves a device with nothing new in line with the restored heads, pushing nothing", async () => {
    const { server, b } = await restoredAfter(async (a) => {
      await a.write("new.md", "only on A");
    });
    // B received new.md before the restore.
    const before = server.revisionCount;
    await b.sync();
    // B holds new.md too, so it re-uploads it; then nothing else.
    expect(server.revisionCount).toBe(before + 1);
    expect(contents(serverDocs(server))).toEqual(await b.files());
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("converges two devices that both synced past the backup", async () => {
    const { server, a, b } = await restoredAfter(async (a) => {
      await a.write("new.md", "only on A");
      await a.write("edited.md", "after");
    });
    await a.sync();
    await b.sync();
    await a.sync();
    await b.sync();
    const files = await a.files();
    expect(await b.files()).toEqual(files);
    expect(contents(serverDocs(server))).toEqual(files);
    expect(files["new.md"]).toBe("only on A");
    expect(files["edited.md"]).toBe("before");
    // Each device that held the edit the restore lost keeps it as a copy.
    expect(Object.values(files).filter((content) => content === "after")).toHaveLength(2);
  });

  it("restarts from the start after a crash midway, and repeats nothing", async () => {
    const { server, a } = await restoredAfter(async (a) => {
      await a.write("edited.md", "after");
      await a.write("new.md", "only on A");
    });
    // Killed during the resync, after it moved the edit aside and before it wrote the head.
    const write = a.vault.write.bind(a.vault);
    let killed = false;
    a.vault.write = (path, data, precondition) => {
      if (!killed && path.startsWith("edited.md")) {
        killed = true;
        return Promise.reject(new Error("killed"));
      }
      return write(path, data, precondition);
    };
    await expect(a.sync()).rejects.toThrow("killed");
    expect((await a.files())["edited.md"]).toBeUndefined();
    await a.restart().sync();
    const files = await a.files();
    expect(Object.values(files).filter((content) => content === "after")).toHaveLength(1);
    expect(files["edited.md"]).toBe("before");
    expect(files["new.md"]).toBe("only on A");
    expect(contents(serverDocs(server))).toEqual(files);
    expect((await a.journal.load()).pending).toEqual([]);
  });
});
