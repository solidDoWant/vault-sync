/**
 * Membership changes of an end-to-end encrypted vault (docs/design/
 * encryption.md, "Invitations" and "Protection against an active server"):
 * each request carries the signed log entry that records it, placed on top
 * of the log head the device read ({@link appendLogEntry}).
 *
 * An invitation's code `<id>.<secret>` is generated here, not by the server,
 * which sees only SHA-256 of `<id>`'s bytes. The invitation's key pair and
 * signing key come from `<secret>`. The inviting device wraps every epoch
 * key to the invitation's key, and the link it hands out is
 * `<id>.<secret>.<invite_anchor>`, each part base64url without padding: the
 * anchor (the genesis hash and the inviter's fingerprint, MACed under a key
 * from `<secret>`) is what the newcomer trusts the vault's log from.
 *
 * The code and the secret never appear in an error.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { randomBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";

import type {
  Invitation,
  MembershipService,
} from "../../gen/vaultsync/v1/membership_pb";
import { VaultRole } from "../../gen/vaultsync/v1/types_pb";
import {
  KeyRecipientKind,
  type KeySlotSchema,
} from "../../gen/vaultsync/v1/vault_key_pb";
import {
  bundleOf,
  fingerprint,
  invitationKeyPair,
  inviteSignSeed,
  makeInviteAnchor,
  signPublicKey,
} from "../e2ee/identity";
import { sealKeySlot } from "../e2ee/keyslot";
import {
  EntryType,
  entryHash,
  idPayload,
  invitePayload,
  setRolePayload,
} from "../e2ee/memberlog";
import { appendLogEntry, type LogReadClient } from "./member-log";
import type { UserKeyPair } from "./user-key";

/** The MembershipService calls that change an encrypted vault's membership (ProtocolClient.membership). */
export type EncryptedMembershipClient = Pick<
  Client<typeof MembershipService>,
  "createInvitation" | "revokeInvitation" | "updateMemberRole" | "leaveVault"
>;

/** What a membership change of an encrypted vault needs: the vault, the user's key that signs, and the calls. */
export interface EncryptedMembershipContext {
  vaultId: string;
  userKey: UserKeyPair;
  membership: EncryptedMembershipClient;
  log: LogReadClient;
}

/** The bytes of an invitation code's `<id>` and of its `<secret>`. */
const CODE_PART_SIZE = 16;

type SlotInit = MessageInitShape<typeof KeySlotSchema>;

/** A role as the membership log encodes it (0x01 owner, 0x02 editor, 0x03 viewer). */
export function logRole(role: VaultRole): number {
  switch (role) {
    case VaultRole.OWNER:
      return 0x01;
    case VaultRole.EDITOR:
      return 0x02;
    case VaultRole.VIEWER:
      return 0x03;
    default:
      throw new Error("an invitation or member needs a role");
  }
}

/** The signing seeds of the signed-in user: every entry but a redeem is signed by its author alone. */
function signedByUser(context: EncryptedMembershipContext): Uint8Array[] {
  return [context.userKey.signSeed];
}

/** A new invitation to an encrypted vault: the link to hand out, shown once, and the server's invitation. */
export interface EncryptedInvitation {
  link: string;
  invitation: Invitation;
}

/**
 * Invites to the vault with `role`: generates the code, wraps every epoch
 * key (1 to `currentEpoch`, from `epochKey`) to the invitation's key, and
 * sends CreateInvitation with the invite entry, SHA-256 of `<id>`, the slots
 * and the invite anchor. Resolves with the link `<id>.<secret>.<anchor>`.
 */
export async function createEncryptedInvitation(
  context: EncryptedMembershipContext & {
    currentEpoch: number;
    epochKey: (epoch: number) => Uint8Array | undefined;
  },
  role: VaultRole,
  ttlSeconds: number,
): Promise<EncryptedInvitation> {
  const { vaultId, userKey } = context;
  const id = randomBytes(CODE_PART_SIZE);
  const secret = randomBytes(CODE_PART_SIZE);
  const invitationId = crypto.randomUUID();
  const invitationKey = invitationKeyPair(secret, vaultId, invitationId);
  const slots: SlotInit[] = [];
  for (let epoch = 1; epoch <= context.currentEpoch; epoch++) {
    const epochKey = context.epochKey(epoch);
    if (epochKey === undefined)
      throw new Error(
        `this device does not hold the key of epoch ${String(epoch)}, so it cannot invite yet`,
      );
    slots.push({
      epoch,
      recipientKind: KeyRecipientKind.INVITATION,
      recipientId: invitationId,
      wrappedKey: await sealKeySlot(invitationKey.publicKey, epochKey, {
        vaultId,
        epoch,
        recipientKind: "invitation",
        recipientId: invitationId,
      }),
    });
  }
  const inviterFingerprint = fingerprint(
    bundleOf(
      { kemSeed: userKey.privateKey, signSeed: userKey.signSeed },
      userKey.userId,
    ),
  );
  let anchor: Uint8Array = new Uint8Array();
  const response = await appendLogEntry(
    context.log,
    vaultId,
    (log) => {
      const genesis = log[0];
      if (genesis === undefined)
        throw new Error("the vault's membership log is empty");
      anchor = makeInviteAnchor(secret, vaultId, invitationId, {
        genesisHash: entryHash(genesis),
        inviterFingerprint,
      });
      return {
        type: EntryType.invite,
        payload: invitePayload(
          invitationId,
          logRole(role),
          signPublicKey(inviteSignSeed(secret, vaultId, invitationId)),
          invitationKey.publicKey,
        ),
        signSeeds: signedByUser(context),
      };
    },
    (logEntry) =>
      context.membership.createInvitation({
        vaultId,
        role,
        ttlSeconds,
        logEntry,
        idHash: sha256(id),
        slots,
        inviteAnchor: anchor,
      }),
  );
  if (response.invitation === undefined)
    throw new Error("the server created the invitation but returned none");
  return {
    link: [id, secret, anchor]
      .map((part) => base64urlnopad.encode(part))
      .join("."),
    invitation: response.invitation,
  };
}

/** Revokes a pending invitation with its revoke entry. */
export async function revokeEncryptedInvitation(
  context: EncryptedMembershipContext,
  invitationId: string,
): Promise<void> {
  const { vaultId } = context;
  await appendLogEntry(
    context.log,
    vaultId,
    () => ({
      type: EntryType.revokeInvitation,
      payload: idPayload(invitationId),
      signSeeds: signedByUser(context),
    }),
    (logEntry) =>
      context.membership.revokeInvitation({ vaultId, invitationId, logEntry }),
  );
}

/** Changes a member's role with its set-role entry. */
export async function setEncryptedMemberRole(
  context: EncryptedMembershipContext,
  userId: string,
  role: VaultRole,
): Promise<void> {
  const { vaultId } = context;
  await appendLogEntry(
    context.log,
    vaultId,
    () => ({
      type: EntryType.setRole,
      payload: setRolePayload(userId, logRole(role)),
      signSeeds: signedByUser(context),
    }),
    (logEntry) =>
      context.membership.updateMemberRole({ vaultId, userId, role, logEntry }),
  );
}

/** Leaves the vault with the user's own leave entry. */
export async function leaveEncryptedVault(
  context: EncryptedMembershipContext,
): Promise<void> {
  const { vaultId, userKey } = context;
  await appendLogEntry(
    context.log,
    vaultId,
    () => ({
      type: EntryType.leave,
      payload: idPayload(userKey.userId),
      signSeeds: signedByUser(context),
    }),
    (logEntry) => context.membership.leaveVault({ vaultId, logEntry }),
  );
}
