/**
 * The vault key manager (SPEC.md §9.3, "Epochs and key slots"): the epoch
 * keys of one end-to-end encrypted vault on this device. It unwraps the
 * caller's key slots with the unlocked user key, checks every key against
 * its epoch's key commitment before using it, and keeps the keys only in an
 * {@link EpochKeyStore} (device-local plugin data in the plugin, never
 * synced). On an owner device it also creates the next epoch when the vault
 * is rotation-pending, builds the next epoch a member's removal needs, and
 * grants slots to members who are missing them.
 *
 * Against an active server (docs/design/encryption.md, "Signed epochs"), it
 * uses an epoch key only from an epoch whose record an owner signed in the
 * membership log this device verified, refuses an epoch below the highest it
 * has verified, and wraps keys only to the recipients that log names, with
 * their keys from the log: never to a key the server adds or swaps.
 *
 * Nothing here logs, and no error message or state carries a key.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import type { MembershipService } from "../../gen/vaultsync/v1/membership_pb";
import { KeyRecipientKind, type EpochRecordSchema, type KeySlotSchema, type NextEpochSchema, type VaultKeyService } from "../../gen/vaultsync/v1/vault_key_pb";
import { DecryptError, generateKey } from "../e2ee/e2ee";
import { KeyCommitmentError, keyCommitment, openKeySlot, sealKeySlot, verifyKeyCommitment } from "../e2ee/keyslot";
import { EntryType, epochRecipients, idPayload, replayLog, signEpochRecord, type LogState } from "../e2ee/memberlog";
import { escrowEqual, type EscrowBundle } from "../e2ee/identity";
import { nextEntry, toLogEntry } from "./member-log";
import type { UserKeyPair } from "./user-key";
import { epochRecordMessage, NO_PREVIOUS_COMMITMENT, verifyEpochs } from "./verified-epochs";
import { readMemberLog, type LogTrust } from "./verified-log";

/** The VaultKeyService calls the manager makes (ProtocolClient.vaultKeys). */
export type VaultKeyClient = Pick<Client<typeof VaultKeyService>, "listKeySlots" | "listEpochs" | "listMissingSlots" | "rotateEpoch" | "addKeySlots" | "listLogEntries">;

/** The MembershipService calls the manager makes on an owner device (ProtocolClient.membership). */
export type MemberKeyClient = Pick<Client<typeof MembershipService>, "removeMember">;

/** Where a device keeps the epoch keys it unwrapped: device-local only, never synced. */
export interface EpochKeyStore {
  /** The epoch keys stored for the vault, by epoch. */
  load(): Promise<ReadonlyMap<number, Uint8Array>>;
  /** Replaces the stored epoch keys of the vault. */
  save(keys: ReadonlyMap<number, Uint8Array>): Promise<void>;
}

/** An {@link EpochKeyStore} in memory, for tests. */
export class MemoryEpochKeyStore implements EpochKeyStore {
  keys = new Map<number, Uint8Array>();

  load(): Promise<ReadonlyMap<number, Uint8Array>> {
    return Promise.resolve(new Map(this.keys));
  }

  save(keys: ReadonlyMap<number, Uint8Array>): Promise<void> {
    this.keys = new Map(keys);
    return Promise.resolve();
  }
}

export interface VaultKeyManagerOptions {
  vaultId: string;
  /** The signed-in user's unlocked key pair. */
  userKey: UserKeyPair;
  /** Whether the signed-in user owns the vault: only owners rotate and grant. */
  owner: boolean;
  keys: VaultKeyClient;
  membership: MemberKeyClient;
  store: EpochKeyStore;
  /** What this device verifies the vault's membership log, and so its epochs, with. */
  trust: LogTrust;
  /**
   * The deployment's escrow key, in a vault with escrow: every epoch this
   * device creates also wraps its key to it (SPEC.md §9.4). Undefined in a
   * vault without escrow.
   */
  escrow?: EscrowRecipient;
}

/** The deployment's escrow public key, as GetServerInfo publishes it. */
export interface EscrowRecipient {
  /** The id escrow slots name it by (their recipient_id). */
  keyId: string;
  /** The hybrid ML-KEM-768 + X25519 public key (1216 bytes). */
  publicKey: Uint8Array;
  /** The pinned escrow bundle naming this key, which the vault's log must name too. */
  bundle?: EscrowBundle;
}

/** A key slot this device refused: it did not open with the user key, or its key does not match the epoch's commitment. */
export class VaultKeyRefusedError extends Error {
  constructor(
    readonly epoch: number,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`The vault key for epoch ${String(epoch)} was refused: ${reason}.`, options);
    this.name = "VaultKeyRefusedError";
  }
}

