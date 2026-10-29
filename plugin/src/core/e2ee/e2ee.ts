/**
 * End-to-end encryption primitives of SPEC.md §9.3, cipher suite 2:
 * HKDF-SHA256 sub-keys, XChaCha20-Poly1305 with associated data, HMAC-SHA256
 * path_key and blob_id, and Argon2id passphrase wrapping. The hybrid
 * post-quantum key wrapping of key slots is in hybrid.ts.
 *
 * Every symmetric ciphertext starts with its suite version byte, and every open
 * authenticates the whole header together with the caller's associated data,
 * so a ciphertext with an unknown suite, a changed header or associated data,
 * or a truncated tag fails closed with {@link DecryptError}. The formats are
 * described in docs/design/crypto.md; testdata/crypto/vectors.json pins them,
 * and the Go implementation (internal/e2ee) must agree with it.
 *
 * Pure JavaScript (@noble/*), so it behaves the same on Electron and Android
 * WebView. Random bytes come from `crypto.getRandomValues`. The Argon2id
 * derivation is asynchronous and yields to the event loop every few
 * milliseconds, so a passphrase unlock does not freeze the UI.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { nfc } from "../pathkey/normalize";
import { pathKey as normalizePath } from "../pathkey/pathkey";

/** The suite version byte of every suite 2 symmetric ciphertext and passphrase-wrapped secret. */
export const SUITE_V2 = 0x02;
/** The size of every symmetric key and sub-key. */
export const KEY_SIZE = 32;
/** The XChaCha20-Poly1305 nonce size. */
export const NONCE_SIZE = 24;
/** The Poly1305 tag size. */
export const TAG_SIZE = 16;
/** The Argon2id salt size of a passphrase-wrapped secret. */
export const SALT_SIZE = 16;

const PASSPHRASE_HEADER_SIZE = 1 + 4 + 4 + 1 + SALT_SIZE;

const SUBKEY_INFO_PREFIX = "vault-sync/v1/subkey/";
const PASSPHRASE_WRAP_INFO = "vault-sync/v1/passphrase/wrap";
const PASSPHRASE_AUTH_INFO = "vault-sync/v1/passphrase/auth";

/**
 * How long (ms) the Argon2id derivation computes before it yields to the
 * event loop.
 */
const ARGON2_ASYNC_TICK_MS = 10;

const encoder = new TextEncoder();

/**
 * Thrown for every ciphertext that does not open: unknown suite, malformed or
 * short input, or a failed authentication. The causes are deliberately not
 * told apart.
 */
export class DecryptError extends Error {
  constructor() {
    super("e2ee: ciphertext does not authenticate");
    this.name = "DecryptError";
  }
}

/** The HKDF sub-keys of a vault epoch key (SPEC.md §9.3). */
export const SUBKEY_LABELS = ["content", "path", "path_key_secret", "blob_id_secret"] as const;
export type SubkeyLabel = (typeof SUBKEY_LABELS)[number];

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`e2ee: ${name} must be ${String(length)} bytes, got ${String(value.length)}`);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Derives the sub-key named by `label` from a 32-byte epoch key: HKDF-SHA256
 * with an empty salt and the info "vault-sync/v1/subkey/" + label.
 */
export function deriveSubkey(epochKey: Uint8Array, label: SubkeyLabel): Uint8Array {
  requireLength("epoch key", epochKey, KEY_SIZE);
  if (!(SUBKEY_LABELS as readonly string[]).includes(label)) {
    throw new Error(`e2ee: unknown sub-key label ${JSON.stringify(label)}`);
  }
  return hkdf(sha256, epochKey, new Uint8Array(0), encoder.encode(SUBKEY_INFO_PREFIX + label), KEY_SIZE);
}

/** Returns header || nonce || ciphertext, authenticating header || aad. */
function sealAfterHeader(
  header: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  requireLength("key", key, KEY_SIZE);
  requireLength("nonce", nonce, NONCE_SIZE);
  return concat(header, nonce, xchacha20poly1305(key, nonce, concat(header, aad)).encrypt(plaintext));
}

/** Opens nonce || ciphertext, authenticating header || aad. */
function openAfterHeader(header: Uint8Array, key: Uint8Array, rest: Uint8Array, aad: Uint8Array): Uint8Array {
  requireLength("key", key, KEY_SIZE);
  if (rest.length < NONCE_SIZE + TAG_SIZE) {
    throw new DecryptError();
  }
  try {
    return xchacha20poly1305(key, rest.subarray(0, NONCE_SIZE), concat(header, aad)).decrypt(rest.subarray(NONCE_SIZE));
  } catch {
    throw new DecryptError();
  }
}

