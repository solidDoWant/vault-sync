/**
 * Identity keys of docs/design/crypto.md "Identity keys, the membership log
 * and signed epochs": the user secret (hybrid KEM seed and Ed25519 signing
 * seed), user key bundles and fingerprints, invitation signing keys, invite
 * anchors, the sealed anchor list, escrow bundles and escrow rotation
 * statements. Ed25519 is @noble/curves; the Go implementation
 * (internal/e2ee) must agree with testdata/crypto/vectors.json.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { equalBytes, randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32crockford, bech32 } from "@scure/base";

import { DecryptError, KEY_SIZE, NONCE_SIZE, open, sealWithNonce } from "./e2ee";
import { PRIVATE_KEY_SIZE, PUBLIC_KEY_SIZE, publicKey } from "./hybrid";
import { concat, uuidBytes } from "./keyslot";

/** The size of a user secret: kem_seed (32) || sign_seed (32). */
export const USER_SECRET_SIZE = PRIVATE_KEY_SIZE + 32;
/** The size of an Ed25519 public key. */
export const SIGN_PUBLIC_KEY_SIZE = 32;
/** The size of an Ed25519 signature. */
export const SIGNATURE_SIZE = 64;
/** The size of a fingerprint, an entry hash and a genesis hash. */
export const HASH_SIZE = 32;
/** The largest age recipient string of an escrow bundle. */
export const MAX_ESCROW_RECIPIENT_SIZE = 4096;
/** The most vaults an anchor list holds. */
export const MAX_ANCHORS = 100_000;

const BUNDLE_LABEL = "vault-sync/v1/bundle";
const FINGERPRINT_LABEL = "vault-sync/v1/fingerprint";
const INVITE_SIGN_LABEL = "vault-sync/v1/invitation-sign";
const INVITE_ANCHOR_LABEL = "vault-sync/v1/invite-anchor";
const ANCHORS_LABEL = "vault-sync/v1/anchors";
const ESCROW_BUNDLE_LABEL = "vault-sync/v1/escrow";
const ESCROW_ROTATION_LABEL = "vault-sync/v1/escrow-rotation";
const AGE_RECIPIENT_HRP = "age1pq";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const label = (value: string): Uint8Array => encoder.encode(value);

/** The size of an encoded user key bundle. */
export const BUNDLE_SIZE = BUNDLE_LABEL.length + 16 + SIGN_PUBLIC_KEY_SIZE + PUBLIC_KEY_SIZE;

/** Thrown for every signed statement that does not verify. */
export class SignatureError extends Error {
  constructor() {
    super("e2ee: signature does not verify");
    this.name = "SignatureError";
  }
}

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`e2ee: ${name} must be ${String(length)} bytes, got ${String(value.length)}`);
  }
}

function hasPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.length >= prefix.length && equalBytes(value.subarray(0, prefix.length), prefix);
}

/** Returns `x` as a big-endian u32. */
export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** Returns `x` as a big-endian u64; `value` is a non-negative safe integer. */
export function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`e2ee: ${String(value)} is not a non-negative safe integer`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

/** lp(x): len(x) as u32 followed by x. */
export function lengthPrefixed(value: Uint8Array): Uint8Array {
  return concat(u32(value.length), value);
}

/** Reads lp(x) of at most `limit` bytes; returns x and the rest, or undefined. */
export function readLengthPrefixed(encoded: Uint8Array, limit: number): { value: Uint8Array; rest: Uint8Array } | undefined {
  if (encoded.length < 4) return undefined;
  const size = new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0);
  if (size > limit || size > encoded.length - 4) return undefined;
  return { value: encoded.subarray(4, 4 + size), rest: encoded.subarray(4 + size) };
}

/** The canonical lowercase UUID string of 16 bytes. */
export function uuidString(raw: Uint8Array): string {
  requireLength("uuid", raw, 16);
  const hex = Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Verifies an Ed25519 signature with RFC 8032 rules, as Go's crypto/ed25519 does. */
export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== SIGN_PUBLIC_KEY_SIZE || signature.length !== SIGNATURE_SIZE) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Signs `message` with the Ed25519 key of a 32-byte seed. */
export function sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

