import { describe, expect, it } from "vitest";

import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { generateKeyPair } from "../e2ee/hybrid";
import { bundleOf } from "../e2ee/identity";
import { EntryType, genesisPayload, setRolePayload, type Entry } from "../e2ee/memberlog";
import { createProtocolClient } from "../protocol/client";
import { addAnchor, readAnchorList } from "./anchor-list";
import { createEncryptedVault } from "./encrypted-vault";
import {
  createEncryptedInvitation,
  parseInviteLink,
  redeemEncryptedInvitation,
  revokeEncryptedInvitation,
  setEncryptedMemberRole,
  type EncryptedMembershipContext,
  type RedeemContext,
} from "./encrypted-membership";
import { genesisEntry, nextEntry } from "./member-log";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import type { UserKeyPair } from "./user-key";
import { MemoryEpochKeyStore } from "./vault-keys";
import { LogVerificationError, MemoryVerifiedLogStore } from "./verified-log";

function user(n: number): UserKeyPair {
  return { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(n), userId: `0190a5b4-0000-7000-8000-0000000003${String(n).padStart(2, "0")}` };
}

const alice = user(1);
const bob = user(2);
const mallory = user(3);

/** An encrypted vault alice created on her first device, with bob seeded as an editor. */
async function aliceVault() {
  const server = new MemoryVaultKeyServer("0190a5b4-0000-7000-8000-000000000301");
  for (const member of [alice, bob, mallory]) server.userKeys.set(member.userId, member.publicKey);
  const client = createProtocolClient({ transport: server.transport(alice.userId) });
  const store = new MemoryEpochKeyStore();
  const firstDevice = new MemoryVerifiedLogStore();
  const vault = await createEncryptedVault({
    name: "Secret",
    escrow: undefined,
    userKey: alice,
    vaults: client.vaults,
    anchors: client.userKeys,
    verifiedLogs: firstDevice,
    keys: client.vaultKeys,
    membership: client.membership,
    store: () => store,
  });
  server.seedMember(bob, VaultRole.EDITOR, alice);
  /** A device of `key`'s with what it has verified in `verifiedLogs`. */
  const context = (key: UserKeyPair, verifiedLogs: MemoryVerifiedLogStore): EncryptedMembershipContext => {
    const own = createProtocolClient({ transport: server.transport(key.userId) });
    return { vaultId: vault.id, userKey: key, membership: own.membership, log: own.vaultKeys, anchors: own.userKeys, verifiedLogs };
  };
  const redeemer = (key: UserKeyPair, verifiedLogs: MemoryVerifiedLogStore): RedeemContext => {
    const own = createProtocolClient({ transport: server.transport(key.userId) });
    return { userKey: key, membership: own.membership, log: own.vaultKeys, anchors: own.userKeys, verifiedLogs };
  };
  const invite = async () => {
    const created = await createEncryptedInvitation({ ...context(alice, firstDevice), currentEpoch: 1, epochKey: (epoch) => store.keys.get(epoch) }, VaultRole.VIEWER, 0);
    const link = parseInviteLink(created.link);
    if (link === undefined) throw new Error("malformed link");
    return { link, invitationId: created.invitation.id };
  };
  return { server, vault, firstDevice, context, redeemer, invite };
}

/** An entry `signer` signed after the last of `log`. */
function signedAfter(vaultId: string, log: readonly Entry[], type: number, payload: Uint8Array, signer: UserKeyPair): Entry {
  return nextEntry(vaultId, log, { type, payload, signSeeds: [signer.signSeed] });
}

describe("a newcomer verifying the vault's membership log from its invite link", () => {
  it("refuses a log that starts from another genesis, before redeeming or anchoring it", async () => {
    const { server, vault, redeemer, invite } = await aliceVault();
    const { link } = await invite();
    const invite_ = server.log.at(-1);
    if (invite_ === undefined) throw new Error("no invite entry");
    // The server forges a whole log: mallory's genesis, then the same invitation.
    const forgedGenesis = genesisEntry(vault.id, genesisPayload(bundleOf({ kemSeed: mallory.privateKey, signSeed: mallory.signSeed }, mallory.userId), undefined), mallory.signSeed);
    const forged = [forgedGenesis, signedAfter(vault.id, [forgedGenesis], EntryType.invite, invite_.payload, mallory)];
    server.log.splice(0, server.log.length, ...forged);
    const newcomer = new MemoryVerifiedLogStore();

    await expect(redeemEncryptedInvitation(redeemer(mallory, newcomer), link)).rejects.toBeInstanceOf(LogVerificationError);

    expect(server.count("RedeemInvitation")).toBe(0);
    expect(server.anchorLists.has(mallory.userId)).toBe(false);
    expect(newcomer.checkpoints.size).toBe(0);
  });

  it("refuses an entry the server injected into the real log", async () => {
    const { server, vault, redeemer, invite } = await aliceVault();
    const { link } = await invite();
    // An owner entry signed by a non-owner: the server makes bob an owner.
    server.log.push(signedAfter(vault.id, server.log, EntryType.setRole, setRolePayload(bob.userId, 0x01), bob));

    await expect(redeemEncryptedInvitation(redeemer(mallory, new MemoryVerifiedLogStore()), link)).rejects.toBeInstanceOf(LogVerificationError);

    expect(server.count("RedeemInvitation")).toBe(0);
  });

  it("redeems the real log and records its head as verified", async () => {
    const { server, vault, redeemer, invite } = await aliceVault();
    const { link } = await invite();
    const newcomer = new MemoryVerifiedLogStore();

    await redeemEncryptedInvitation(redeemer(mallory, newcomer), link);

    expect(server.count("RedeemInvitation")).toBe(1);
    expect(newcomer.checkpoints.get(vault.id)?.seq).toBe(server.log.length - 1);
  });
});

