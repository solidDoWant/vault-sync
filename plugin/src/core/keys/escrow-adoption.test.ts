import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { KeyRecipientKind } from "../../gen/vaultsync/v1/vault_key_pb";
import { ageRecipient, generateKeyPair } from "../e2ee/hybrid";
import { encodeEscrowBundle, escrowResetPoint, signEscrowRotation, signPublicKey, type EscrowRotation } from "../e2ee/identity";
import { EntryType, escrowResetPayload } from "../e2ee/memberlog";
import { openKeySlot, verifyKeyCommitment } from "../e2ee/keyslot";
import { createProtocolClient } from "../protocol/client";
import { acceptEscrowChange, createEncryptedVault, declineEscrowChange, EscrowChainError, escrowOffer, MemoryEscrowPin, type EscrowKey } from "./encrypted-vault";
import { escrowResets } from "./escrow-resets";
import { nextEntry } from "./member-log";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import { LogVerificationError, MemoryVerifiedLogStore, readMemberLog } from "./verified-log";
import { MemoryEpochKeyStore, VaultKeyManager, type VaultKeyClient } from "./vault-keys";

const serverVaultId = "00000000-0000-4000-8000-000000000000";
const ownerId = "11111111-1111-4111-8111-111111111111";

function escrowKey(signByte: number) {
  const pair = generateKeyPair();
  const signSeed = new Uint8Array(32).fill(signByte);
  const recipient: EscrowKey = {
    keyId: `sha256:${bytesToHex(sha256(pair.publicKey))}`,
    publicKey: pair.publicKey,
    bundle: { signPub: signPublicKey(signSeed), recipient: ageRecipient(pair.publicKey) },
  };
  return { pair, signSeed, recipient, encodedBundle: encodeEscrowBundle(recipient.bundle) };
}

type Key = ReturnType<typeof escrowKey>;

function statement(rotation: EscrowRotation) {
  return {
    $typeName: "vaultsync.v1.EscrowRotationStatement" as const,
    oldBundleHash: rotation.oldBundleHash,
    newBundle: encodeEscrowBundle(rotation.newBundle),
    signature: rotation.signature,
    reset: rotation.reset ?? false,
  };
}

/** The escrow fields of a GetServerInfo response: the chain from `root` through `rotations`, whose head is `head`. */
function serverInfo(head: Key, root: Key, rotations: EscrowRotation[]) {
  return {
    escrowPublicKey: head.recipient.publicKey,
    escrowKeyId: head.recipient.keyId,
    escrowDefault: true,
    escrowRootBundle: root.encodedBundle,
    escrowRotations: rotations.map(statement),
  };
}

/**
 * A vault created with escrow under `old`, after the admin appended a reset
 * point from `old` to `fresh` (the old signing key was lost): the server
 * publishes the chain, and the owner's devices verify logs with it.
 */
async function resetVault() {
  const old = escrowKey(9);
  const fresh = escrowKey(10);
  const server = new MemoryVaultKeyServer(serverVaultId);
  const owner = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(1), userId: ownerId };
  server.userKeys.set(ownerId, owner.publicKey);
  const client = createProtocolClient({ transport: server.transport(ownerId) });
  const creatorStore = new MemoryEpochKeyStore();
  const vault = await createEncryptedVault({
    name: "Secret",
    escrow: old.recipient,
    userKey: owner,
    vaults: client.vaults,
    anchors: client.userKeys,
    verifiedLogs: new MemoryVerifiedLogStore(),
    keys: client.vaultKeys,
    membership: client.membership,
    store: () => creatorStore,
  });
  const rotations = [escrowResetPoint(old.recipient.bundle, fresh.recipient.bundle)];
  server.escrowRotations = rotations;
  const info = serverInfo(fresh, old, rotations);

  /** One of the owner's devices, which pinned `old` before the reset; its escrow key is what escrowOffer gives it now. */
  async function device(pin: MemoryEscrowPin, keys: (client: VaultKeyClient) => VaultKeyClient = (same) => same) {
    const offer = await escrowOffer(info, pin);
    if (offer.recipient === undefined) throw new Error("no escrow offered");
    const trust = { userKey: owner, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: new MemoryVerifiedLogStore(), escrowRotations: rotations };
    const manager = new VaultKeyManager({ vaultId: vault.id, userKey: owner, owner: true, keys: keys(client.vaultKeys), membership: client.membership, store: new MemoryEpochKeyStore(), trust, escrow: offer.recipient });
    return { offer, manager, trust };
  }

  /** A device whose user accepted the reset in the prompt. */
  async function accepting(keys?: (client: VaultKeyClient) => VaultKeyClient) {
    const pin = new MemoryEscrowPin(old.recipient.bundle);
    const { offer } = await device(pin);
    if (offer.change === undefined) throw new Error("no escrow change");
    await acceptEscrowChange(pin, offer.change);
    return device(pin, keys);
  }

  return { server, owner, vault, client, old, fresh, info, device, accepting };
}

type ResetVault = Awaited<ReturnType<typeof resetVault>>;

