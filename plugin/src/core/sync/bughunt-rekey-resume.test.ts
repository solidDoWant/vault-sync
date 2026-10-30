import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../protocol/client";
import { reencryptHistory } from "./rekey";
import { Device, encryptedServer } from "./testing";

/** 10 KiB of distinct bytes, so an upload takes several 4 KiB chunks. */
function attachment(): Uint8Array {
  const bytes = new Uint8Array(10 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

describe("a re-key job interrupted during an upload, then run again", () => {
  it("leaves history readable: a new device receives the attachment byte for byte", async () => {
    const { server, keys } = encryptedServer({ maxChunkBytes: 4096 });
    const a = new Device(server, "device-a", { keys });
    const content = attachment();
    await a.vault.write("photo.png", content);
    await a.sync();
    keys.rotate();

    // The owner's re-key job is interrupted (app killed) after the server stored the first chunk of the re-sealed attachment.
    const job = createProtocolClient({ transport: server.transport });
    let chunks = 0;
    server.interceptor = (method) => {
      if (method === "PutBlobChunk" && ++chunks === 2) throw new Error("app killed");
    };
    await expect(reencryptHistory(job, server.vaultId, keys)).rejects.toThrow();
    server.interceptor = undefined;

    // The owner runs the job again: it resumes.
    await reencryptHistory(job, server.vaultId, keys);

    const fresh = new Device(server, "device-new", { keys });
    await fresh.sync();
    expect(await fresh.vault.read("photo.png")).toEqual(content);
  });
});
