/**
 * An in-memory VaultKeyService for one end-to-end encrypted vault, plus the
 * MembershipService calls the vault key manager makes (ListMembers and
 * RemoveMember), for tests. It follows the contract of
 * proto/vaultsync/v1/vault_key.proto and SPEC.md §9.3 (and the Go server,
 * #694): epochs from 1, created only as a compare-and-set on the current
 * epoch; an epoch's recipients exactly the members with a user key; slots
 * listed only to their recipient; AddKeySlots keeping an existing slot;
 * owner-only management; at most one escrow slot per epoch, only in a vault
 * with escrow. It also serves VaultService's CreateVault for this one vault,
 * making the caller its owner. Each member gets their own transport, so the server
 * knows who calls. Every request is recorded serialized, as it would cross
 * the network.
 */
import { create, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import { MembershipService } from "../../gen/vaultsync/v1/membership_pb";
import { VaultEncryption, VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { UserKeyService } from "../../gen/vaultsync/v1/user_key_pb";
import { VaultService } from "../../gen/vaultsync/v1/vault_pb";
import { ConversionRefusedSchema, KeyRecipientKind, VaultKeyService, type EpochRecord as EpochRecordMessage, type NextEpoch } from "../../gen/vaultsync/v1/vault_key_pb";
import type { LogEntry } from "../../gen/vaultsync/v1/types_pb";
import { equalBytes, randomBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { bundleOf, invitationKeyPair, inviteSignSeed, signPublicKey, uuidString, type EscrowRotation } from "../e2ee/identity";
import { uuidBytes } from "../e2ee/keyslot";
import { EntryType, LogError, genesisPayload, idPayload, invitePayload, redeemPayload, replayLog, verifyEpochRecord, type Entry, type LogState, type ReplayOptions } from "../e2ee/memberlog";
import { logRole } from "./encrypted-membership";
import { fromLogEntry, genesisEntry, nextEntry, toLogEntry } from "./member-log";
import type { UserKeyPair } from "./user-key";

/** A member as the server stores them. */
export interface StoredMember {
  role: VaultRole;
  /** The member's user public key; undefined while they have none. */
  publicKey: Uint8Array | undefined;
  /** The member's signing public key, if their key has one. */
  signPublicKey?: Uint8Array;
}

/** A stored epoch. */
export interface StoredEpoch {
  epoch: number;
  commitment: Uint8Array;
  creator: string;
  /** The owner's signed record, as RotateEpoch or RemoveMember stored it. */
  record?: EpochRecordMessage;
}

/** A stored key slot, to a member or to the escrow key. */
export interface StoredSlot {
  epoch: number;
  recipientKind: KeyRecipientKind;
  recipientId: string;
  wrappedKey: Uint8Array;
  creator: string;
}

/** A request as sent: who sent it, the procedure name and its serialized bytes. */
export interface RecordedRequest {
  caller: string;
  procedure: string;
  bytes: Uint8Array;
}

/** The server's limit of slots in a new epoch (100 members plus one escrow slot). */
const MAX_EPOCH_SLOTS = 101;
/** The server's limit of slots per AddKeySlots. */
const MAX_ADDED_SLOTS = 1000;

export class MemoryVaultKeyServer {
  readonly members = new Map<string, StoredMember>();
  readonly epochs: StoredEpoch[] = [];
  readonly slots: StoredSlot[] = [];
  currentEpoch = 0;
  /** A new E2EE vault starts with a pending rotation. */
  rotationPending = true;
  /** Whether the vault has escrow: its epochs may carry one escrow slot. */
  escrow = false;
  /** The deployment's escrow chain, which the server replays the log with. */
  escrowRotations: EscrowRotation[] = [];
  /** Whether CreateVault created the vault (it can be created once). */
  created = false;
  /** Users' public keys (UserKeyService), which CreateVault's caller is listed with. */
  readonly userKeys = new Map<string, Uint8Array>();
  /** The vault's membership log, from genesis. */
  readonly log: Entry[] = [];
  /** The signing seeds of seeded members, and of the one who signed the genesis. */
  private readonly signSeeds = new Map<string, Uint8Array>();
  private founder: Uint8Array | undefined;
  /** Pending invitations, by id. */
  readonly invitations = new Map<string, { idHash: Uint8Array; role: VaultRole; slots: StoredSlot[]; anchor: Uint8Array }>();
  /**
   * Whether the vault is end-to-end encrypted. A plaintext vault
   * ({@link plaintextVault}) has members but no log or epochs until
   * ConvertVault converts it.
   */
  encrypted = true;
  /** The vault's head seq at its conversion (ListEpochs' conversion_seq); 0 when never converted. */
  conversionSeq = 0n;
  /** In a plaintext vault: its head seq, which a conversion records. */
  headSeq = 0n;
  /** In a plaintext vault: its live documents, whose path keys ConvertVault needs. */
  liveDocuments = new Set<string>();
  /** In a plaintext vault: its pending invitations, which block a conversion. */
  plaintextInvitations: string[] = [];
  /** Users' sealed anchor lists (UserKeyService) and their versions. */
  readonly anchorLists = new Map<string, { version: number; sealed: Uint8Array }>();
  /** Every request any member sent, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Page size of every list; small by default so that clients must page. */
  pageSize = 2;
  /**
   * When set, epoch changes (RotateEpoch, RemoveMember) wait until this many
   * of them have arrived, then run one after the other in arrival order: two
   * owner devices that read the same current epoch race for it.
   */
  holdEpochChanges: number | undefined;
  private held: (() => void)[] = [];

  /** The vault's id: the one CreateVault's caller chose, once it created the vault. */
  constructor(public vaultId: string) {}

  private replayOptions(): ReplayOptions {
    return { escrowRotations: this.escrowRotations };
  }

  /** The membership after the whole log, replayed as the server checks it. */
  logState(): LogState {
    const states = replayLog(this.vaultId, this.log, this.replayOptions());
    const last = states.at(-1);
    if (last === undefined) throw new Error("empty log");
    return last;
  }

  /**
   * Checks `sent` as the server checks a membership change's entry: the
   * log's next position (ABORTED otherwise), verifying on top of the log,
   * of the expected type; `matches` checks it records the requested change.
   * Appends it and returns the state after it.
   */
  appendEntry(sent: LogEntry | undefined, type: number, matches: (entry: Entry, before: LogState, after: LogState) => boolean): LogState {
    return this.appendEntryChecked(sent, type, matches, () => undefined);
  }

  /** {@link appendEntry}, running `check` (which throws to refuse) after the entry verified and before it is appended. */
  private appendEntryChecked(sent: LogEntry | undefined, type: number, matches: (entry: Entry, before: LogState, after: LogState) => boolean, check: () => void): LogState {
    if (sent === undefined) throw new ConnectError("log_entry is required in an E2EE vault", Code.InvalidArgument);
    const entry = fromLogEntry(this.vaultId, sent);
    if (entry.seq !== this.log.length + 1) throw new ConnectError("the entry's seq is not the log's next", Code.Aborted);
    if (entry.type !== type) throw new ConnectError("the entry does not record this change", Code.InvalidArgument);
    let states: LogState[];
    try {
      states = replayLog(this.vaultId, [...this.log, entry], this.replayOptions());
    } catch (error) {
      if (error instanceof LogError) throw new ConnectError(`the entry does not verify: ${error.message}`, Code.InvalidArgument);
      throw error;
    }
    const after = states[states.length - 1];
    const before = states[states.length - 2];
    if (after === undefined || before === undefined || !matches(entry, before, after)) throw new ConnectError("the entry does not record this change", Code.InvalidArgument);
    check();
    this.log.push(entry);
    return after;
  }

  /** Makes this a plaintext vault that exists, with no log and no epochs, as before a conversion. */
  plaintextVault(): void {
    this.encrypted = false;
    this.created = true;
    this.rotationPending = false;
  }

  /** Adds a member of a plaintext vault with their user key and signing key, or with no key. */
  addPlaintextMember(userId: string, role: VaultRole, key?: UserKeyPair): void {
    this.members.set(userId, { role, publicKey: key?.publicKey, signPublicKey: key === undefined ? undefined : signPublicKey(key.signSeed) });
  }

  /** Adds a member; `publicKey` is their user key, if they have one. */
  addMember(userId: string, role: VaultRole, publicKey?: Uint8Array): void {
    this.members.set(userId, { role, publicKey });
  }

  /**
   * Adds a member with their user key and records it in the log as the
   * server would have: the first member (an owner) signs the genesis, every
   * later one is invited by that owner (or by `inviter`) and redeems.
   */
  seedMember(key: UserKeyPair, role: VaultRole, inviter?: UserKeyPair): void {
    this.addMember(key.userId, role, key.publicKey);
    this.signSeeds.set(key.userId, key.signSeed);
    const bundle = bundleOf({ kemSeed: key.privateKey, signSeed: key.signSeed }, key.userId);
    if (this.log.length === 0) {
      if (role !== VaultRole.OWNER) throw new Error("the first seeded member signs the genesis and must be an owner");
      this.founder = key.signSeed;
      this.log.push(genesisEntry(this.vaultId, genesisPayload(bundle, undefined), key.signSeed));
      return;
    }
    const founder = inviter?.signSeed ?? this.founder;
    if (founder === undefined) throw new Error("no owner to invite the member");
    const secret = randomBytes(16);
    const invitationId = crypto.randomUUID();
    const inviteSeed = inviteSignSeed(secret, this.vaultId, invitationId);
    const payload = invitePayload(invitationId, logRole(role), signPublicKey(inviteSeed), invitationKeyPair(secret, this.vaultId, invitationId).publicKey);
    this.log.push(nextEntry(this.vaultId, this.log, { type: EntryType.invite, payload, signSeeds: [founder] }));
    this.log.push(nextEntry(this.vaultId, this.log, { type: EntryType.redeem, payload: redeemPayload(invitationId, bundle), signSeeds: [inviteSeed, key.signSeed] }));
  }

  /** The member leaves (LeaveVault): an owner client must rotate. A seeded member's leave entry is logged. */
  leave(userId: string): void {
    this.members.delete(userId);
    this.rotationPending = true;
    const seed = this.signSeeds.get(userId);
    if (seed !== undefined) this.log.push(nextEntry(this.vaultId, this.log, { type: EntryType.leave, payload: idPayload(userId), signSeeds: [seed] }));
  }

  /** The slots of `epoch`, by recipient. */
  slotsOf(epoch: number): StoredSlot[] {
    return this.slots.filter((slot) => slot.epoch === epoch);
  }

  /** How many requests of `procedure` were sent. */
  count(procedure: string): number {
    return this.requests.filter((request) => request.procedure === procedure).length;
  }

  /** A transport for `userId`'s devices. */
  transport(userId: string): Transport {
    return recording(
      userId,
      createRouterTransport(({ service }) => {
        service(VaultService, {
          createVault: (request) => {
            if (this.created) throw new ConnectError("this memory server holds one vault", Code.ResourceExhausted);
            if (request.encryption !== VaultEncryption.E2EE) throw new ConnectError("this memory server holds an E2EE vault", Code.InvalidArgument);
            if (request.genesis === undefined) throw new ConnectError("genesis is required in an E2EE vault", Code.InvalidArgument);
            const genesis = fromLogEntry(request.newVaultId, request.genesis);
            let state: LogState | undefined;
            try {
              state = replayLog(request.newVaultId, [genesis])[0];
            } catch (error) {
              throw new ConnectError(`invalid genesis: ${error instanceof Error ? error.message : String(error)}`, Code.InvalidArgument);
            }
            const creator = state?.members.get(userId);
            const userKey = this.userKeys.get(userId);
            if (state === undefined || creator === undefined || userKey === undefined || !equalBytes(creator.bundle.kemPub, userKey)) {
              throw new ConnectError("the genesis does not name the caller", Code.InvalidArgument);
            }
            if ((state.escrow !== undefined) !== request.escrow) throw new ConnectError("the genesis does not record the requested escrow", Code.InvalidArgument);
            this.vaultId = request.newVaultId;
            this.log.push(genesis);
            this.created = true;
            this.escrow = request.escrow;
            this.addMember(userId, VaultRole.OWNER, this.userKeys.get(userId));
            return { vault: { id: this.vaultId, name: request.name, encryption: request.encryption, escrow: request.escrow, role: VaultRole.OWNER } };
          },
        });
        service(UserKeyService, {
          getAnchorList: () => {
            const stored = this.anchorLists.get(userId);
            return { version: BigInt(stored?.version ?? 0), sealedList: stored?.sealed ?? new Uint8Array() };
          },
          putAnchorList: (request) => {
            const version = Number(request.version);
            if (version < 1 || request.sealedList.length === 0) throw new ConnectError("invalid anchor list", Code.InvalidArgument);
            if (version !== (this.anchorLists.get(userId)?.version ?? 0) + 1) throw new ConnectError("not the stored version plus one", Code.FailedPrecondition);
            this.anchorLists.set(userId, { version, sealed: request.sealedList });
            return {};
          },
        });
        service(VaultKeyService, {
          listLogEntries: (request) => {
            if (!(request.vaultId === this.vaultId && this.members.has(userId))) this.invitationHeldBy(request.invitationId);
            const { items, next } = this.page(this.log, request.pageToken);
            return { entries: items.map(toLogEntry), nextPageToken: next };
          },
          listKeySlots: (request) => {
            this.member(userId, request.vaultId);
            const mine = this.slots.filter((slot) => slot.recipientKind === KeyRecipientKind.USER && slot.recipientId === userId).sort((a, b) => a.epoch - b.epoch);
            const { items, next } = this.page(mine, request.pageToken);
            return {
              slots: items.map((slot) => ({ epoch: slot.epoch, recipientKind: KeyRecipientKind.USER, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creatorUserId: slot.creator })),
              nextPageToken: next,
            };
          },
          listEpochs: (request) => {
            this.member(userId, request.vaultId);
            const { items, next } = this.page(this.epochs, request.pageToken);
            return {
              epochs: items.map((epoch) => ({ epoch: epoch.epoch, commitment: epoch.commitment, creatorUserId: epoch.creator, record: epoch.record })),
              nextPageToken: next,
              currentEpoch: this.currentEpoch,
              rotationPending: this.rotationPending,
              conversionSeq: this.conversionSeq,
            };
          },
          listMissingSlots: (request) => {
            this.owner(userId, request.vaultId);
            const missing = [];
            for (const epoch of this.epochs) {
              for (const [memberId, member] of [...this.members].sort(([a], [b]) => a.localeCompare(b))) {
                if (member.publicKey === undefined) continue;
                if (this.slots.some((slot) => slot.epoch === epoch.epoch && slot.recipientKind === KeyRecipientKind.USER && slot.recipientId === memberId)) continue;
                missing.push({ epoch: epoch.epoch, userId: memberId, publicKey: member.publicKey });
              }
            }
            const { items, next } = this.page(missing, request.pageToken);
            return { missingSlots: items, nextPageToken: next };
          },
          convertVault: (request) => {
            this.owner(userId, request.vaultId);
            if (this.encrypted) throw new ConnectError("the vault is already end-to-end encrypted", Code.FailedPrecondition);
            const withoutKey = [...this.members].filter(([, member]) => member.publicKey === undefined || member.signPublicKey === undefined).map(([id]) => id);
            if (withoutKey.length > 0 || this.plaintextInvitations.length > 0) {
              throw new ConnectError("the vault cannot be converted yet", Code.FailedPrecondition, undefined, [
                { desc: ConversionRefusedSchema, value: { membersWithoutKey: withoutKey.sort(), pendingInvitations: [...this.plaintextInvitations].sort() } },
              ]);
            }
            if (request.genesis === undefined) throw new ConnectError("genesis is required", Code.InvalidArgument);
            if (request.membersEntry === undefined) throw new ConnectError("members_entry is required", Code.InvalidArgument);
            const log = [fromLogEntry(this.vaultId, request.genesis), fromLogEntry(this.vaultId, request.membersEntry)];
            let state: LogState | undefined;
            try {
              state = replayLog(this.vaultId, log, this.replayOptions()).at(-1);
            } catch (error) {
              throw new ConnectError(`the log does not verify: ${error instanceof Error ? error.message : String(error)}`, Code.InvalidArgument);
            }
            if (state?.members.get(userId)?.role !== logRole(VaultRole.OWNER) || (state.escrow !== undefined) !== request.escrow) {
              throw new ConnectError("the genesis does not name the caller or the requested escrow", Code.InvalidArgument);
            }
            const named =
              state.members.size === this.members.size &&
              [...this.members].every(([id, member]) => {
                const logged = state.members.get(id);
                return (
                  logged !== undefined &&
                  logged.role === logRole(member.role) &&
                  member.publicKey !== undefined &&
                  member.signPublicKey !== undefined &&
                  equalBytes(logged.bundle.kemPub, member.publicKey) &&
                  equalBytes(logged.bundle.signPub, member.signPublicKey)
                );
              });
            if (!named) throw new ConnectError("the log does not name the vault's members, roles and keys", Code.Aborted);
            if (state.convertedAtSeq !== this.headSeq) throw new ConnectError("the vault changed since the members entry's converted_at_seq", Code.Aborted);
            const documents = new Set(request.pathKeys.map((entry) => entry.documentId));
            if (documents.size !== request.pathKeys.length || request.pathKeys.some((entry) => entry.pathKey.length !== 32)) {
              throw new ConnectError("one 32-byte path key per document", Code.InvalidArgument);
            }
            if (documents.size !== this.liveDocuments.size || [...documents].some((id) => !this.liveDocuments.has(id))) {
              throw new ConnectError("path_keys do not name the vault's live documents", Code.Aborted);
            }
            const nextEpoch = this.checkNextEpoch(request.nextEpoch);
            this.checkRecord(nextEpoch, request.record, log, log.length);
            this.escrow = request.escrow;
            this.log.push(...log);
            const epoch = this.applyNextEpoch(userId, nextEpoch, request.record);
            this.encrypted = true;
            this.conversionSeq = this.headSeq;
            return { epoch: { epoch: epoch.epoch, commitment: epoch.commitment, creatorUserId: epoch.creator }, conversionSeq: this.conversionSeq };
          },
          rotateEpoch: async (request) => {
            this.owner(userId, request.vaultId);
            const nextEpoch = this.checkNextEpoch(request.nextEpoch);
            await this.hold();
            this.checkEpochCurrent(nextEpoch);
            if (request.escrowEntry === undefined) {
              this.checkRecord(nextEpoch, request.record, this.log, undefined);
            } else {
              // The escrow entry is appended with the epoch, whose record names it.
              // An escrow entry (0x08), or an escrow reset entry (0x0A) that adopts a reset.
              const escrowEntry = request.escrowEntry;
              const previous = this.escrow;
              const type = escrowEntry.type === EntryType.escrowReset ? EntryType.escrowReset : EntryType.escrow;
              const after = this.appendEntryChecked(escrowEntry, type, () => true, () => {
                const entry = fromLogEntry(this.vaultId, escrowEntry);
                this.escrow = replayLog(this.vaultId, [...this.log, entry], this.replayOptions()).at(-1)?.escrow !== undefined;
                try {
                  this.checkRecord(nextEpoch, request.record, [...this.log, entry], entry.seq);
                } catch (error) {
                  this.escrow = previous;
                  throw error;
                }
              });
              this.escrow = after.escrow !== undefined;
            }
            const epoch = this.applyNextEpoch(userId, nextEpoch, request.record);
            return { epoch: { epoch: epoch.epoch, commitment: epoch.commitment, creatorUserId: epoch.creator } };
          },
          addKeySlots: (request) => {
            this.owner(userId, request.vaultId);
            if (request.slots.length < 1 || request.slots.length > MAX_ADDED_SLOTS) throw new ConnectError("1 to 1000 slots", Code.InvalidArgument);
            const seen = new Set<string>();
            for (const slot of request.slots) {
              if (slot.recipientKind !== KeyRecipientKind.USER) throw new ConnectError("no escrow in this vault", Code.InvalidArgument);
              checkWrappedKey(slot.wrappedKey);
              if (!this.epochs.some((epoch) => epoch.epoch === slot.epoch)) throw new ConnectError("no such epoch", Code.InvalidArgument);
              if (this.members.get(slot.recipientId)?.publicKey === undefined) throw new ConnectError("not a member with a user key", Code.InvalidArgument);
              const key = `${String(slot.epoch)}/${slot.recipientId}`;
              if (seen.has(key)) throw new ConnectError("duplicate slot", Code.InvalidArgument);
              seen.add(key);
            }
            let added = 0;
            for (const slot of request.slots) {
              if (this.slots.some((stored) => stored.epoch === slot.epoch && stored.recipientId === slot.recipientId)) continue;
              this.slots.push({ epoch: slot.epoch, recipientKind: KeyRecipientKind.USER, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creator: userId });
              added++;
            }
            return { added };
          },
        });
        service(MembershipService, {
          listMembers: (request) => {
            this.owner(userId, request.vaultId);
            return {
              members: [...this.members].map(([memberId, member]) => ({
                userId: memberId,
                role: member.role,
                publicKey: member.publicKey ?? new Uint8Array(),
                signPublicKey: member.signPublicKey ?? new Uint8Array(),
              })),
            };
          },
          listInvitations: (request) => {
            this.owner(userId, request.vaultId);
            return { invitations: this.encrypted ? [] : this.plaintextInvitations.map((id) => ({ id, role: VaultRole.EDITOR })) };
          },
          removeMember: async (request) => {
            this.owner(userId, request.vaultId);
            if (!this.members.has(request.userId)) throw new ConnectError("not a member", Code.NotFound);
            const nextEpoch = this.checkNextEpoch(request.nextEpoch);
            await this.hold();
            if (!this.members.has(request.userId)) throw new ConnectError("not a member", Code.NotFound);
            this.checkEpochCurrent(nextEpoch);
            this.appendEntryChecked(
              request.logEntry,
              EntryType.removeMember,
              (_entry, before, after) => before.members.has(request.userId) && !after.members.has(request.userId),
              () => {
                if (request.logEntry === undefined) return;
                const entry = fromLogEntry(this.vaultId, request.logEntry);
                this.checkRecord(nextEpoch, request.record, [...this.log, entry], entry.seq);
              },
            );
            this.applyNextEpoch(userId, nextEpoch, request.record);
            this.members.delete(request.userId);
            return {};
          },
          createInvitation: (request) => {
            this.owner(userId, request.vaultId);
            if (request.idHash.length !== 32 || request.inviteAnchor.length !== 96) throw new ConnectError("id_hash and invite_anchor are required", Code.InvalidArgument);
            const before = new Set(this.invitations.keys());
            const state = this.appendEntryChecked(
              request.logEntry,
              EntryType.invite,
              (_entry, previous, after) => {
                const added = [...after.invitations.keys()].filter((id) => !previous.invitations.has(id));
                return added.length === 1 && after.invitations.get(added[0] ?? "")?.role === logRole(request.role);
              },
              () => {
                // The slots: exactly one per epoch, to the new invitation.
                const invitationId = request.logEntry === undefined ? "" : uuidString(request.logEntry.payload.subarray(0, 16));
                const epochs = request.slots.map((slot) => slot.epoch).sort((a, b) => a - b);
                if (epochs.length !== this.currentEpoch || epochs.some((epoch, index) => epoch !== index + 1)) throw new ConnectError("one slot per epoch", Code.InvalidArgument);
                if (request.slots.some((slot) => slot.recipientKind !== KeyRecipientKind.INVITATION || slot.recipientId !== invitationId)) {
                  throw new ConnectError("invitation slots only", Code.InvalidArgument);
                }
              },
            );
            const invitationId = [...state.invitations.keys()].find((id) => !before.has(id)) ?? "";
            this.invitations.set(invitationId, {
              idHash: request.idHash,
              role: request.role,
              anchor: request.inviteAnchor,
              slots: request.slots.map((slot) => ({ epoch: slot.epoch, recipientKind: slot.recipientKind, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creator: userId })),
            });
            return { invitation: { id: invitationId, role: request.role }, code: "" };
          },
          revokeInvitation: (request) => {
            this.owner(userId, request.vaultId);
            if (!this.invitations.has(request.invitationId)) throw new ConnectError("no such invitation", Code.NotFound);
            this.appendEntry(request.logEntry, EntryType.revokeInvitation, (_entry, before, after) => before.invitations.has(request.invitationId) && !after.invitations.has(request.invitationId));
            this.invitations.delete(request.invitationId);
            return {};
          },
          updateMemberRole: (request) => {
            this.owner(userId, request.vaultId);
            const member = this.members.get(request.userId);
            if (member === undefined) throw new ConnectError("not a member", Code.NotFound);
            this.appendEntry(request.logEntry, EntryType.setRole, (_entry, _before, after) => after.members.get(request.userId)?.role === logRole(request.role));
            member.role = request.role;
            return { member: { userId: request.userId, role: request.role } };
          },
          getInvitationSlots: (request) => {
            const [invitationId, invitation] = this.invitationHeldBy(request.id);
            return {
              invitationId,
              vaultId: this.vaultId,
              role: invitation.role,
              slots: [...invitation.slots].sort((a, b) => a.epoch - b.epoch).map((slot) => ({ epoch: slot.epoch, recipientKind: slot.recipientKind, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creatorUserId: slot.creator })),
              epochs: this.epochs.map((epoch) => ({ epoch: epoch.epoch, commitment: epoch.commitment, creatorUserId: epoch.creator, record: epoch.record })),
              inviteAnchor: invitation.anchor,
            };
          },
          redeemInvitation: (request) => {
            const [invitationId, invitation] = this.invitationHeldBy(request.code.split(".")[0] ?? "");
            if (this.members.has(userId)) throw new ConnectError("already a member of this vault", Code.AlreadyExists);
            const publicKey = this.userKeys.get(userId);
            if (publicKey === undefined) throw new ConnectError("the caller has no user key", Code.InvalidArgument);
            this.appendEntryChecked(
              request.logEntry,
              EntryType.redeem,
              (entry, before, after) => equalBytes(entry.payload.subarray(0, 16), uuidBytes("invitation id", invitationId)) && !before.members.has(userId) && after.members.get(userId)?.role === logRole(invitation.role),
              () => {
                // The caller's own slots: exactly one per epoch.
                const epochs = request.slots.map((slot) => slot.epoch).sort((a, b) => a - b);
                if (epochs.length !== this.currentEpoch || epochs.some((epoch, index) => epoch !== index + 1)) throw new ConnectError("one slot per epoch", Code.InvalidArgument);
                if (request.slots.some((slot) => slot.recipientKind !== KeyRecipientKind.USER || slot.recipientId !== userId)) throw new ConnectError("slots wrapped to the caller only", Code.InvalidArgument);
                for (const slot of request.slots) checkWrappedKey(slot.wrappedKey);
              },
            );
            for (const slot of request.slots) this.slots.push({ epoch: slot.epoch, recipientKind: KeyRecipientKind.USER, recipientId: userId, wrappedKey: slot.wrappedKey, creator: userId });
            this.addMember(userId, invitation.role, publicKey);
            this.invitations.delete(invitationId);
            return { vault: { id: this.vaultId, role: invitation.role, encryption: VaultEncryption.E2EE } };
          },
          leaveVault: (request) => {
            this.member(userId, request.vaultId);
            this.appendEntry(request.logEntry, EntryType.leave, (_entry, before, after) => before.members.has(userId) && !after.members.has(userId));
            this.members.delete(userId);
            this.rotationPending = true;
            return {};
          },
        });
      }),
      this.requests,
    );
  }

  private member(userId: string, vaultId: string): StoredMember {
    const member = vaultId === this.vaultId ? this.members.get(userId) : undefined;
    if (member === undefined) throw new ConnectError("vault not found", Code.NotFound);
    return member;
  }

  /** The pending invitation whose code's `<id>` is `id`; NOT_FOUND for any other id, as the server answers. */
  private invitationHeldBy(id: string): [string, { idHash: Uint8Array; role: VaultRole; slots: StoredSlot[]; anchor: Uint8Array }] {
    let raw: Uint8Array | undefined;
    try {
      raw = base64urlnopad.decode(id);
    } catch {
      raw = undefined;
    }
    const hash = raw?.length === 16 ? sha256(raw) : undefined;
    const found = hash === undefined ? undefined : [...this.invitations].find(([, invitation]) => equalBytes(invitation.idHash, hash));
    if (found === undefined) throw new ConnectError("invitation not found", Code.NotFound);
    return found;
  }

  private owner(userId: string, vaultId: string): void {
    if (this.member(userId, vaultId).role !== VaultRole.OWNER) throw new ConnectError("owners only", Code.PermissionDenied);
  }

  private page<Item>(items: readonly Item[], token: string): { items: Item[]; next: string } {
    const start = token === "" ? 0 : Number(token);
    if (!Number.isInteger(start) || start < 0) throw new ConnectError("bad page token", Code.InvalidArgument);
    const end = start + this.pageSize;
    return { items: items.slice(start, end), next: end < items.length ? String(end) : "" };
  }

  private checkNextEpoch(nextEpoch: NextEpoch | undefined): NextEpoch {
    if (nextEpoch === undefined) throw new ConnectError("next_epoch is required in an E2EE vault", Code.InvalidArgument);
    if (nextEpoch.commitment.length !== 32) throw new ConnectError("commitment must be 32 bytes", Code.InvalidArgument);
    if (nextEpoch.slots.length > MAX_EPOCH_SLOTS) throw new ConnectError("too many slots", Code.InvalidArgument);
    for (const slot of nextEpoch.slots) checkWrappedKey(slot.wrappedKey);
    return nextEpoch;
  }

  /**
   * Checks the new epoch's record as the server does: signed by an owner at
   * its position of `log` (`position` when the request appends an entry with
   * the epoch) over the new epoch's commitment and the current one's, its
   * recipients the log's there, and the slots exactly one per recipient.
   */
  private checkRecord(nextEpoch: NextEpoch, record: EpochRecordMessage | undefined, log: readonly Entry[], position: number | undefined): void {
    if (record === undefined) throw new ConnectError("an E2EE vault's epoch needs its signed record", Code.InvalidArgument);
    if (position !== undefined && Number(record.logSeq) !== position) throw new ConnectError("the record must name the entry appended with the epoch", Code.InvalidArgument);
    const previous = this.epochs.find((stored) => stored.epoch === nextEpoch.expectedEpoch)?.commitment ?? new Uint8Array(32);
    const recipients = record.recipients.map((recipient) => ({ kind: recipient.kind, id: recipient.recipientId, keyHash: recipient.keyHash }));
    try {
      verifyEpochRecord(this.vaultId, replayLog(this.vaultId, log, this.replayOptions()), {
        vaultId: this.vaultId,
        epoch: nextEpoch.expectedEpoch + 1,
        commitment: nextEpoch.commitment,
        prevCommitment: previous,
        logSeq: Number(record.logSeq),
        logHash: record.logHash,
        recipients,
        signature: record.signature,
      });
    } catch {
      throw new ConnectError("the record is not signed by an owner at its log position, or its recipients are not the log's", Code.InvalidArgument);
    }
    const expected = new Set(
      recipients.map((recipient) => `${String(recipient.kind)}/${recipient.kind === 0x02 ? new TextDecoder().decode(recipient.id) : uuidString(recipient.id)}`),
    );
    const sent = new Set(nextEpoch.slots.map((slot) => `${String(slot.recipientKind)}/${slot.recipientId}`));
    if (sent.size !== nextEpoch.slots.length || sent.size !== expected.size || [...sent].some((key) => !expected.has(key))) {
      throw new ConnectError("next_epoch.slots are not the record's recipients", Code.InvalidArgument);
    }
    if (!this.escrow && nextEpoch.slots.some((slot) => slot.recipientKind === KeyRecipientKind.ESCROW)) throw new ConnectError("no escrow in this vault", Code.InvalidArgument);
  }

  private checkEpochCurrent(nextEpoch: NextEpoch): void {
    if (nextEpoch.expectedEpoch !== this.currentEpoch) {
      throw new ConnectError("expected_epoch is not the vault's current epoch", Code.FailedPrecondition, undefined, [
        { desc: ErrorDetailSchema, value: { reason: ErrorReason.EPOCH_NOT_CURRENT } },
      ]);
    }
  }

  private applyNextEpoch(creator: string, nextEpoch: NextEpoch, record: EpochRecordMessage | undefined): StoredEpoch {
    this.checkEpochCurrent(nextEpoch);
    const epoch: StoredEpoch = { epoch: this.currentEpoch + 1, commitment: nextEpoch.commitment, creator, record };
    this.epochs.push(epoch);
    for (const slot of nextEpoch.slots) {
      const stored = { epoch: epoch.epoch, recipientKind: slot.recipientKind, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creator };
      const invitation = slot.recipientKind === KeyRecipientKind.INVITATION ? this.invitations.get(slot.recipientId) : undefined;
      if (invitation !== undefined) invitation.slots.push(stored);
      else this.slots.push(stored);
    }
    this.currentEpoch = epoch.epoch;
    this.rotationPending = false;
    return epoch;
  }

  /** Waits for the held epoch changes (holdEpochChanges), then lets them run in arrival order. */
  private async hold(): Promise<void> {
    if (this.holdEpochChanges === undefined) return;
    const arrived = new Promise<void>((resolve) => this.held.push(resolve));
    if (this.held.length >= this.holdEpochChanges) {
      this.holdEpochChanges = undefined;
      const held = this.held;
      this.held = [];
      for (const release of held) release();
    }
    await arrived;
  }
}

function checkWrappedKey(wrappedKey: Uint8Array): void {
  if (wrappedKey.length < 1 || wrappedKey.length > 2048) throw new ConnectError("wrapped key must be 1 to 2048 bytes", Code.InvalidArgument);
}

/** `transport`, recording each unary request's caller and serialized bytes into `requests`. */
function recording(caller: string, transport: Transport, requests: RecordedRequest[]): Transport {
  return {
    unary: (method, signal, timeoutMs, header, input, contextValues) => {
      const schema: DescMessage = method.input;
      requests.push({ caller, procedure: method.name, bytes: toBinary(schema, create(schema, input)) });
      return transport.unary(method, signal, timeoutMs, header, input, contextValues);
    },
    stream: (method, signal, timeoutMs, header, input, contextValues) => transport.stream(method, signal, timeoutMs, header, input, contextValues),
  };
}
