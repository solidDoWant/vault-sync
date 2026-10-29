/**
 * The membership log and signed epoch records of docs/design/crypto.md
 * "Identity keys, the membership log and signed epochs": an append-only,
 * hash-chained, signed log per encrypted vault, its replay into the member
 * set, roles, pending invitations and escrow state at every sequence number,
 * and owner-signed epochs checked against that replay. The Go implementation
 * (internal/e2ee) must agree with testdata/crypto/vectors.json.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type Bundle,
  BUNDLE_SIZE,
  encodeBundle,
  encodeEscrowBundle,
  type EscrowBundle,
  escrowKeyId,
  escrowReachable,
  type EscrowRotation,
  HASH_SIZE,
  lengthPrefixed,
  MAX_ESCROW_RECIPIENT_SIZE,
  parseBundle,
  parseEscrowBundle,
  sign,
  SIGN_PUBLIC_KEY_SIZE,
  u64,
  uuidString,
  verifySignature,
} from "./identity";
import { concat, MAX_RECIPIENT_ID_SIZE, uuidBytes } from "./keyslot";

const LOG_ENTRY_LABEL = "vault-sync/v1/log-entry";
const EPOCH_RECORD_LABEL = "vault-sync/v1/epoch";
const encoder = new TextEncoder();

/** The largest log entry payload: a genesis with an escrow bundle. */
export const MAX_ENTRY_PAYLOAD_SIZE = BUNDLE_SIZE + 1 + "vault-sync/v1/escrow".length + SIGN_PUBLIC_KEY_SIZE + 4 + MAX_ESCROW_RECIPIENT_SIZE;
/** The most recipients of one epoch record (count is a u16). */
export const MAX_EPOCH_RECIPIENTS = 0xffff;

/** Thrown when a membership log does not verify. */
export class LogError extends Error {
  constructor(detail: string) {
    super(`e2ee: membership log does not verify: ${detail}`);
    this.name = "LogError";
  }
}

/** Thrown for an epoch record that does not verify. */
export class EpochRecordError extends Error {
  constructor() {
    super("e2ee: epoch record does not verify");
    this.name = "EpochRecordError";
  }
}

/** The entry types. */
export const EntryType = Object.freeze({
  genesis: 0x01,
  invite: 0x02,
  revokeInvitation: 0x03,
  redeem: 0x04,
  removeMember: 0x05,
  leave: 0x06,
  setRole: 0x07,
  escrow: 0x08,
});

/** The roles. */
export const Role = Object.freeze({ owner: 0x01, editor: 0x02, viewer: 0x03 });

const validRole = (role: number): boolean => role >= Role.owner && role <= Role.viewer;

/** A log entry with its signatures (a redeem entry has the invitation key's, then the newcomer's). */
export interface Entry {
  vaultId: string;
  seq: number;
  prevHash: Uint8Array;
  type: number;
  payload: Uint8Array;
  signatures: Uint8Array[];
}

/** "vault-sync/v1/log-entry" || uuid(vault_id) || seq (u64) || prev_hash (32) || type (u8) || lp(payload). */
export function entryBody(entry: Omit<Entry, "signatures">): Uint8Array {
  if (entry.prevHash.length !== HASH_SIZE) throw new Error("e2ee: prev hash of the wrong size");
  if (entry.payload.length > MAX_ENTRY_PAYLOAD_SIZE) throw new Error("e2ee: log entry payload too large");
  return concat(encoder.encode(LOG_ENTRY_LABEL), uuidBytes("vault id", entry.vaultId), u64(entry.seq), entry.prevHash, Uint8Array.of(entry.type), lengthPrefixed(entry.payload));
}

/** SHA-256 of the entry body. */
export function entryHash(entry: Omit<Entry, "signatures">): Uint8Array {
  return sha256(entryBody(entry));
}

/** Returns the entry signed with the Ed25519 seeds, in order. */
export function signEntry(entry: Omit<Entry, "signatures">, ...signSeeds: Uint8Array[]): Entry {
  const body = entryBody(entry);
  return { ...entry, signatures: signSeeds.map((seed) => sign(seed, body)) };
}

/** 0x00 for no escrow, or 0x01 || escrow bundle. */
export function escrowPayload(escrow: EscrowBundle | undefined): Uint8Array {
  return escrow === undefined ? Uint8Array.of(0x00) : concat(Uint8Array.of(0x01), encodeEscrowBundle(escrow));
}

