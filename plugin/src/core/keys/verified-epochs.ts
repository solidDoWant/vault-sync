/**
 * Verifying an end-to-end encrypted vault's epochs against its verified
 * membership log (docs/design/encryption.md, "Signed epochs"): a device uses
 * an epoch key only from an epoch whose record an owner signed in the log it
 * verified, and refuses an epoch below the highest it has verified. Every
 * refusal is a {@link LogVerificationError}.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";

import type { EpochRecord as EpochRecordMessage, EpochRecordSchema } from "../../gen/vaultsync/v1/vault_key_pb";
import { EpochRecordError, verifyEpochRecord, type EpochRecord, type LogState } from "../e2ee/memberlog";
import { LogVerificationError, type VerifiedLogStore } from "./verified-log";

/** An epoch as the server lists it. */
export interface ListedEpoch {
  epoch: number;
  commitment: Uint8Array;
  record?: EpochRecordMessage;
}

/** The previous commitment epoch 1's record signs. */
export const NO_PREVIOUS_COMMITMENT = new Uint8Array(32);

/** The wire form of a signed record. */
export function epochRecordMessage(record: EpochRecord): MessageInitShape<typeof EpochRecordSchema> {
  return {
    logSeq: BigInt(record.logSeq),
    logHash: record.logHash,
    recipients: record.recipients.map((recipient) => ({ kind: recipient.kind, recipientId: recipient.id, keyHash: recipient.keyHash })),
    signature: record.signature,
  };
}

/**
 * Checks that `epochs` are exactly 1 to `currentEpoch`, each with a record
 * signed by an owner at its position in `states` over its commitment and the
 * previous epoch's, and that `currentEpoch` is not below the highest epoch
 * this device has verified for the vault; then records `currentEpoch` as
 * verified.
 */
export async function verifyEpochs(store: VerifiedLogStore, vaultId: string, states: readonly LogState[], epochs: readonly ListedEpoch[], currentEpoch: number): Promise<void> {
  const highest = await store.highestEpoch(vaultId);
  if (currentEpoch < highest) throw new LogVerificationError(vaultId, "the vault's epoch is lower than this device has verified");
  const sorted = [...epochs].sort((left, right) => left.epoch - right.epoch);
  if (sorted.length !== currentEpoch || sorted.some((listed, index) => listed.epoch !== index + 1)) {
    throw new LogVerificationError(vaultId, "the vault's epochs are not numbered 1 to its current epoch");
  }
  let prevCommitment: Uint8Array = NO_PREVIOUS_COMMITMENT;
  for (const listed of sorted) {
    const { record } = listed;
    if (record === undefined) throw new LogVerificationError(vaultId, `epoch ${String(listed.epoch)} has no owner-signed record`);
    try {
      if (record.logSeq > BigInt(Number.MAX_SAFE_INTEGER)) throw new EpochRecordError();
      verifyEpochRecord(vaultId, states, {
        vaultId,
        epoch: listed.epoch,
        commitment: listed.commitment,
        prevCommitment,
        logSeq: Number(record.logSeq),
        logHash: record.logHash,
        recipients: record.recipients.map((recipient) => ({ kind: recipient.kind, id: recipient.recipientId, keyHash: recipient.keyHash })),
        signature: record.signature,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new LogVerificationError(vaultId, `epoch ${String(listed.epoch)} is not signed by an owner in the verified membership log, or its recipients are not the log's`, { cause: error });
    }
    prevCommitment = listed.commitment;
  }
  if (currentEpoch > highest) await store.saveHighestEpoch(vaultId, currentEpoch);
}
