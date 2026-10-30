import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { generateKey } from "../e2ee/e2ee";
import { generateKeyPair } from "../e2ee/hybrid";
import { keyCommitment, openKeySlot, sealKeySlot } from "../e2ee/keyslot";
import { create } from "@bufbuild/protobuf";
import { EpochRecordSchema, KeyRecipientKind, type EpochRecord as EpochRecordMessage } from "../../gen/vaultsync/v1/vault_key_pb";
import { entryHash, epochRecipients, signEpochRecord } from "../e2ee/memberlog";
import { epochRecordMessage } from "./verified-epochs";
import { createProtocolClient } from "../protocol/client";
import { addAnchor } from "./anchor-list";
import { MemoryVaultKeyServer } from "./memory-vault-keys";
import { LogVerificationError, MemoryVerifiedLogStore, type LogTrust } from "./verified-log";
import type { UserKeyPair } from "./user-key";
import {
  MemoryEpochKeyStore,
  VaultKeyManager,
  vaultKeyStatusMessage,
  WAITING_FOR_KEY_MESSAGE,
  type VaultKeyState,
} from "./vault-keys";

const vaultId = "0190a5b4-0000-7000-8000-000000000001";

interface User {
  id: string;
  key: UserKeyPair;
}

function user(n: number): User {
  const id = `0190a5b4-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;
  return { id, key: { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(n), userId: id } };
}

const alice = user(1); // owner
const bob = user(2); // second owner
const carol = user(3); // editor
const mallory = user(4); // the member who leaves or is removed
const erin = user(5); // a new member

/** Adds `member` to the vault's log, and the vault's genesis to their anchor list. */
async function join(
  server: MemoryVaultKeyServer,
  member: User,
  role: VaultRole,
): Promise<void> {
  server.seedMember(member.key, role);
  const genesis = server.log[0];
  if (genesis === undefined) throw new Error("no genesis");
  const client = createProtocolClient({ transport: server.transport(member.id) });
  await addAnchor(client.userKeys, member.key, new MemoryVerifiedLogStore(), { vaultId, genesisHash: entryHash(genesis) });
}

/** A device of `member` with its own epoch key store and verified-log store. */
function device(
  server: MemoryVaultKeyServer,
  member: User,
  owner: boolean,
  store = new MemoryEpochKeyStore(),
  verifiedLogs = new MemoryVerifiedLogStore(),
) {
  const client = createProtocolClient({
    transport: server.transport(member.id),
  });
  const trust: LogTrust = { userKey: member.key, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs };
  const manager = new VaultKeyManager({
    vaultId,
    userKey: member.key,
    owner,
    keys: client.vaultKeys,
    membership: client.membership,
    store,
    trust,
  });
  return { manager, store, verifiedLogs };
}

/** The key of `epoch` that `member`'s stored slot holds, if it opens with their key. */
async function unwrap(
  server: MemoryVaultKeyServer,
  member: User,
  epoch: number,
): Promise<Uint8Array | undefined> {
  const slot = server
    .slotsOf(epoch)
    .find((stored) => stored.recipientId === member.id);
  if (slot === undefined) return undefined;
  return openKeySlot(member.key.privateKey, slot.wrappedKey, {
    vaultId,
    epoch,
    recipientKind: "user",
    recipientId: member.id,
  });
}

/** Whether `member`'s private key opens any slot of `epoch`, whoever it is listed for. */
async function opensAnySlot(
  server: MemoryVaultKeyServer,
  member: User,
  epoch: number,
): Promise<boolean> {
  for (const slot of server.slotsOf(epoch)) {
    try {
      await openKeySlot(member.key.privateKey, slot.wrappedKey, {
        vaultId,
        epoch,
        recipientKind: "user",
        recipientId: slot.recipientId,
      });
      return true;
    } catch {
      // Not this member's slot.
    }
  }
  return false;
}

/** Whether `privateKey` opens any user slot of `epoch`, whoever it is listed for. */
async function opensWith(server: MemoryVaultKeyServer, privateKey: Uint8Array, epoch: number): Promise<boolean> {
  for (const slot of server.slotsOf(epoch)) {
    try {
      await openKeySlot(privateKey, slot.wrappedKey, { vaultId, epoch, recipientKind: "user", recipientId: slot.recipientId });
      return true;
    } catch {
      // Not sealed to this key.
    }
  }
  return false;
}

function recipients(server: MemoryVaultKeyServer, epoch: number): string[] {
  return server
    .slotsOf(epoch)
    .map((slot) => slot.recipientId)
    .sort();
}

function commitmentOf(
  server: MemoryVaultKeyServer,
  epoch: number,
): Uint8Array | undefined {
  return server.epochs.find((stored) => stored.epoch === epoch)?.commitment;
}

/** A vault of alice (owner), carol (editor) and mallory (editor), with epoch 1 created by alice's device. */
async function sharedVault() {
  const server = new MemoryVaultKeyServer(vaultId);
  await join(server, alice, VaultRole.OWNER);
  await join(server, carol, VaultRole.EDITOR);
  await join(server, mallory, VaultRole.EDITOR);
  const owner = device(server, alice, true);
  await owner.manager.sync();
  return { server, owner };
}

/** Every console call's arguments, as text. */
function captureConsole(): string[] {
  const lines: string[] = [];
  for (const level of [
    "log",
    "debug",
    "info",
    "warn",
    "error",
    "trace",
  ] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            arg instanceof Error
              ? `${arg.message} ${String(arg.stack)}`
              : typeof arg === "string"
                ? arg
                : JSON.stringify(arg),
          )
          .join(" "),
      );
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rotation on an owner device", () => {
  it("creates the first epoch of a new vault for every member with a user key", async () => {
    const server = new MemoryVaultKeyServer(vaultId);
    await join(server, alice, VaultRole.OWNER);
    await join(server, carol, VaultRole.EDITOR);
    server.addMember(mallory.id, VaultRole.VIEWER); // no user key yet

    const state = await device(server, alice, true).manager.sync();

    expect(state).toMatchObject({
      status: "ready",
      currentEpoch: 1,
      epochs: [1],
      rotated: true,
    });
    expect(server.rotationPending).toBe(false);
    expect(recipients(server, 1)).toEqual([alice.id, carol.id].sort());
  });

  it("given a rotation-pending vault after a member left, creates the next epoch for the remaining members only", async () => {
    const { server, owner } = await sharedVault();
    server.leave(mallory.id);

    const state = await owner.manager.sync();

    expect(state).toMatchObject({
      status: "ready",
      currentEpoch: 2,
      epochs: [1, 2],
      rotated: true,
    });
    expect(server.rotationPending).toBe(false);
    expect(recipients(server, 2)).toEqual([alice.id, carol.id].sort());
    expect(await opensAnySlot(server, mallory, 2)).toBe(false);
    // Every remaining member unwraps the same key, which matches the epoch's commitment.
    const key = owner.manager.epochKey(2);
    expect(key).toBeDefined();
    expect(await unwrap(server, carol, 2)).toEqual(key);
    expect(commitmentOf(server, 2)).toEqual(
      keyCommitment(key ?? new Uint8Array(32), vaultId, 2),
    );
    expect(owner.manager.epochKey(1)).not.toEqual(key);
  });

  it("leaves rotation to owners: an editor device creates no epoch", async () => {
    const { server } = await sharedVault();
    server.leave(mallory.id);
    const before = server.count("RotateEpoch");

    const state = await device(server, carol, false).manager.sync();

    expect(server.count("RotateEpoch")).toBe(before);
    expect(
      server.requests
        .filter((request) => request.caller === carol.id)
        .map((request) => request.procedure),
    ).not.toContain("ListMissingSlots");
    expect(state).toMatchObject({
      status: "ready",
      currentEpoch: 1,
      rotated: false,
    });
    expect(server.rotationPending).toBe(true);
  });

  it("given two owner devices rotating at once, creates one epoch, and the loser adopts it without creating another", async () => {
    const server = new MemoryVaultKeyServer(vaultId);
    await join(server, alice, VaultRole.OWNER);
    await join(server, bob, VaultRole.OWNER);
    await join(server, carol, VaultRole.EDITOR);
    const first = device(server, alice, true);
    const second = device(server, bob, true);
    server.holdEpochChanges = 2;

    const states = await Promise.all([
      first.manager.sync(),
      second.manager.sync(),
    ]);

    expect(server.count("RotateEpoch")).toBe(2);
    expect(server.epochs.map((epoch) => epoch.epoch)).toEqual([1]);
    expect(states.map((state) => state.rotated).sort()).toEqual([false, true]);
    for (const state of states)
      expect(state).toMatchObject({
        status: "ready",
        currentEpoch: 1,
        epochs: [1],
      });
    expect(first.manager.epochKey(1)).toEqual(second.manager.epochKey(1));
    expect(await unwrap(server, carol, 1)).toEqual(first.manager.epochKey(1));

    await Promise.all([first.manager.sync(), second.manager.sync()]);

    expect(server.count("RotateEpoch")).toBe(2);
    expect(server.epochs).toHaveLength(1);
  });
});

describe("removing a member from an E2EE vault", () => {
  it("sends the next epoch with the removal, without a slot for the removed member", async () => {
    const { server, owner } = await sharedVault();

    await owner.manager.removeMember(mallory.id);

    expect(server.count("RemoveMember")).toBe(1);
    expect(server.members.has(mallory.id)).toBe(false);
    expect(server.currentEpoch).toBe(2);
    expect(recipients(server, 2)).toEqual([alice.id, carol.id].sort());
    expect(await opensAnySlot(server, mallory, 2)).toBe(false);
    expect(owner.manager.epochKey(2)).toEqual(await unwrap(server, carol, 2));
    expect(server.count("RotateEpoch")).toBe(1); // only epoch 1's
  });

  it("removes the member under a fresh epoch even when another owner device's rotation wins the race", async () => {
    const { server, owner } = await sharedVault();
    await join(server, bob, VaultRole.OWNER);
    await owner.manager.sync(); // grants bob epoch 1
    server.rotationPending = true;
    const other = device(server, bob, true);
    server.holdEpochChanges = 2;

    await Promise.all([
      owner.manager.removeMember(mallory.id),
      other.manager.sync(),
    ]);

    expect(server.members.has(mallory.id)).toBe(false);
    const current = server.currentEpoch;
    expect(current).toBeGreaterThanOrEqual(2);
    expect(recipients(server, current)).toEqual(
      [alice.id, bob.id, carol.id].sort(),
    );
    expect(await opensAnySlot(server, mallory, current)).toBe(false);
  });

  it("is refused on a device that does not own the vault", async () => {
    const { server } = await sharedVault();

    await expect(
      device(server, carol, false).manager.removeMember(mallory.id),
    ).rejects.toThrow(/only an owner/);

    expect(server.members.has(mallory.id)).toBe(true);
  });
});

describe("a new member", () => {
  it("waits for an owner to share the vault key, then unwraps every epoch once an owner device granted them", async () => {
    const { server, owner } = await sharedVault();
    server.leave(mallory.id);
    await owner.manager.sync();
    server.rotationPending = true;
    await owner.manager.sync();
    expect(server.currentEpoch).toBe(3);
    await join(server, erin, VaultRole.VIEWER);
    const newcomer = device(server, erin, false);

    const waiting = await newcomer.manager.sync();

    expect(waiting).toMatchObject({
      status: "waiting",
      currentEpoch: 3,
      epochs: [],
      missing: [1, 2, 3],
    });
    expect(vaultKeyStatusMessage(waiting)).toBe(WAITING_FOR_KEY_MESSAGE);
    expect(WAITING_FOR_KEY_MESSAGE).toMatch(
      /waiting for an owner to share the vault key/i,
    );
    expect(newcomer.manager.epochKey(3)).toBeUndefined();

    const granting = await owner.manager.sync();
    const ready = await newcomer.manager.sync();

    expect(granting.granted).toBe(3);
    expect(ready).toMatchObject({
      status: "ready",
      epochs: [1, 2, 3],
      missing: [],
    });
    expect(vaultKeyStatusMessage(ready)).toBeUndefined();
    for (const epoch of [1, 2, 3])
      expect(newcomer.manager.epochKey(epoch)).toEqual(
        owner.manager.epochKey(epoch),
      );
    expect((await owner.manager.sync()).granted).toBe(0);
  });


  it("waits while a new vault has no epoch yet", async () => {
    const server = new MemoryVaultKeyServer(vaultId);
    await join(server, alice, VaultRole.OWNER);
    await join(server, carol, VaultRole.EDITOR);

    const state = await device(server, carol, false).manager.sync();

    expect(state).toMatchObject({ status: "waiting", currentEpoch: 0 });
    expect(vaultKeyStatusMessage(state)).toBe(WAITING_FOR_KEY_MESSAGE);
  });
});

describe("key commitments", () => {
  it("refuses a slot whose key does not match the epoch's commitment and reports it instead of using the key", async () => {
    const { server } = await sharedVault();
    // The server swaps carol's slot for one sealed to her key with another epoch key.
    const forged = generateKey();
    const slot = server
      .slotsOf(1)
      .find((stored) => stored.recipientId === carol.id);
    if (slot === undefined) throw new Error("no slot for carol");
    slot.wrappedKey = await sealKeySlot(carol.key.publicKey, forged, {
      vaultId,
      epoch: 1,
      recipientKind: "user",
      recipientId: carol.id,
    });
    const member = device(server, carol, false);

    const state = await member.manager.sync();

    expect(state.status).toBe("refused");
    expect(state.refused.map((error) => error.epoch)).toEqual([1]);
    expect(vaultKeyStatusMessage(state)).toMatch(
      /epoch 1 was refused: the key does not match the epoch's key commitment/,
    );
    expect(state.epochs).toEqual([]);
    expect(member.manager.epochKey(1)).toBeUndefined();
    expect(member.store.keys.has(1)).toBe(false);
  });

  it("refuses a slot that does not open with the device's key", async () => {
    const { server } = await sharedVault();
    const slot = server
      .slotsOf(1)
      .find((stored) => stored.recipientId === carol.id);
    if (slot === undefined) throw new Error("no slot for carol");
    slot.wrappedKey = await sealKeySlot(
      generateKeyPair().publicKey,
      generateKey(),
      { vaultId, epoch: 1, recipientKind: "user", recipientId: carol.id },
    );
    const member = device(server, carol, false);

    const state = await member.manager.sync();

    expect(state.status).toBe("refused");
    expect(vaultKeyStatusMessage(state)).toMatch(/does not open/);
    expect(member.manager.epochKey(1)).toBeUndefined();
  });

  it("stops using and sharing a held key once the server's commitment for its epoch changes", async () => {
    const { server, owner } = await sharedVault();
    const epoch = server.epochs[0];
    if (epoch === undefined) throw new Error("no epoch");
    epoch.commitment = keyCommitment(generateKey(), vaultId, 1);
    await join(server, erin, VaultRole.EDITOR);

    await expect(owner.manager.sync()).rejects.toBeInstanceOf(LogVerificationError);

    expect(server.count("AddKeySlots")).toBe(0);
    expect(await unwrap(server, erin, 1)).toBeUndefined();
  });
});

/** A member's key that the server makes up: no member holds its private key. */
const forgedKey = generateKeyPair();

describe("recipients come from the verified log, not the server (P4-19)", () => {
  it("grants no slot to a user the server lists as a member but the log does not name", async () => {
    const { server, owner } = await sharedVault();
    server.addMember(erin.id, VaultRole.EDITOR, forgedKey.publicKey);

    const state = await owner.manager.sync();

    expect(state.granted).toBe(0);
    expect(server.count("AddKeySlots")).toBe(0);
    expect(recipients(server, 1)).not.toContain(erin.id);
  });

  it("wraps a missing slot to the member's key in the log when the server swaps it", async () => {
    const { server, owner } = await sharedVault();
    await join(server, erin, VaultRole.EDITOR);
    const stored = server.members.get(erin.id);
    if (stored === undefined) throw new Error("erin is not a member");
    stored.publicKey = forgedKey.publicKey;

    expect((await owner.manager.sync()).granted).toBe(1);

    expect(await unwrap(server, erin, 1)).toEqual(owner.manager.epochKey(1));
    await expect(opensWith(server, forgedKey.privateKey, 1)).resolves.toBe(false);
  });

  it("rotates only to the log's members and their keys in the log, whatever the server lists", async () => {
    const { server, owner } = await sharedVault();
    server.addMember(erin.id, VaultRole.EDITOR, forgedKey.publicKey);
    const stored = server.members.get(carol.id);
    if (stored === undefined) throw new Error("carol is not a member");
    stored.publicKey = forgedKey.publicKey;
    server.rotationPending = true;

    const state = await owner.manager.sync();

    expect(state.rotated).toBe(true);
    expect(recipients(server, 2)).toEqual([alice.id, carol.id, mallory.id].sort());
    expect(await unwrap(server, carol, 2)).toEqual(owner.manager.epochKey(2));
    await expect(opensWith(server, forgedKey.privateKey, 2)).resolves.toBe(false);
  });

  it("signs the removal's epoch with the log after the remove-member entry as its recipients", async () => {
    const { server, owner } = await sharedVault();

    await owner.manager.removeMember(mallory.id);

    const record = server.epochs[1]?.record;
    expect(record?.logSeq).toBe(BigInt(server.log.length));
    expect(record?.recipients).toHaveLength(2);
    expect(await device(server, carol, false).manager.sync()).toMatchObject({ status: "ready", epochs: [1, 2] });
  });
});

/** Injects epoch 2, whose key the server wraps to carol, with `record` (or none). */
function injectEpoch(server: MemoryVaultKeyServer, sign: ((body: { commitment: Uint8Array; prevCommitment: Uint8Array }) => EpochRecordMessage) | undefined): Promise<void> {
  const epochKey = generateKey();
  const commitment = keyCommitment(epochKey, vaultId, 2);
  const prevCommitment = server.epochs[0]?.commitment ?? new Uint8Array(32);
  server.epochs.push({ epoch: 2, commitment, creator: alice.id, record: sign?.({ commitment, prevCommitment }) });
  server.currentEpoch = 2;
  return sealKeySlot(carol.key.publicKey, epochKey, { vaultId, epoch: 2, recipientKind: "user", recipientId: carol.id }).then((wrappedKey) => {
    server.slots.push({ epoch: 2, recipientKind: KeyRecipientKind.USER, recipientId: carol.id, wrappedKey, creator: alice.id });
  });
}

/** A record of epoch 2 at the log's head, signed with `signSeed`. */
function recordSignedBy(server: MemoryVaultKeyServer, signSeed: Uint8Array) {
  return ({ commitment, prevCommitment }: { commitment: Uint8Array; prevCommitment: Uint8Array }): EpochRecordMessage => {
    const head = server.logState();
    const record = signEpochRecord({ vaultId, epoch: 2, commitment, prevCommitment, logSeq: head.seq, logHash: head.hash, recipients: epochRecipients(head) }, signSeed);
    return create(EpochRecordSchema, epochRecordMessage(record));
  };
}

describe("only verified epochs are used (P4-20)", () => {
  it("refuses an epoch the server injects without an owner-signed record", async () => {
    const { server } = await sharedVault();
    await injectEpoch(server, undefined);
    const member = device(server, carol, false);

    await expect(member.manager.sync()).rejects.toBeInstanceOf(LogVerificationError);

    expect(member.manager.epochKey(2)).toBeUndefined();
    expect(member.store.keys.has(2)).toBe(false);
  });

  it("refuses an epoch whose record a member who is not an owner signed", async () => {
    const { server } = await sharedVault();
    await injectEpoch(server, recordSignedBy(server, carol.key.signSeed));
    const member = device(server, carol, false);

    await expect(member.manager.sync()).rejects.toBeInstanceOf(LogVerificationError);

    expect(member.manager.epochKey(2)).toBeUndefined();
    expect(member.store.keys.has(2)).toBe(false);
  });

  it("uses an injected epoch's key only once an owner signed its record", async () => {
    const { server } = await sharedVault();
    await injectEpoch(server, recordSignedBy(server, alice.key.signSeed));
    const member = device(server, carol, false);

    expect(await member.manager.sync()).toMatchObject({ status: "ready", epochs: [1, 2] });
  });

  it("refuses an epoch lower than the highest this device verified, and accepts the same one again", async () => {
    const { server, owner } = await sharedVault();
    server.rotationPending = true;
    await owner.manager.sync();
    const member = device(server, carol, false);
    expect((await member.manager.sync()).currentEpoch).toBe(2);
    expect((await member.manager.sync()).currentEpoch).toBe(2);

    server.epochs.pop();
    server.currentEpoch = 1;

    await expect(member.manager.sync()).rejects.toThrow(/lower than this device has verified/);
    expect(member.verifiedLogs.epochs.get(vaultId)).toBe(2);
  });
});

describe("epoch key storage", () => {
  it("keeps epoch keys in the device's store and uses them from there on the next start", async () => {
    const { server, owner } = await sharedVault();
    const key = owner.manager.epochKey(1);
    expect(owner.store.keys.get(1)).toEqual(key);

    const restarted = device(server, alice, true, owner.store);
    server.slots.splice(0); // nothing left to unwrap: the key must come from the store
    const state = await restarted.manager.sync();

    expect(state).toMatchObject({ status: "ready", epochs: [1] });
    expect(restarted.manager.epochKey(1)).toEqual(key);
  });

  it("never logs an epoch key, and no state or request carries one in the clear", async () => {
    const lines = captureConsole();
    const { server, owner } = await sharedVault();
    server.leave(mallory.id);
    await join(server, erin, VaultRole.EDITOR);
    const states: VaultKeyState[] = [await owner.manager.sync()];
    const member = device(server, erin, false);
    states.push(await member.manager.sync());
    await owner.manager.removeMember(carol.id);
    states.push(await member.manager.sync());

    expect(lines).toEqual([]);
    const keys = [1, 2, 3].map((epoch) => owner.manager.epochKey(epoch));
    for (const key of keys) {
      expect(key).toBeDefined();
      const hex = bytesToHex(key ?? new Uint8Array());
      expect(JSON.stringify(states)).not.toContain(hex);
      for (const request of server.requests)
        expect(bytesToHex(request.bytes)).not.toContain(hex);
    }
  });
});
