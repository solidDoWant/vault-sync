import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { createProtocolClient } from "../protocol/client";
import { InMemoryServer } from "./memory-server";
import { uploadContent } from "./upload";

const content = new TextEncoder().encode("an attachment the server may already hold");
const hash = sha256Hex(content);
const size = BigInt(content.length);

function setup() {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 });
  const methods: string[] = [];
  server.interceptor = (method) => {
    methods.push(method);
  };
  return { server, methods, api: createProtocolClient({ transport: server.transport }) };
}

describe("uploadContent", () => {
  it("does not read the local file when the server already holds the blob", async () => {
    const { server, methods, api } = setup();
    expect(await uploadContent(api, server.vaultId, hash, size, () => Promise.resolve(content))).toBe("complete");
    methods.length = 0;
    let reads = 0;
    const result = await uploadContent(api, server.vaultId, hash, size, () => {
      reads++;
      return Promise.resolve(content);
    });
    expect(result).toBe("complete");
    expect(reads).toBe(0);
    expect(methods).not.toContain("BeginBlob");
  });

  it("reads and uploads the file when the server does not hold the blob", async () => {
    const { server, methods, api } = setup();
    let reads = 0;
    const result = await uploadContent(api, server.vaultId, hash, size, () => {
      reads++;
      return Promise.resolve(content);
    });
    expect(result).toBe("complete");
    expect(reads).toBe(1);
    expect(methods).toContain("CommitBlob");
  });

  it("opens no session for changed content the server does not hold", async () => {
    const { server, methods, api } = setup();
    const result = await uploadContent(api, server.vaultId, hash, size, () => Promise.resolve(new TextEncoder().encode("edited since")));
    expect(result).toBe("missing");
    expect(methods).not.toContain("BeginBlob");
  });
});