/**
 * Encrypts `plaintext` under a 32-byte key with a fresh random nonce and binds
 * `aad`: SUITE_V2 || nonce || XChaCha20-Poly1305(plaintext), the associated
 * data being SUITE_V2 || aad.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return sealWithNonce(key, randomBytes(NONCE_SIZE), plaintext, aad);
}

/**
 * {@link seal} with a given nonce. Only for the shared test vectors: a nonce
 * must never be used twice with one key.
 */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return sealAfterHeader(Uint8Array.of(SUITE_V2), key, nonce, plaintext, aad);
}

/**
 * Reverses {@link seal}. Throws {@link DecryptError} unless `sealed` is a suite
 * 2 ciphertext under `key` with exactly this `aad`.
 */
export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  if (sealed.length < 1 || sealed[0] !== SUITE_V2) {
    throw new DecryptError();
  }
  return openAfterHeader(sealed.subarray(0, 1), key, sealed.subarray(1), aad);
}

/** Returns a new random 32-byte symmetric key (an epoch key). */
export function generateKey(): Uint8Array {
  return randomBytes(KEY_SIZE);
}

function mac(secret: Uint8Array, data: Uint8Array): Uint8Array {
  requireLength("secret", secret, KEY_SIZE);
  return hmac(sha256, secret, data);
}

/**
 * The E2EE path_key of a path (SPEC.md §5): HMAC-SHA256(path_key_secret,
 * UTF-8 of the normalized path).
 */
export function pathKey(pathKeySecret: Uint8Array, path: string): Uint8Array {
  return mac(pathKeySecret, encoder.encode(normalizePath(path)));
}

/** The E2EE blob_id of a plaintext (SPEC.md §5): HMAC-SHA256(blob_id_secret, plaintext). */
export function blobId(blobIdSecret: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return mac(blobIdSecret, plaintext);
}

/** The Argon2id parameters of a passphrase-wrapped secret. */
export interface Argon2Params {
  /** Memory cost in KiB. */
  memory: number;
  /** Time cost. */
  iterations: number;
  /** Number of lanes. */
  parallelism: number;
}

/**
 * The parameters {@link wrapWithPassphrase} uses by default: 64 MiB, three
 * passes, one lane. Measurements are in docs/design/crypto.md.
 */
export const DEFAULT_ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({ memory: 64 * 1024, iterations: 3, parallelism: 1 });

/**
 * The bounds of the Argon2id parameters a passphrase-wrapped secret may
 * carry. The upper bounds keep a hostile stored value from making a phone
 * allocate or compute without limit; the lower bounds refuse parameters weaker
 * than OWASP's minimum for Argon2id.
 */
export const ARGON2_BOUNDS = Object.freeze({
  minMemory: 19 * 1024,
  maxMemory: 128 * 1024,
  minIterations: 2,
  maxIterations: 8,
  minParallelism: 1,
  maxParallelism: 4,
});

function validParams(params: Argon2Params): boolean {
  const inRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  return (
    inRange(params.memory, ARGON2_BOUNDS.minMemory, ARGON2_BOUNDS.maxMemory) &&
    inRange(params.iterations, ARGON2_BOUNDS.minIterations, ARGON2_BOUNDS.maxIterations) &&
    inRange(params.parallelism, ARGON2_BOUNDS.minParallelism, ARGON2_BOUNDS.maxParallelism)
  );
}

/**
 * The two keys derived from a passphrase (SPEC.md §9.3). `wrapKey` encrypts
 * the wrapped secret and never leaves the device; `authKey` is the verifier
 * the device presents to the server to have the wrapped secret released. Both
 * are HKDF-SHA256 expansions of the same Argon2id output under different info
 * labels, so neither can be computed from the other: the server, which learns
 * `authKey`, cannot unwrap the secret with it.
 */
export interface PassphraseKeys {
  wrapKey: Uint8Array;
  authKey: Uint8Array;
}

/**
 * Derives the wrap and auth keys of `passphrase`: stretched =
 * Argon2id(UTF-8(NFC(passphrase)), salt, params, 32), then
 * HKDF-SHA256(stretched, empty salt, info) with the info
 * "vault-sync/v1/passphrase/wrap" and "vault-sync/v1/passphrase/auth". The
 * passphrase is NFC-normalized with the pinned Unicode tables of ../pathkey
 * (not the runtime's), so every device derives the same keys from the same
 * characters. Rejects an empty passphrase, a salt of the wrong size and
 * parameters outside the bounds before deriving. The derivation yields to the
 * event loop as it runs.
 */