/** The creator's bundle, then the escrow part. */
export function genesisPayload(creator: Bundle, escrow: EscrowBundle | undefined): Uint8Array {
  return concat(encodeBundle(creator), escrowPayload(escrow));
}

/** uuid(invitation_id) || role || invite_sign_pub. */
export function invitePayload(invitationId: string, role: number, inviteSignPub: Uint8Array): Uint8Array {
  if (!validRole(role) || inviteSignPub.length !== SIGN_PUBLIC_KEY_SIZE) throw new Error("e2ee: malformed invite");
  return concat(uuidBytes("invitation id", invitationId), Uint8Array.of(role), inviteSignPub);
}

/** uuid(id): the payload of revoke invitation, remove member and leave. */
export function idPayload(id: string): Uint8Array {
  return uuidBytes("id", id);
}

/** uuid(invitation_id) || newcomer bundle. */
export function redeemPayload(invitationId: string, newcomer: Bundle): Uint8Array {
  return concat(uuidBytes("invitation id", invitationId), encodeBundle(newcomer));
}

/** uuid(user_id) || role. */
export function setRolePayload(userId: string, role: number): Uint8Array {
  if (!validRole(role)) throw new Error("e2ee: unknown role");
  return concat(uuidBytes("user id", userId), Uint8Array.of(role));
}

