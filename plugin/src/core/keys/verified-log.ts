/**
 * Verifying an end-to-end encrypted vault's membership log from its trust
 * anchor (docs/design/encryption.md, "Verifying the log" and "Trust
 * anchors"). The device replays the log from genesis, anchored by the
 * genesis hash it trusts: a member's from the user's sealed anchor list, a
 * newcomer's from its invite link. It keeps, per vault, the highest
 * sequence number and hash it has verified, and refuses a shorter log or a
 * different hash at a position it has already verified. It also keeps the
 * highest anchor list version it has seen and refuses a lower one.
 *
 * Every refusal is a {@link LogVerificationError}: the server sent key or
 * membership data that doesn't verify. The device never falls back to
 * trusting the server.
 */
import { equalBytes } from "@noble/ciphers/utils.js";

import type { EscrowRotation } from "../e2ee/identity";
import { LogError, replayLog, type Entry, type LogState } from "../e2ee/memberlog";
import { readAnchorList, type AnchorListClient } from "./anchor-list";
import { readLog, type LogReadClient } from "./member-log";
import type { UserKeyPair } from "./user-key";

/** The highest log position a device has verified for a vault. */
export interface LogCheckpoint {
  seq: number;
  hash: Uint8Array;
}

/** What a device keeps of the logs and the anchor list it verified: device-local only, never synced. */
export interface VerifiedLogStore {
  /** The highest position verified for the vault, if any. */
  checkpoint(vaultId: string): Promise<LogCheckpoint | undefined>;
  saveCheckpoint(vaultId: string, checkpoint: LogCheckpoint): Promise<void>;
  /** The highest epoch verified for the vault (0 for none). */
  highestEpoch(vaultId: string): Promise<number>;
  saveHighestEpoch(vaultId: string, epoch: number): Promise<void>;
  /** The highest version of the user's anchor list seen (0 for none). */
  anchorListVersion(): Promise<number>;
  saveAnchorListVersion(version: number): Promise<void>;
}

/** A {@link VerifiedLogStore} in memory, for tests. */
export class MemoryVerifiedLogStore implements VerifiedLogStore {
  readonly checkpoints = new Map<string, LogCheckpoint>();
  readonly epochs = new Map<string, number>();
  anchorVersion = 0;

  highestEpoch(vaultId: string): Promise<number> {
    return Promise.resolve(this.epochs.get(vaultId) ?? 0);
  }

  saveHighestEpoch(vaultId: string, epoch: number): Promise<void> {
    this.epochs.set(vaultId, epoch);
    return Promise.resolve();
  }

  checkpoint(vaultId: string): Promise<LogCheckpoint | undefined> {
    return Promise.resolve(this.checkpoints.get(vaultId));
  }

  saveCheckpoint(vaultId: string, checkpoint: LogCheckpoint): Promise<void> {
    this.checkpoints.set(vaultId, checkpoint);
    return Promise.resolve();
  }

  anchorListVersion(): Promise<number> {
    return Promise.resolve(this.anchorVersion);
  }

  saveAnchorListVersion(version: number): Promise<void> {
    this.anchorVersion = version;
    return Promise.resolve();
  }
}

/** The server sent key or membership data that doesn't verify. */
export class LogVerificationError extends Error {
  override readonly name = "LogVerificationError";
  constructor(
    /** The vault whose data was refused; undefined for the user's anchor list. */
    readonly vaultId: string | undefined,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`The server sent key or membership data that doesn't verify: ${detail}.`, options);
  }
}

/** A vault's log verified from its anchor: its entries and the state after each. */
export interface VerifiedLog {
  entries: Entry[];
  states: LogState[];
}

/** Records `entries`' last position as verified, after a check that it extends `checkpoint`. */
async function advance(store: VerifiedLogStore, vaultId: string, states: readonly LogState[]): Promise<void> {
  const checkpoint = await store.checkpoint(vaultId);
  if (checkpoint !== undefined) {
    if (states.length < checkpoint.seq) throw new LogVerificationError(vaultId, "the membership log is shorter than this device has verified");
    const verified = states[checkpoint.seq - 1];
    if (verified === undefined || !equalBytes(verified.hash, checkpoint.hash)) {
      throw new LogVerificationError(vaultId, "the membership log forks from the one this device has verified");
    }
  }
  const head = states.at(-1);
  if (head !== undefined && (checkpoint === undefined || head.seq > checkpoint.seq)) {
    await store.saveCheckpoint(vaultId, { seq: head.seq, hash: head.hash });
  }
}

/**
 * Checks `entries` from genesis against `genesisHash` and the device's
 * checkpoint, and records their head as verified.
 */
export async function verifyLog(
  store: VerifiedLogStore,
  vaultId: string,
  entries: Entry[],
  genesisHash: Uint8Array,
  escrowRotations?: readonly EscrowRotation[],
): Promise<VerifiedLog> {
  let states: LogState[];
  try {
    states = replayLog(vaultId, entries, { genesisHash, escrowRotations });
  } catch (error) {
    if (error instanceof LogError) throw new LogVerificationError(vaultId, error.message, { cause: error });
    throw error;
  }
  await advance(store, vaultId, states);
  return { entries, states };
}

/**
 * Reads the vault's log (a newcomer with the `<id>` of its invite code) and
 * verifies it from `genesisHash` ({@link verifyLog}).
 */
export async function readVerifiedLog(
  client: LogReadClient,
  store: VerifiedLogStore,
  vaultId: string,
  genesisHash: Uint8Array,
  invitationId = "",
): Promise<VerifiedLog> {
  return verifyLog(store, vaultId, await readLog(client, vaultId, invitationId), genesisHash);
}

/**
 * The genesis hash the user's anchor list names for `vaultId`. A list of a
 * lower version than this device has seen is refused, as is a list without
 * the vault: every vault of the user's is anchored before it exists.
 */
export async function memberAnchor(client: AnchorListClient, userKey: UserKeyPair, store: VerifiedLogStore, vaultId: string): Promise<Uint8Array> {
  const { anchors } = await readAnchorList(client, userKey, store);
  const anchor = anchors.find((stored) => stored.vaultId === vaultId);
  if (anchor === undefined) throw new LogVerificationError(vaultId, "the user's anchor list does not name this vault");
  return anchor.genesisHash;
}

/** What a member's device verifies a vault's log with. */
export interface LogTrust {
  userKey: UserKeyPair;
  log: LogReadClient;
  anchors: AnchorListClient;
  verifiedLogs: VerifiedLogStore;
}

/** A member's read of the vault's log, verified from the user's anchor list. */
export async function readMemberLog(trust: LogTrust, vaultId: string): Promise<VerifiedLog> {
  const genesisHash = await memberAnchor(trust.anchors, trust.userKey, trust.verifiedLogs, vaultId);
  return readVerifiedLog(trust.log, trust.verifiedLogs, vaultId, genesisHash);
}