async function escrowSlotsOpen(vault: ResetVault, epoch: number, key: Key) {
  const slots = vault.server.slotsOf(epoch).filter((slot) => slot.recipientKind === KeyRecipientKind.ESCROW);
  expect(slots.map((slot) => slot.recipientId)).toEqual([key.recipient.keyId]);
  const commitment = vault.server.epochs.find((stored) => stored.epoch === epoch)?.commitment;
  if (commitment === undefined) throw new Error(`no epoch ${String(epoch)}`);
  for (const slot of slots) {
    const epochKey = await openKeySlot(key.pair.privateKey, slot.wrappedKey, { vaultId: vault.vault.id, epoch, recipientKind: "escrow", recipientId: slot.recipientId });
    verifyKeyCommitment(epochKey, commitment, vault.vault.id, epoch);
  }
}

describe("the escrow chain with a reset point", () => {
  it("verifies a chain with a reset point, and raises the reset prompt for a device pinned before it", async () => {
    const vault = await resetVault();
    const pin = new MemoryEscrowPin(vault.old.recipient.bundle);
    const offer = await escrowOffer(vault.info, pin);
    expect(offer.change).toEqual({ pinned: vault.old.recipient.bundle, offered: vault.fresh.recipient.bundle, declined: false });
    expect(offer.recipient?.bundle).toEqual(vault.old.recipient.bundle);
  });

  it("never follows a signed rotation across a reset point", async () => {
    const old = escrowKey(9);
    const fresh = escrowKey(10);
    const next = escrowKey(11);
    const rotations = [escrowResetPoint(old.recipient.bundle, fresh.recipient.bundle), signEscrowRotation(fresh.signSeed, fresh.recipient.bundle, next.recipient.bundle)];
    const offer = await escrowOffer(serverInfo(next, old, rotations), new MemoryEscrowPin(old.recipient.bundle));
    expect(offer.change?.offered).toEqual(next.recipient.bundle);
  });

  it("refuses a reset point with a signature, and an unmarked statement without one", async () => {
    const old = escrowKey(9);
    const fresh = escrowKey(10);
    const signed = signEscrowRotation(old.signSeed, old.recipient.bundle, fresh.recipient.bundle);
    await expect(escrowOffer(serverInfo(fresh, old, [{ ...signed, reset: true }]), new MemoryEscrowPin())).rejects.toThrow(EscrowChainError);
    await expect(escrowOffer(serverInfo(fresh, old, [{ ...signed, signature: new Uint8Array() }]), new MemoryEscrowPin())).rejects.toThrow(EscrowChainError);
  });

  it("refuses a chain that holds a bundle twice", async () => {
    const old = escrowKey(9);
    const fresh = escrowKey(10);
    const rotations = [escrowResetPoint(old.recipient.bundle, fresh.recipient.bundle), escrowResetPoint(fresh.recipient.bundle, old.recipient.bundle)];
    await expect(escrowOffer(serverInfo(old, old, rotations), new MemoryEscrowPin())).rejects.toThrow(EscrowChainError);
  });

  it("stops escrow when the published chain does not extend the chain the device verified", async () => {
    const old = escrowKey(9);
    const fresh = escrowKey(10);
    const other = escrowKey(11);
    const pin = new MemoryEscrowPin();
    await escrowOffer(serverInfo(fresh, old, [escrowResetPoint(old.recipient.bundle, fresh.recipient.bundle)]), pin);
    expect(pin.chain?.length).toBe(2);

    // Shorter than the pinned chain.
    await expect(escrowOffer(serverInfo(old, old, []), pin)).rejects.toThrow(EscrowChainError);
    // As long, but another bundle at the pinned head's position.
    await expect(escrowOffer(serverInfo(other, old, [escrowResetPoint(old.recipient.bundle, other.recipient.bundle)]), pin)).rejects.toThrow(EscrowChainError);
    // Extending it is accepted, and pinned.
    const longer = [escrowResetPoint(old.recipient.bundle, fresh.recipient.bundle), signEscrowRotation(fresh.signSeed, fresh.recipient.bundle, other.recipient.bundle)];
    expect((await escrowOffer(serverInfo(other, old, longer), pin)).change).toBeUndefined();
    expect(pin.chain?.length).toBe(3);
  });

  it("records the accepted bundle's hash, and never counts a first-sight pin as an acceptance", async () => {
    const vault = await resetVault();
    const firstSight = new MemoryEscrowPin();
    expect((await escrowOffer(vault.info, firstSight)).recipient?.adopt).toBeUndefined();
    expect(firstSight.accepted).toBeUndefined();

    const { offer } = await vault.accepting();
    expect(offer.recipient?.adopt).toBe(true);
  });
});

