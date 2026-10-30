/**
 * Converting a plaintext vault to end-to-end encryption in place
 * (docs/design/encryption.md, "Converting a plaintext vault in place" and
 * "Converting a plaintext vault" under "Protection against an active
 * server"). The owner's device writes the vault's membership log (genesis,
 * then a members entry with the head change sequence number it read the
 * vault's documents at, listing every other member's bundle and role as the
 * server reports them), epoch 1 with its slots and signed record, and the
 * HMAC path key of every live document, and sends them in one ConvertVault.
 * History stays plaintext at epoch 0 until the re-key job encrypts it.
 *
 * That moment trusts the server's report of the members' keys, like any
 * first meeting. So the device first shows every member's fingerprint
 * ({@link conversionMembers}) and converts only with the fingerprints the
 * owner confirmed they compared: if the server reports any other key when
 * the device builds the log, it refuses ({@link FingerprintsChangedError}).
 */
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { equalBytes } from "@noble/ciphers/utils.js";

import type { MembershipService } from "../../gen/vaultsync/v1/membership_pb";
import type { SyncService } from "../../gen/vaultsync/v1/sync_pb";
import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import { ConversionRefusedSchema, type VaultKeyService } from "../../gen/vaultsync/v1/vault_key_pb";
import { deriveSubkey, pathKey } from "../e2ee/e2ee";
import { PUBLIC_KEY_SIZE } from "../e2ee/hybrid";
import { SIGN_PUBLIC_KEY_SIZE, bundleOf, fingerprint, formatFingerprint, type Bundle } from "../e2ee/identity";
import { EntryType, entryHash, genesisPayload, membersPayload, replayLog, type Entry } from "../e2ee/memberlog";
import { toIncoming } from "../sync/remote";
import { addAnchor, type AnchorListClient } from "./anchor-list";
import type { EscrowKey } from "./encrypted-vault";
import { logRole } from "./encrypted-membership";
import { genesisEntry, nextEntry, toLogEntry } from "./member-log";
import type { UserKeyPair } from "./user-key";
import { NO_PREVIOUS_COMMITMENT } from "./verified-epochs";
import type { VerifiedLogStore } from "./verified-log";
import { VaultKeyManager, buildEpoch, vaultKeyStatusMessage, type EpochKeyStore, type MemberKeyClient, type VaultKeyClient } from "./vault-keys";

/** The MembershipService call listing the members and the keys the server reports for them. */
export type ConversionMembersClient = Pick<Client<typeof MembershipService>, "listMembers" | "listInvitations">;
/** The SyncService call the device reads the vault's live documents with. */
export type ConversionSyncClient = Pick<Client<typeof SyncService>, "listChanges">;
/** The VaultKeyService calls of a conversion. */
export type ConversionKeyClient = VaultKeyClient & Pick<Client<typeof VaultKeyService>, "convertVault">;

/** A member of the vault to convert, with the fingerprint of the key the server reports for them. */
export interface ConversionMember {
  userId: string;
  displayName: string;
  role: VaultRole;
  /** The fingerprint of the member's bundle, or undefined when they have no user key (with a signing key) yet. */
  fingerprint: string | undefined;
}

/**
 * The vault cannot be converted yet: some members have no user key, or the
 * vault has pending invitations, which have no keys a slot could wrap to.
 */
export class ConversionRefusedError extends Error {
  override readonly name = "ConversionRefusedError";

  constructor(
    readonly membersWithoutKey: readonly string[],
    readonly pendingInvitations: readonly string[],
  ) {
    const reasons: string[] = [];
    if (membersWithoutKey.length > 0) reasons.push(`members without encryption set up: ${membersWithoutKey.join(", ")}`);
    if (pendingInvitations.length > 0) reasons.push(`pending invitations, which must be revoked first: ${pendingInvitations.join(", ")}`);
    super(`The vault cannot be converted yet (${reasons.join("; ")}).`);
  }
}

/** The server now reports other members or keys than the ones the owner compared. */
export class FingerprintsChangedError extends Error {
  override readonly name = "FingerprintsChangedError";

  constructor() {
    super("The vault's members or their keys changed since you compared the fingerprints. Compare them again before converting.");
  }
}

