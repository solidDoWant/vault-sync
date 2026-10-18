import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import type { DocumentKindName, RemoteRevision } from "../journal/journal";
import type { ProtocolClient } from "../protocol/client";
import { isVaultRelativePath } from "../vaultpath/vaultpath";

/** The protocol calls the pull side uses. */
export type PullApi = Pick<ProtocolClient, "sync" | "blobs">;

/** The server sent something the protocol does not allow, or content that does not match its hash. */
export class RemoteContentError extends Error {
  override readonly name = "RemoteContentError";
}

/** A revision from the change feed plus whether its path may touch the disk. */
export interface IncomingRevision {
  remote: RemoteRevision;
  /** The path is valid UTF-8 and vault-relative (SPEC.md §6.2); otherwise it must never reach the vault. */
  pathAllowed: boolean;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder("utf-8");

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
    },
    pathAllowed: decodable && isVaultRelativePath(path),
  };
}

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

/** Fetches a revision's content by revision id (the merge base, SPEC.md §8). */
export async function revisionContent(api: PullApi, vaultId: string, revisionId: string): Promise<Uint8Array> {
  const revision = (await api.sync.getRevision({ vaultId, revisionId })).revision;
  if (revision?.contentRef === undefined) throw new RemoteContentError(`revision ${revisionId} has no content`);
  return downloadContent(api, vaultId, bytesToHex(revision.contentRef.blobId), revision.contentRef.size);
}
