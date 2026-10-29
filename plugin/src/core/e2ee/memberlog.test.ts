import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/crypto/vectors.json";
import { DecryptError } from "./e2ee";
import {
  anchorKey,
  bundleOf,
  encodeBundle,
  encodeEscrowBundle,
  type EscrowRotation,
  fingerprint,
  formatFingerprint,
  inviteSignSeed,
  openAnchorList,
  openInviteAnchor,
  parseBundle,
  parseEscrowBundle,
  parseUserSecret,
  sealAnchorListWithNonce,
  SignatureError,
  signPublicKey,
  verifyEscrowChain,
} from "./identity";
import { type Entry, entryHash, epochRecordBody, type EpochRecord, EpochRecordError, LogError, type LogState, replayLog, signEntry, signEpochRecord, verifyEpochRecord } from "./memberlog";

const vectors = shared.identity_keys;

interface EntryVector {
  seq: number;
  prev_hash: string;
  type: number;
  payload: string;
  signatures: string[];
}

interface RotationVector {
  old_bundle_hash: string;
  new_bundle: string;
  signature: string;
}

interface RecordVector {
  epoch: number;
  commitment: string;
  prev_commitment: string;
  log_seq: number;
  log_hash: string;
  recipients: { kind: number; id: string; key_hash: string }[];
  signature: string;
}

const entriesOf = (vaultId: string, entries: readonly EntryVector[]): Entry[] =>
  entries.map((entry) => ({
    vaultId,
    seq: entry.seq,
    prevHash: hexToBytes(entry.prev_hash),
    type: entry.type,
    payload: hexToBytes(entry.payload),
    signatures: entry.signatures.map((signature) => hexToBytes(signature)),
  }));

const rotationsOf = (rotations: readonly RotationVector[]): EscrowRotation[] =>
  rotations.map((rotation) => ({
    oldBundleHash: hexToBytes(rotation.old_bundle_hash),
    newBundle: parseEscrowBundle(hexToBytes(rotation.new_bundle)),
    signature: hexToBytes(rotation.signature),
  }));

const recordOf = (vaultId: string, vector: RecordVector): EpochRecord => ({
  vaultId,
  epoch: vector.epoch,
  commitment: hexToBytes(vector.commitment),
  prevCommitment: hexToBytes(vector.prev_commitment),
  logSeq: vector.log_seq,
  logHash: hexToBytes(vector.log_hash),
  recipients: vector.recipients.map((recipient) => ({ kind: recipient.kind, id: hexToBytes(recipient.id), keyHash: hexToBytes(recipient.key_hash) })),
  signature: hexToBytes(vector.signature),
});

function stateJson(state: LogState): unknown {
  const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] => [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    seq: state.seq,
    hash: bytesToHex(state.hash),
    members: sorted(state.members).map(([userId, member]) => ({ user_id: userId, role: member.role, fingerprint: bytesToHex(fingerprint(member.bundle)) })),
    invitations: sorted(state.invitations).map(([id, invitation]) => ({ id, role: invitation.role, sign_pub: bytesToHex(invitation.signPub) })),
    escrow: state.escrow === undefined ? "" : bytesToHex(encodeEscrowBundle(state.escrow)),
  };
}