describe("a user's other device verifying the log from the user's anchor list", () => {
  it("refuses an anchor list of a lower version than it has seen", async () => {
    const { server, context } = await aliceVault();
    const secondDevice = new MemoryVerifiedLogStore();
    const version1 = server.anchorLists.get(alice.userId);
    if (version1 === undefined) throw new Error("no anchor list");
    // The first device anchors another vault: the list is at version 2, which the second device then reads.
    await addAnchor(context(alice, new MemoryVerifiedLogStore()).anchors, alice, new MemoryVerifiedLogStore(), { vaultId: "0190a5b4-0000-7000-8000-000000000399", genesisHash: new Uint8Array(32).fill(7) });
    await setEncryptedMemberRole(context(alice, secondDevice), bob.userId, VaultRole.VIEWER);
    expect(secondDevice.anchorVersion).toBe(2);
    const head = server.log.length;

    server.anchorLists.set(alice.userId, version1);

    await expect(readAnchorList(context(alice, secondDevice).anchors, alice, secondDevice)).rejects.toBeInstanceOf(LogVerificationError);
    await expect(setEncryptedMemberRole(context(alice, secondDevice), bob.userId, VaultRole.EDITOR)).rejects.toBeInstanceOf(LogVerificationError);
    expect(server.log).toHaveLength(head);
  });

  it("accepts the list at the version it has seen", async () => {
    const { server, context } = await aliceVault();
    const secondDevice = new MemoryVerifiedLogStore();
    await setEncryptedMemberRole(context(alice, secondDevice), bob.userId, VaultRole.VIEWER);
    await setEncryptedMemberRole(context(alice, secondDevice), bob.userId, VaultRole.EDITOR);

    expect(secondDevice.anchorVersion).toBe(1);
    expect(server.members.get(bob.userId)?.role).toBe(VaultRole.EDITOR);
  });

  it("refuses a log whose genesis is not the anchored one", async () => {
    const { server, vault, context } = await aliceVault();
    const forged = genesisEntry(vault.id, genesisPayload(bundleOf({ kemSeed: alice.privateKey, signSeed: alice.signSeed }, alice.userId), undefined), mallory.signSeed);
    server.log.splice(0, server.log.length, forged);

    await expect(setEncryptedMemberRole(context(alice, new MemoryVerifiedLogStore()), bob.userId, VaultRole.VIEWER)).rejects.toBeInstanceOf(LogVerificationError);
  });
});

describe("a device that has verified the log up to a position", () => {
  it("refuses a log shorter than it has verified", async () => {
    const { server, firstDevice, context, invite } = await aliceVault();
    const { invitationId } = await invite();
    const verified = server.log.length;
    expect(firstDevice.checkpoints.get(server.vaultId)?.seq).toBe(verified - 1);
    await setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.VIEWER);
    // The server rolls back alice's set-role entry and the invite before it.
    server.log.splice(verified - 1);

    await expect(revokeEncryptedInvitation(context(alice, firstDevice), invitationId)).rejects.toThrow(/shorter than this device has verified/);
    expect(server.log).toHaveLength(verified - 1);
  });

  it("refuses a log with another entry at a position it has verified", async () => {
    const { server, vault, firstDevice, context } = await aliceVault();
    await setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.VIEWER);
    const verified = server.log.length;
    expect(firstDevice.checkpoints.get(vault.id)?.seq).toBe(verified - 1);
    await setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.EDITOR);
    expect(firstDevice.checkpoints.get(vault.id)?.seq).toBe(verified);
    // A fork: another validly signed entry in place of the last one this device verified.
    server.log.splice(verified - 1);
    server.log.push(signedAfter(vault.id, server.log, EntryType.setRole, setRolePayload(bob.userId, 0x01), alice));

    await expect(setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.VIEWER)).rejects.toThrow(/forks from the one this device has verified/);
    expect(server.log).toHaveLength(verified);
  });

  it("accepts a longer log that extends the one it has verified", async () => {
    const { server, vault, firstDevice, context } = await aliceVault();
    await setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.VIEWER);
    server.log.push(signedAfter(vault.id, server.log, EntryType.setRole, setRolePayload(bob.userId, 0x02), alice));

    await setEncryptedMemberRole(context(alice, firstDevice), bob.userId, VaultRole.VIEWER);

    expect(firstDevice.checkpoints.get(vault.id)?.seq).toBe(server.log.length - 1);
  });
});
