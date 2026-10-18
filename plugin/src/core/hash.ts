import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Lowercase hex SHA-256 of `data`: the content hash used for change detection
 * (SPEC.md §8) and, for plaintext vaults, the blob id (SPEC.md §5). Uses
 * @noble/hashes rather than Node's crypto so it runs on Android WebView.
 */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
