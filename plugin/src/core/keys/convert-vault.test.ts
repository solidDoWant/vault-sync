import { describe, expect, it } from "vitest";

import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { KeyRecipientKind } from "../../gen/vaultsync/v1/vault_key_pb";
import { deriveSubkey, pathKey } from "../e2ee/e2ee";
import { generateKeyPair } from "../e2ee/hybrid";
import { bundleOf, fingerprint, formatFingerprint } from "../e2ee/identity";
import { EntryType, replayLog } from "../e2ee/memberlog";
import { openKeySlot } from "../e2ee/keyslot";
import { createProtocolClient } from "../protocol/client";
import { InMemoryServer } from "../sync/memory-server";
import { Device } from "../sync/testing";
import { ConversionRefusedError, FingerprintsChangedError, conversionMembers, convertVault, type ConversionMember } from "./convert-vault";
import { logRole } from "./encrypted-membership";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import type { UserKeyPair } from "./user-key";
import { MemoryVerifiedLogStore } from "./verified-log";
import { MemoryEpochKeyStore, VaultKeyManager } from "./vault-keys";

const vaultId = "0190a5b4-0000-7000-8000-000000000001";
const ownerId = "0190a5b4-0000-7000-8000-000000000101";
const editorId = "0190a5b4-0000-7000-8000-000000000102";
const viewerId = "0190a5b4-0000-7000-8000-000000000103";

function userKey(userId: string, seed: number): UserKeyPair {
  return { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(seed), userId };
}

function fingerprintOf(key: UserKeyPair): string {
  return formatFingerprint(fingerprint(bundleOf({ kemSeed: key.privateKey, signSeed: key.signSeed }, key.userId)));
}

/** A plaintext vault with an owner, an editor and a viewer, and two live documents and a deleted one. */
async function plaintextVault() {
  const sync = new InMemoryServer({ vaultId });
  const device = new Device(sync, "device-a");
  await device.write("a.md", "a\n");
  await device.write("b.md", "b\n");
  await device.write("gone.md", "gone\n");
  await device.sync();
  await device.vault.delete("gone.md");
  await device.sync();

  const keys = new MemoryVaultKeyServer(vaultId);
  keys.plaintextVault();
  const owner = userKey(ownerId, 1);
  const editor = userKey(editorId, 2);
  const viewer = userKey(viewerId, 3);
  keys.addPlaintextMember(ownerId, VaultRole.OWNER, owner);
  keys.addPlaintextMember(editorId, VaultRole.EDITOR, editor);
  keys.addPlaintextMember(viewerId, VaultRole.VIEWER, viewer);
  keys.headSeq = sync.currentHeadSeq;
  keys.liveDocuments = new Set(sync.liveDocuments().values());

  const client = createProtocolClient({ transport: keys.transport(ownerId) });
  const syncClient = createProtocolClient({ transport: sync.transport });
  const store = new MemoryEpochKeyStore();
  const convert = (compared: readonly ConversionMember[]) =>
    convertVault({
      vaultId,
      userKey: owner,
      compared,
      escrow: undefined,
      membership: client.membership,
      sync: syncClient.sync,
      keys: client.vaultKeys,
      anchors: client.userKeys,
      verifiedLogs: new MemoryVerifiedLogStore(),
      store,
    });
  return { sync, keys, owner, editor, viewer, client, store, convert };
}

