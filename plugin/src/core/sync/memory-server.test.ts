import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { DeviceService } from "../../gen/vaultsync/v1/device_pb";
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

/** Commits a new folder document at `path` through the protocol; returns the error code, or "ok". */
async function commitFolder(server: InMemoryServer, documentId: string, path: string): Promise<string> {
  const api = createProtocolClient({ transport: server.transport });
  try {
    await api.sync.commitRevision({
      vaultId: server.vaultId,
      documentId,
      revisionId: `${documentId}-1`,
      baseRevId: "",
      kind: DocumentKind.FOLDER,
      path: encoder.encode(path),
      deleted: false,
      deviceId: "device",
    });
    return "ok";
  } catch (error) {
    return error instanceof ConnectError ? Code[error.code] : String(error);
  }
}

describe("InMemoryServer's folder documents", () => {
  type Kind = "file" | "folder";
  const cases: { name: string; first: [Kind, string]; second: [Kind, string]; want: string }[] = [
    { name: "a file under a folder", first: ["folder", "P"], second: ["file", "p/x.md"], want: "ok" },
    { name: "a folder under a folder", first: ["folder", "P"], second: ["folder", "p/Q"], want: "ok" },
    { name: "a folder over a file", first: ["file", "P/x.md"], second: ["folder", "p"], want: "ok" },
    { name: "a folder over a folder", first: ["folder", "P/Q"], second: ["folder", "p"], want: "ok" },
    { name: "a file under a file", first: ["file", "P"], second: ["file", "p/x.md"], want: "AlreadyExists" },
    { name: "a folder under a file", first: ["file", "P"], second: ["folder", "p/Q"], want: "AlreadyExists" },
    { name: "a file over a file", first: ["file", "P/x.md"], second: ["file", "p"], want: "AlreadyExists" },
    { name: "a file over a folder", first: ["folder", "P/Q"], second: ["file", "p"], want: "AlreadyExists" },
    { name: "a file at a folder", first: ["folder", "P"], second: ["file", "p"], want: "AlreadyExists" },
    { name: "a folder at a file", first: ["file", "P"], second: ["folder", "p"], want: "AlreadyExists" },
  ];

  const commitKind = (server: InMemoryServer, documentId: string, [kind, path]: [Kind, string]) =>
    kind === "folder" ? commitFolder(server, documentId, path) : commit(server, documentId, `${documentId}-1`, "", path);

  for (const { name, first, second, want } of cases) {
    it(`${want === "ok" ? "accepts" : "refuses"} ${name}`, async () => {
      const server = new InMemoryServer();
      expect(await commitKind(server, "first", first)).toBe("ok");
      expect(await commitKind(server, "second", second)).toBe(want);
    });
  }

  it("refuses a folder with content", async () => {
    const server = new InMemoryServer();
    const content = encoder.encode("content");
    server.commit({ documentId: "blob-holder", path: "blob", content });
    const api = createProtocolClient({ transport: server.transport });
    await expect(
      api.sync.commitRevision({
        vaultId: server.vaultId,
        documentId: "folder",
        revisionId: "folder-1",
        baseRevId: "",
        kind: DocumentKind.FOLDER,
        contentRef: { blobId: hexToBytes(sha256Hex(content)), size: BigInt(content.length) },
        path: encoder.encode("p"),
        deleted: false,
        deviceId: "device",
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
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
    // A colon anywhere else is not a portable name either (engine.md §6).
    expect(await commit(server, "z", "z1", "", "12:x.md")).toBe("InvalidArgument");
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

  it("creates a document at a name of exactly 255 bytes and a path of exactly 1024 bytes, and at no longer one (engine.md §6)", async () => {
    const server = new InMemoryServer();
    expect(await commit(server, "a", "a1", "", "é".repeat(127) + "a")).toBe("ok");
    expect(await commit(server, "b", "b1", "", "é".repeat(128))).toBe("InvalidArgument");
    expect(await commit(server, "c", "c1", "", `${"c".repeat(254)}/`.repeat(4) + "abcd")).toBe("ok");
    expect(await commit(server, "d", "d1", "", `${"d".repeat(254)}/`.repeat(4) + "abcde")).toBe("InvalidArgument");
  });

  it("refuses to create or rename a document into a path that is not in NFC, and keeps one already there (engine.md §6)", async () => {
    const server = new InMemoryServer();
    expect(await commit(server, "a", "a1", "", "Cafe\u0301.md")).toBe("InvalidArgument");
    expect(await commit(server, "a", "a1", "", "Caf\u00e9.md")).toBe("ok");
    expect(await commit(server, "a", "a2", "a1", "Re\u0301sume\u0301/Caf\u00e9.md")).toBe("InvalidArgument");
    const kept = server.commit({ documentId: "kept", path: "Ole\u0301.md", content: "kept" });
    expect(await commit(server, "kept", "kept2", kept.id, "Ole\u0301.md")).toBe("ok");
  });

  // U+1D160 decomposes into three 4-byte code points (testdata/paths/key.json). Only a
  // document kept at a path from before the 1024-byte limit can reach the normalized limit.
  it("refuses an edit in place of a path longer than 8192 bytes once normalized, and accepts one of exactly 8192", async () => {
    const server = new InMemoryServer();
    const over = "\u{1d160}".repeat(682) + "a".repeat(9);
    const exact = "\u{1d160}".repeat(682) + "a".repeat(8);
    const overHead = server.commit({ documentId: "over", path: over, content: "over" });
    const exactHead = server.commit({ documentId: "exact", path: exact, content: "exact" });
    expect(await commit(server, "over", "over2", overHead.id, over)).toBe("InvalidArgument");
    expect(await commit(server, "exact", "exact2", exactHead.id, exact)).toBe("ok");
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

describe("InMemoryServer's RenameDevice", () => {
  /** Renames `deviceId` to `name`; returns the error code, or "ok". */
  async function rename(server: InMemoryServer, deviceId: string, name: string): Promise<string> {
    const client = createClient(DeviceService, server.transport);
    try {
      const response = await client.renameDevice({ deviceId, name });
      expect(response.device?.id).toBe(deviceId);
      expect(response.device?.name).toBe(name);
      return "ok";
    } catch (error) {
      return Code[ConnectError.from(error).code];
    }
  }

  it("renames a registered device, which history then names by its new name", async () => {
    const server = new InMemoryServer();
    server.deviceNames.set("laptop", "Laptop");
    expect(await rename(server, "laptop", "Work laptop")).toBe("ok");
    expect(server.deviceNames.get("laptop")).toBe("Work laptop");
  });

  it("answers NOT_FOUND for an unknown device", async () => {
    const server = new InMemoryServer();
    expect(await rename(server, "phone", "Phone")).toBe("NotFound");
    expect(server.deviceNames.has("phone")).toBe(false);
  });

  it("refuses a name RegisterDevice would refuse, at exactly 256 and 257 bytes", async () => {
    const server = new InMemoryServer();
    server.deviceNames.set("laptop", "Laptop");
    expect(await rename(server, "laptop", "a".repeat(256))).toBe("ok");
    for (const name of ["a".repeat(257), "é".repeat(128) + "a", "", "  ", "Lap\u0000top", "Lap​top", "Lap top", "Lap top"]) {
      expect(await rename(server, "laptop", name)).toBe("InvalidArgument");
    }
    expect(server.deviceNames.get("laptop")).toBe("a".repeat(256));
  });
});
