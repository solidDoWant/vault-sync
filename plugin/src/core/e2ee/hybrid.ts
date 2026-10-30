/**
 * Hybrid post-quantum key wrapping of cipher suite 2 (docs/design/crypto.md):
 * ML-KEM-768 + X25519 in age's format. A private key is the 32-byte seed of
 * an MLKEM768-X25519 key pair (an age identity AGE-SECRET-KEY-PQ-1…), its
 * public key the 1216-byte MLKEM768-X25519 public key (an age recipient
 * age1pq1…), and a sealed value is a binary age file with one
 * mlkem768x25519 recipient stanza, which the standard age tool opens.
 *
 * Built on age-encryption (typage), the TypeScript age implementation, over
 * the same @noble/* packages as the rest of this module; the Go
 * implementation (internal/e2ee) uses filippo.io/age.
 */
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { bech32 } from "@scure/base";
import { Decrypter, Encrypter } from "age-encryption";

import { DecryptError } from "./e2ee";

/** The size of a hybrid private key (the MLKEM768-X25519 seed). */
export const PRIVATE_KEY_SIZE = 32;
/** The size of a hybrid public key: ML-KEM-768 (1184 bytes) then X25519 (32 bytes). */
export const PUBLIC_KEY_SIZE = 1184 + 32;
/** The largest age file {@link openFrom} accepts. */
export const MAX_SEALED_SIZE = 2048;

const AGE_RECIPIENT_HRP = "age1pq";
const AGE_IDENTITY_HRP = "AGE-SECRET-KEY-PQ-";

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`e2ee: ${name} must be ${String(length)} bytes, got ${String(value.length)}`);
  }
}

/** Returns a new hybrid ML-KEM-768 + X25519 key pair. */
export function generateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = randomBytes(PRIVATE_KEY_SIZE);
  return { privateKey, publicKey: publicKey(privateKey) };
}

/** Returns the hybrid public key of a 32-byte private key. */
export function publicKey(privateKey: Uint8Array): Uint8Array {
  requireLength("private key", privateKey, PRIVATE_KEY_SIZE);
  return ml_kem768_x25519.keygen(privateKey).publicKey;
}

/** The age recipient string (age1pq1…) of a hybrid public key. */
export function ageRecipient(publicKey: Uint8Array): string {
  requireLength("public key", publicKey, PUBLIC_KEY_SIZE);
  // Without bech32's 90-character limit, as age does.
  return bech32.encode(AGE_RECIPIENT_HRP, bech32.toWords(publicKey), false);
}

/** The age identity string (AGE-SECRET-KEY-PQ-1…) of a hybrid private key. */
export function ageIdentity(privateKey: Uint8Array): string {
  requireLength("private key", privateKey, PRIVATE_KEY_SIZE);
  return bech32.encodeFromBytes(AGE_IDENTITY_HRP, privateKey).toUpperCase();
}

/**
 * Encrypts `plaintext` to a hybrid public key as a binary age file with a
 * single mlkem768x25519 recipient stanza.
 */
export async function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(ageRecipient(recipientPublicKey));
  return encrypter.encrypt(plaintext);
}

/**
 * Reverses {@link sealTo} with the recipient's hybrid private key. Throws
 * {@link DecryptError} for every input that is not a well-formed age file to
 * this key of at most {@link MAX_SEALED_SIZE} bytes.
 */
export async function openFrom(recipientPrivateKey: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(ageIdentity(recipientPrivateKey));
  if (sealed.length === 0 || sealed.length > MAX_SEALED_SIZE) {
    throw new DecryptError();
  }
  try {
    return await decrypter.decrypt(sealed);
  } catch {
    throw new DecryptError();
  }
}
