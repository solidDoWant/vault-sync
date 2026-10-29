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
});