describe("converting a plaintext vault in place", () => {
  it("[P4-23] shows every member's key fingerprint, as the server reports it, before converting", async () => {
    const { client, owner, editor, viewer, keys } = await plaintextVault();

    const members = await conversionMembers(client.membership, vaultId);

    expect(members.map((member) => [member.userId, member.role, member.fingerprint])).toEqual([
      [ownerId, VaultRole.OWNER, fingerprintOf(owner)],
      [editorId, VaultRole.EDITOR, fingerprintOf(editor)],
      [viewerId, VaultRole.VIEWER, fingerprintOf(viewer)],
    ]);
    expect(keys.count("ConvertVault")).toBe(0);
  });

  it("[P4-23] does not convert when the server reports another key than the one the owner compared", async () => {
    const { client, keys, convert } = await plaintextVault();
    const compared = await conversionMembers(client.membership, vaultId);
    // The server swaps the editor's key after the owner compared the fingerprints.
    keys.addPlaintextMember(editorId, VaultRole.EDITOR, userKey(editorId, 7));

    await expect(convert(compared)).rejects.toBeInstanceOf(FingerprintsChangedError);
    expect(keys.count("ConvertVault")).toBe(0);
    expect(keys.encrypted).toBe(false);
  });

  it("[P4-23] does not convert with fingerprints the owner did not compare for every member", async () => {
    const { client, keys, convert } = await plaintextVault();
    const compared = await conversionMembers(client.membership, vaultId);

    await expect(convert(compared.slice(0, 2))).rejects.toBeInstanceOf(FingerprintsChangedError);
    expect(keys.count("ConvertVault")).toBe(0);
  });

  it("[P4-10] converts with every member and their role in the log, a slot for each in epoch 1, and every live document's path key", async () => {
    const { sync, keys, client, store, editor, viewer, convert } = await plaintextVault();
    const compared = await conversionMembers(client.membership, vaultId);

    const conversionSeq = await convert(compared);

    expect(keys.encrypted).toBe(true);
    expect(conversionSeq).toBe(sync.currentHeadSeq);
    expect(keys.conversionSeq).toBe(sync.currentHeadSeq);
    expect(keys.log.map((entry) => entry.type)).toEqual([EntryType.genesis, EntryType.members]);
    const state = replayLog(vaultId, keys.log).at(-1);
    expect(new Map([...(state?.members ?? [])].map(([id, member]) => [id, member.role]))).toEqual(
      new Map([
        [ownerId, logRole(VaultRole.OWNER)],
        [editorId, logRole(VaultRole.EDITOR)],
        [viewerId, logRole(VaultRole.VIEWER)],
      ]),
    );
    expect(keys.currentEpoch).toBe(1);
    const epochKey = store.keys.get(1);
    if (epochKey === undefined) throw new Error("the owner device holds no epoch 1 key");
    for (const member of [editor, viewer]) {
      const slot = keys.slotsOf(1).find((stored) => stored.recipientKind === KeyRecipientKind.USER && stored.recipientId === member.userId);
      if (slot === undefined) throw new Error(`no slot for ${member.userId}`);
      expect(await openKeySlot(member.privateKey, slot.wrappedKey, { vaultId, epoch: 1, recipientKind: "user", recipientId: member.userId })).toEqual(epochKey);
    }
    const sent = keys.requests.filter((request) => request.procedure === "ConvertVault");
    expect(sent).toHaveLength(1);
    const secret = deriveSubkey(epochKey, "path_key_secret");
    const [request] = sent;
    for (const path of ["a.md", "b.md"]) {
      expect(containsBytes(request?.bytes ?? new Uint8Array(), pathKey(secret, path))).toBe(true);
    }
    expect(containsBytes(request?.bytes ?? new Uint8Array(), pathKey(secret, "gone.md"))).toBe(false);
  });

  it("[P4-10] signs the head seq it read the documents at as the bound of the plaintext history, which readers take instead of the server's conversion seq", async () => {
    const { sync, keys, client, owner, convert } = await plaintextVault();

    await convert(await conversionMembers(client.membership, vaultId));

    const signed = replayLog(vaultId, keys.log).at(-1)?.convertedAtSeq;
    expect(signed).toBe(sync.currentHeadSeq);
    // The server reports a later conversion than the signed one.
    keys.conversionSeq = sync.currentHeadSeq + 5n;
    const manager = new VaultKeyManager({
      vaultId,
      userKey: owner,
      owner: true,
      keys: client.vaultKeys,
      membership: client.membership,
      store: new MemoryEpochKeyStore(),
      trust: { userKey: owner, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: new MemoryVerifiedLogStore() },
    });
    await manager.sync();
    expect(manager.conversionSeq()).toBe(sync.currentHeadSeq);
  });

  it("[P4-10] writes a members entry with the bound of the plaintext history when the owner is the vault's only member", async () => {
    const sync = new InMemoryServer({ vaultId });
    const device = new Device(sync, "device-a");
    await device.write("a.md", "a\n");
    await device.sync();
    const keys = new MemoryVaultKeyServer(vaultId);
    keys.plaintextVault();
    const owner = userKey(ownerId, 1);
    keys.addPlaintextMember(ownerId, VaultRole.OWNER, owner);
    keys.headSeq = sync.currentHeadSeq;
    keys.liveDocuments = new Set(sync.liveDocuments().values());
    const client = createProtocolClient({ transport: keys.transport(ownerId) });

    await convertVault({
      vaultId,
      userKey: owner,
      compared: await conversionMembers(client.membership, vaultId),
      escrow: undefined,
      membership: client.membership,
      sync: createProtocolClient({ transport: sync.transport }).sync,
      keys: client.vaultKeys,
      anchors: client.userKeys,
      verifiedLogs: new MemoryVerifiedLogStore(),
      store: new MemoryEpochKeyStore(),
    });

    expect(keys.log.map((entry) => entry.type)).toEqual([EntryType.genesis, EntryType.members]);
    const state = replayLog(vaultId, keys.log).at(-1);
    expect(state?.members.size).toBe(1);
    expect(state?.convertedAtSeq).toBe(sync.currentHeadSeq);
  });

  it("[P4-10] is refused, listing them, while a member has no key", async () => {
    const { client, keys, convert } = await plaintextVault();
    keys.addPlaintextMember(viewerId, VaultRole.VIEWER);
    const compared = await conversionMembers(client.membership, vaultId);
    expect(compared.find((member) => member.userId === viewerId)?.fingerprint).toBeUndefined();

    const refused = await convert(compared).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConversionRefusedError);
    expect((refused as ConversionRefusedError).membersWithoutKey).toEqual([viewerId]);
    expect(keys.encrypted).toBe(false);
  });

  it("is refused, listing them, while invitations are pending", async () => {
    const { client, keys, convert } = await plaintextVault();
    const invitation = "0190a5b4-0000-7000-8000-000000000201";
    keys.plaintextInvitations = [invitation];

    const refused = await convert(await conversionMembers(client.membership, vaultId)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConversionRefusedError);
    expect((refused as ConversionRefusedError).pendingInvitations).toEqual([invitation]);
    expect(keys.encrypted).toBe(false);
    // Refused before anything is written: no anchor names a genesis the vault does not have.
    expect(keys.anchorLists.size).toBe(0);
  });
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let index = 0; index < needle.length; index++) if (haystack[start + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}
