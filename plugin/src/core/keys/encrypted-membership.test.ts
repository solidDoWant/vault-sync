import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { generateKeyPair } from "../e2ee/hybrid";
import {
  bundleOf,
  fingerprint,
  invitationKeyPair,
  inviteSignSeed,
  signPublicKey,
  verifyInviteAnchor,
} from "../e2ee/identity";
import { openKeySlot, verifyKeyCommitment } from "../e2ee/keyslot";
import { Role, entryHash, replayLog } from "../e2ee/memberlog";
import { createProtocolClient } from "../protocol/client";
import { addAnchor, readAnchorList } from "./anchor-list";
import { createEncryptedVault } from "./encrypted-vault";
import {
  createEncryptedInvitation,
  leaveEncryptedVault,
  parseInviteLink,
  redeemEncryptedInvitation,
  revokeEncryptedInvitation,
  type RedeemContext,
  setEncryptedMemberRole,
  type EncryptedMembershipContext,
} from "./encrypted-membership";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import type { UserKeyPair } from "./user-key";
import { MemoryEpochKeyStore, VaultKeyManager } from "./vault-keys";
import { LogVerificationError, MemoryVerifiedLogStore } from "./verified-log";

function user(n: number): UserKeyPair {
  return {
    ...generateKeyPair(),
    signSeed: new Uint8Array(32).fill(n),
    userId: `0190a5b4-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
  };
}

const alice = user(1);
const bob = user(2);
const carol = user(3);

/** An encrypted vault alice created on her device, with her signed genesis and epoch 1. */
async function aliceVault() {
  const server = new MemoryVaultKeyServer(
    "0190a5b4-0000-7000-8000-000000000001",
  );
  for (const member of [alice, bob, carol])
    server.userKeys.set(member.userId, member.publicKey);
  const client = createProtocolClient({
    transport: server.transport(alice.userId),
  });
  const store = new MemoryEpochKeyStore();
  /** Each user's device: what it has verified. */
  const devices = new Map<string, MemoryVerifiedLogStore>();
  const verifiedLogs = (key: UserKeyPair): MemoryVerifiedLogStore => {
    const stored = devices.get(key.userId) ?? new MemoryVerifiedLogStore();
    devices.set(key.userId, stored);
    return stored;
  };
  const vault = await createEncryptedVault({
    name: "Secret",
    escrow: undefined,
    userKey: alice,
    vaults: client.vaults,
    anchors: client.userKeys,
    verifiedLogs: verifiedLogs(alice),
    keys: client.vaultKeys,
    membership: client.membership,
    store: () => store,
  });
  const manager = new VaultKeyManager({
    vaultId: vault.id,
    userKey: alice,
    owner: true,
    keys: client.vaultKeys,
    membership: client.membership,
    store,
    trust: { userKey: alice, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: verifiedLogs(alice) },
  });
  await manager.sync();
  const context = (key: UserKeyPair): EncryptedMembershipContext => {
    const own = createProtocolClient({
      transport: server.transport(key.userId),
    });
    return {
      vaultId: vault.id,
      userKey: key,
      membership: own.membership,
      log: own.vaultKeys,
      anchors: own.userKeys,
      verifiedLogs: verifiedLogs(key),
    };
  };
  const redeemer = (key: UserKeyPair): RedeemContext => {
    const own = createProtocolClient({
      transport: server.transport(key.userId),
    });
    return {
      userKey: key,
      membership: own.membership,
      log: own.vaultKeys,
      anchors: own.userKeys,
      verifiedLogs: verifiedLogs(key),
    };
  };
  const keyManager = (key: UserKeyPair) => {
    const own = createProtocolClient({
      transport: server.transport(key.userId),
    });
    return new VaultKeyManager({
      vaultId: vault.id,
      userKey: key,
      owner: false,
      keys: own.vaultKeys,
      membership: own.membership,
      store: new MemoryEpochKeyStore(),
      trust: { userKey: key, log: own.vaultKeys, anchors: own.userKeys, verifiedLogs: verifiedLogs(key) },
    });
  };
  /** Adds the vault's genesis to the anchor list of a member the server seeded. */
  const anchor = async (key: UserKeyPair): Promise<void> => {
    const genesis = server.log[0];
    if (genesis === undefined) throw new Error("no genesis");
    await addAnchor(context(key).anchors, key, verifiedLogs(key), {
      vaultId: vault.id,
      genesisHash: entryHash(genesis),
    });
  };
  return {
    server,
    vault,
    manager,
    anchor,
    verifiedLogs,
    context,
    redeemer,
    keyManager,
    epochKey: (epoch: number) => manager.epochKey(epoch),
  };
}

/** The members of the replayed log, by user id, with their log roles. */
function members(server: MemoryVaultKeyServer): Record<string, number> {
  const state = replayLog(server.vaultId, server.log).at(-1);
  if (state === undefined) throw new Error("empty log");
  return Object.fromEntries([...state.members].map(([userId, member]) => [userId, member.role]));
}

describe("membership changes of an encrypted vault", () => {
  it("invites with a link whose secret opens the invitation's slots and whose anchor names the genesis and the inviter", async () => {
    const { server, vault, context, epochKey } = await aliceVault();

    const created = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.EDITOR,
      0,
    );

    const parts = created.link.split(".");
    expect(parts).toHaveLength(3);
    const [id, secret, anchor] = parts.map((part) =>
      base64urlnopad.decode(part),
    );
    if (id === undefined || secret === undefined || anchor === undefined)
      throw new Error("malformed link");
    expect(id).toHaveLength(16);
    expect(secret).toHaveLength(16);
    const invitationId = created.invitation.id;
    const stored = server.invitations.get(invitationId);
    expect(stored?.idHash).toEqual(sha256(id));
    expect(stored?.anchor).toEqual(anchor);
    const genesis = server.log[0];
    if (genesis === undefined) throw new Error("no genesis");
    expect(verifyInviteAnchor(secret, vault.id, invitationId, anchor)).toEqual({
      genesisHash: entryHash(genesis),
      inviterFingerprint: fingerprint(
        bundleOf(
          { kemSeed: alice.privateKey, signSeed: alice.signSeed },
          alice.userId,
        ),
      ),
    });

    const invitation = replayLog(vault.id, server.log)
      .at(-1)
      ?.invitations.get(invitationId);
    expect(invitation?.role).toBe(Role.editor);
    expect(invitation?.signPub).toEqual(
      signPublicKey(inviteSignSeed(secret, vault.id, invitationId)),
    );
    const slot = stored?.slots[0];
    if (slot === undefined) throw new Error("no slot");
    expect(stored?.slots).toHaveLength(1);
    const key = await openKeySlot(
      invitationKeyPair(secret, vault.id, invitationId).privateKey,
      slot.wrappedKey,
      {
        vaultId: vault.id,
        epoch: 1,
        recipientKind: "invitation",
        recipientId: invitationId,
      },
    );
    const commitment = server.epochs[0]?.commitment;
    if (commitment === undefined) throw new Error("no epoch");
    expect(() => {
      verifyKeyCommitment(key, commitment, vault.id, 1);
    }).not.toThrow();
  });

  it("is accepted for invite, revoke, redeem, role change, removal and leave, and the log replays to the expected members", async () => {
    const { server, vault, manager, context, redeemer, epochKey } =
      await aliceVault();
    const invite = async (role: VaultRole) => {
      const created = await createEncryptedInvitation(
        { ...context(alice), currentEpoch: 1, epochKey },
        role,
        0,
      );
      const link = parseInviteLink(created.link);
      if (link === undefined) throw new Error("malformed link");
      return link;
    };

    const revoked = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.VIEWER,
      0,
    );
    await revokeEncryptedInvitation(context(alice), revoked.invitation.id);
    expect(replayLog(vault.id, server.log).at(-1)?.invitations.size).toBe(0);
    expect(server.invitations.has(revoked.invitation.id)).toBe(false);

    const forBob = await invite(VaultRole.EDITOR);
    const forCarol = await invite(VaultRole.EDITOR);
    const joined = await redeemEncryptedInvitation(redeemer(bob), forBob);
    expect(joined).toMatchObject({ id: vault.id, role: VaultRole.EDITOR });
    await redeemEncryptedInvitation(redeemer(carol), forCarol);
    expect(server.members.get(bob.userId)?.role).toBe(VaultRole.EDITOR);
    expect(members(server)).toEqual({
      [alice.userId]: Role.owner,
      [bob.userId]: Role.editor,
      [carol.userId]: Role.editor,
    });
    await manager.sync();

    await setEncryptedMemberRole(context(alice), bob.userId, VaultRole.OWNER);
    expect(server.members.get(bob.userId)?.role).toBe(VaultRole.OWNER);
    await manager.removeMember(carol.userId);
    expect(server.members.has(carol.userId)).toBe(false);
    await leaveEncryptedVault(context(alice));
    expect(server.members.has(alice.userId)).toBe(false);

    expect(members(server)).toEqual({ [bob.userId]: Role.owner });
  });

  it("rebuilds its entry on top of the new head when another change took the log's next position", async () => {
    const { server, context, epochKey, anchor } = await aliceVault();
    server.seedMember(bob, VaultRole.OWNER, alice);
    await anchor(bob);
    const head = server.log.length;

    // bob's change lands between alice's read of the log and her request.
    const aliceContext = context(alice);
    const racing: EncryptedMembershipContext = {
      ...aliceContext,
      log: {
        listLogEntries: async (request) => {
          const response = await aliceContext.log.listLogEntries(request);
          if (response.nextPageToken === "" && server.log.length === head)
            await setEncryptedMemberRole(
              context(bob),
              bob.userId,
              VaultRole.OWNER,
            );
          return response;
        },
      },
    };
    await createEncryptedInvitation(
      { ...racing, currentEpoch: 1, epochKey },
      VaultRole.EDITOR,
      0,
    );

    expect(server.log).toHaveLength(head + 2);
    expect(replayLog(server.vaultId, server.log).at(-1)?.invitations.size).toBe(
      1,
    );
  });

  it("redeems a link into the epoch keys and the anchor of the vault's genesis", async () => {
    const { server, vault, context, redeemer, keyManager, epochKey } =
      await aliceVault();
    const created = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.VIEWER,
      0,
    );
    const link = parseInviteLink(created.link);
    if (link === undefined) throw new Error("malformed link");

    await redeemEncryptedInvitation(redeemer(bob), link);

    const bobs = keyManager(bob);
    await bobs.sync();
    expect(bobs.epochKey(1)).toEqual(epochKey(1));
    const genesis = server.log[0];
    if (genesis === undefined) throw new Error("no genesis");
    const { anchors } = await readAnchorList(
      redeemer(bob).anchors,
      bob,
      new MemoryVerifiedLogStore(),
    );
    expect(anchors).toEqual([
      { vaultId: vault.id, genesisHash: entryHash(genesis) },
    ]);
    expect(server.invitations.has(created.invitation.id)).toBe(false);
  });

  it("refuses a link whose anchor was changed, before redeeming", async () => {
    const { server, context, redeemer, epochKey } = await aliceVault();
    const created = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.VIEWER,
      0,
    );
    const link = parseInviteLink(created.link);
    if (link === undefined) throw new Error("malformed link");
    const anchor = link.anchor.slice();
    anchor[0] = (anchor[0] ?? 0) ^ 1;

    await expect(
      redeemEncryptedInvitation(redeemer(bob), { ...link, anchor }),
    ).rejects.toThrow(/does not match the invitation/);
    expect(server.members.has(bob.userId)).toBe(false);
  });

  it("refuses an epoch the server lists without its owner-signed record, before redeeming", async () => {
    const { server, context, redeemer, epochKey } = await aliceVault();
    const created = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.VIEWER,
      0,
    );
    const link = parseInviteLink(created.link);
    if (link === undefined) throw new Error("malformed link");
    const epoch = server.epochs[0];
    if (epoch === undefined) throw new Error("no epoch");
    delete epoch.record;

    await expect(
      redeemEncryptedInvitation(redeemer(bob), link),
    ).rejects.toBeInstanceOf(LogVerificationError);
    expect(server.members.has(bob.userId)).toBe(false);
  });

  it("redeems on top of the new head when another change took the log's next position", async () => {
    const { server, context, redeemer, epochKey } = await aliceVault();
    const created = await createEncryptedInvitation(
      { ...context(alice), currentEpoch: 1, epochKey },
      VaultRole.EDITOR,
      0,
    );
    const link = parseInviteLink(created.link);
    if (link === undefined) throw new Error("malformed link");
    const head = server.log.length;

    // alice's role change lands between bob's read of the log and his request.
    const bobs = redeemer(bob);
    const racing: RedeemContext = {
      ...bobs,
      log: {
        listLogEntries: async (request) => {
          const response = await bobs.log.listLogEntries(request);
          if (response.nextPageToken === "" && server.log.length === head)
            await setEncryptedMemberRole(
              context(alice),
              alice.userId,
              VaultRole.OWNER,
            );
          return response;
        },
      },
    };
    await redeemEncryptedInvitation(racing, link);

    expect(server.log).toHaveLength(head + 2);
    expect(members(server)).toEqual({
      [alice.userId]: Role.owner,
      [bob.userId]: Role.editor,
    });
  });

  it("is refused without its entry", async () => {
    const { server, vault } = await aliceVault();
    const client = createProtocolClient({
      transport: server.transport(alice.userId),
    });
    await expect(
      client.membership.leaveVault({ vaultId: vault.id }),
    ).rejects.toThrow(/log_entry is required/);
  });
});