/** Upper bound on pages read from the vault's changes, against a server that never ends the list. */
const MAX_PAGES = 100_000;
/** ConvertVault attempts while documents keep changing meanwhile (ABORTED). */
const MAX_CONVERT_ATTEMPTS = 3;

/** A member's bundle as the server reports it, or undefined when it reports no complete key. */
function reportedBundle(member: { userId: string; publicKey: Uint8Array; signPublicKey: Uint8Array }): Bundle | undefined {
  if (member.publicKey.length !== PUBLIC_KEY_SIZE || member.signPublicKey.length !== SIGN_PUBLIC_KEY_SIZE) return undefined;
  return { userId: member.userId, kemPub: member.publicKey, signPub: member.signPublicKey };
}

interface ReportedMember extends ConversionMember {
  bundle: Bundle | undefined;
}

async function reportedMembers(client: ConversionMembersClient, vaultId: string): Promise<ReportedMember[]> {
  const response = await client.listMembers({ vaultId });
  return response.members.map((member) => {
    const bundle = reportedBundle(member);
    return {
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      bundle,
      fingerprint: bundle === undefined ? undefined : formatFingerprint(fingerprint(bundle)),
    };
  });
}

/**
 * Every member of the vault with the fingerprint of the key the server
 * reports for them: what the owner compares, out of band, before converting.
 */
export async function conversionMembers(client: ConversionMembersClient, vaultId: string): Promise<ConversionMember[]> {
  return (await reportedMembers(client, vaultId)).map(({ userId, displayName, role, fingerprint }) => ({ userId, displayName, role, fingerprint }));
}

/** Whether `reported` names exactly the members and fingerprints of `compared`. */
function sameFingerprints(compared: readonly ConversionMember[], reported: readonly ReportedMember[]): boolean {
  if (compared.length !== reported.length) return false;
  const expected = new Map(compared.map((member) => [member.userId, member.fingerprint]));
  return reported.every((member) => member.fingerprint !== undefined && expected.has(member.userId) && expected.get(member.userId) === member.fingerprint);
}

/** The current path of every live document of the plaintext vault, by document id, and the vault's head seq they were read at. */
async function liveDocuments(client: ConversionSyncClient, vaultId: string): Promise<{ live: Map<string, string>; headSeq: bigint }> {
  const heads = new Map<string, { deleted: boolean; path: string }>();
  let sinceSeq = 0n;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.listChanges({ vaultId, sinceSeq });
    for (const revision of response.revisions) {
      heads.set(revision.documentId, { deleted: revision.deleted, path: toIncoming(revision).remote.path });
      if (revision.seq > sinceSeq) sinceSeq = revision.seq;
    }
    if (!response.hasMore) {
      const live = new Map<string, string>();
      for (const [documentId, head] of heads) if (!head.deleted) live.set(documentId, head.path);
      return { live, headSeq: response.headSeq };
    }
  }
  throw new Error("the server's list of changes does not end");
}

export interface ConvertVaultOptions {
  vaultId: string;
  /** The signed-in owner's unlocked key pair: it signs the log and epoch 1's record. */
  userKey: UserKeyPair;
  /** The members and fingerprints the owner confirmed they compared ({@link conversionMembers}). */
  compared: readonly ConversionMember[];
  /** The escrow key, for a converted vault with escrow; undefined without escrow. */
  escrow: EscrowKey | undefined;
  membership: ConversionMembersClient & MemberKeyClient;
  sync: ConversionSyncClient;
  keys: ConversionKeyClient;
  anchors: AnchorListClient;
  verifiedLogs: VerifiedLogStore;
  /** Where this device keeps the vault's epoch keys. */
  store: EpochKeyStore;
}

/**
 * Converts the plaintext vault to end-to-end encryption, after the owner
 * compared the members' fingerprints in `compared`. Refuses with {@link
 * ConversionRefusedError} while a member has no key or an invitation is
 * pending, and with {@link FingerprintsChangedError} when the server reports
 * other members or keys than the compared ones. Adds the vault's genesis
 * hash to the user's anchor list first, so that the converted vault is never
 * without its anchor. Resolves with the conversion's seq once this device
 * holds epoch 1's key.
 */
