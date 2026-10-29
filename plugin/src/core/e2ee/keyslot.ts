/**
 * Key slots and key commitments of vault key epochs (SPEC.md §9.3, byte
 * formats in docs/design/crypto.md): an epoch key wrapped to a recipient's
 * hybrid ML-KEM-768 + X25519 public key as an age file that binds the vault,
 * the epoch and the recipient, and the HMAC-SHA256 commitment every epoch stores so that a
 * recipient can check the key it unwrapped. The Go implementation
 * (internal/e2ee) must agree with testdata/crypto/vectors.json.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { DecryptError, KEY_SIZE } from "./e2ee";
import { openFrom, sealTo } from "./hybrid";

/** Who a key slot is wrapped to (SPEC.md §5 key_slots). */
export type RecipientKind = "user" | "escrow";

/**
 * A key slot: the epoch key of vault `vaultId` at `epoch`, wrapped to a
 * recipient. `vaultId` is a canonical lowercase UUID; `recipientId` is the
 * user's id (a canonical lowercase UUID) for "user" and the escrow key's id
 * (1 to 255 UTF-8 bytes) for "escrow". `epoch` is a non-negative safe
 * integer.
 */
export interface KeySlot {
  vaultId: string;
  epoch: number;
  recipientKind: RecipientKind;
  recipientId: string;
}

/** The largest encoded recipient id of a key slot (its length is one byte). */
export const MAX_RECIPIENT_ID_SIZE = 255;

const KEY_SLOT_LABEL = "vault-sync/v1/key-slot";
const KEY_COMMITMENT_LABEL = "vault-sync/v1/key-commitment";
const RECIPIENT_KIND_BYTES: Readonly<Record<RecipientKind, number>> = Object.freeze({ user: 0x01, escrow: 0x02 });

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const encoder = new TextEncoder();

/** Thrown when an epoch key does not match its epoch's key commitment. */
export class KeyCommitmentError extends Error {
  constructor() {
    super("e2ee: epoch key does not match the key commitment");
    this.name = "KeyCommitmentError";
  }
}

export function uuidBytes(name: string, value: string): Uint8Array {
  if (!CANONICAL_UUID.test(value)) {
    throw new Error(`e2ee: ${name} ${JSON.stringify(value)} is not a canonical lowercase UUID`);
  }
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function epochBytes(epoch: number): Uint8Array {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`e2ee: epoch must be a non-negative safe integer, got ${String(epoch)}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(epoch));
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function recipientIdBytes(slot: KeySlot): Uint8Array {
  switch (slot.recipientKind) {
    case "user":
      return uuidBytes("recipient id", slot.recipientId);
    case "escrow": {
      const id = encoder.encode(slot.recipientId);
      if (LONE_SURROGATE.test(slot.recipientId) || id.length === 0 || id.length > MAX_RECIPIENT_ID_SIZE) {
        throw new Error(`e2ee: escrow recipient id must be 1 to ${String(MAX_RECIPIENT_ID_SIZE)} bytes of UTF-8`);
      }
      return id;
    }
    default:
      throw new Error(`e2ee: unknown recipient kind ${JSON.stringify(slot.recipientKind)}`);
  }
}

/**
 * The associated data a key slot binds:
 *
 *     "vault-sync/v1/key-slot" || vault_id (16) || epoch (u64 BE) ||
 *     recipient_kind (u8: 0x01 user, 0x02 escrow) || len(recipient_id) (u8) || recipient_id
 *
 * with `vault_id` and a user's `recipient_id` as their 16 UUID bytes and an
 * escrow `recipient_id` as its UTF-8 bytes. Throws for ids that are not in
 * canonical form, so one slot has exactly one encoding.
 */
export function keySlotAd(slot: KeySlot): Uint8Array {
  const vaultId = uuidBytes("vault id", slot.vaultId);
  const epoch = epochBytes(slot.epoch);
  const recipientId = recipientIdBytes(slot);
  return concat(encoder.encode(KEY_SLOT_LABEL), vaultId, epoch, Uint8Array.of(RECIPIENT_KIND_BYTES[slot.recipientKind], recipientId.length), recipientId);
}

/**
 * Wraps a 32-byte epoch key to a recipient's hybrid public key: an age file
 * to the recipient ({@link sealTo}) whose payload is the epoch key followed by
 * the slot's associated data ({@link keySlotAd}). The standard age tool opens
 * it with the recipient's identity; the first 32 bytes it prints are the
 * epoch key.
 */
export async function sealKeySlot(recipientPublicKey: Uint8Array, epochKey: Uint8Array, slot: KeySlot): Promise<Uint8Array> {
  if (epochKey.length !== KEY_SIZE) {
    throw new Error(`e2ee: epoch key must be ${String(KEY_SIZE)} bytes, got ${String(epochKey.length)}`);
  }
  return sealTo(recipientPublicKey, concat(epochKey, keySlotAd(slot)));
}

/**
 * Reverses {@link sealKeySlot} with the recipient's hybrid private key.
 * Throws {@link DecryptError} unless `wrapped` is an age file to this key
 * whose payload is a 32-byte key followed by exactly this slot's associated
 * data (vault, epoch, recipient kind and recipient id). The caller then
 * checks the key against the epoch's commitment ({@link verifyKeyCommitment}).
 */
export async function openKeySlot(recipientPrivateKey: Uint8Array, wrapped: Uint8Array, slot: KeySlot): Promise<Uint8Array> {
  const ad = keySlotAd(slot);
  const payload = await openFrom(recipientPrivateKey, wrapped);
  if (payload.length !== KEY_SIZE + ad.length || !equalBytes(payload.subarray(KEY_SIZE), ad)) {
    throw new DecryptError();
  }
  return payload.slice(0, KEY_SIZE);
}

/**
 * The key commitment of an epoch: HMAC-SHA256(epoch_key,
 * "vault-sync/v1/key-commitment" || vault_id (16) || epoch (u64 BE)).
 */
export function keyCommitment(epochKey: Uint8Array, vaultId: string, epoch: number): Uint8Array {
  if (epochKey.length !== KEY_SIZE) {
    throw new Error(`e2ee: epoch key must be ${String(KEY_SIZE)} bytes, got ${String(epochKey.length)}`);
  }
  return hmac(sha256, epochKey, concat(encoder.encode(KEY_COMMITMENT_LABEL), uuidBytes("vault id", vaultId), epochBytes(epoch)));
}

/**
 * Checks in constant time that `epochKey` is the key the commitment of the
 * vault's epoch was computed from; throws {@link KeyCommitmentError}
 * otherwise (including for a key or commitment of the wrong size).
 */
export function verifyKeyCommitment(epochKey: Uint8Array, commitment: Uint8Array, vaultId: string, epoch: number): void {
  if (epochKey.length !== KEY_SIZE) {
    throw new KeyCommitmentError();
  }
  const expected = keyCommitment(epochKey, vaultId, epoch);
  if (expected.length !== commitment.length) {
    throw new KeyCommitmentError();
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= (expected[index] ?? 0) ^ (commitment[index] ?? 0);
  }
  if (difference !== 0) {
    throw new KeyCommitmentError();
  }
}
