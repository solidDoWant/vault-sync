import { describe, expect, it } from "vitest";

import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { KeyRecipientKind } from "../../gen/vaultsync/v1/vault_key_pb";
import { generateKey } from "../e2ee/e2ee";
import { generateKeyPair } from "../e2ee/hybrid";
import { bundleOf } from "../e2ee/identity";
import { keyCommitment, sealKeySlot } from "../e2ee/keyslot";
import { EntryType, entryHash, redeemPayload } from "../e2ee/memberlog";
import { addAnchor } from "../keys/anchor-list";
import { nextEntry } from "../keys/member-log";
import { MemoryVaultKeyServer } from "../keys/memory-vault-keys";
import type { UserKeyPair } from "../keys/user-key";
import { MemoryEpochKeyStore, VaultKeyManager } from "../keys/vault-keys";
import { LogVerificationError, MemoryVerifiedLogStore } from "../keys/verified-log";
import { createProtocolClient } from "../protocol/client";
import { InMemoryServer } from "./memory-server";
import { RemoteContentError } from "./remote";
import { Device } from "./testing";

// docs/design/encryption.md, "Hard stop": on any verification failure the
// device stops syncing that vault, keeps the local files, and reports what
// failed. It never falls back to trusting the server.

const vaultId = "0190a5b4-0000-7000-8000-000000000501";

function user(n: number): UserKeyPair {
  return { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(n), userId: `0190a5b4-0000-7000-8000-0000000005${String(n).padStart(2, "0")}` };
}

const alice = user(1); // owner
const carol = user(2); // editor
const erin = user(3); // a user the server makes up a membership for

/**
 * An encrypted vault of alice (owner) and carol (editor) at epoch 1, and
 * alice's device syncing it with her real key manager: `keys` is the vault's
 * key data on the server, `server` its revisions.
 */
async function ownerDevice() {
  const keys = new MemoryVaultKeyServer(vaultId);
  for (const [member, role] of [
    [alice, VaultRole.OWNER],
    [carol, VaultRole.EDITOR],
  ] as const) {
    keys.seedMember(member, role);
    const genesis = keys.log[0];
    if (genesis === undefined) throw new Error("no genesis");
    const own = createProtocolClient({ transport: keys.transport(member.userId) });
    await addAnchor(own.userKeys, member, new MemoryVerifiedLogStore(), { vaultId, genesisHash: entryHash(genesis) });
  }
  const client = createProtocolClient({ transport: keys.transport(alice.userId) });
  const manager = new VaultKeyManager({
    vaultId,
    userKey: alice,
    owner: true,
    keys: client.vaultKeys,
    membership: client.membership,
    store: new MemoryEpochKeyStore(),
    trust: { userKey: alice, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: new MemoryVerifiedLogStore() },
  });
  await manager.sync();
  const server = new InMemoryServer({ vaultId, encrypted: true });
  server.currentEpoch = keys.currentEpoch;
  const owner = new Device(server, "alice-laptop", { keys: manager });
  await owner.write("plan.md", "first draft\n");
  await owner.sync();
  return { keys, server, owner, manager };
}

/** The server's head seq: how many revisions were committed. */
async function headSeq(server: InMemoryServer): Promise<bigint> {
  return (await createProtocolClient({ transport: server.transport }).sync.listChanges({ vaultId, sinceSeq: 0n })).headSeq;
}

/**
 * Edits the device's files, syncs, and checks the hard stop: the sync fails
 * with the verification error, nothing reaches the server, the files stay
 * as the user left them, no retry is scheduled, and a later sync (even one
 * a remote change asks for) is refused without asking the server again.
 */
async function expectHardStop(owner: Device, server: InMemoryServer, keys: MemoryVaultKeyServer): Promise<void> {
  const before = await headSeq(server);
  await owner.write("plan.md", "second draft\n");
  await owner.write("new.md", "a new note\n");
  owner.timers.fire(2_000);

  await expect(owner.sync()).rejects.toBeInstanceOf(LogVerificationError);

  expect(owner.engine.status).toBe("error");
  expect(owner.engine.lastError).toBeInstanceOf(LogVerificationError);
  expect(String(owner.engine.lastError)).toContain("The server sent key or membership data that doesn't verify");
  expect(await owner.files()).toEqual({ "plan.md": "second draft\n", "new.md": "a new note\n" });
  expect(await headSeq(server)).toBe(before);
  expect(owner.timers.delays()).toEqual([]);

  const sent = keys.requests.length;
  owner.engine.notifyRemoteChange();
  await expect(owner.sync()).rejects.toBeInstanceOf(LogVerificationError);
  await expect(owner.engine.start()).rejects.toBeInstanceOf(LogVerificationError);
  expect(keys.requests.length).toBe(sent);
  expect(await headSeq(server)).toBe(before);
  expect(owner.timers.delays()).toEqual([]);
}

