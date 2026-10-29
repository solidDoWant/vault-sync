import { Decrypter } from "age-encryption";
import { describe, expect, it } from "vitest";

import { DecryptError } from "./e2ee";
import { ageIdentity, ageRecipient, generateKeyPair, MAX_SEALED_SIZE, openFrom, PRIVATE_KEY_SIZE, PUBLIC_KEY_SIZE, publicKey, sealTo } from "./hybrid";

const encoder = new TextEncoder();

describe("hybrid key wrapping", () => {
  it("generates a key pair of the documented sizes whose public key follows from the private key", () => {
    const pair = generateKeyPair();
    expect(pair.privateKey).toHaveLength(PRIVATE_KEY_SIZE);
    expect(pair.publicKey).toHaveLength(1216);
    expect(publicKey(pair.privateKey)).toEqual(pair.publicKey);
    expect(ageRecipient(pair.publicKey)).toMatch(/^age1pq1[02-9ac-hj-np-z]+$/);
    expect(ageIdentity(pair.privateKey)).toMatch(/^AGE-SECRET-KEY-PQ-1[02-9AC-HJ-NP-Z]+$/);
  });

  it("seals a binary age file that only the recipient opens", async () => {
    const recipient = generateKeyPair();
    const plaintext = encoder.encode("epoch key");
    const sealed = await sealTo(recipient.publicKey, plaintext);
    expect(new TextDecoder().decode(sealed.subarray(0, 40))).toBe("age-encryption.org/v1\n-> mlkem768x25519 ");
    expect(await sealTo(recipient.publicKey, plaintext)).not.toEqual(sealed);
    expect(await openFrom(recipient.privateKey, sealed)).toEqual(plaintext);
    await expect(openFrom(generateKeyPair().privateKey, sealed)).rejects.toThrow(DecryptError);

    // age itself opens it with the identity string.
    const decrypter = new Decrypter();
    decrypter.addIdentity(ageIdentity(recipient.privateKey));
    expect(await decrypter.decrypt(sealed)).toEqual(plaintext);
  });

  it("opens a file of exactly the bound and refuses one byte more", async () => {
    const recipient = generateKeyPair();
    const empty = await sealTo(recipient.publicKey, new Uint8Array(0));
    const atBound = await sealTo(recipient.publicKey, new Uint8Array(MAX_SEALED_SIZE - empty.length));
    const overBound = await sealTo(recipient.publicKey, new Uint8Array(MAX_SEALED_SIZE - empty.length + 1));
    expect(atBound).toHaveLength(2048);
    expect(overBound).toHaveLength(2049);
    expect(await openFrom(recipient.privateKey, atBound)).toHaveLength(MAX_SEALED_SIZE - empty.length);
    await expect(openFrom(recipient.privateKey, overBound)).rejects.toThrow(DecryptError);
  });

  it("refuses keys of the wrong size", async () => {
    const { publicKey: recipient } = generateKeyPair();
    await expect(sealTo(recipient.subarray(0, PUBLIC_KEY_SIZE - 1), encoder.encode("k"))).rejects.toThrow();
    await expect(sealTo(Uint8Array.of(...recipient, 0), encoder.encode("k"))).rejects.toThrow();
    expect(() => publicKey(new Uint8Array(PRIVATE_KEY_SIZE - 1))).toThrow();
  });
});
