import { Code, ConnectError } from "@connectrpc/connect";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Invitation, Member } from "../gen/vaultsync/v1/membership_pb";
import { VaultEncryption, VaultRole, type Vault } from "../gen/vaultsync/v1/types_pb";
import type { ProtocolClient } from "../core/protocol/client";
import { createEncryptedInvitation, leaveEncryptedVault, parseInviteLink, redeemEncryptedInvitation, revokeEncryptedInvitation, setEncryptedMemberRole, type EncryptedMembershipContext, type RedeemContext } from "../core/keys/encrypted-membership";
import type { VaultKeyManager } from "../core/keys/vault-keys";
import { readMemberLog, type LogTrust } from "../core/keys/verified-log";
import { fingerprint, formatFingerprint } from "../core/e2ee/identity";
import { listRemoteVaults } from "./controller";
import { isolated, shownName } from "./display-text";
import { errorMessage } from "./status";

// The settings' Sharing section and joining by invite code (#34, SPEC.md
// §9.2): the connected vault's members and pending invitations for its
// owners, the caller's own role for everyone else, and redeeming a code. No
// Obsidian import, so it is unit-tested against faked services; settings.ts
// shows it. Invite codes are secrets: they never appear in an error message
// or a log line.

/** The roles a member or an invitation can have, in the order the settings offer them. */
export const roles: readonly VaultRole[] = [VaultRole.OWNER, VaultRole.EDITOR, VaultRole.VIEWER];

/** A role as the settings name it. */
export function roleName(role: VaultRole): string {
  switch (role) {
    case VaultRole.OWNER:
      return "Owner";
    case VaultRole.EDITOR:
      return "Editor";
    case VaultRole.VIEWER:
      return "Viewer";
    default:
      return "Unknown role";
  }
}

/** What each role may do, for the settings' descriptions. */
export function roleDescription(role: VaultRole): string {
  switch (role) {
    case VaultRole.OWNER:
      return "Owners read and change notes and manage the vault's members and invitations.";
    case VaultRole.EDITOR:
      return "Editors read and change notes.";
    case VaultRole.VIEWER:
      return "Viewers can only read notes; the server refuses their changes.";
    default:
      return "";
  }
}

/** One member as the Sharing section lists them. */
export interface MemberRow {
  userId: string;
  /** The member's display name as it is shown (shownName, isolated), or the start of their user id when it shows nothing. */
  label: string;
  role: VaultRole;
  /** Their role and when they joined. */
  description: string;
  /**
   * In an encrypted vault whose log verified: the fingerprint of the
   * member's key in the verified membership log, for comparing out of band;
   * undefined when the log names no key for them.
   */
  fingerprint?: string;
}

/**
 * An encrypted vault's keys as the Sharing section shows them: the vault
 * fingerprint (its genesis hash) once the membership log verified from the
 * user's anchor list, or why it could not be read (such as a locked key).
 */
export type VaultKeys = { kind: "verified"; vaultFingerprint: string } | { kind: "unavailable"; reason: string };

/** One pending invitation as the Sharing section lists it. */
export interface InvitationRow {
  id: string;
  role: VaultRole;
  label: string;
  /** When it was created and when it expires. */
  description: string;
}

/**
 * The connected vault's Sharing section: for an owner the members and pending
 * invitations; for an editor or viewer only their role; `not-member` when the
 * server no longer lists the vault (the user was removed or left).
 */
export type Sharing =
  | { kind: "owner"; members: MemberRow[]; invitations: InvitationRow[]; encrypted: boolean; keys?: VaultKeys }
  | { kind: "member"; role: VaultRole; keys?: VaultKeys }
  | { kind: "not-member" };

/** Formats a time in the user's locale. */
export type FormatDate = (date: Date) => string;

/**
 * Reads the Sharing section of `vaultId`: management lists only for its
 * owners. In an end-to-end encrypted vault it also verifies the membership
 * log with `trust` and shows the vault fingerprint and, to owners, each
 * member's key fingerprint (docs/design/encryption.md, "Identity keys").
 * When the log cannot be read or does not verify, the lists are still shown,
 * without fingerprints, together with the reason.
 */
export async function loadSharing(client: ProtocolClient, vaultId: string, formatDate: FormatDate, trust?: () => Promise<LogTrust>): Promise<Sharing> {
  const vault = (await listRemoteVaults(client)).find((listed) => listed.id === vaultId);
  if (vault === undefined) return { kind: "not-member" };
  const encrypted = vault.encryption === VaultEncryption.E2EE && trust !== undefined ? await verifiedKeys(vaultId, trust) : undefined;
  const keys = encrypted === undefined ? {} : { keys: encrypted.keys };
  if (vault.role !== VaultRole.OWNER) return { kind: "member", role: vault.role, ...keys };
  const [members, invitations] = await Promise.all([client.membership.listMembers({ vaultId }), client.membership.listInvitations({ vaultId })]);
  return {
    kind: "owner",
    members: members.members.map((member) => {
      const row = memberRow(member, formatDate);
      const shown = encrypted?.fingerprints.get(member.userId);
      return shown === undefined ? row : { ...row, fingerprint: shown };
    }),
    invitations: invitations.invitations.map((invitation) => invitationRow(invitation, formatDate)),
    encrypted: vault.encryption === VaultEncryption.E2EE,
    ...keys,
  };
}