describe("a verification failure stops syncing the vault and keeps its files", () => {
  it("[P4-19] stops the owner's device when the server adds a member key to the vault's log", async () => {
    const { keys, server, owner } = await ownerDevice();
    // A redeem entry for a key no owner invited: only the made-up member signed it.
    const forged = bundleOf({ kemSeed: erin.privateKey, signSeed: erin.signSeed }, erin.userId);
    keys.log.push(nextEntry(vaultId, keys.log, { type: EntryType.redeem, payload: redeemPayload(crypto.randomUUID(), forged), signSeeds: [erin.signSeed] }));
    keys.addMember(erin.userId, VaultRole.EDITOR, erin.publicKey);

    await expectHardStop(owner, server, keys);
    expect(keys.count("AddKeySlots")).toBe(0);
  });

  it("[P4-19] stops the owner's device when the server swaps a member's key in the vault's log", async () => {
    const { keys, server, owner } = await ownerDevice();
    // Carol's redeem entry, rewritten to carry a key the server made up.
    const swapped = user(9);
    const index = keys.log.findIndex((entry) => entry.type === EntryType.redeem);
    const forged = bundleOf({ kemSeed: swapped.privateKey, signSeed: swapped.signSeed }, carol.userId);
    keys.log[index] = nextEntry(vaultId, keys.log.slice(0, index), { type: EntryType.redeem, payload: redeemPayload(crypto.randomUUID(), forged), signSeeds: [swapped.signSeed] });

    await expectHardStop(owner, server, keys);
    expect(keys.count("AddKeySlots")).toBe(0);
  });

  it("[P4-20] stops the device when the server injects an epoch no owner signed, and never encrypts under it", async () => {
    const { keys, server, owner } = await ownerDevice();
    const epochKey = generateKey();
    keys.epochs.push({ epoch: 2, commitment: keyCommitment(epochKey, vaultId, 2), creator: alice.userId, record: undefined });
    keys.slots.push({
      epoch: 2,
      recipientKind: KeyRecipientKind.USER,
      recipientId: alice.userId,
      wrappedKey: await sealKeySlot(alice.publicKey, epochKey, { vaultId, epoch: 2, recipientKind: "user", recipientId: alice.userId }),
      creator: alice.userId,
    });
    keys.currentEpoch = 2;
    server.currentEpoch = 2;

    await expectHardStop(owner, server, keys);
  });

  it("[P4-20] stops the device when the server rolls back the membership log", async () => {
    const { keys, server, owner } = await ownerDevice();
    keys.log.pop();

    await expectHardStop(owner, server, keys);
  });

  it("[P4-20] stops the device when the server rolls back the epoch, and never encrypts under the older key", async () => {
    const { keys, server, owner, manager } = await ownerDevice();
    keys.rotationPending = true;
    await manager.sync();
    server.currentEpoch = keys.currentEpoch;
    await owner.write("plan.md", "under epoch 2\n");
    await owner.sync();
    expect(server.currentEpoch).toBe(2);

    keys.epochs.pop();
    keys.currentEpoch = 1;
    server.currentEpoch = 1;

    await expectHardStop(owner, server, keys);
  });

  it("[P4-10] refuses plaintext revisions the server injects into a vault created encrypted, whatever conversion seq it reports", async () => {
    const { keys, server, owner } = await ownerDevice();
    const note = [...(await owner.journal.load()).docs.values()].find((doc) => doc.path === "plan.md");
    if (note === undefined) throw new Error("no plan.md");
    // The server claims a conversion the verified log does not record, and
    // serves epoch-0 revisions: an edit of a member's note and a new file.
    keys.conversionSeq = 1n << 60n;
    server.commit({ documentId: note.documentId, path: "plan.md", content: "content forged by the server\n" });
    server.commit({ documentId: crypto.randomUUID(), path: "injected.md", content: "file forged by the server\n" });

    await expect(owner.sync()).rejects.toBeInstanceOf(RemoteContentError);

    expect(await owner.files()).toEqual({ "plan.md": "first draft\n" });
    expect(owner.engine.status).toBe("error");
  });

  it("keeps syncing an honest vault with the real key manager", async () => {
    const { server, owner } = await ownerDevice();
    const before = await headSeq(server);
    await owner.write("plan.md", "second draft\n");

    await owner.sync();

    expect(await headSeq(server)).toBe(before + 1n);
    expect(owner.engine.status).toBe("idle");
  });
});