describe("identity keys match the shared vectors", () => {
  it("derives bundles, fingerprints and anchor keys from the user secret", () => {
    for (const vector of vectors.identity) {
      const secret = parseUserSecret(hexToBytes(vector.user_secret));
      const bundle = bundleOf(secret, vector.user_id);
      expect(bytesToHex(bundle.signPub)).toBe(vector.sign_pub);
      expect(bytesToHex(bundle.kemPub)).toBe(vector.kem_pub);
      expect(bytesToHex(encodeBundle(bundle))).toBe(vector.bundle);
      expect(bytesToHex(fingerprint(bundle))).toBe(vector.fingerprint);
      expect(formatFingerprint(fingerprint(bundle))).toBe(vector.fingerprint_display);
      expect(bytesToHex(anchorKey(secret.kemSeed))).toBe(vector.anchor_key);
      expect(parseBundle(hexToBytes(vector.bundle))).toEqual(bundle);
    }
  });

  it("derives invitation signing keys from the invitation secret", () => {
    for (const vector of vectors.invite_sign) {
      const seed = inviteSignSeed(hexToBytes(vector.secret), vector.vault_id, vector.invitation_id);
      expect(bytesToHex(seed)).toBe(vector.seed);
      expect(bytesToHex(signPublicKey(seed))).toBe(vector.sign_pub);
    }
  });

  it("opens invite anchors, only as their vault's", async () => {
    for (const vector of vectors.invite_anchor) {
      const anchor = await openInviteAnchor(hexToBytes(vector.invitation_private_key), hexToBytes(vector.sealed), vector.vault_id);
      expect(bytesToHex(anchor.genesisHash)).toBe(vector.genesis_hash);
      expect(bytesToHex(anchor.inviterFingerprint)).toBe(vector.inviter_fingerprint);
      await expect(openInviteAnchor(hexToBytes(vector.invitation_private_key), hexToBytes(vector.sealed), "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0f")).rejects.toThrow(DecryptError);
    }
  });

  it("seals and opens anchor lists, and refuses the rejected ones", () => {
    for (const vector of vectors.anchor_list) {
      const anchors = vector.anchors.map((anchor) => ({ vaultId: anchor.vault_id, genesisHash: hexToBytes(anchor.genesis_hash) }));
      expect(bytesToHex(sealAnchorListWithNonce(hexToBytes(vector.anchor_key), hexToBytes(vector.nonce), vector.user_id, vector.version, anchors))).toBe(vector.sealed);
      expect(openAnchorList(hexToBytes(vector.anchor_key), hexToBytes(vector.sealed), vector.user_id, vector.version)).toEqual(anchors);
    }
    for (const vector of vectors.rejected_anchor_lists) {
      expect(() => openAnchorList(hexToBytes(vector.anchor_key), hexToBytes(vector.sealed), vector.user_id, vector.version), vector.name).toThrow(DecryptError);
    }
  });

  it("encodes escrow bundles and follows only signed, chained rotations", () => {
    for (const vector of vectors.escrow_bundles) {
      expect(bytesToHex(encodeEscrowBundle({ signPub: signPublicKey(hexToBytes(vector.sign_seed)), recipient: vector.recipient }))).toBe(vector.encoded);
    }
    for (const vector of vectors.escrow_chains) {
      const end = verifyEscrowChain(parseEscrowBundle(hexToBytes(vector.pinned)), rotationsOf(vector.rotations));
      expect(bytesToHex(encodeEscrowBundle(end))).toBe(vector.result);
    }
    for (const vector of vectors.rejected_escrow_chains) {
      expect(() => verifyEscrowChain(parseEscrowBundle(hexToBytes(vector.pinned)), rotationsOf(vector.rotations)), vector.name).toThrow(SignatureError);
    }
  });
});

describe("the membership log matches the shared vectors", () => {
  const log = vectors.membership_log;
  const entries = entriesOf(log.vault_id, log.entries);
  const invitationKeys = new Map(Object.entries(log.invitation_keys).map(([id, key]) => [id, hexToBytes(key)]));

  it("signs and hashes every entry to exactly the vector bytes", () => {
    entries.forEach((entry, index) => {
      const vector = log.entries[index];
      expect(vector).toBeDefined();
      if (vector === undefined) return;
      const signed = signEntry(entry, ...vector.signer_seeds.map((seed) => hexToBytes(seed)));
      expect(signed.signatures.map((signature) => bytesToHex(signature))).toEqual(vector.signatures);
      expect(bytesToHex(entryHash(entry))).toBe(vector.hash);
    });
  });

  it("replays to the same member set, roles, invitations and escrow at every seq", () => {
    const first = log.entries[0];
    const states = replayLog(log.vault_id, entries, {
      escrowRotations: rotationsOf(log.escrow_rotations),
      ...(first === undefined ? {} : { genesisHash: hexToBytes(first.hash) }),
    });
    expect(states.map(stateJson)).toEqual(log.states);
  });

  it("verifies the signed epoch records and refuses the rejected ones", () => {
    const states = replayLog(log.vault_id, entries, { escrowRotations: rotationsOf(log.escrow_rotations) });
    for (const vector of log.epoch_records) {
      const record = recordOf(log.vault_id, vector);
      expect(bytesToHex(epochRecordBody(record)), vector.name).toBe(vector.body);
      expect(bytesToHex(signEpochRecord(record, hexToBytes(vector.signer_seed)).signature), vector.name).toBe(vector.signature);
      expect(() => { verifyEpochRecord(log.vault_id, states, invitationKeys, record); }, vector.name).not.toThrow();
    }
    for (const vector of vectors.rejected_epoch_records) {
      expect(() => { verifyEpochRecord(log.vault_id, states, invitationKeys, recordOf(log.vault_id, vector)); }, vector.name).toThrow(EpochRecordError);
    }
  });

  it("refuses every rejected log", () => {
    for (const vector of vectors.rejected_logs) {
      const options = {
        escrowRotations: rotationsOf(vector.escrow_rotations),
        ...("genesis_hash" in vector && typeof vector.genesis_hash === "string" ? { genesisHash: hexToBytes(vector.genesis_hash) } : {}),
      };
      expect(() => replayLog(vector.vault_id, entriesOf(vector.vault_id, vector.entries), options), vector.name).toThrow(LogError);
    }
  });
});
