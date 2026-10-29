import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

// Size limits (docs/design/engine.md §7) and the device path-length check (§6):
// what one device cannot hold or send is skipped and listed for the conflict
// view, and everything else keeps syncing.

const limit = 1_000;

describe("size limits", () => {
  it("a remote file over this device's limit is not downloaded, is listed, and other files still arrive", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    const b = new Device(server, "device-b", { maxFileBytes: limit });
    await a.write("big.bin", "x".repeat(limit + 1));
    await a.write("note.md", "hello");
    await a.sync();

    await b.sync();

    expect(await b.files()).toEqual({ "note.md": "hello" });
    const problems = await b.engine.problems();
    expect(problems.skipped).toEqual([expect.objectContaining({ path: "big.bin", reason: "too-large", size: limit + 1 })]);
  });

  it("a remote file exactly at the limit is downloaded", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    const b = new Device(server, "device-b", { maxFileBytes: limit });
    await a.write("big.bin", "x".repeat(limit));
    await a.sync();

    await b.sync();

    expect(Object.keys(await b.files())).toEqual(["big.bin"]);
    expect((await b.engine.problems()).skipped).toEqual([]);
  });

  it("a skipped file is listed until a revision of it that fits arrives", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    const b = new Device(server, "device-b", { maxFileBytes: limit });
    await a.write("big.bin", "x".repeat(limit + 1));
    await a.sync();
    await b.sync();
    await a.write("big.bin", "small");
    await a.sync();

    await b.sync();

    expect(await b.files()).toEqual({ "big.bin": "small" });
    expect((await b.engine.problems()).skipped).toEqual([]);
  });

  it("a local file over the limit is not uploaded, is listed, and other files still sync", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a", { maxFileBytes: limit });
    await a.write("big.bin", "x".repeat(limit + 1));
    await a.write("note.md", "hello");

    await a.sync();

    expect(server.liveFiles()).toEqual(new Map([["note.md", "hello"]]));
    expect((await a.engine.problems()).tooLarge).toEqual([expect.objectContaining({ path: "big.bin", size: limit + 1 })]);
  });

  it("a local file the server refuses as too large is listed, and other files still sync", async () => {
    const server = new InMemoryServer({ maxBlobBytes: limit });
    const a = new Device(server, "device-a");
    await a.write("big.bin", "x".repeat(limit + 1));
    await a.write("note.md", "hello");

    await a.sync();

    expect(server.liveFiles()).toEqual(new Map([["note.md", "hello"]]));
    expect((await a.engine.problems()).tooLarge).toEqual([expect.objectContaining({ path: "big.bin" })]);
    expect(a.engine.status).toBe("idle");
  });
});

describe("device path length", () => {
  it("a remote path too long for this device is skipped and listed, and the rest of the pull continues", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    const b = new Device(server, "device-b", { pathRules: { platform: "windows", root: "C:\\vault" } });
    const long = `${"d".repeat(200)}/${"n".repeat(60)}.md`;
    await a.write(long, "far");
    await a.write("note.md", "hello");
    await a.sync();

    await b.sync();

    expect(await b.files()).toEqual({ "note.md": "hello" });
    expect((await b.engine.problems()).skipped).toEqual([expect.objectContaining({ path: long, reason: "path-too-long" })]);
    expect(server.liveFiles().get(long)).toBe("far");
  });

  it("a remote path the vault refuses to hold is skipped and listed, and the rest of the pull continues", async () => {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    // The engine's rules allow the name, but the vault (its platform) refuses it.
    const b = new Device(server, "device-b", {}, { pathRules: { platform: "windows", root: "C:\\vault" } });
    const long = `${"d".repeat(200)}/${"n".repeat(60)}.md`;
    await a.write(long, "too long for Windows");
    await a.write("note.md", "hello");
    await a.sync();

    await b.sync();

    expect(await b.files()).toEqual({ "note.md": "hello" });
    expect((await b.engine.problems()).skipped).toEqual([expect.objectContaining({ path: long, reason: "refused-by-vault" })]);
    expect(b.engine.status).toBe("idle");
  });
});

describe("a remote file named like the engine's temporary files", () => {
  // The server accepts any portable name, so another client or the import CLI
  // can commit a document named like a temporary file (§8). This device cannot
  // hold it: the startup cleanup would remove it and detection would push its
  // delete.
  const temporaryNames = ["Report.pdf.vault-sync-tmp", "draft.md.vault-sync-new", "taken.md.vault-sync-new"];

  async function seeded(): Promise<{ server: InMemoryServer; b: Device }> {
    const server = new InMemoryServer();
    const a = new Device(server, "device-a");
    await a.write("keep.md", "a note");
    await a.write("taken.md", "a note whose replacement name is taken");
    await a.sync();
    for (const [index, path] of temporaryNames.entries()) server.commit({ documentId: `temporary-${String(index)}`, path, content: `user file ${path}` });
    return { server, b: new Device(server, "device-b") };
  }

  it("is not written, is listed, and stays on the server through syncs and a restart", async () => {
    const { server, b } = await seeded();
    const before = new Map(server.liveFiles());

    await b.sync();
    await b.sync();
    b.restart();
    await b.sync();
    await b.sync();

    expect(await b.files()).toEqual({ "keep.md": "a note", "taken.md": "a note whose replacement name is taken" });
    expect(server.liveFiles()).toEqual(before);
    expect((await b.engine.problems()).skipped).toEqual(
      expect.arrayContaining(temporaryNames.map((path) => expect.objectContaining({ path, reason: "temporary-name" }) as unknown)),
    );
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("is not written by the resync after a server restore, and stays on the server", async () => {
    const { server, b } = await seeded();
    await b.sync();
    const backupSeq = server.currentHeadSeq;
    const before = new Map(server.liveFiles());
    await b.write("after.md", "after the backup");
    await b.sync();
    server.restoreTo(backupSeq);

    await b.sync();
    b.restart();
    await b.sync();

    expect(await b.files()).toEqual({ "after.md": "after the backup", "keep.md": "a note", "taken.md": "a note whose replacement name is taken" });
    expect(server.liveFiles()).toEqual(new Map([...before, ["after.md", "after the backup"]]));
    expect((await b.engine.problems()).skipped).toEqual(
      expect.arrayContaining(temporaryNames.map((path) => expect.objectContaining({ path, reason: "temporary-name" }) as unknown)),
    );
  });
});
