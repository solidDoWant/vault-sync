import { describe, expect, it } from "vitest";

import { DecryptError, generateKey, generateKeyPair, KEY_SIZE } from "./e2ee";
import { KeyCommitmentError, keyCommitment, keySlotAd, MAX_RECIPIENT_ID_SIZE, openKeySlot, sealKeySlot, type KeySlot, verifyKeyCommitment } from "./keyslot";

const VAULT_ID = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e";
const OTHER_VAULT_ID = "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0f";
const USER_ID = "0190d6e5-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const OTHER_USER_ID = "0190d6e5-1a2b-7c3d-8e4f-5a6b7c8d9e10";

const userSlot: KeySlot = { vaultId: VAULT_ID, epoch: 7, recipientKind: "user", recipientId: USER_ID };

describe("key slots", () => {
  it("opens a slot only as the slot it was sealed for", () => {
    const recipient = generateKeyPair();
    const epochKey = generateKey();
    const wrapped = sealKeySlot(recipient.publicKey, epochKey, userSlot);
    expect(sealKeySlot(recipient.publicKey, epochKey, userSlot)).not.toEqual(wrapped);
    expect(openKeySlot(recipient.privateKey, wrapped, userSlot)).toEqual(epochKey);

    for (const other of [
      { ...userSlot, vaultId: OTHER_VAULT_ID },
      { ...userSlot, epoch: 8 },
      { ...userSlot, epoch: 7 + 2 ** 32 },
      { ...userSlot, recipientId: OTHER_USER_ID },
      { ...userSlot, recipientKind: "escrow" as const },
    ]) {
      expect(() => openKeySlot(recipient.privateKey, wrapped, other)).toThrow(DecryptError);
    }
    expect(() => openKeySlot(generateKeyPair().privateKey, wrapped, userSlot)).toThrow(DecryptError);
  });

  it("encodes the slot fields at their documented sizes", () => {
    expect(keySlotAd(userSlot)).toHaveLength(22 + 16 + 8 + 1 + 1 + 16);
    expect(keySlotAd({ ...userSlot, recipientKind: "escrow", recipientId: "e" })).toHaveLength(22 + 16 + 8 + 1 + 1 + 1);
    expect(keySlotAd({ ...userSlot, recipientKind: "escrow", recipientId: "e".repeat(MAX_RECIPIENT_ID_SIZE) })).toHaveLength(22 + 16 + 8 + 1 + 1 + 255);
    expect(keySlotAd({ ...userSlot, epoch: 0 })).toHaveLength(64);
    expect(keySlotAd({ ...userSlot, epoch: Number.MAX_SAFE_INTEGER })).toHaveLength(64);
  });

  it("refuses slots that are not in canonical form", () => {
    const { publicKey } = generateKeyPair();
    for (const slot of [
      { ...userSlot, vaultId: VAULT_ID.toUpperCase() },
      { ...userSlot, vaultId: VAULT_ID.replaceAll("-", "") },
      { ...userSlot, vaultId: `{${VAULT_ID}}` },
      { ...userSlot, vaultId: "" },
      { ...userSlot, recipientId: USER_ID.toUpperCase() },
      { ...userSlot, recipientId: "escrow-2026" },
      { ...userSlot, recipientKind: "escrow" as const, recipientId: "" },
      { ...userSlot, recipientKind: "escrow" as const, recipientId: "e".repeat(MAX_RECIPIENT_ID_SIZE + 1) },
      { ...userSlot, recipientKind: "escrow" as const, recipientId: "e\ud800" },
      { ...userSlot, recipientKind: "device" as unknown as KeySlot["recipientKind"] },
      { ...userSlot, epoch: -1 },
      { ...userSlot, epoch: 1.5 },
      { ...userSlot, epoch: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => keySlotAd(slot)).toThrow();
      expect(() => sealKeySlot(publicKey, new Uint8Array(KEY_SIZE), slot)).toThrow();
    }
  });

  it("refuses to seal a key of the wrong size", () => {
    const { publicKey } = generateKeyPair();
    for (const size of [0, KEY_SIZE - 1, KEY_SIZE + 1]) {
      expect(() => sealKeySlot(publicKey, new Uint8Array(size), userSlot)).toThrow();
    }
  });
});

describe("key commitments", () => {
  const epochKey = generateKey();
  const commitment = keyCommitment(epochKey, VAULT_ID, 1);

  it("verifies the key it was computed from", () => {
    expect(commitment).toHaveLength(32);
    expect(() => {
      verifyKeyCommitment(epochKey, commitment, VAULT_ID, 1);
    }).not.toThrow();
  });

  it("refuses any other key, vault, epoch or commitment", () => {
    const attempts: [Uint8Array, Uint8Array, string, number][] = [
      [generateKey(), commitment, VAULT_ID, 1],
      [epochKey.subarray(0, KEY_SIZE - 1), commitment, VAULT_ID, 1],
      [epochKey, commitment, OTHER_VAULT_ID, 1],
      [epochKey, commitment, VAULT_ID, 2],
      [epochKey, commitment.subarray(0, 31), VAULT_ID, 1],
      [epochKey, new Uint8Array(0), VAULT_ID, 1],
    ];
    for (const [key, value, vaultId, epoch] of attempts) {
      expect(() => {
        verifyKeyCommitment(key, value, vaultId, epoch);
      }).toThrow(KeyCommitmentError);
    }
  });

  it("refuses a non-canonical vault id", () => {
    expect(() => keyCommitment(epochKey, VAULT_ID.toUpperCase(), 1)).toThrow();
  });
});