/** The vault fingerprint and the members' key fingerprints from the vault's verified log, or why they are unavailable. */
async function verifiedKeys(vaultId: string, trust: () => Promise<LogTrust>): Promise<{ keys: VaultKeys; fingerprints: ReadonlyMap<string, string> }> {
  try {
    const { states } = await readMemberLog(await trust(), vaultId);
    const genesis = states[0];
    const head = states.at(-1);
    if (genesis === undefined || head === undefined) throw new Error("the vault's membership log is empty");
    const fingerprints = new Map<string, string>();
    for (const [userId, member] of head.members) fingerprints.set(userId, formatFingerprint(fingerprint(member.bundle)));
    return { keys: { kind: "verified", vaultFingerprint: vaultFingerprint(genesis.hash) }, fingerprints };
  } catch (error) {
    return { keys: { kind: "unavailable", reason: errorMessage(error) }, fingerprints: new Map() };
  }
}

/**
 * The vault fingerprint: the whole genesis hash as 64 lowercase hex digits
 * in groups of four, the form the escrow import's `-genesis` takes
 * (docs/import.md).
 */
export function vaultFingerprint(genesisHash: Uint8Array): string {
  return (bytesToHex(genesisHash).match(/.{1,4}/gu) ?? []).join(" ");
}

/**
 * What the member list says about a member's key in an encrypted vault whose
 * log verified: their fingerprint, or that the log names no key for them.
 * Undefined in a plaintext vault, and when the fingerprints are unavailable
 * (the vault fingerprint's line says why).
 */
export function memberKeyText(member: MemberRow, keys: VaultKeys | undefined): string | undefined {
  if (keys?.kind !== "verified") return undefined;
  return member.fingerprint === undefined ? "No key for this member in the verified membership log." : `Key fingerprint: ${member.fingerprint}`;
}

/** What the Sharing section says about an encrypted vault's fingerprint, or why no fingerprints are shown. */
export function vaultKeysText(keys: VaultKeys): string {
  return keys.kind === "verified"
    ? `Vault fingerprint: ${keys.vaultFingerprint}. Compare fingerprints with the other members outside Vault Sync; the server cannot forge them. An operator restoring the vault from escrow needs this vault fingerprint.`
    : `Key fingerprints are not shown: ${keys.reason}`;
}

export function memberRow(member: Member, formatDate: FormatDate): MemberRow {
  const name = shownName(member.displayName);
  const joined = member.joinTime === undefined ? "" : ` Joined ${formatDate(timestampDate(member.joinTime))}.`;
  return {
    userId: member.userId,
    label: name === "" ? `user ${member.userId.slice(0, 8)}` : isolated(name),
    role: member.role,
    description: `${roleName(member.role)}.${joined}`,
  };
}

export function invitationRow(invitation: Invitation, formatDate: FormatDate): InvitationRow {
  const created = invitation.createTime === undefined ? "" : ` Created ${formatDate(timestampDate(invitation.createTime))}.`;
  const expires = invitation.expireTime === undefined ? "" : ` Expires ${formatDate(timestampDate(invitation.expireTime))}.`;
  return {
    id: invitation.id,
    role: invitation.role,
    label: `${roleName(invitation.role)} invitation`,
    description: `${created}${expires}`.trim(),
  };
}

/** The longest an invitation may stay redeemable, in days (the server's maximum, SPEC.md §9.2). */
export const maxInvitationDays = 30;

/**
 * The invitation lifetime the user entered, in days: undefined for an empty
 * field (the server's default, 7 days), otherwise a whole number from 1 to
 * maxInvitationDays. Anything else throws, with a message to show.
 */
export function parseInvitationDays(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/u.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > maxInvitationDays) {
    throw new Error(`An invitation expires after 1 to ${String(maxInvitationDays)} days; leave the field empty for 7 days.`);
  }
  return Number(trimmed);
}

/**
 * What a membership change of an end-to-end encrypted vault needs: the
 * signed-in user's key, which signs its log entry, and the vault's key
 * manager, which wraps epoch keys to an invitation and builds the epoch a
 * removal needs. Undefined for a plaintext vault.
 */
export interface EncryptedSharing {
  context: EncryptedMembershipContext;
  manager: VaultKeyManager;
}

/** A new invitation: its code, shown once, and its row. */
export interface CreatedInvitation {
  code: string;
  invitation: InvitationRow;
}

/**
 * Creates an invitation to `vaultId` with `role`, redeemable for `days` days
 * (the server's default when undefined). In an encrypted vault the code is
 * the link this device generated, which carries the invitation's secret.
 */
