import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { KeyRecipientKind } from "../../gen/vaultsync/v1/vault_key_pb";
import { VaultEncryption, VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { ageRecipient, generateKeyPair } from "../e2ee/hybrid";
import { anchorKey, encodeEscrowBundle, openAnchorList, signPublicKey } from "../e2ee/identity";
import { entryHash, replayLog } from "../e2ee/memberlog";
import { openKeySlot, verifyKeyCommitment } from "../e2ee/keyslot";
import { createProtocolClient } from "../protocol/client";
import { createEncryptedVault, escrowOffer, type EscrowKey } from "./encrypted-vault";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import { MemoryEpochKeyStore } from "./vault-keys";

const serverVaultId = "0190a5b4-0000-7000-8000-000000000001";
const ownerId = "0190a5b4-0000-7000-8000-000000000101";

/** The deployment's escrow key pair, and the recipient GetServerInfo would publish for it. */
function escrowKey() {
  const pair = generateKeyPair();
  const recipient: EscrowKey = {
    keyId: `sha256:${bytesToHex(sha256(pair.publicKey))}`,
    publicKey: pair.publicKey,
    bundle: { signPub: signPublicKey(new Uint8Array(32).fill(9)), recipient: ageRecipient(pair.publicKey) },
  };
  return { pair, recipient, encodedBundle: encodeEscrowBundle(recipient.bundle) };
}

async function create(escrow: EscrowKey | undefined) {
  const server = new MemoryVaultKeyServer(serverVaultId);
  const owner = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(1), userId: ownerId };
  server.userKeys.set(ownerId, owner.publicKey);
  const client = createProtocolClient({ transport: server.transport(ownerId) });
  const store = new MemoryEpochKeyStore();
  const vault = await createEncryptedVault({
    name: "Secret",
    escrow,
    userKey: owner,
    vaults: client.vaults,
    anchors: client.userKeys,
    keys: client.vaultKeys,
    membership: client.membership,
    store: () => store,
  });
  return { server, owner, store, vault, client };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let start = 0;
    start + needle.length <= haystack.length;
    start++
  ) {
    for (let index = 0; index < needle.length; index++)
      if (haystack[start + index] !== needle[index]) continue outer;
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

    const commitment = server.epochs.find(
      (epoch) => epoch.epoch === 1,
    )?.commitment;
    expect(commitment).toBeDefined();
    const slots = server.slotsOf(1);
    expect(
      slots.map((slot) => [slot.recipientKind, slot.recipientId]).sort(),
    ).toEqual(
      [
        [KeyRecipientKind.USER, ownerId],
        [KeyRecipientKind.ESCROW, escrow.recipient.keyId],
      ].sort(),
    );

    const ownerSlot = slots.find(
      (slot) => slot.recipientKind === KeyRecipientKind.USER,
    );
    const escrowSlot = slots.find(
      (slot) => slot.recipientKind === KeyRecipientKind.ESCROW,
    );
    if (
      ownerSlot === undefined ||
      escrowSlot === undefined ||
      commitment === undefined
    )
      throw new Error("missing slot or commitment");
    const ownerKey = await openKeySlot(owner.privateKey, ownerSlot.wrappedKey, {
      vaultId: vault.id,
      epoch: 1,
      recipientKind: "user",
      recipientId: ownerId,
    });
    const escrowedKey = await openKeySlot(
      escrow.pair.privateKey,
      escrowSlot.wrappedKey,
      {
        vaultId: vault.id,
        epoch: 1,
        recipientKind: "escrow",
        recipientId: escrow.recipient.keyId,
      },
    );
    expect(escrowedKey).toEqual(ownerKey);
    expect(() => {
      verifyKeyCommitment(ownerKey, commitment, vault.id, 1);
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
    expect(slots.map((slot) => [slot.recipientKind, slot.recipientId])).toEqual(
      [[KeyRecipientKind.USER, ownerId]],
    );
    const slot = slots[0];
    if (slot === undefined) throw new Error("no slot");
    await expect(
      openKeySlot(owner.privateKey, slot.wrappedKey, {
        vaultId: vault.id,
        epoch: 1,
        recipientKind: "user",
        recipientId: ownerId,
      }),
    ).resolves.toHaveLength(32);
  });

  it("never sends the epoch key to the server unwrapped", async () => {
    const { server, store } = await create(escrowKey().recipient);

    const epochKey = store.keys.get(1);
    if (epochKey === undefined) throw new Error("no epoch key");
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests)
      expect(contains(request.bytes, epochKey), request.procedure).toBe(false);
  });
});

