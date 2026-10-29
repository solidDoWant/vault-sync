/**
 * The associated data of encrypted paths and contents (docs/design/crypto.md,
 * "Associated data of contents and paths"): a path binds the vault, the
 * document and the revision's epoch; content binds the vault and the epoch
 * only, so two documents with equal content share one blob.
 */
import { epochBytes, uuidBytes } from "./keyslot";

const encoder = new TextEncoder();
const PATH_LABEL = encoder.encode("vault-sync/v1/path");
const CONTENT_LABEL = encoder.encode("vault-sync/v1/content");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `"vault-sync/v1/path" || vault_id (16) || document_id (16) || epoch (u64)`. */
export function pathAad(vaultId: string, documentId: string, epoch: number): Uint8Array {
  return concat(PATH_LABEL, uuidBytes("vault id", vaultId), uuidBytes("document id", documentId), epochBytes(epoch));
}

/** `"vault-sync/v1/content" || vault_id (16) || epoch (u64)`. */
export function contentAad(vaultId: string, epoch: number): Uint8Array {
  return concat(CONTENT_LABEL, uuidBytes("vault id", vaultId), epochBytes(epoch));
}