/**
 * The vault's keys as this device sees them after {@link
 * VaultKeyManager.sync}:
 *
 * - `ready`: the device holds the key of every epoch, the current one
 *   included.
 * - `waiting`: some epoch's key has not been shared with the user yet (or
 *   the vault has no epoch yet), so the device waits for an owner device.
 * - `refused`: a slot was refused ({@link VaultKeyRefusedError}); its key is
 *   not used.
 */
export interface VaultKeyState {
  status: "ready" | "waiting" | "refused";
  /** The epoch new revisions must use; 0 while the vault has none. */
  currentEpoch: number;
  /** The epochs whose key this device holds, ascending. */
  epochs: number[];
  /** The epochs whose key this device lacks, ascending. */
  missing: number[];
  /** The slots this device refused. */
  refused: VaultKeyRefusedError[];
  /** Whether this sync created an epoch (RotateEpoch). */
  rotated: boolean;
  /** How many slots this sync granted to other members (AddKeySlots). */
  granted: number;
}

/** What a member sees while an owner has not shared the vault key with them. */
export const WAITING_FOR_KEY_MESSAGE = "Waiting for an owner to share the vault key.";

/** What to tell the user about the vault's keys, or undefined when they are ready. */
export function vaultKeyStatusMessage(state: VaultKeyState): string | undefined {
  switch (state.status) {
    case "ready":
      return undefined;
    case "waiting":
      return WAITING_FOR_KEY_MESSAGE;
    case "refused":
      return state.refused.map((error) => error.message).join(" ");
  }
}

/** Upper bound on pages read from one list, against a server that never ends a list. */
const MAX_PAGES = 10_000;
/** The server's limit of slots per AddKeySlots. */
const MAX_ADDED_SLOTS = 1000;
/** RemoveMember attempts when another epoch change keeps winning the race. */
const MAX_REMOVE_ATTEMPTS = 3;

type SlotInit = MessageInitShape<typeof KeySlotSchema>;
type NextEpochInit = MessageInitShape<typeof NextEpochSchema>;
type EpochRecordInit = MessageInitShape<typeof EpochRecordSchema>;

/** Whether `error` is the server's refusal of a stale expected_epoch: another epoch change won. */
export function isEpochNotCurrent(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    error.code === Code.FailedPrecondition &&
    error.findDetails(ErrorDetailSchema).some((detail) => detail.reason === ErrorReason.EPOCH_NOT_CURRENT)
  );
}

interface EpochView {
  currentEpoch: number;
  rotationPending: boolean;
  commitments: Map<number, Uint8Array>;
  refused: VaultKeyRefusedError[];
  /** The membership after the verified log's last entry. */
  head: LogState;
}

export class VaultKeyManager {
  private keys: Map<number, Uint8Array> | undefined;
  /** Epochs whose held key the last read refused: never used or shared. */
  private refusedEpochs = new Set<number>();

  constructor(private readonly options: VaultKeyManagerOptions) {}

  /** The key of `epoch`, if this device holds it (and it matched the epoch's commitment). */
  epochKey(epoch: number): Uint8Array | undefined {
    return this.refusedEpochs.has(epoch) ? undefined : this.keys?.get(epoch);
  }

  /**
   * Brings this device's epoch keys up to date: unwraps and checks every
   * slot of the user's it does not hold yet, and on an owner device creates
   * the next epoch when the vault is rotation-pending and grants missing
   * slots for the epochs it holds. When another owner device created the
   * epoch first, adopts that one instead of creating another.
   */
  async sync(): Promise<VaultKeyState> {
    let view = await this.read();
    let rotated = false;
    if (this.options.owner && view.rotationPending) {
      try {
        await this.createEpoch(view, view.head, (nextEpoch, record) => this.options.keys.rotateEpoch({ vaultId: this.options.vaultId, nextEpoch, record }));
        rotated = true;
      } catch (error) {
        // Another owner device won the rotation: adopt its epoch.
        if (!isEpochNotCurrent(error)) throw error;
      }
      view = await this.read();
    }
    const granted = this.options.owner ? await this.grantMissing(view.head) : 0;
    return this.state(view, rotated, granted);
  }

