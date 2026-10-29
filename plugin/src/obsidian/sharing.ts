import { Code, ConnectError } from "@connectrpc/connect";
import { timestampDate } from "@bufbuild/protobuf/wkt";

import type { Invitation, Member } from "../gen/vaultsync/v1/membership_pb";
import { VaultRole, type Vault } from "../gen/vaultsync/v1/types_pb";
import type { ProtocolClient } from "../core/protocol/client";
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
}

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
export type Sharing = { kind: "owner"; members: MemberRow[]; invitations: InvitationRow[] } | { kind: "member"; role: VaultRole } | { kind: "not-member" };

/** Formats a time in the user's locale. */
export type FormatDate = (date: Date) => string;

/** The signed-in user's role in `vaultId` (from ListVaults), or undefined when they are not a member. */
export async function roleIn(client: ProtocolClient, vaultId: string): Promise<VaultRole | undefined> {
  return (await listRemoteVaults(client)).find((vault) => vault.id === vaultId)?.role;
}

/** Reads the Sharing section of `vaultId`: management lists only for its owners. */
export async function loadSharing(client: ProtocolClient, vaultId: string, formatDate: FormatDate): Promise<Sharing> {
  const role = await roleIn(client, vaultId);
  if (role === undefined) return { kind: "not-member" };
  if (role !== VaultRole.OWNER) return { kind: "member", role };
  const [members, invitations] = await Promise.all([client.membership.listMembers({ vaultId }), client.membership.listInvitations({ vaultId })]);
  return {
    kind: "owner",
    members: members.members.map((member) => memberRow(member, formatDate)),
    invitations: invitations.invitations.map((invitation) => invitationRow(invitation, formatDate)),
  };
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

/** A new invitation: its code, shown once, and its row. */
export interface CreatedInvitation {
  code: string;
  invitation: InvitationRow;
}

/** Creates an invitation to `vaultId` with `role`, redeemable for `days` days (the server's default when undefined). */
export async function createInvitation(client: ProtocolClient, vaultId: string, role: VaultRole, days: number | undefined, formatDate: FormatDate): Promise<CreatedInvitation> {
  const response = await client.membership.createInvitation({ vaultId, role, ttlSeconds: days === undefined ? 0 : days * 24 * 60 * 60 });
  if (response.invitation === undefined || response.code === "") throw new Error("the server created the invitation but returned no code");
  return { code: response.code, invitation: invitationRow(response.invitation, formatDate) };
}

export async function revokeInvitation(client: ProtocolClient, vaultId: string, invitationId: string): Promise<void> {
  await client.membership.revokeInvitation({ vaultId, invitationId });
}

export async function setMemberRole(client: ProtocolClient, vaultId: string, userId: string, role: VaultRole): Promise<void> {
  await client.membership.updateMemberRole({ vaultId, userId, role });
}

export async function removeMember(client: ProtocolClient, vaultId: string, userId: string): Promise<void> {
  await client.membership.removeMember({ vaultId, userId });
}

export async function leaveVault(client: ProtocolClient, vaultId: string): Promise<void> {
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
 * is never part of an error.
 */
export async function joinVault(client: ProtocolClient, code: string): Promise<Vault> {
  const trimmed = code.trim();
  if (trimmed === "") throw new InviteCodeError();
  let vault: Vault | undefined;
  try {
    vault = (await client.membership.redeemInvitation({ code: trimmed })).vault;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) throw new InviteCodeError();
    if (error instanceof ConnectError && error.code === Code.AlreadyExists) throw new AlreadyMemberError();
    throw error;
  }
  if (vault === undefined) throw new Error("the server accepted the invite code but returned no vault");
  return vault;
}