export async function createInvitation(
  client: ProtocolClient,
  vaultId: string,
  role: VaultRole,
  days: number | undefined,
  formatDate: FormatDate,
  encrypted?: EncryptedSharing,
): Promise<CreatedInvitation> {
  const ttlSeconds = days === undefined ? 0 : days * 24 * 60 * 60;
  if (encrypted !== undefined) {
    const { manager } = encrypted;
    const state = await manager.sync();
    const created = await createEncryptedInvitation({ ...encrypted.context, currentEpoch: state.currentEpoch, epochKey: (epoch) => manager.epochKey(epoch) }, role, ttlSeconds);
    return { code: created.link, invitation: invitationRow(created.invitation, formatDate) };
  }
  const response = await client.membership.createInvitation({ vaultId, role, ttlSeconds });
  if (response.invitation === undefined || response.code === "") throw new Error("the server created the invitation but returned no code");
  return { code: response.code, invitation: invitationRow(response.invitation, formatDate) };
}

export async function revokeInvitation(client: ProtocolClient, vaultId: string, invitationId: string, encrypted?: EncryptedSharing): Promise<void> {
  if (encrypted !== undefined) return revokeEncryptedInvitation(encrypted.context, invitationId);
  await client.membership.revokeInvitation({ vaultId, invitationId });
}

export async function setMemberRole(client: ProtocolClient, vaultId: string, userId: string, role: VaultRole, encrypted?: EncryptedSharing): Promise<void> {
  if (encrypted !== undefined) return setEncryptedMemberRole(encrypted.context, userId, role);
  await client.membership.updateMemberRole({ vaultId, userId, role });
}

/** Removes a member; in an encrypted vault together with the next epoch, which the removed member gets no key of. */
export async function removeMember(client: ProtocolClient, vaultId: string, userId: string, encrypted?: EncryptedSharing): Promise<void> {
  if (encrypted !== undefined) return encrypted.manager.removeMember(userId);
  await client.membership.removeMember({ vaultId, userId });
}

/** An owner's manual rotation of an encrypted vault's key: the next epoch, which every current member gets a key of, and other devices pick up at their next sync. */
export async function rotateVaultKey(encrypted: EncryptedSharing | undefined): Promise<void> {
  if (encrypted === undefined) throw new Error("only an end-to-end encrypted vault has a key to rotate");
  await encrypted.manager.rotate();
}

export async function leaveVault(client: ProtocolClient, vaultId: string, encrypted?: EncryptedSharing): Promise<void> {
  if (encrypted !== undefined) return leaveEncryptedVault(encrypted.context);
  await client.membership.leaveVault({ vaultId });
}

/** Deletes `vaultId` on the server (DeleteVault, owner only). */
export async function deleteVault(client: ProtocolClient, vaultId: string): Promise<void> {
  await client.vaults.deleteVault({ vaultId });
}

/** Whether the name the owner typed to confirm deleting a vault is the vault's name, exactly. */
export function deleteConfirmed(typed: string, vaultName: string): boolean {
  return vaultName !== "" && typed === vaultName;
}

/**
 * A membership change's refusal, to show: the server's last-owner refusal
 * (FAILED_PRECONDITION) in words, anything else as errorMessage shows it.
 */
export function membershipErrorMessage(error: unknown): string {
  if (error instanceof ConnectError && error.code === Code.FailedPrecondition) return "A vault must keep at least one owner. Make another member an owner first.";
  return errorMessage(error);
}

/** An invite code the server does not accept: malformed, unknown, expired, revoked or used. */
export class InviteCodeError extends Error {
  override readonly name = "InviteCodeError";
  constructor() {
    super("This invite code is invalid, has expired or was already used. Ask the vault's owner for a new one.");
  }
}

/** Redeeming an invitation to a vault the user is already a member of; the invitation stays usable. */
export class AlreadyMemberError extends Error {
  override readonly name = "AlreadyMemberError";
  constructor() {
    super("You are already a member of this vault. Choose it under Connect to an existing vault instead; the invite code was not used.");
  }
}

/**
 * Redeems an invite code (RedeemInvitation) and resolves with the vault the
 * user joined. An empty code is refused without a request. The server
 * answers every unusable code with one NOT_FOUND, and so does this
 * (InviteCodeError); an existing membership is AlreadyMemberError. The code
 * is never part of an error. An encrypted vault's link `<id>.<secret>.<anchor>`
 * is redeemed with the user's key from `redeemer`, which wraps the vault's
 * keys to it and signs the redeem entry.
 */
export async function joinVault(client: ProtocolClient, code: string, redeemer?: () => Promise<RedeemContext>): Promise<Vault> {
  const trimmed = code.trim();
  if (trimmed === "") throw new InviteCodeError();
  const link = parseInviteLink(trimmed);
  let vault: Vault | undefined;
  try {
    if (link !== undefined) {
      if (redeemer === undefined) throw new Error("this device cannot join an end-to-end encrypted vault");
      vault = await redeemEncryptedInvitation(await redeemer(), link);
    } else vault = (await client.membership.redeemInvitation({ code: trimmed })).vault;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) throw new InviteCodeError();
    if (error instanceof ConnectError && error.code === Code.AlreadyExists) throw new AlreadyMemberError();
    throw error;
  }
  if (vault === undefined) throw new Error("the server accepted the invite code but returned no vault");
  return vault;
}
