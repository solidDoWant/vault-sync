import { describe, expect, it } from "vitest";

import type { SyncEngineOptions } from "./engine";
import { InMemoryServer } from "./memory-server";
import { Device, encryptedServer } from "./testing";

/** 10 KiB of distinct bytes, so an upload takes several 4 KiB chunks. */
function attachment(): Uint8Array {
  const bytes = new Uint8Array(10 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

/**
 * Two devices hold the same attachment (the user saved the same PDF on
 * both) under different names. A's upload stops after the first chunk (a
 * network failure; no restart). B then syncs: its upload of the same content
 * continues A's server session. A syncs again, then a third device syncs.
 */
async function sameContentFromTwoDevices(server: InMemoryServer, options: Partial<SyncEngineOptions>) {
  const a = new Device(server, "device-a", options);
  const b = new Device(server, "device-b", options);
  const c = new Device(server, "device-c", options);
  const content = attachment();
  await a.vault.write("from-a.pdf", content);
  await b.vault.write("from-b.pdf", content);
  let chunks = 0;
  server.interceptor = (method) => {
    if (method === "PutBlobChunk" && ++chunks === 2) throw new Error("network failure");
  };
  await a.sync().catch(() => undefined);
  server.interceptor = undefined;
  await b.sync();
  await a.sync();
  const cSync = await c.sync().then(
    () => "ok",
    (error: unknown) => String(error),
  );
  return { c, content, cSync };
}

describe("two uploaders of the same content", () => {
  it("plaintext vault: a third device receives both files byte for byte", async () => {
    const { c, content, cSync } = await sameContentFromTwoDevices(new InMemoryServer({ maxChunkBytes: 4096 }), {});
    expect(cSync).toBe("ok");
    expect(await c.vault.read("from-a.pdf")).toEqual(content);
    expect(await c.vault.read("from-b.pdf")).toEqual(content);
  });

  it("encrypted vault: a third device receives both files byte for byte", async () => {
    const { server, keys } = encryptedServer({ maxChunkBytes: 4096 });
    const { c, content, cSync } = await sameContentFromTwoDevices(server, { keys });
    expect(cSync).toBe("ok");
    expect(await c.vault.read("from-a.pdf")).toEqual(content);
    expect(await c.vault.read("from-b.pdf")).toEqual(content);
  });
});