function parseEscrowPayload(payload: Uint8Array): { escrow: EscrowBundle | undefined } | undefined {
  if (payload.length === 1 && payload[0] === 0x00) return { escrow: undefined };
  if (payload.length > 1 && payload[0] === 0x01) {
    try {
      return { escrow: parseEscrowBundle(payload.subarray(1)) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A vault member in the replayed log. */
export interface Member {
  bundle: Bundle;
  role: number;
}

/** A pending invitation in the replayed log. */
export interface Invitation {
  id: string;
  role: number;
  signPub: Uint8Array;
}

/** The membership after the entry at `seq`. */
export interface LogState {
  seq: number;
  hash: Uint8Array;
  members: ReadonlyMap<string, Member>;
  invitations: ReadonlyMap<string, Invitation>;
  escrow: EscrowBundle | undefined;
  /** The escrow bundle most recently named in the log, kept while escrow is off. */
  lastEscrow: EscrowBundle | undefined;
}

/** What a device trusts beyond the log. */
export interface ReplayOptions {
  /** The trust anchor the genesis entry must hash to. */
  genesisHash?: Uint8Array;
  /** The published chain of escrow rotation statements. */
  escrowRotations?: readonly EscrowRotation[];
}

function ownerSigned(state: LogState, body: Uint8Array, signature: Uint8Array): boolean {
  for (const member of state.members.values()) {
    if (member.role === Role.owner && verifySignature(member.bundle.signPub, body, signature)) return true;
  }
  return false;
}

/**
 * Verifies a vault's log from genesis and returns the state after every
 * entry (`states[i]` is the state at seq i + 1). Throws {@link LogError} on
 * the first broken link, wrong signer or entry not allowed at its point.
 */
export function replayLog(vaultId: string, entries: readonly Entry[], options: ReplayOptions = {}): LogState[] {
  if (entries.length === 0) throw new LogError("empty log");
  const states: LogState[] = [];
  const used = new Set<string>();
  let state: LogState = { seq: 0, hash: new Uint8Array(HASH_SIZE), members: new Map(), invitations: new Map(), escrow: undefined, lastEscrow: undefined };
  for (const entry of entries) {
    let next: LogState;
    try {
      next = applyEntry(vaultId, state, used, entry, options.escrowRotations ?? []);
    } catch (error) {
      throw new LogError(`seq ${String(state.seq + 1)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (next.seq === 1 && options.genesisHash !== undefined && !equalBytes(next.hash, options.genesisHash)) {
      throw new LogError("genesis does not match the trust anchor");
    }
    states.push(next);
    state = next;
  }
  return states;
}

function uuidAt(payload: Uint8Array): string {
  if (payload.length !== 16) throw new Error("malformed id");
  return uuidString(payload);
}

function applyEntry(vaultId: string, state: LogState, used: Set<string>, entry: Entry, rotations: readonly EscrowRotation[]): LogState {
  if (entry.vaultId !== vaultId || entry.seq !== state.seq + 1 || !equalBytes(entry.prevHash, state.hash)) throw new Error("broken link");
  const body = entryBody(entry);
  if ((entry.type === EntryType.genesis) !== (entry.seq === 1)) throw new Error("genesis must be exactly the first entry");
  if (entry.signatures.length !== (entry.type === EntryType.redeem ? 2 : 1)) throw new Error("wrong number of signatures");

  const members = new Map(state.members);
  const invitations = new Map(state.invitations);
  let { escrow, lastEscrow } = state;
  const payload = entry.payload;
  const signature = entry.signatures[0] ?? new Uint8Array();
  const requireOwner = (): void => {
    if (!ownerSigned(state, body, signature)) throw new Error("wrong signer");
  };

  switch (entry.type) {
    case EntryType.genesis: {
      if (payload.length < BUNDLE_SIZE) throw new Error("malformed genesis");
      const creator = parseBundle(payload.subarray(0, BUNDLE_SIZE));
      const parsed = parseEscrowPayload(payload.subarray(BUNDLE_SIZE));
      if (parsed === undefined) throw new Error("malformed genesis escrow");
      if (!verifySignature(creator.signPub, body, signature)) throw new Error("wrong signer");
      members.set(creator.userId, { bundle: creator, role: Role.owner });
      escrow = parsed.escrow;
      lastEscrow = parsed.escrow;
      break;
    }
    case EntryType.invite: {
      if (payload.length !== 16 + 1 + SIGN_PUBLIC_KEY_SIZE) throw new Error("malformed invite");
      const id = uuidString(payload.subarray(0, 16));
      const role = payload[16] ?? 0;
      if (!validRole(role)) throw new Error("unknown role");
      requireOwner();
      if (used.has(id)) throw new Error("invitation id already used");
      used.add(id);
      invitations.set(id, { id, role, signPub: payload.slice(17) });
      break;
    }
    case EntryType.revokeInvitation: {
      const id = uuidAt(payload);
      requireOwner();
      if (!state.invitations.has(id)) throw new Error("invitation not pending");
      invitations.delete(id);
      break;
    }
    case EntryType.redeem: {
      if (payload.length !== 16 + BUNDLE_SIZE) throw new Error("malformed redeem");
      const id = uuidString(payload.subarray(0, 16));
      const newcomer = parseBundle(payload.subarray(16));
      const invitation = state.invitations.get(id);
      if (invitation === undefined) throw new Error("invitation not pending");
      if (!verifySignature(invitation.signPub, body, signature) || !verifySignature(newcomer.signPub, body, entry.signatures[1] ?? new Uint8Array())) {
        throw new Error("wrong signer");
      }
      if (state.members.has(newcomer.userId)) throw new Error("already a member");
      invitations.delete(id);
      members.set(newcomer.userId, { bundle: newcomer, role: invitation.role });
      break;
    }
    case EntryType.removeMember:
    case EntryType.leave: {
      const user = uuidAt(payload);
      const member = state.members.get(user);
      if (member === undefined) throw new Error("not a member");
      const signed = entry.type === EntryType.leave ? verifySignature(member.bundle.signPub, body, signature) : ownerSigned(state, body, signature);
      if (!signed) throw new Error("wrong signer");
      members.delete(user);
      break;
    }
    case EntryType.setRole: {
      if (payload.length !== 17) throw new Error("malformed set role");
      const user = uuidString(payload.subarray(0, 16));
      const role = payload[16] ?? 0;
      if (!validRole(role)) throw new Error("unknown role");
      const member = state.members.get(user);
      if (member === undefined) throw new Error("not a member");
      requireOwner();
      members.set(user, { ...member, role });
      break;
    }
    case EntryType.escrow: {
      const parsed = parseEscrowPayload(payload);
      if (parsed === undefined) throw new Error("malformed escrow");
      requireOwner();
      if (parsed.escrow !== undefined && state.lastEscrow !== undefined) {
        const refusal = escrowReachable(state.lastEscrow, parsed.escrow, rotations);
        if (refusal !== undefined) throw new Error(refusal);
      }
      escrow = parsed.escrow;
      if (parsed.escrow !== undefined) lastEscrow = parsed.escrow;
      break;
    }
    default:
      throw new Error("unknown entry type");
  }

  if (![...members.values()].some((member) => member.role === Role.owner)) throw new Error("no owner left");
  return { seq: entry.seq, hash: sha256(body), members, invitations, escrow, lastEscrow };
}

/** One recipient of an epoch: kind (0x01 user, 0x02 escrow, 0x03 invitation), encoded recipient id, SHA-256 of its public key. */
export interface EpochRecipient {
  kind: number;
  id: Uint8Array;
  keyHash: Uint8Array;
}

/** A signed epoch. */
export interface EpochRecord {
  vaultId: string;
  epoch: number;
  commitment: Uint8Array;
  prevCommitment: Uint8Array;
  logSeq: number;
  logHash: Uint8Array;
  recipients: EpochRecipient[];
  signature: Uint8Array;
}

/** The signed bytes of an epoch record, recipients in the record's order. */
export function epochRecordBody(record: Omit<EpochRecord, "signature">): Uint8Array {
  if (record.commitment.length !== 32 || record.prevCommitment.length !== 32 || record.logHash.length !== HASH_SIZE) {
    throw new Error("e2ee: epoch record hash of the wrong size");
  }
  if (record.recipients.length > MAX_EPOCH_RECIPIENTS) throw new Error("e2ee: too many epoch recipients");
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, record.recipients.length);
  return concat(
    encoder.encode(EPOCH_RECORD_LABEL),
    uuidBytes("vault id", record.vaultId),
    u64(record.epoch),
    record.commitment,
    record.prevCommitment,
    u64(record.logSeq),
    record.logHash,
    count,
    ...record.recipients.map((recipient) => {
      if (recipient.id.length === 0 || recipient.id.length > MAX_RECIPIENT_ID_SIZE || recipient.keyHash.length !== HASH_SIZE) {
        throw new Error("e2ee: malformed epoch recipient");
      }
      return concat(Uint8Array.of(recipient.kind), lengthPrefixed(recipient.id), recipient.keyHash);
    }),
  );
}

/** Returns the record signed with an owner's signing seed. */
export function signEpochRecord(record: Omit<EpochRecord, "signature">, ownerSignSeed: Uint8Array): EpochRecord {
  return { ...record, signature: sign(ownerSignSeed, epochRecordBody(record)) };
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * The sorted recipients an epoch at `state` must list: every member, every
 * pending invitation and the escrow key if escrow is on. `invitationKeys`
 * gives each pending invitation's hybrid public key by invitation id.
 */
export function epochRecipients(state: LogState, invitationKeys: ReadonlyMap<string, Uint8Array>): EpochRecipient[] {
  const recipients: EpochRecipient[] = [];
  for (const [userId, member] of state.members) {
    recipients.push({ kind: 0x01, id: uuidBytes("user id", userId), keyHash: sha256(member.bundle.kemPub) });
  }
  for (const id of state.invitations.keys()) {
    const key = invitationKeys.get(id);
    if (key === undefined) throw new Error(`e2ee: no public key for invitation ${id}`);
    recipients.push({ kind: 0x03, id: uuidBytes("invitation id", id), keyHash: sha256(key) });
  }
  if (state.escrow !== undefined) {
    recipients.push({ kind: 0x02, id: encoder.encode(escrowKeyId(state.escrow)), keyHash: sha256(encoder.encode(state.escrow.recipient)) });
  }
  return recipients.sort((left, right) => left.kind - right.kind || compareBytes(left.id, right.id));
}

/**
 * Checks a record against the replayed log states: the log position it names
 * exists with that hash, an owner at that position signed it, its recipients
 * are exactly {@link epochRecipients} there in sorted order, and epoch 1 has
 * an all-zero previous commitment. Throws {@link EpochRecordError}.
 */
export function verifyEpochRecord(vaultId: string, states: readonly LogState[], invitationKeys: ReadonlyMap<string, Uint8Array>, record: EpochRecord): void {
  if (record.vaultId !== vaultId || record.epoch === 0 || record.logSeq === 0 || record.logSeq > states.length) throw new EpochRecordError();
  const state = states[record.logSeq - 1];
  if (state === undefined || !equalBytes(state.hash, record.logHash)) throw new EpochRecordError();
  if (record.epoch === 1 && !equalBytes(record.prevCommitment, new Uint8Array(32))) throw new EpochRecordError();
  let expected: EpochRecipient[];
  try {
    if (!ownerSigned(state, epochRecordBody(record), record.signature)) throw new EpochRecordError();
    expected = epochRecipients(state, invitationKeys);
  } catch {
    throw new EpochRecordError();
  }
  const same =
    expected.length === record.recipients.length &&
    expected.every((recipient, index) => {
      const other = record.recipients[index];
      return other !== undefined && recipient.kind === other.kind && equalBytes(recipient.id, other.id) && equalBytes(recipient.keyHash, other.keyHash);
    });
  if (!same) throw new EpochRecordError();
}
