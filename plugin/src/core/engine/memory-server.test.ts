import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { DocumentKind } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import { createProtocolClient } from "../protocol/client";
import { InMemoryServer } from "./memory-server";

const encoder = new TextEncoder();

/** Commits `path` for `documentId` through the protocol, as a client would; returns the error code, or "ok". */
async function commit(server: InMemoryServer, documentId: string, revisionId: string, baseRevId: string, path: string, deleted = false): Promise<string> {
  const api = createProtocolClient({ transport: server.transport });
  const content = encoder.encode(`content of ${path}`);
  server.commit({ documentId: "blob-holder", path: `blobs/${revisionId}`, content });
  try {
    await api.sync.commitRevision({
      vaultId: server.vaultId,
      documentId,
      revisionId,
      baseRevId,
      kind: DocumentKind.TEXT,
      contentRef: { blobId: hexToBytes(sha256Hex(content)), size: BigInt(content.length) },
      path: encoder.encode(path),
      deleted,
      deviceId: "device",
    });
    return "ok";
  } catch (error) {
    return error instanceof ConnectError ? Code[error.code] : String(error);
  }
}

describe("InMemoryServer's file/folder rule (SPEC.md §6.3, #134)", () => {
  it("refuses a create under another live document's file, and at another's folder, ignoring case", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "file", path: "Notes", content: "a file" });
    server.commit({ documentId: "nested", path: "other/c.md", content: "nested" });

    expect(await commit(server, "x", "x1", "", "notes/c.md")).toBe("AlreadyExists");
    expect(await commit(server, "y", "y1", "", "OTHER")).toBe("AlreadyExists");
    expect(await commit(server, "z", "z1", "", "notes2/c.md")).toBe("ok");
  });

  it("refuses a rename into the collision, but never an edit or delete that keeps a live path key", async () => {
    const server = new InMemoryServer();
    const file = server.commit({ documentId: "file", path: "notes", content: "a file" });
    // A collision committed before the rule existed.
    const nested = server.commit({ documentId: "nested", path: "notes/c.md", content: "nested" });
    const elsewhere = server.commit({ documentId: "elsewhere", path: "e.md", content: "e" });

    expect(await commit(server, "elsewhere", "e2", elsewhere.id, "notes/e.md")).toBe("AlreadyExists");
    expect(await commit(server, "nested", "n2", nested.id, "notes/c.md")).toBe("ok");
    expect(await commit(server, "file", "f2", file.id, "notes", true)).toBe("ok");
  });

  it("ignores tombstones", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "file", path: "notes", content: "a file" });
    server.commit({ documentId: "file", path: "notes", deleted: true });

    expect(await commit(server, "x", "x1", "", "notes/c.md")).toBe("ok");
  });
});