export async function convertVault(options: ConvertVaultOptions): Promise<bigint> {
  const { vaultId, userKey } = options;
  for (let attempt = 1; ; attempt++) {
    const members = await reportedMembers(options.membership, vaultId);
    const withoutKey = members.filter((member) => member.bundle === undefined).map((member) => member.userId);
    const pending = (await options.membership.listInvitations({ vaultId })).invitations.map((invitation) => invitation.id);
    if (withoutKey.length > 0 || pending.length > 0) throw new ConversionRefusedError(withoutKey.sort(), pending.sort());
    if (!sameFingerprints(options.compared, members)) throw new FingerprintsChangedError();
    const creator = bundleOf({ kemSeed: userKey.privateKey, signSeed: userKey.signSeed }, userKey.userId);
    const self = members.find((member) => member.userId === userKey.userId);
    if (self?.role !== VaultRole.OWNER) throw new Error("only an owner can convert the vault");
    if (self.bundle === undefined || !equalBytes(self.bundle.kemPub, creator.kemPub) || !equalBytes(self.bundle.signPub, creator.signPub)) {
      throw new Error("the server reports another key for you than this device's");
    }

    // The documents are read first: the members entry signs the head seq
    // they were read at, the bound of the vault's plaintext history, and the
    // server converts only while its head seq is still that one.
    const documents = await liveDocuments(options.sync, vaultId);
    const genesis = genesisEntry(vaultId, genesisPayload(creator, options.escrow?.bundle), userKey.signSeed);
    const log: Entry[] = [genesis];
    const others = members.filter((member) => member.userId !== userKey.userId);
    const payload = membersPayload(
      documents.headSeq,
      others.map((member) => ({ bundle: member.bundle as Bundle, role: logRole(member.role) })),
    );
    log.push(nextEntry(vaultId, log, { type: EntryType.members, payload, signSeeds: [userKey.signSeed] }));
    const at = replayLog(vaultId, log).at(-1);
    if (at === undefined) throw new Error("the membership log is empty");
    const built = await buildEpoch({ vaultId, signSeed: userKey.signSeed, at, expected: 0, prevCommitment: NO_PREVIOUS_COMMITMENT, escrow: options.escrow });
    const secret = deriveSubkey(built.epochKey, "path_key_secret");
    const pathKeys = [...documents.live].map(([documentId, path]) => ({ documentId, pathKey: pathKey(secret, path) }));

    await addAnchor(options.anchors, userKey, options.verifiedLogs, { vaultId, genesisHash: entryHash(genesis) });
    let conversionSeq: bigint;
    try {
      const response = await options.keys.convertVault({
        vaultId,
        genesis: toLogEntry(genesis),
        membersEntry: toLogEntry(log[1] as Entry),
        nextEpoch: built.nextEpoch,
        record: built.record,
        escrow: options.escrow !== undefined,
        pathKeys,
      });
      conversionSeq = response.conversionSeq;
    } catch (error) {
      const refused = error instanceof ConnectError ? error.findDetails(ConversionRefusedSchema)[0] : undefined;
      if (refused !== undefined) throw new ConversionRefusedError(refused.membersWithoutKey, refused.pendingInvitations);
      // Members, keys or documents changed meanwhile: read them again.
      if (error instanceof ConnectError && error.code === Code.Aborted && attempt < MAX_CONVERT_ATTEMPTS) continue;
      throw error;
    }
    await options.verifiedLogs.saveCheckpoint(vaultId, { seq: at.seq, hash: at.hash });
    const keys = new Map(await options.store.load());
    keys.set(built.epoch, built.epochKey);
    await options.store.save(keys);
    const manager = new VaultKeyManager({
      vaultId,
      userKey,
      owner: true,
      keys: options.keys,
      membership: options.membership,
      store: options.store,
      trust: { userKey, log: options.keys, anchors: options.anchors, verifiedLogs: options.verifiedLogs },
      escrow: options.escrow,
    });
    const problem = vaultKeyStatusMessage(await manager.sync());
    if (problem !== undefined) throw new Error(`the vault was converted, but its key is not ready: ${problem}`);
    return conversionSeq;
  }
}