describe("createEncryptedVault's genesis", () => {
  it("signs a genesis naming the owner and the escrow bundle, and anchors it in the owner's anchor list", async () => {
    const escrow = escrowKey();
    const { server, owner, vault } = await create(escrow.recipient);

    expect(vault.id).not.toBe(serverVaultId);
    expect(server.log).toHaveLength(1);
    const [state] = replayLog(vault.id, server.log);
    expect(state?.members.get(ownerId)?.bundle.kemPub).toEqual(owner.publicKey);
    expect(state?.members.get(ownerId)?.bundle.signPub).toEqual(signPublicKey(owner.signSeed));
    expect(state?.escrow).toEqual(escrow.recipient.bundle);

    const stored = server.anchorLists.get(ownerId);
    expect(stored?.version).toBe(1);
    const genesis = server.log[0];
    if (stored === undefined || genesis === undefined) throw new Error("no anchor list or genesis");
    expect(openAnchorList(anchorKey(owner.privateKey), stored.sealed, ownerId, 1)).toEqual([{ vaultId: vault.id, genesisHash: entryHash(genesis) }]);
  });

  it("names no escrow in the genesis of a vault without escrow", async () => {
    const { server, vault } = await create(undefined);
    expect(replayLog(vault.id, server.log)[0]?.escrow).toBeUndefined();
  });
});

describe("escrowOffer", () => {
  it("offers the server's escrow key, on by default when the server says so", () => {
    const { recipient, encodedBundle } = escrowKey();
    expect(
      escrowOffer({
        escrowPublicKey: recipient.publicKey,
        escrowKeyId: recipient.keyId,
        escrowDefault: true,
        escrowRootBundle: encodedBundle,
        escrowRotations: [],
      }),
    ).toEqual({ recipient, byDefault: true });
    expect(
      escrowOffer({
        escrowPublicKey: recipient.publicKey,
        escrowKeyId: recipient.keyId,
        escrowDefault: false,
        escrowRootBundle: encodedBundle,
        escrowRotations: [],
      }),
    ).toEqual({ recipient, byDefault: false });
  });

  it("names the escrow bundle of the last rotation, and refuses one that names another key", () => {
    const old = escrowKey();
    const { recipient, encodedBundle } = escrowKey();
    const rotation = { $typeName: "vaultsync.v1.EscrowRotationStatement" as const, oldBundleHash: new Uint8Array(32), newBundle: encodedBundle, signature: new Uint8Array(64) };
    expect(
      escrowOffer({
        escrowPublicKey: recipient.publicKey,
        escrowKeyId: recipient.keyId,
        escrowDefault: true,
        escrowRootBundle: old.encodedBundle,
        escrowRotations: [rotation],
      }).recipient?.bundle,
    ).toEqual(recipient.bundle);
    expect(() =>
      escrowOffer({
        escrowPublicKey: recipient.publicKey,
        escrowKeyId: recipient.keyId,
        escrowDefault: true,
        escrowRootBundle: old.encodedBundle,
        escrowRotations: [],
      }),
    ).toThrow(/bundle does not name/);
  });

  it("offers no escrow when the server has no escrow key", () => {
    expect(
      escrowOffer({
        escrowPublicKey: new Uint8Array(),
        escrowKeyId: "",
        escrowDefault: false,
        escrowRootBundle: new Uint8Array(),
        escrowRotations: [],
      }),
    ).toEqual({ recipient: undefined, byDefault: false });
  });

  it("refuses an escrow key its id does not name, or of the wrong size", () => {
    const { recipient } = escrowKey();
    const other = escrowKey().recipient;
    expect(() =>
      escrowOffer({
        escrowPublicKey: recipient.publicKey,
        escrowKeyId: other.keyId,
        escrowDefault: true,
        escrowRootBundle: encodeEscrowBundle(recipient.bundle),
        escrowRotations: [],
      }),
    ).toThrow(/does not name/);
    const short = recipient.publicKey.slice(1);
    expect(() =>
      escrowOffer({
        escrowPublicKey: short,
        escrowKeyId: `sha256:${bytesToHex(sha256(short))}`,
        escrowDefault: true,
        escrowRootBundle: encodeEscrowBundle(recipient.bundle),
        escrowRotations: [],
      }),
    ).toThrow(/malformed/);
  });
});
