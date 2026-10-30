import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/crypto/vectors.json";
import { DecryptError } from "./e2ee";
import { ageIdentity, ageRecipient } from "./hybrid";
import {
  anchorKey,
  bundleOf,
  encodeBundle,
  encodeEscrowBundle,
  type EscrowRotation,
  fingerprint,
  formatFingerprint,
  invitationKeyPair,
  inviteMacKey,
  inviteSignSeed,
  makeInviteAnchor,
  verifyInviteAnchor,
  openAnchorList,
  parseBundle,
  parseEscrowBundle,
  parseUserSecret,
  sealAnchorListWithNonce,
  SignatureError,
  signPublicKey,
  verifyEscrowChain,
} from "./identity";
import { type Entry, entryHash, epochRecordBody, type EpochRecord, EpochRecordError, LogError, type LogState, replayLog, Role, signEntry, signEpochRecord, verifyEpochRecord } from "./memberlog";

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
    invitations: sorted(state.invitations).map(([id, invitation]) => ({
      id,
      role: invitation.role,
      sign_pub: bytesToHex(invitation.signPub),
      kem_pub_hash: bytesToHex(sha256(invitation.kemPub)),
    })),
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

  it("derives invitation key pairs from the invitation secret", () => {
    expect(vectors.invitation_key).toHaveLength(3);
    for (const vector of vectors.invitation_key) {
      const secret = hexToBytes(vector.secret);
      // The seed follows docs/design/crypto.md, derived here with HKDF
      // directly, not by the code under test.
      const info = new Uint8Array([...new TextEncoder().encode("vault-sync/v1/invitation-key"), ...hexToBytes(vector.invitation_id.replaceAll("-", ""))]);
      expect(bytesToHex(hkdf(sha256, secret, hexToBytes(vector.vault_id.replaceAll("-", "")), info, 32))).toBe(vector.private_key);
      const pair = invitationKeyPair(secret, vector.vault_id, vector.invitation_id);
      expect(bytesToHex(pair.privateKey)).toBe(vector.private_key);
      expect(bytesToHex(pair.publicKey)).toBe(vector.public_key);
      expect(ageIdentity(pair.privateKey)).toBe(vector.age_identity);
      expect(ageRecipient(pair.publicKey)).toBe(vector.age_recipient);
    }
  });

  it("makes and verifies invite anchors, and refuses the rejected ones", () => {
    for (const vector of vectors.invite_anchor) {
      const secret = hexToBytes(vector.secret);
      expect(bytesToHex(inviteMacKey(secret, vector.vault_id, vector.invitation_id))).toBe(vector.mac_key);
      const made = makeInviteAnchor(secret, vector.vault_id, vector.invitation_id, {
        genesisHash: hexToBytes(vector.genesis_hash),
        inviterFingerprint: hexToBytes(vector.inviter_fingerprint),
      });
      expect(bytesToHex(made)).toBe(vector.anchor);
      const anchor = verifyInviteAnchor(secret, vector.vault_id, vector.invitation_id, hexToBytes(vector.anchor));
      expect(bytesToHex(anchor.genesisHash)).toBe(vector.genesis_hash);
      expect(bytesToHex(anchor.inviterFingerprint)).toBe(vector.inviter_fingerprint);
    }
    for (const vector of vectors.rejected_invite_anchors) {
      expect(() => verifyInviteAnchor(hexToBytes(vector.secret), vector.vault_id, vector.invitation_id, hexToBytes(vector.anchor)), vector.name).toThrow(SignatureError);
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

describe("the log of a converted vault matches the shared vectors", () => {
  const log = vectors.converted_log;
  const entries = entriesOf(log.vault_id, log.entries);

  it("replays genesis and the members entry to the same members and roles", () => {
    const first = log.entries[0];
    const states = replayLog(log.vault_id, entries, first === undefined ? {} : { genesisHash: hexToBytes(first.hash) });
    expect(states.map(stateJson)).toEqual(log.states);
    expect(Object.fromEntries([...(states[1]?.members ?? new Map<string, { role: number }>())].map(([userId, member]) => [userId, member.role]))).toEqual({
      [vectors.identity[0]?.user_id ?? ""]: Role.owner,
      [vectors.identity[1]?.user_id ?? ""]: Role.editor,
      [vectors.identity[2]?.user_id ?? ""]: Role.viewer,
    });
  });

  it("signs every entry and verifies the epoch record at the members entry", () => {
    entries.forEach((entry, index) => {
      const vector = log.entries[index];
      expect(vector).toBeDefined();
      if (vector === undefined) return;
      expect(signEntry(entry, ...vector.signer_seeds.map((seed) => hexToBytes(seed))).signatures.map((signature) => bytesToHex(signature))).toEqual(vector.signatures);
      expect(bytesToHex(entryHash(entry))).toBe(vector.hash);
    });
    const states = replayLog(log.vault_id, entries);
    expect(log.epoch_records.map((vector) => vector.log_seq)).toEqual([2]);
    for (const vector of log.epoch_records) {
      const record = recordOf(log.vault_id, vector);
      expect(bytesToHex(epochRecordBody(record)), vector.name).toBe(vector.body);
      expect(bytesToHex(signEpochRecord(record, hexToBytes(vector.signer_seed)).signature), vector.name).toBe(vector.signature);
      expect(() => { verifyEpochRecord(log.vault_id, states, record); }, vector.name).not.toThrow();
    }
  });
});

describe("the membership log matches the shared vectors", () => {
  const log = vectors.membership_log;
  const entries = entriesOf(log.vault_id, log.entries);

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
      expect(() => { verifyEpochRecord(log.vault_id, states, record); }, vector.name).not.toThrow();
    }
    for (const vector of vectors.rejected_epoch_records) {
      expect(() => { verifyEpochRecord(log.vault_id, states, recordOf(log.vault_id, vector)); }, vector.name).toThrow(EpochRecordError);
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
