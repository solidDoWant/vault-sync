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

describe("InMemoryServer's backslash rule (SPEC.md §6.2, #191)", () => {
  it("refuses to create a path with a backslash, beside a live slash twin or file, or anywhere", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "twin", path: "a/b", content: "slash" });
    server.commit({ documentId: "file", path: "notes", content: "a file" });

    expect(await commit(server, "x", "x1", "", "a\\b")).toBe("InvalidArgument");
    expect(await commit(server, "y", "y1", "", "notes\\c.md")).toBe("InvalidArgument");
    expect(await commit(server, "z", "z1", "", "elsewhere\\z.md")).toBe("InvalidArgument");
    expect(await commit(server, "w", "w1", "", "elsewhere/z.md")).toBe("ok");
  });

  it("lets a live document already at a backslash path be edited and deleted in place, or renamed to a valid path", async () => {
    const server = new InMemoryServer();
    const edited = server.commit({ documentId: "edit", path: "a\\b.md", content: "legacy" });
    const deleted = server.commit({ documentId: "delete", path: "c\\d.md", content: "legacy" });
    const renamed = server.commit({ documentId: "rename", path: "e\\f.md", content: "legacy" });

    expect(await commit(server, "edit", "e2", edited.id, "a\\b.md")).toBe("ok");
    expect(await commit(server, "delete", "d2", deleted.id, "c\\d.md", true)).toBe("ok");
    expect(await commit(server, "rename", "r2", renamed.id, "e/f.md")).toBe("ok");
  });

  it("refuses to move a document to another backslash path, or to bring a tombstone back at one", async () => {
    const server = new InMemoryServer();
    const moved = server.commit({ documentId: "move", path: "a\\b.md", content: "legacy" });
    server.commit({ documentId: "back", path: "c\\d.md", content: "legacy" });
    const tombstone = server.commit({ documentId: "back", path: "c\\d.md", deleted: true });

    expect(await commit(server, "move", "m2", moved.id, "a\\c.md")).toBe("InvalidArgument");
    expect(await commit(server, "back", "b3", tombstone.id, "c\\d.md")).toBe("InvalidArgument");
  });
});

describe("InMemoryServer's drive-like path rule (SPEC.md §6.2, #148)", () => {
  it("refuses to create a path starting with one character and a colon", async () => {
    const server = new InMemoryServer();

    expect(await commit(server, "x", "x1", "", "1:x.md")).toBe("InvalidArgument");
    expect(await commit(server, "y", "y1", "", "é:x.md")).toBe("InvalidArgument");
    expect(await commit(server, "z", "z1", "", "12:x.md")).toBe("ok");
  });

  it("lets a live document already at such a path be edited in place, but not moved to another", async () => {
    const server = new InMemoryServer();
    const legacy = server.commit({ documentId: "legacy", path: "1:x.md", content: "legacy" });

    expect(await commit(server, "legacy", "l2", legacy.id, "2:x.md")).toBe("InvalidArgument");
    expect(await commit(server, "legacy", "l3", legacy.id, "1:x.md")).toBe("ok");
  });
});

describe("InMemoryServer's path text rule (SPEC.md §6.2, #148)", () => {
  it.each([
    ["a NUL", "a\u0000b.md"],
    ["a newline", "a\nb.md"],
    ["more than 4096 bytes", "é".repeat(2049)],
  ])("refuses a path with %s", async (_, path) => {
    expect(await commit(new InMemoryServer(), "x", "x1", "", path)).toBe("InvalidArgument");
  });

  it("accepts a path of exactly 4096 bytes", async () => {
    expect(await commit(new InMemoryServer(), "x", "x1", "", "é".repeat(2048))).toBe("ok");
  });

  // U+1D160 decomposes into three 4-byte code points (testdata/paths/key.json, #100).
  it("refuses a path longer than 8192 bytes once normalized, and accepts one of exactly 8192", async () => {
    expect(await commit(new InMemoryServer(), "x", "x1", "", "\u{1d160}".repeat(682) + "a".repeat(9))).toBe("InvalidArgument");
    expect(await commit(new InMemoryServer(), "x", "x1", "", "\u{1d160}".repeat(682) + "a".repeat(8))).toBe("ok");
  });
});

describe("InMemoryServer's upload session limit (SPEC.md §6.2, #370)", () => {
  async function begin(server: InMemoryServer, content: string): Promise<string> {
    const api = createProtocolClient({ transport: server.transport });
    const bytes = encoder.encode(content);
    try {
      await api.blobs.beginBlob({ vaultId: server.vaultId, blobId: hexToBytes(sha256Hex(bytes)), size: BigInt(bytes.length) });
      return "ok";
    } catch (error) {
      return error instanceof ConnectError ? Code[error.code] : String(error);
    }
  }

  it("refuses a new session at the limit while no session has been idle past the reclaim threshold, and reclaims one that has", async () => {
    let clock = 0;
    const server = new InMemoryServer({ maxUploads: 2, uploadReclaimIdleMs: 600_000, now: () => new Date(clock) });
    expect(await begin(server, "one")).toBe("ok");
    expect(await begin(server, "two")).toBe("ok");
    clock += 600_000;
    expect(await begin(server, "three")).toBe("ResourceExhausted");
    expect(server.openUploads()).toBe(2);
    clock += 1;
    expect(await begin(server, "three")).toBe("ok");
    expect(server.openUploads()).toBe(1);
  });
});
