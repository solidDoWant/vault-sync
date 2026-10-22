import { Code } from "@connectrpc/connect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import type { DocumentKindName, RemoteRevision } from "../journal/journal";
import type { ProtocolClient } from "../protocol/client";
import { isPathText, isVaultRelativePath } from "../vaultpath/vaultpath";
import { errorCode } from "./errors";

/** The protocol calls the engine uses, to pull and to push. */
export type PullApi = Pick<ProtocolClient, "sync" | "blobs">;

/** The server sent something the protocol does not allow, or content that does not match its hash. */
export class RemoteContentError extends Error {
  override readonly name = "RemoteContentError";
}

/** A revision from the change feed plus whether its path may touch the disk. */
export interface IncomingRevision {
  remote: RemoteRevision;
  /** The path is valid UTF-8, within the length and character-set rule, and vault-relative (SPEC.md §6.2); otherwise it must never reach the vault. */
  pathAllowed: boolean;
  /**
   * The revision's anchor (SPEC.md §6.1), when the server sends one. An own
   * commit that this revision acknowledges records it (design §4.6, #892).
   */
  anchor?: Uint8Array;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder("utf-8");

/** Length of a Revision.anchor (SPEC.md §6.1). */
const anchorBytes = 16;

/** Converts a protobuf revision (plaintext vault) into journal form. */
export function toIncoming(revision: Revision): IncomingRevision {
  let path: string;
  let decodable = true;
  try {
    path = strictDecoder.decode(revision.path);
  } catch {
    path = lenientDecoder.decode(revision.path);
    decodable = false;
  }
  return {
    remote: {
      revisionId: revision.id,
      documentId: revision.documentId,
      seq: revision.seq,
      parentRevisionId: revision.parentRevId,
      kind: kindName(revision.kind),
      path,
      deleted: revision.deleted,
      contentHash: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
      size: revision.contentRef?.size ?? 0n,
      deviceId: revision.deviceId,
    },
    pathAllowed: decodable && isPathText(path) && isVaultRelativePath(path),
    ...(revision.anchor.length === anchorBytes ? { anchor: revision.anchor } : {}),
  };
}

/** The protobuf form of a document kind. */
export function kindValue(kind: DocumentKindName): DocumentKind {
  switch (kind) {
    case "text":
      return DocumentKind.TEXT;
    case "yjs":
      return DocumentKind.YJS;
    case "blob":
      return DocumentKind.BLOB;
  }
}

/** Extensions (without the dot, lower case) classified as `text` by default (SPEC.md §7); everything else is a `blob`. */
export const defaultTextExtensions: readonly string[] = ["md", "txt", "css", "js"];

/**
 * A classification of new documents by extension (SPEC.md §7): `text` for
 * the given extensions (without the dot, compared case-insensitively), which
 * then get three-way merges, `blob` for everything else, whose concurrent
 * edits become conflict copies. Pass it as the engine's `classify` option. A
 * document keeps the kind it was created with.
 */
export function classifyByExtensions(textExtensions: Iterable<string>): (path: string) => DocumentKindName {
  const extensions = new Set([...textExtensions].map((extension) => extension.replace(/^\./, "").toLowerCase()));
  return (path) => {
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return "blob";
    return extensions.has(name.slice(dot + 1).toLowerCase()) ? "text" : "blob";
  };
}

/** The default classification of a new document by its path's extension (SPEC.md §7). */
export const classifyByExtension: (path: string) => DocumentKindName = classifyByExtensions(defaultTextExtensions);

function kindName(kind: DocumentKind): DocumentKindName {
  switch (kind) {
    case DocumentKind.TEXT:
      return "text";
    case DocumentKind.YJS:
      return "yjs";
    default:
      return "blob";
  }
}

/**
 * Downloads a blob with ranged DownloadBlob calls (SPEC.md §6.2) and verifies
 * its size and, for plaintext vaults, that its SHA-256 is the blob id (§5).
 */
export async function downloadContent(api: PullApi, vaultId: string, contentHash: string, size: bigint): Promise<Uint8Array> {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RemoteContentError(`blob ${contentHash} is too large to hold`);
  const total = Number(size);
  const content = new Uint8Array(total);
  const blobId = hexToBytes(contentHash);
  let offset = 0;
  while (offset < total) {
    const response = await api.blobs.downloadBlob({ vaultId, blobId, offset: BigInt(offset), length: 0 });
    if (response.size !== size) throw new RemoteContentError(`blob ${contentHash} has size ${String(response.size)}, expected ${String(size)}`);
    if (response.data.length === 0 || offset + response.data.length > total) {
      throw new RemoteContentError(`blob ${contentHash} returned ${String(response.data.length)} bytes at offset ${String(offset)} of ${String(total)}`);
    }
    content.set(response.data, offset);
    offset += response.data.length;
  }
  if (sha256Hex(content) !== contentHash) throw new RemoteContentError(`blob ${contentHash} does not match its content hash`);
  return content;
}

/**
 * The first `limit` bytes of a blob of `size` bytes, in ranges, for a
 * preview only: a part of the content cannot be checked against its hash,
 * so it must never be written or uploaded.
 */
export async function downloadStart(api: PullApi, vaultId: string, contentHash: string, size: bigint, limit: number): Promise<Uint8Array> {
  const total = Math.min(limit, Number(size));
  const content = new Uint8Array(total);
  const blobId = hexToBytes(contentHash);
  let offset = 0;
  while (offset < total) {
    const response = await api.blobs.downloadBlob({ vaultId, blobId, offset: BigInt(offset), length: total - offset });
    if (response.size !== size) throw new RemoteContentError(`blob ${contentHash} has size ${String(response.size)}, expected ${String(size)}`);
    if (response.data.length === 0 || offset + response.data.length > total) {
      throw new RemoteContentError(`blob ${contentHash} returned ${String(response.data.length)} bytes at offset ${String(offset)} of ${String(total)}`);
    }
    content.set(response.data, offset);
    offset += response.data.length;
  }
  return content;
}

/** Fetches a revision's content by revision id (the merge base, SPEC.md §8). */
export async function revisionContent(api: PullApi, vaultId: string, revisionId: string): Promise<Uint8Array> {
  const revision = (await api.sync.getRevision({ vaultId, revisionId })).revision;
  if (revision?.contentRef === undefined) throw new RemoteContentError(`revision ${revisionId} has no content`);
  return downloadContent(api, vaultId, bytesToHex(revision.contentRef.blobId), revision.contentRef.size);
}

/**
 * The merge base's content (SPEC.md §8), or null if retention purged the
 * revision or its blob is gone (NOT_FOUND from GetRevision or DownloadBlob,
 * §11): the two versions then have no common base. Any other failure is
 * thrown.
 */
export async function baseContent(api: PullApi, vaultId: string, revisionId: string): Promise<Uint8Array | null> {
  try {
    return await revisionContent(api, vaultId, revisionId);
  } catch (error) {
    if (errorCode(error) === Code.NotFound) return null;
    throw error;
  }
}
