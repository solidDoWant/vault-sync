import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { KeyRecipientKind } from "../../gen/vaultsync/v1/vault_key_pb";
import { VaultEncryption, VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { generateKeyPair } from "../e2ee/hybrid";
import { openKeySlot, verifyKeyCommitment } from "../e2ee/keyslot";
import { createProtocolClient } from "../protocol/client";
import { createEncryptedVault, escrowOffer } from "./encrypted-vault";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import { MemoryEpochKeyStore, type EscrowRecipient } from "./vault-keys";

const vaultId = "0190a5b4-0000-7000-8000-000000000001";
const ownerId = "0190a5b4-0000-7000-8000-000000000101";

/** The deployment's escrow key pair, and the recipient GetServerInfo would publish for it. */
function escrowKey() {
  const pair = generateKeyPair();
  const recipient: EscrowRecipient = { keyId: `sha256:${bytesToHex(sha256(pair.publicKey))}`, publicKey: pair.publicKey };
  return { pair, recipient };
}

async function create(escrow: EscrowRecipient | undefined) {
  const server = new MemoryVaultKeyServer(vaultId);
  const owner = generateKeyPair();
  server.userKeys.set(ownerId, owner.publicKey);
  const client = createProtocolClient({ transport: server.transport(ownerId) });
  const store = new MemoryEpochKeyStore();
  const vault = await createEncryptedVault({
    name: "Secret",
    escrow,
    userKey: owner,
    vaults: client.vaults,
    keys: client.vaultKeys,
    membership: client.membership,
    store: () => store,
  });
  return { server, owner, store, vault };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let index = 0; index < needle.length; index++) if (haystack[start + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}

describe("createEncryptedVault", () => {
  it("creates an encrypted vault with escrow whose epoch 1 opens for the owner and for the escrow key", async () => {
    const escrow = escrowKey();
    const { server, owner, store, vault } = await create(escrow.recipient);

    expect(vault.encryption).toBe(VaultEncryption.E2EE);
    expect(vault.escrow).toBe(true);
    expect(vault.role).toBe(VaultRole.OWNER);
    expect(server.currentEpoch).toBe(1);
    expect(server.rotationPending).toBe(false);

    const commitment = server.epochs.find((epoch) => epoch.epoch === 1)?.commitment;
    expect(commitment).toBeDefined();
    const slots = server.slotsOf(1);
    expect(slots.map((slot) => [slot.recipientKind, slot.recipientId]).sort()).toEqual(
      [
        [KeyRecipientKind.USER, ownerId],
        [KeyRecipientKind.ESCROW, escrow.recipient.keyId],
      ].sort(),
    );

    const ownerSlot = slots.find((slot) => slot.recipientKind === KeyRecipientKind.USER);
    const escrowSlot = slots.find((slot) => slot.recipientKind === KeyRecipientKind.ESCROW);
    if (ownerSlot === undefined || escrowSlot === undefined || commitment === undefined) throw new Error("missing slot or commitment");
    const ownerKey = await openKeySlot(owner.privateKey, ownerSlot.wrappedKey, { vaultId, epoch: 1, recipientKind: "user", recipientId: ownerId });
    const escrowedKey = await openKeySlot(escrow.pair.privateKey, escrowSlot.wrappedKey, { vaultId, epoch: 1, recipientKind: "escrow", recipientId: escrow.recipient.keyId });
    expect(escrowedKey).toEqual(ownerKey);
    expect(() => {
      verifyKeyCommitment(ownerKey, commitment, vaultId, 1);
    }).not.toThrow();
    expect(store.keys.get(1)).toEqual(ownerKey);
  });

  it("creates an encrypted vault without escrow when escrow is turned off", async () => {
    const { server, owner, vault } = await create(undefined);

    expect(vault.encryption).toBe(VaultEncryption.E2EE);
    expect(vault.escrow).toBe(false);
    expect(server.escrow).toBe(false);
    expect(server.currentEpoch).toBe(1);
    const slots = server.slotsOf(1);
    expect(slots.map((slot) => [slot.recipientKind, slot.recipientId])).toEqual([[KeyRecipientKind.USER, ownerId]]);
    const slot = slots[0];
    if (slot === undefined) throw new Error("no slot");
    await expect(openKeySlot(owner.privateKey, slot.wrappedKey, { vaultId, epoch: 1, recipientKind: "user", recipientId: ownerId })).resolves.toHaveLength(32);
  });

  it("never sends the epoch key to the server unwrapped", async () => {
    const { server, store } = await create(escrowKey().recipient);

    const epochKey = store.keys.get(1);
    if (epochKey === undefined) throw new Error("no epoch key");
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) expect(contains(request.bytes, epochKey), request.procedure).toBe(false);
  });
});

describe("escrowOffer", () => {
  it("offers the server's escrow key, on by default when the server says so", () => {
    const { recipient } = escrowKey();
    expect(escrowOffer({ escrowPublicKey: recipient.publicKey, escrowKeyId: recipient.keyId, escrowDefault: true })).toEqual({ recipient, byDefault: true });
    expect(escrowOffer({ escrowPublicKey: recipient.publicKey, escrowKeyId: recipient.keyId, escrowDefault: false })).toEqual({ recipient, byDefault: false });
  });

  it("offers no escrow when the server has no escrow key", () => {
    expect(escrowOffer({ escrowPublicKey: new Uint8Array(), escrowKeyId: "", escrowDefault: false })).toEqual({ recipient: undefined, byDefault: false });
  });

  it("refuses an escrow key its id does not name, or of the wrong size", () => {
    const { recipient } = escrowKey();
    const other = escrowKey().recipient;
    expect(() => escrowOffer({ escrowPublicKey: recipient.publicKey, escrowKeyId: other.keyId, escrowDefault: true })).toThrow(/does not name/);
    const short = recipient.publicKey.slice(1);
    expect(() => escrowOffer({ escrowPublicKey: short, escrowKeyId: `sha256:${bytesToHex(sha256(short))}`, escrowDefault: true })).toThrow(/malformed/);
  });
});
