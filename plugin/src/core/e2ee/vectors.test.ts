import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/crypto/vectors.json";
import {
  blobId,
  DecryptError,
  derivePassphraseKeys,
  deriveSubkey,
  open,
  pathKey,
  sealWithNonce,
  type SubkeyLabel,
  unwrapWithKey,
  unwrapWithPassphrase,
  wrapWith,
} from "./e2ee";
import { ageIdentity, ageRecipient, openFrom, publicKey } from "./hybrid";
import { KeyCommitmentError, keyCommitment, keySlotAd, openKeySlot, type KeySlot, type RecipientKind, verifyKeyCommitment } from "./keyslot";

interface SlotFields {
  vault_id: string;
  epoch: number;
  recipient_kind: string;
  recipient_id: string;
}

function slotOf(vector: SlotFields): KeySlot {
  return { vaultId: vector.vault_id, epoch: vector.epoch, recipientKind: vector.recipient_kind as RecipientKind, recipientId: vector.recipient_id };
}

const uuidHex = (value: string): string => value.replaceAll("-", "");
const u64Hex = (value: number): string => value.toString(16).padStart(16, "0");
const utf8Hex = (value: string): string => bytesToHex(new TextEncoder().encode(value));

// The associated data of a slot built from the layout in
// docs/design/crypto.md, not by the code under test.
function documentedSlotAd(vector: SlotFields): string {
  const byUuid = vector.recipient_kind === "user" || vector.recipient_kind === "invitation";
  const recipientId = byUuid ? uuidHex(vector.recipient_id) : utf8Hex(vector.recipient_id);
  const kind = { user: "01", escrow: "02", invitation: "03" }[vector.recipient_kind];
  if (kind === undefined) throw new Error(`unknown recipient kind ${vector.recipient_kind}`);
  const length = (recipientId.length / 2).toString(16).padStart(2, "0");
  return utf8Hex("vault-sync/v1/key-slot") + uuidHex(vector.vault_id) + u64Hex(vector.epoch) + kind + length + recipientId;
}

