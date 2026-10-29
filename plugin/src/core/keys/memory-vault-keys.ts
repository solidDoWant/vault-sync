/**
 * An in-memory VaultKeyService for one end-to-end encrypted vault, plus the
 * MembershipService calls the vault key manager makes (ListMembers and
 * RemoveMember), for tests. It follows the contract of
 * proto/vaultsync/v1/vault_key.proto and SPEC.md §9.3 (and the Go server,
 * #694): epochs from 1, created only as a compare-and-set on the current
 * epoch; an epoch's recipients exactly the members with a user key; slots
 * listed only to their recipient; AddKeySlots keeping an existing slot;
 * owner-only management. Each member gets their own transport, so the server
 * knows who calls. Every request is recorded serialized, as it would cross
 * the network.
 */
import { create, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import { MembershipService } from "../../gen/vaultsync/v1/membership_pb";
import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { KeyRecipientKind, VaultKeyService, type NextEpoch } from "../../gen/vaultsync/v1/vault_key_pb";

/** A member as the server stores them. */
export interface StoredMember {
  role: VaultRole;
  /** The member's user public key; undefined while they have none. */
  publicKey: Uint8Array | undefined;
}

/** A stored epoch. */
export interface StoredEpoch {
  epoch: number;
  commitment: Uint8Array;
  creator: string;
}

/** A stored user key slot. */
export interface StoredSlot {
  epoch: number;
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

  constructor(readonly vaultId: string) {}

  /** Adds a member; `publicKey` is their user key, if they have one. */
  addMember(userId: string, role: VaultRole, publicKey?: Uint8Array): void {
    this.members.set(userId, { role, publicKey });
  }

  /** The member leaves (LeaveVault): an owner client must rotate. */
  leave(userId: string): void {
    this.members.delete(userId);
    this.rotationPending = true;
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
        service(VaultKeyService, {
          listKeySlots: (request) => {
            this.member(userId, request.vaultId);
            const mine = this.slots.filter((slot) => slot.recipientId === userId).sort((a, b) => a.epoch - b.epoch);
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
              epochs: items.map((epoch) => ({ epoch: epoch.epoch, commitment: epoch.commitment, creatorUserId: epoch.creator })),
              nextPageToken: next,
              currentEpoch: this.currentEpoch,
              rotationPending: this.rotationPending,
            };
          },
          listMissingSlots: (request) => {
            this.owner(userId, request.vaultId);
            const missing = [];
            for (const epoch of this.epochs) {
              for (const [memberId, member] of [...this.members].sort(([a], [b]) => a.localeCompare(b))) {
                if (member.publicKey === undefined) continue;
                if (this.slots.some((slot) => slot.epoch === epoch.epoch && slot.recipientId === memberId)) continue;
                missing.push({ epoch: epoch.epoch, userId: memberId, publicKey: member.publicKey });
              }
            }
            const { items, next } = this.page(missing, request.pageToken);
            return { missingSlots: items, nextPageToken: next };
          },
          rotateEpoch: async (request) => {
            this.owner(userId, request.vaultId);
            const nextEpoch = this.checkNextEpoch(request.nextEpoch, undefined);
            await this.hold();
            const epoch = this.applyNextEpoch(userId, nextEpoch);
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
              this.slots.push({ epoch: slot.epoch, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creator: userId });
              added++;
            }
            return { added };
          },
        });
        service(MembershipService, {
          listMembers: (request) => {
            this.owner(userId, request.vaultId);
            return {
              members: [...this.members].map(([memberId, member]) => ({ userId: memberId, role: member.role, publicKey: member.publicKey ?? new Uint8Array() })),
            };
          },
          removeMember: async (request) => {
            this.owner(userId, request.vaultId);
            if (!this.members.has(request.userId)) throw new ConnectError("not a member", Code.NotFound);
            const nextEpoch = this.checkNextEpoch(request.nextEpoch, request.userId);
            await this.hold();
            if (!this.members.has(request.userId)) throw new ConnectError("not a member", Code.NotFound);
            this.checkRecipients(nextEpoch, request.userId);
            this.applyNextEpoch(userId, nextEpoch);
            this.members.delete(request.userId);
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

  private owner(userId: string, vaultId: string): void {
    if (this.member(userId, vaultId).role !== VaultRole.OWNER) throw new ConnectError("owners only", Code.PermissionDenied);
  }

  private page<Item>(items: readonly Item[], token: string): { items: Item[]; next: string } {
    const start = token === "" ? 0 : Number(token);
    if (!Number.isInteger(start) || start < 0) throw new ConnectError("bad page token", Code.InvalidArgument);
    const end = start + this.pageSize;
    return { items: items.slice(start, end), next: end < items.length ? String(end) : "" };
  }

  private checkNextEpoch(nextEpoch: NextEpoch | undefined, removed: string | undefined): NextEpoch {
    if (nextEpoch === undefined) throw new ConnectError("next_epoch is required in an E2EE vault", Code.InvalidArgument);
    if (nextEpoch.commitment.length !== 32) throw new ConnectError("commitment must be 32 bytes", Code.InvalidArgument);
    if (nextEpoch.slots.length > MAX_EPOCH_SLOTS) throw new ConnectError("too many slots", Code.InvalidArgument);
    for (const slot of nextEpoch.slots) checkWrappedKey(slot.wrappedKey);
    this.checkRecipients(nextEpoch, removed);
    return nextEpoch;
  }

  /** The slots must be exactly the members with a user key, but `removed`. */
  private checkRecipients(nextEpoch: NextEpoch, removed: string | undefined): void {
    const seen = new Set<string>();
    for (const slot of nextEpoch.slots) {
      if (slot.recipientKind !== KeyRecipientKind.USER) throw new ConnectError("no escrow in this vault", Code.InvalidArgument);
      if (slot.recipientId === removed || this.members.get(slot.recipientId)?.publicKey === undefined) {
        throw new ConnectError(`user ${slot.recipientId} is not a recipient`, Code.InvalidArgument);
      }
      if (seen.has(slot.recipientId)) throw new ConnectError("duplicate slot", Code.InvalidArgument);
      seen.add(slot.recipientId);
    }
    for (const [memberId, member] of this.members) {
      if (memberId !== removed && member.publicKey !== undefined && !seen.has(memberId)) throw new ConnectError(`no slot for ${memberId}`, Code.InvalidArgument);
    }
  }

  private applyNextEpoch(creator: string, nextEpoch: NextEpoch): StoredEpoch {
    if (nextEpoch.expectedEpoch !== this.currentEpoch) {
      throw new ConnectError("expected_epoch is not the vault's current epoch", Code.FailedPrecondition, undefined, [
        { desc: ErrorDetailSchema, value: { reason: ErrorReason.EPOCH_NOT_CURRENT } },
      ]);
    }
    const epoch: StoredEpoch = { epoch: this.currentEpoch + 1, commitment: nextEpoch.commitment, creator };
    this.epochs.push(epoch);
    for (const slot of nextEpoch.slots) this.slots.push({ epoch: epoch.epoch, recipientId: slot.recipientId, wrappedKey: slot.wrappedKey, creator });
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
