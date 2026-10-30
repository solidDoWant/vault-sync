import { describe, expect, it } from "vitest";

import type { SyncEngineOptions } from "./engine";
import { InMemoryServer, type InMemoryServerOptions } from "./memory-server";
import { Device, encryptedServer } from "./testing";

/** 10 KiB of distinct bytes, so the upload takes several 4 KiB chunks. */
function attachment(): Uint8Array {
  const bytes = new Uint8Array(10 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

/**
 * Device A starts uploading an attachment; the app is killed after the
 * server stored the first chunk (the upload session stays on the server).
 * After the restart A syncs again, which resumes the upload, and commits.
 * Device B then syncs.
 */
async function interruptedUpload(server: InMemoryServer, options: Partial<SyncEngineOptions>) {
  const a = new Device(server, "device-a", options);
  const b = new Device(server, "device-b", options);
  const content = attachment();
  await a.vault.write("photo.png", content);
  let chunks = 0;
  server.interceptor = (method) => {
    if (method === "PutBlobChunk" && ++chunks === 2) throw new Error("app killed");
  };
  await a.sync().catch(() => undefined);
  server.interceptor = undefined;
  expect(chunks).toBe(2);

  a.restart();
  await a.sync();
  const bSync = await b.sync().then(
    () => "ok",
    (error: unknown) => String(error),
  );
  return { a, b, content, bSync };
}

const serverOptions: InMemoryServerOptions = { maxChunkBytes: 4096 };

describe("an attachment upload interrupted by an app restart, then resumed", () => {
  it("plaintext vault: the other device receives the attachment byte for byte", async () => {
    const server = new InMemoryServer(serverOptions);
    const { b, content, bSync } = await interruptedUpload(server, {});
    expect(bSync).toBe("ok");
    expect(await b.vault.read("photo.png")).toEqual(content);
  });

  it("encrypted vault: the other device receives the attachment byte for byte", async () => {
    const { server, keys } = encryptedServer(serverOptions);
    const { a, b, content, bSync } = await interruptedUpload(server, { keys });
    // Every later sync of every other device stops at the attachment's revision, so later notes never arrive.
    await a.write("later.md", "written after the attachment\n");
    await a.sync();
    b.restart();
    for (let round = 0; round < 3; round++) await b.sync().catch(() => undefined);
    expect(Object.keys(await b.files())).toContain("later.md");
    expect(bSync).toBe("ok");
    expect(await b.vault.read("photo.png")).toEqual(content);
  });
});