// The same file is asserted by internal/e2ee in Go (which generates it), so
// passing here means both languages produce and accept exactly the same
// bytes, and refuse the same ones.
// Argon2id derivations take a few hundred milliseconds each; shared CI
// runners can be several times slower than a quiet machine.
describe("shared crypto vectors", { timeout: 60_000 }, () => {
  describe("published known answers", () => {
    for (const vector of shared.standards.hkdf_sha256) {
      it(`HKDF-SHA256: ${vector.name}`, () => {
        const okm = hkdf(sha256, hexToBytes(vector.ikm), hexToBytes(vector.salt), hexToBytes(vector.info), vector.length);
        expect(bytesToHex(okm)).toBe(vector.okm);
      });
    }
    for (const vector of shared.standards.xchacha20poly1305) {
      it(`XChaCha20-Poly1305: ${vector.name}`, () => {
        const cipher = xchacha20poly1305(hexToBytes(vector.key), hexToBytes(vector.nonce), hexToBytes(vector.aad));
        expect(bytesToHex(cipher.encrypt(hexToBytes(vector.plaintext)))).toBe(vector.ciphertext);
      });
    }
    for (const vector of shared.standards.x25519) {
      it(`X25519: ${vector.name}`, () => {
        expect(bytesToHex(x25519.getPublicKey(hexToBytes(vector.private_key)))).toBe(vector.public_key);
        const secret = x25519.getSharedSecret(hexToBytes(vector.private_key), hexToBytes(vector.peer_public_key));
        expect(bytesToHex(secret)).toBe(vector.shared_secret);
      });
    }
  });

  it("has vectors of every kind", () => {
    for (const kind of [shared.subkeys, shared.aead, shared.hybrid, shared.path_key, shared.blob_id, shared.passphrase, shared.rejected, shared.key_slot, shared.key_commitment, shared.rejected_key_slots, shared.rejected_key_commitments]) {
      expect(kind.length).toBeGreaterThan(0);
    }
  });

  for (const vector of shared.subkeys) {
    it(`derives the sub-key: ${vector.name}`, () => {
      expect(bytesToHex(deriveSubkey(hexToBytes(vector.epoch_key), vector.label as SubkeyLabel))).toBe(vector.subkey);
    });
  }

  for (const vector of shared.aead) {
    it(`seals and opens: ${vector.name}`, () => {
      const key = hexToBytes(vector.key);
      const aad = hexToBytes(vector.aad);
      const sealed = sealWithNonce(key, hexToBytes(vector.nonce), hexToBytes(vector.plaintext), aad);
      expect(bytesToHex(sealed)).toBe(vector.sealed);
      expect(bytesToHex(open(key, hexToBytes(vector.sealed), aad))).toBe(vector.plaintext);
    });
  }

  // Hybrid sealing is randomized inside age, so these vectors are opened, not
  // reproduced; the Go generator pins their bytes.
  for (const vector of shared.hybrid) {
    it(`opens from a hybrid recipient: ${vector.name}`, async () => {
      const recipient = hexToBytes(vector.recipient_private_key);
      expect(bytesToHex(publicKey(recipient))).toBe(vector.recipient_public_key);
      expect(ageIdentity(recipient)).toBe(vector.age_identity);
      expect(ageRecipient(hexToBytes(vector.recipient_public_key))).toBe(vector.age_recipient);
      expect(bytesToHex(await openFrom(recipient, hexToBytes(vector.sealed)))).toBe(vector.plaintext);
    });
  }

  for (const vector of shared.path_key) {
    it(`computes the path_key: ${vector.name}`, () => {
      expect(bytesToHex(pathKey(hexToBytes(vector.secret), vector.path))).toBe(vector.path_key);
    });
  }

  for (const vector of shared.blob_id) {
    it(`computes the blob_id: ${vector.name}`, () => {
      expect(bytesToHex(blobId(hexToBytes(vector.secret), hexToBytes(vector.plaintext)))).toBe(vector.blob_id);
    });
  }

  for (const vector of shared.passphrase) {
    it(`wraps and unwraps with a passphrase: ${vector.name}`, async () => {
      const params = { memory: vector.memory, iterations: vector.iterations, parallelism: vector.parallelism };
      const aad = hexToBytes(vector.aad);
      const { wrapped, keys } = await wrapWith(
        vector.passphrase,
        params,
        hexToBytes(vector.salt),
        hexToBytes(vector.nonce),
        hexToBytes(vector.secret),
        aad,
      );
      expect(bytesToHex(wrapped)).toBe(vector.wrapped);
      expect(bytesToHex(keys.wrapKey)).toBe(vector.wrap_key);
      expect(bytesToHex(keys.authKey)).toBe(vector.auth_key);
      const derived = await derivePassphraseKeys(vector.passphrase, params, hexToBytes(vector.salt));
      expect(bytesToHex(derived.wrapKey)).toBe(vector.wrap_key);
      expect(bytesToHex(derived.authKey)).toBe(vector.auth_key);
      expect(bytesToHex(await unwrapWithPassphrase(vector.passphrase, hexToBytes(vector.wrapped), aad))).toBe(vector.secret);
      expect(bytesToHex(unwrapWithKey(hexToBytes(vector.wrap_key), hexToBytes(vector.wrapped), aad))).toBe(vector.secret);
    });
  }

  // The pairs share their salt and nonce, so equal wrapped values show that
  // both normalization forms of a passphrase derive the same key.
  it("wraps both normalization forms of a passphrase identically", () => {
    const wrapped = new Map(shared.passphrase.map((vector) => [vector.name, vector.wrapped]));
    for (const [precomposed, decomposed] of [
      ["precomposed passphrase", "decomposed passphrase"],
      ["Unicode 15.0 mark, precomposed passphrase", "Unicode 15.0 mark, decomposed passphrase"],
    ] as const) {
      expect(wrapped.get(precomposed)).toBeDefined();
      expect(wrapped.get(decomposed)).toBe(wrapped.get(precomposed));
    }
  });

  for (const vector of shared.key_slot) {
    it(`opens a key slot: ${vector.name}`, async () => {
      const slot = slotOf(vector);
      expect(documentedSlotAd(vector)).toBe(vector.ad);
      expect(bytesToHex(keySlotAd(slot))).toBe(vector.ad);
      const recipient = hexToBytes(vector.recipient_private_key);
      expect(bytesToHex(publicKey(recipient))).toBe(vector.recipient_public_key);
      // The slot is an age file whose payload is the epoch key followed by
      // the documented associated data.
      expect(bytesToHex(await openFrom(recipient, hexToBytes(vector.sealed)))).toBe(vector.epoch_key + vector.ad);
      expect(bytesToHex(await openKeySlot(recipient, hexToBytes(vector.sealed), slot))).toBe(vector.epoch_key);
    });
  }

  for (const vector of shared.key_commitment) {
    it(`computes and verifies the key commitment: ${vector.name}`, () => {
      const epochKey = hexToBytes(vector.epoch_key);
      const documented = hmac(sha256, epochKey, hexToBytes(utf8Hex("vault-sync/v1/key-commitment") + uuidHex(vector.vault_id) + u64Hex(vector.epoch)));
      expect(bytesToHex(documented)).toBe(vector.commitment);
      expect(bytesToHex(keyCommitment(epochKey, vector.vault_id, vector.epoch))).toBe(vector.commitment);
      expect(() => {
        verifyKeyCommitment(epochKey, hexToBytes(vector.commitment), vector.vault_id, vector.epoch);
      }).not.toThrow();
    });
  }

  for (const vector of shared.rejected_key_slots) {
    it(`refuses the key slot: ${vector.name}`, async () => {
      await expect(openKeySlot(hexToBytes(vector.recipient_private_key), hexToBytes(vector.sealed), slotOf(vector))).rejects.toThrow(DecryptError);
    });
  }

  for (const vector of shared.rejected_key_commitments) {
    it(`refuses the key commitment: ${vector.name}`, () => {
      expect(() => {
        verifyKeyCommitment(hexToBytes(vector.epoch_key), hexToBytes(vector.commitment), vector.vault_id, vector.epoch);
      }).toThrow(KeyCommitmentError);
    });
  }

  for (const vector of shared.rejected) {
    it(`refuses: ${vector.name}`, async () => {
      const sealed = hexToBytes(vector.sealed);
      const aad = hexToBytes(vector.aad);
      const attempt = (): Uint8Array | Promise<Uint8Array> => {
        switch (vector.kind) {
          case "aead":
            return open(hexToBytes(vector.key ?? ""), sealed, aad);
          case "hybrid":
            expect(aad).toHaveLength(0);
            return openFrom(hexToBytes(vector.key ?? ""), sealed);
          case "passphrase":
            return unwrapWithPassphrase(vector.passphrase ?? "", sealed, aad);
          default:
            throw new Error(`unknown kind ${vector.kind}`);
        }
      };
      await expect((async () => attempt())()).rejects.toThrow(DecryptError);
    });
  }
});