export async function derivePassphraseKeys(passphrase: string, params: Argon2Params, salt: Uint8Array): Promise<PassphraseKeys> {
  if (passphrase === "") {
    throw new Error("e2ee: passphrase is empty");
  }
  if (!validParams(params)) {
    throw new Error(`e2ee: Argon2id parameters out of bounds: ${JSON.stringify(params)}`);
  }
  requireLength("salt", salt, SALT_SIZE);
  const stretched = await argon2idAsync(encoder.encode(nfc(passphrase)), salt, {
    m: params.memory,
    t: params.iterations,
    p: params.parallelism,
    dkLen: KEY_SIZE,
    asyncTick: ARGON2_ASYNC_TICK_MS,
  });
  const empty = new Uint8Array(0);
  return {
    wrapKey: hkdf(sha256, stretched, empty, encoder.encode(PASSPHRASE_WRAP_INFO), KEY_SIZE),
    authKey: hkdf(sha256, stretched, empty, encoder.encode(PASSPHRASE_AUTH_INFO), KEY_SIZE),
  };
}

/**
 * Encrypts `secret` (a user's hybrid private key) under the wrap key of
 * `passphrase` ({@link derivePassphraseKeys}) with a fresh salt and binds
 * `aad`: SUITE_V2 || memory (u32 BE) || iterations (u32 BE) || parallelism
 * (u8) || salt (16) || nonce || ciphertext, the associated data being the
 * header || aad. Also returns the auth key, for the server's verifier.
 */
export async function wrapWithPassphrase(
  passphrase: string,
  secret: Uint8Array,
  aad: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<{ wrapped: Uint8Array; authKey: Uint8Array }> {
  const { wrapped, keys } = await wrapWith(passphrase, params, randomBytes(SALT_SIZE), randomBytes(NONCE_SIZE), secret, aad);
  return { wrapped, authKey: keys.authKey };
}

/**
 * {@link wrapWithPassphrase} with a given salt and nonce, also returning both
 * keys. Only for the shared test vectors.
 */
export async function wrapWith(
  passphrase: string,
  params: Argon2Params,
  salt: Uint8Array,
  nonce: Uint8Array,
  secret: Uint8Array,
  aad: Uint8Array,
): Promise<{ wrapped: Uint8Array; keys: PassphraseKeys }> {
  const keys = await derivePassphraseKeys(passphrase, params, salt);
  const header = new Uint8Array(PASSPHRASE_HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[0] = SUITE_V2;
  view.setUint32(1, params.memory);
  view.setUint32(5, params.iterations);
  header[9] = params.parallelism;
  header.set(salt, 10);
  return { wrapped: sealAfterHeader(header, keys.wrapKey, nonce, secret, aad), keys };
}

/**
 * Returns the Argon2id parameters and salt from the header of a
 * passphrase-wrapped secret (at least its first 26 bytes), so a device can
 * derive its keys before it holds the wrapped secret. Throws
 * {@link DecryptError} for an unknown suite, a short header or parameters
 * outside the bounds.
 */
export function parsePassphraseHeader(wrapped: Uint8Array): { params: Argon2Params; salt: Uint8Array } {
  if (wrapped.length < PASSPHRASE_HEADER_SIZE || wrapped[0] !== SUITE_V2) {
    throw new DecryptError();
  }
  const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
  const params: Argon2Params = {
    memory: view.getUint32(1),
    iterations: view.getUint32(5),
    parallelism: view.getUint8(9),
  };
  if (!validParams(params)) {
    throw new DecryptError();
  }
  return { params, salt: wrapped.slice(10, PASSPHRASE_HEADER_SIZE) };
}

/**
 * Reverses {@link wrapWithPassphrase}. Rejects with {@link DecryptError} for a
 * wrong passphrase, a different `aad`, an unknown suite, a changed header, or
 * Argon2id parameters outside the bounds, which it refuses before deriving.
 */
export async function unwrapWithPassphrase(passphrase: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  // Refuse what cannot open before paying for the derivation.
  if (wrapped.length < PASSPHRASE_HEADER_SIZE + NONCE_SIZE + TAG_SIZE) {
    throw new DecryptError();
  }
  const { params, salt } = parsePassphraseHeader(wrapped);
  let keys: PassphraseKeys;
  try {
    keys = await derivePassphraseKeys(passphrase, params, salt);
  } catch {
    throw new DecryptError();
  }
  return unwrapWithKey(keys.wrapKey, wrapped, aad);
}

/**
 * Opens a passphrase-wrapped secret with a wrap key already derived by
 * {@link derivePassphraseKeys} from its header's parameters and salt. Throws
 * {@link DecryptError} as {@link unwrapWithPassphrase} does.
 */
export function unwrapWithKey(wrapKey: Uint8Array, wrapped: Uint8Array, aad: Uint8Array): Uint8Array {
  parsePassphraseHeader(wrapped);
  return openAfterHeader(
    wrapped.subarray(0, PASSPHRASE_HEADER_SIZE),
    wrapKey,
    wrapped.subarray(PASSPHRASE_HEADER_SIZE),
    aad,
  );
}