/** The Ed25519 public key of a 32-byte seed. */
export function signPublicKey(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

/** A user's 64-byte secret, the value the passphrase wraps. */
export interface UserSecret {
  kemSeed: Uint8Array;
  signSeed: Uint8Array;
}

/** Returns a new random user secret. */
export function generateUserSecret(): UserSecret {
  return parseUserSecret(randomBytes(USER_SECRET_SIZE));
}

/** Splits the 64 bytes kem_seed || sign_seed. */
export function parseUserSecret(raw: Uint8Array): UserSecret {
  requireLength("user secret", raw, USER_SECRET_SIZE);
  return { kemSeed: raw.slice(0, PRIVATE_KEY_SIZE), signSeed: raw.slice(PRIVATE_KEY_SIZE) };
}

/** Returns kem_seed || sign_seed. */
export function userSecretBytes(secret: UserSecret): Uint8Array {
  return concat(secret.kemSeed, secret.signSeed);
}

/** A user key bundle: (user id, signing public key, hybrid public key). */
export interface Bundle {
  userId: string;
  signPub: Uint8Array;
  kemPub: Uint8Array;
}

/** The bundle of a user secret for `userId`. */
export function bundleOf(secret: UserSecret, userId: string): Bundle {
  return { userId, signPub: signPublicKey(secret.signSeed), kemPub: publicKey(secret.kemSeed) };
}

/** "vault-sync/v1/bundle" || uuid(user_id) || sign_pub (32) || kem_pub (1216). */
export function encodeBundle(bundle: Bundle): Uint8Array {
  requireLength("signing public key", bundle.signPub, SIGN_PUBLIC_KEY_SIZE);
  requireLength("hybrid public key", bundle.kemPub, PUBLIC_KEY_SIZE);
  return concat(label(BUNDLE_LABEL), uuidBytes("bundle user id", bundle.userId), bundle.signPub, bundle.kemPub);
}

/** Reverses {@link encodeBundle}. */
export function parseBundle(encoded: Uint8Array): Bundle {
  if (encoded.length !== BUNDLE_SIZE || !hasPrefix(encoded, label(BUNDLE_LABEL))) {
    throw new Error("e2ee: malformed bundle");
  }
  const rest = encoded.subarray(BUNDLE_LABEL.length);
  return {
    userId: uuidString(rest.subarray(0, 16)),
    signPub: rest.slice(16, 16 + SIGN_PUBLIC_KEY_SIZE),
    kemPub: rest.slice(16 + SIGN_PUBLIC_KEY_SIZE),
  };
}

/** SHA-256("vault-sync/v1/fingerprint" || sign_pub || kem_pub). */
export function fingerprint(bundle: Bundle): Uint8Array {
  return sha256(concat(label(FINGERPRINT_LABEL), bundle.signPub, bundle.kemPub));
}

/** The first 20 bytes of a fingerprint in Crockford base32, in groups of four separated by spaces. */
export function formatFingerprint(value: Uint8Array): string {
  const encoded = base32crockford.encode(value.subarray(0, 20));
  return (encoded.match(/.{1,4}/g) ?? []).join(" ");
}

function inviteKey(secret: Uint8Array, vaultId: string, invitationId: string, info: string): Uint8Array {
  requireLength("invitation secret", secret, 16);
  return hkdf(sha256, secret, uuidBytes("vault id", vaultId), concat(label(info), uuidBytes("invitation id", invitationId)), 32);
}

/** The Ed25519 seed of an invitation's signing key, from its 16-byte secret. */
export function inviteSignSeed(secret: Uint8Array, vaultId: string, invitationId: string): Uint8Array {
  return inviteKey(secret, vaultId, invitationId, INVITE_SIGN_LABEL);
}

/** The key that authenticates an invitation's anchor, from its 16-byte secret. */
export function inviteMacKey(secret: Uint8Array, vaultId: string, invitationId: string): Uint8Array {
  return inviteKey(secret, vaultId, invitationId, INVITE_ANCHOR_LABEL);
}

/** The size of an invite anchor: genesis hash, inviter fingerprint and their MAC. */
export const INVITE_ANCHOR_SIZE = 3 * HASH_SIZE;

/** What an inviting device gives an invitation: the genesis hash and its own fingerprint. */
export interface InviteAnchor {
  genesisHash: Uint8Array;
  inviterFingerprint: Uint8Array;
}

function inviteAnchorMac(macKey: Uint8Array, vaultId: string, invitationId: string, genesisHash: Uint8Array, inviterFingerprint: Uint8Array): Uint8Array {
  return hmac(sha256, macKey, concat(label(INVITE_ANCHOR_LABEL), uuidBytes("vault id", vaultId), uuidBytes("invitation id", invitationId), genesisHash, inviterFingerprint));
}

/**
 * genesis_hash (32) || inviter_fingerprint (32) || HMAC-SHA256(invite_mac_key,
 * "vault-sync/v1/invite-anchor" || uuid(vault_id) || uuid(invitation_id) || genesis_hash || inviter_fingerprint).
 */
export function makeInviteAnchor(secret: Uint8Array, vaultId: string, invitationId: string, anchor: InviteAnchor): Uint8Array {
  requireLength("genesis hash", anchor.genesisHash, HASH_SIZE);
  requireLength("inviter fingerprint", anchor.inviterFingerprint, HASH_SIZE);
  const tag = inviteAnchorMac(inviteMacKey(secret, vaultId, invitationId), vaultId, invitationId, anchor.genesisHash, anchor.inviterFingerprint);
  return concat(anchor.genesisHash, anchor.inviterFingerprint, tag);
}

/**
 * Checks an invite anchor of `vaultId` and `invitationId` against the
 * invitation secret, comparing the MAC in constant time, and returns what it
 * holds. Throws {@link SignatureError} for any other vault, invitation,
 * secret, or a changed or malformed anchor.
 */
export function verifyInviteAnchor(secret: Uint8Array, vaultId: string, invitationId: string, encoded: Uint8Array): InviteAnchor {
  if (encoded.length !== INVITE_ANCHOR_SIZE) throw new SignatureError();
  const genesisHash = encoded.slice(0, HASH_SIZE);
  const inviterFingerprint = encoded.slice(HASH_SIZE, 2 * HASH_SIZE);
  const expected = inviteAnchorMac(inviteMacKey(secret, vaultId, invitationId), vaultId, invitationId, genesisHash, inviterFingerprint);
  if (!equalBytes(expected, encoded.subarray(2 * HASH_SIZE))) throw new SignatureError();
  return { genesisHash, inviterFingerprint };
}

/** One entry of an anchor list. */
export interface Anchor {
  vaultId: string;
  genesisHash: Uint8Array;
}

/** The key of a user's anchor list, derived from the user's kem_seed. */
export function anchorKey(kemSeed: Uint8Array): Uint8Array {
  requireLength("kem seed", kemSeed, PRIVATE_KEY_SIZE);
  return hkdf(sha256, kemSeed, undefined, label(ANCHORS_LABEL), KEY_SIZE);
}

function anchorListAd(userId: string, version: number): Uint8Array {
  return concat(label(ANCHORS_LABEL), uuidBytes("user id", userId), u64(version));
}

function encodeAnchors(anchors: readonly Anchor[]): Uint8Array {
  if (anchors.length > MAX_ANCHORS) throw new Error("e2ee: too many anchors");
  return concat(
    u32(anchors.length),
    ...anchors.map((anchor) => {
      requireLength("anchor genesis hash", anchor.genesisHash, HASH_SIZE);
      return concat(uuidBytes("anchor vault id", anchor.vaultId), anchor.genesisHash);
    }),
  );
}

/** Seals a user's anchor list at `version`. */
export function sealAnchorList(key: Uint8Array, userId: string, version: number, anchors: readonly Anchor[]): Uint8Array {
  return sealAnchorListWithNonce(key, randomBytes(NONCE_SIZE), userId, version, anchors);
}

/** {@link sealAnchorList} with a given nonce, for vectors. */
export function sealAnchorListWithNonce(key: Uint8Array, nonce: Uint8Array, userId: string, version: number, anchors: readonly Anchor[]): Uint8Array {
  return sealWithNonce(key, nonce, encodeAnchors(anchors), anchorListAd(userId, version));
}

/** Opens a user's anchor list sealed at `version`; throws {@link DecryptError} otherwise. */
export function openAnchorList(key: Uint8Array, sealed: Uint8Array, userId: string, version: number): Anchor[] {
  const list = open(key, sealed, anchorListAd(userId, version));
  if (list.length < 4) throw new DecryptError();
  const count = new DataView(list.buffer, list.byteOffset, 4).getUint32(0);
  if (count > MAX_ANCHORS || list.length - 4 !== count * (16 + HASH_SIZE)) throw new DecryptError();
  const anchors: Anchor[] = [];
  for (let offset = 4; offset < list.length; offset += 16 + HASH_SIZE) {
    anchors.push({ vaultId: uuidString(list.subarray(offset, offset + 16)), genesisHash: list.slice(offset + 16, offset + 16 + HASH_SIZE) });
  }
  return anchors;
}

/** The deployment escrow key: its Ed25519 signing public key and age recipient string. */
export interface EscrowBundle {
  signPub: Uint8Array;
  recipient: string;
}

/** "vault-sync/v1/escrow" || escrow_sign_pub (32) || lp(age_recipient_string). */
export function encodeEscrowBundle(bundle: EscrowBundle): Uint8Array {
  requireLength("escrow signing key", bundle.signPub, SIGN_PUBLIC_KEY_SIZE);
  const recipient = encoder.encode(bundle.recipient);
  if (recipient.length === 0 || recipient.length > MAX_ESCROW_RECIPIENT_SIZE) throw new Error("e2ee: escrow recipient of the wrong size");
  return concat(label(ESCROW_BUNDLE_LABEL), bundle.signPub, lengthPrefixed(recipient));
}

/** Reverses {@link encodeEscrowBundle}; the whole input must be one bundle. */
export function parseEscrowBundle(encoded: Uint8Array): EscrowBundle {
  const malformed = new Error("e2ee: malformed escrow bundle");
  if (!hasPrefix(encoded, label(ESCROW_BUNDLE_LABEL))) throw malformed;
  const rest = encoded.subarray(ESCROW_BUNDLE_LABEL.length);
  if (rest.length < SIGN_PUBLIC_KEY_SIZE) throw malformed;
  const recipient = readLengthPrefixed(rest.subarray(SIGN_PUBLIC_KEY_SIZE), MAX_ESCROW_RECIPIENT_SIZE);
  if (recipient === undefined || recipient.value.length === 0 || recipient.rest.length !== 0) throw malformed;
  let text: string;
  try {
    text = decoder.decode(recipient.value);
  } catch {
    throw malformed;
  }
  return { signPub: rest.slice(0, SIGN_PUBLIC_KEY_SIZE), recipient: text };
}

/** Whether two escrow bundles are the same key. */
export function escrowEqual(left: EscrowBundle, right: EscrowBundle): boolean {
  return equalBytes(left.signPub, right.signPub) && left.recipient === right.recipient;
}

/** The escrow key id (recipient_id of escrow slots) of an escrow bundle: "sha256:" and the hex SHA-256 of its hybrid public key. */
export function escrowKeyId(bundle: EscrowBundle): string {
  const decoded = bech32.decode(bundle.recipient as `${string}1${string}`, false);
  if (decoded.prefix !== AGE_RECIPIENT_HRP) throw new Error("e2ee: escrow recipient is not a hybrid age recipient");
  const key = bech32.fromWords(decoded.words);
  requireLength("escrow public key", key, PUBLIC_KEY_SIZE);
  return `sha256:${Array.from(sha256(key), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A statement, signed by the old escrow signing key, that the escrow key moves to `newBundle`. */
export interface EscrowRotation {
  oldBundleHash: Uint8Array;
  newBundle: EscrowBundle;
  signature: Uint8Array;
}

function escrowRotationMessage(oldBundleHash: Uint8Array, newBundle: EscrowBundle): Uint8Array {
  return concat(label(ESCROW_ROTATION_LABEL), oldBundleHash, encodeEscrowBundle(newBundle));
}

/** The statement moving from `oldBundle` to `newBundle`, signed with the old escrow signing seed. */
export function signEscrowRotation(oldSignSeed: Uint8Array, oldBundle: EscrowBundle, newBundle: EscrowBundle): EscrowRotation {
  const oldBundleHash = sha256(encodeEscrowBundle(oldBundle));
  return { oldBundleHash, newBundle, signature: sign(oldSignSeed, escrowRotationMessage(oldBundleHash, newBundle)) };
}

/** Verifies one rotation step from `current`; returns whether it is from `current` and signed by its key. */
function rotationStepValid(current: EscrowBundle, rotation: EscrowRotation): "valid" | "other" | "unsigned" {
  if (!equalBytes(sha256(encodeEscrowBundle(current)), rotation.oldBundleHash)) return "other";
  let message: Uint8Array;
  try {
    message = escrowRotationMessage(rotation.oldBundleHash, rotation.newBundle);
  } catch {
    return "unsigned";
  }
  return verifySignature(current.signPub, message, rotation.signature) ? "valid" : "unsigned";
}

/**
 * Follows rotation statements from the pinned escrow bundle and returns the
 * bundle the chain ends at. Throws {@link SignatureError} unless every
 * statement names the bundle before it and is signed by its key.
 */
export function verifyEscrowChain(pinned: EscrowBundle, rotations: readonly EscrowRotation[]): EscrowBundle {
  let current = pinned;
  for (const rotation of rotations) {
    if (rotationStepValid(current, rotation) !== "valid") throw new SignatureError();
    current = rotation.newBundle;
  }
  return current;
}

/**
 * Whether `target` is `from` or a bundle the published chain reaches from
 * it, each step signed by the key it replaces. Statements before `from`'s
 * position in the chain are skipped. Returns the reason it is not.
 */
export function escrowReachable(from: EscrowBundle, target: EscrowBundle, rotations: readonly EscrowRotation[]): string | undefined {
  let current = from;
  for (const rotation of rotations) {
    if (escrowEqual(current, target)) return undefined;
    const step = rotationStepValid(current, rotation);
    if (step === "other") continue;
    if (step === "unsigned") return "unsigned escrow rotation";
    current = rotation.newBundle;
  }
  return escrowEqual(current, target) ? undefined : "unchained escrow key";
}