describe("an owner adopting an accepted escrow reset", () => {
  it("writes the owner-signed escrow reset entry with a rotation, and the next epoch is escrowed to the new key", async () => {
    const vault = await resetVault();
    const { manager } = await vault.accepting();

    const state = await manager.sync();

    expect(state.rotated).toBe(true);
    expect(vault.server.currentEpoch).toBe(2);
    const head = vault.server.log.at(-1);
    expect(head?.type).toBe(EntryType.escrowReset);
    expect(vault.server.logState().escrow).toEqual(vault.fresh.recipient.bundle);
    await escrowSlotsOpen(vault, 2, vault.fresh);
  });

  it("adopts at most once for each vault and accepted bundle", async () => {
    const vault = await resetVault();
    const { manager } = await vault.accepting();
    await manager.sync();
    const rotations = vault.server.count("RotateEpoch");

    await manager.sync();
    await (await vault.accepting()).manager.sync();

    expect(vault.server.count("RotateEpoch")).toBe(rotations);
    expect(vault.server.log.filter((entry) => entry.type === EntryType.escrowReset)).toHaveLength(1);
  });

  it("does not adopt a bundle the device only pinned on first sight", async () => {
    const vault = await resetVault();
    const { manager } = await vault.device(new MemoryEscrowPin());

    await manager.sync();

    expect(vault.server.currentEpoch).toBe(1);
    expect(vault.server.log.some((entry) => entry.type === EntryType.escrowReset)).toBe(false);
  });

  it("two accepting owner devices racing leave one escrow reset entry and one new epoch", async () => {
    const vault = await resetVault();
    const first = await vault.accepting();
    const second = await vault.accepting();
    // Both devices read the log before either adopts, then the server runs
    // their rotations one after the other: the loser re-reads, finds the log
    // already names its pin, and sends nothing more.
    vault.server.holdEpochChanges = 2;

    const states = await Promise.all([first.manager.sync(), second.manager.sync()]);

    expect(states.filter((state) => state.rotated)).toHaveLength(1);
    expect(vault.server.currentEpoch).toBe(2);
    expect(vault.server.log.filter((entry) => entry.type === EntryType.escrowReset)).toHaveLength(1);
    await escrowSlotsOpen(vault, 2, vault.fresh);
  });
});

describe("an adoption losing a race", () => {
  it("is rebuilt on the winner's epoch and log head when another rotation wins", async () => {
    const vault = await resetVault();
    const other = await vault.device(new MemoryEscrowPin(vault.old.recipient.bundle));
    let raced = false;
    // Another owner device's rotation lands between the adoption's read and its send.
    const adopter = await vault.accepting((keys) => ({
      ...keys,
      rotateEpoch: async (request) => {
        if (!raced) {
          raced = true;
          await other.manager.rotate();
        }
        return keys.rotateEpoch(request);
      },
    }));

    const state = await adopter.manager.sync();

    expect(raced).toBe(true);
    expect(state.rotated).toBe(true);
    expect(vault.server.currentEpoch).toBe(3);
    expect(vault.server.log.filter((entry) => entry.type === EntryType.escrowReset)).toHaveLength(1);
    await escrowSlotsOpen(vault, 2, vault.old);
    await escrowSlotsOpen(vault, 3, vault.fresh);
  });
});

describe("until the owner adopts", () => {
  it("keeps the vault's escrow on the key its log names: a declining owner's rotation is escrowed to it", async () => {
    const vault = await resetVault();
    const pin = new MemoryEscrowPin(vault.old.recipient.bundle);
    const { offer } = await vault.device(pin);
    if (offer.change === undefined) throw new Error("no escrow change");
    await declineEscrowChange(pin, offer.change);
    const { manager } = await vault.device(pin);

    await manager.sync();
    expect(vault.server.currentEpoch).toBe(1);
    await manager.rotate();

    expect(vault.server.currentEpoch).toBe(2);
    expect(vault.server.logState().escrow).toEqual(vault.old.recipient.bundle);
    await escrowSlotsOpen(vault, 2, vault.old);
  });
});

describe("a device following an owner's escrow reset entry", () => {
  it("wraps new epochs to the adopted key without moving its own pin, and lists the entry for the notice", async () => {
    const vault = await resetVault();
    await (await vault.accepting()).manager.sync();
    const pin = new MemoryEscrowPin(vault.old.recipient.bundle);
    const follower = await vault.device(pin);

    await follower.manager.rotate();

    expect(pin.bundle).toEqual(vault.old.recipient.bundle);
    await escrowSlotsOpen(vault, 3, vault.fresh);
    const { entries, states } = await readMemberLog(follower.trust, vault.vault.id);
    expect(escrowResets(entries, states)).toEqual([{ seq: 2, ownerId, previous: vault.old.recipient.bundle, adopted: vault.fresh.recipient.bundle }]);
  });

  it("stops the vault when the log holds an escrow reset entry signed by a non-owner", async () => {
    const vault = await resetVault();
    const editorSeed = new Uint8Array(32).fill(7);
    vault.server.log.push(
      nextEntry(vault.vault.id, vault.server.log, { type: EntryType.escrowReset, payload: escrowResetPayload(vault.old.recipient.bundle, vault.fresh.recipient.bundle), signSeeds: [editorSeed] }),
    );
    const { manager } = await vault.device(new MemoryEscrowPin(vault.old.recipient.bundle));

    await expect(manager.sync()).rejects.toThrow(LogVerificationError);
  });
});