  /**
   * Removes `userId` from the vault: sends RemoveMember with the
   * remove-member entry signed on top of the verified log's head, and the
   * next epoch with its signed record at that entry, wrapped for every
   * recipient the log names after it (so not for the removed member): the
   * removal and the new epoch take effect together.
   * When another epoch change or log entry wins meanwhile, adopts it and
   * builds the epoch and the entry after it.
   */
  async removeMember(userId: string): Promise<void> {
    if (!this.options.owner) throw new Error("only an owner can remove a member");
    const { vaultId, userKey } = this.options;
    for (let attempt = 1; ; attempt++) {
      const view = await this.read();
      const { entries: log } = await readMemberLog(this.options.trust, vaultId);
      const entry = nextEntry(vaultId, log, { type: EntryType.removeMember, payload: idPayload(userId), signSeeds: [userKey.signSeed] });
      const after = replayLog(vaultId, [...log, entry]).at(-1);
      if (after === undefined) throw new Error("the membership log is empty");
      const logEntry = toLogEntry(entry);
      try {
        await this.createEpoch(view, after, (nextEpoch, record) => this.options.membership.removeMember({ vaultId, userId, nextEpoch, logEntry, record }));
        return;
      } catch (error) {
        const raced = isEpochNotCurrent(error) || (error instanceof ConnectError && error.code === Code.Aborted);
        if (!raced || attempt >= MAX_REMOVE_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Creates the epoch after `view`'s current one with a fresh key, wrapped
   * for every recipient the log names at `at` (members, pending invitations,
   * and the escrow key if escrow is on there), each to its key in the log,
   * and signs its record at that position; sends both through `send`, and
   * keeps the key once the server accepted it. Should the response be lost,
   * the key is not: the device's own slot is in the epoch.
   */
  private async createEpoch(view: EpochView, at: LogState, send: (nextEpoch: NextEpochInit, record: EpochRecordInit) => Promise<unknown>): Promise<void> {
    const { vaultId, userKey } = this.options;
    const expected = view.currentEpoch;
    const epoch = expected + 1;
    const epochKey = generateKey();
    const slots: SlotInit[] = [];
    for (const [userId, member] of at.members) {
      slots.push({
        epoch,
        recipientKind: KeyRecipientKind.USER,
        recipientId: userId,
        wrappedKey: await sealKeySlot(member.bundle.kemPub, epochKey, { vaultId, epoch, recipientKind: "user", recipientId: userId }),
      });
    }
    for (const [invitationId, invitation] of at.invitations) {
      slots.push({
        epoch,
        recipientKind: KeyRecipientKind.INVITATION,
        recipientId: invitationId,
        wrappedKey: await sealKeySlot(invitation.kemPub, epochKey, { vaultId, epoch, recipientKind: "invitation", recipientId: invitationId }),
      });
    }
    if (at.escrow !== undefined) {
      const { escrow } = this.options;
      if (escrow?.bundle === undefined || !escrowEqual(escrow.bundle, at.escrow)) {
        throw new Error("the vault's membership log names another escrow key than the one this device pinned, so it does not rotate");
      }
      slots.push({
        epoch,
        recipientKind: KeyRecipientKind.ESCROW,
        recipientId: escrow.keyId,
        wrappedKey: await sealKeySlot(escrow.publicKey, epochKey, { vaultId, epoch, recipientKind: "escrow", recipientId: escrow.keyId }),
      });
    }
    const commitment = keyCommitment(epochKey, vaultId, epoch);
    const prevCommitment = expected === 0 ? NO_PREVIOUS_COMMITMENT : view.commitments.get(expected);
    if (prevCommitment === undefined) throw new Error(`the vault lists no commitment for epoch ${String(expected)}`);
    const record = signEpochRecord({ vaultId, epoch, commitment, prevCommitment, logSeq: at.seq, logHash: at.hash, recipients: epochRecipients(at) }, userKey.signSeed);
    await send({ expectedEpoch: expected, commitment, slots }, epochRecordMessage(record));
    const keys = await this.loaded();
    keys.set(epoch, epochKey);
    await this.options.store.save(keys);
  }

  /** Grants every missing slot of an epoch this device holds (AddKeySlots); resolves how many were stored. */
  private async grantMissing(head: LogState): Promise<number> {
    const { vaultId } = this.options;
    const missing = await allPages(async (pageToken) => {
      const response = await this.options.keys.listMissingSlots({ vaultId, pageToken });
      return { items: response.missingSlots, next: response.nextPageToken };
    });
    const slots: SlotInit[] = [];
    for (const entry of missing) {
      const epochKey = this.epochKey(entry.epoch);
      // The recipient and its key come from the verified log, never from the
      // server's listing: a user the log does not name gets nothing.
      const member = head.members.get(entry.userId);
      if (epochKey === undefined || member === undefined) continue;
      slots.push({
        epoch: entry.epoch,
        recipientKind: KeyRecipientKind.USER,
        recipientId: entry.userId,
        wrappedKey: await sealKeySlot(member.bundle.kemPub, epochKey, { vaultId, epoch: entry.epoch, recipientKind: "user", recipientId: entry.userId }),
      });
    }
    let granted = 0;
    for (let start = 0; start < slots.length; start += MAX_ADDED_SLOTS) {
      granted += (await this.options.keys.addKeySlots({ vaultId, slots: slots.slice(start, start + MAX_ADDED_SLOTS) })).added;
    }
    return granted;
  }

  /** Reads the vault's epochs and the user's slots, and takes every slot key that opens and matches its commitment. */
  private async read(): Promise<EpochView> {
    const { vaultId, userKey } = this.options;
    const { states } = await readMemberLog(this.options.trust, vaultId);
    const head = states.at(-1);
    if (head === undefined) throw new Error("the membership log is empty");
    const keys = await this.loaded();
    let currentEpoch = 0;
    let rotationPending = false;
    const commitments = new Map<number, Uint8Array>();
    const epochs = await allPages(async (pageToken) => {
      const response = await this.options.keys.listEpochs({ vaultId, pageToken });
      currentEpoch = response.currentEpoch;
      rotationPending = response.rotationPending;
      return { items: response.epochs, next: response.nextPageToken };
    });
    await verifyEpochs(this.options.trust.verifiedLogs, vaultId, states, epochs, currentEpoch);
    for (const epoch of epochs) commitments.set(epoch.epoch, epoch.commitment);
    const slots = await allPages(async (pageToken) => {
      const response = await this.options.keys.listKeySlots({ vaultId, pageToken });
      return { items: response.slots, next: response.nextPageToken };
    });

    const refused: VaultKeyRefusedError[] = [];
    let changed = false;
    // A key this device holds is checked against the commitment the server
    // lists now: an epoch's key never changes.
    for (const [epoch, key] of keys) {
      const commitment = commitments.get(epoch);
      if (commitment === undefined) continue;
      try {
        verifyKeyCommitment(key, commitment, vaultId, epoch);
      } catch (error) {
        if (!(error instanceof KeyCommitmentError)) throw error;
        refused.push(new VaultKeyRefusedError(epoch, "the server's key commitment does not match the key this device holds"));
      }
    }
    for (const slot of slots) {
      if (slot.recipientKind !== KeyRecipientKind.USER || keys.has(slot.epoch)) continue;
      const commitment = commitments.get(slot.epoch);
      if (commitment === undefined) {
        refused.push(new VaultKeyRefusedError(slot.epoch, "the server lists no key commitment for its epoch"));
        continue;
      }
      let epochKey: Uint8Array;
      try {
        epochKey = await openKeySlot(userKey.privateKey, slot.wrappedKey, { vaultId, epoch: slot.epoch, recipientKind: "user", recipientId: slot.recipientId });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        refused.push(new VaultKeyRefusedError(slot.epoch, error instanceof DecryptError ? "it does not open with this device's encryption key" : "the slot is malformed", { cause: error }));
        continue;
      }
      try {
        verifyKeyCommitment(epochKey, commitment, vaultId, slot.epoch);
      } catch (error) {
        if (!(error instanceof KeyCommitmentError)) throw error;
        refused.push(new VaultKeyRefusedError(slot.epoch, "the key does not match the epoch's key commitment", { cause: error }));
        continue;
      }
      keys.set(slot.epoch, epochKey);
      changed = true;
    }
    if (changed) await this.options.store.save(keys);
    this.refusedEpochs = new Set(refused.map((error) => error.epoch));
    return { currentEpoch, rotationPending, commitments, refused, head };
  }

  private state(view: EpochView, rotated: boolean, granted: number): VaultKeyState {
    const epochs: number[] = [];
    const missing: number[] = [];
    for (let epoch = 1; epoch <= view.currentEpoch; epoch++) {
      if (this.epochKey(epoch) !== undefined) epochs.push(epoch);
      else missing.push(epoch);
    }
    const status = view.refused.length > 0 ? "refused" : view.currentEpoch === 0 || missing.length > 0 ? "waiting" : "ready";
    return { status, currentEpoch: view.currentEpoch, epochs, missing, refused: view.refused, rotated, granted };
  }

  private async loaded(): Promise<Map<number, Uint8Array>> {
    this.keys ??= new Map(await this.options.store.load());
    return this.keys;
  }
}

/** Every item of a paged list, following next-page tokens. */
async function allPages<Item>(fetch: (pageToken: string) => Promise<{ items: Item[]; next: string }>): Promise<Item[]> {
  const items: Item[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(pageToken);
    items.push(...response.items);
    if (response.next === "") return items;
    pageToken = response.next;
  }
  throw new Error("the server's list does not end");
}
