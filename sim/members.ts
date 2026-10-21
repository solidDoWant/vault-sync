// The users of a multi-user simulation run (#35) and their vault roles. User
// 0 created the vault and owns it; every engine and scripted client 0 are
// its devices. Every other user joined through a real invitation, and
// membership steps change their roles mid-schedule through the owner's
// MembershipService: demoted to viewer, promoted back to editor, removed, or
// invited again. The changes run fault-free, as the owner's own device would
// make them, and each takes effect on the member's next request (SPEC.md
// §9.2), which in the simulation is the next one the network delivers.
//
// Members also checks every call of a member's device at the moment it
// reaches the server, against the role the member has then: what a viewer
// or a removed member may no longer do must be refused, with the right code,
// and what a member may do must not be (SPEC.md §9.2, §9.3).

import { Code, createClient, type Client, type Transport } from "@connectrpc/connect";

import { withBearerToken } from "../plugin/src/core/protocol/client";
import { MembershipService } from "../plugin/src/gen/vaultsync/v1/membership_pb";
import { VaultRole } from "../plugin/src/gen/vaultsync/v1/types_pb";
import type { Violation } from "./client";
import { errorCode, type Outcome } from "./network";

/** A user's standing in the run's vault. */
export type MemberRole = "owner" | "editor" | "viewer" | "removed";

/** The calls that write to a vault (`authz.Write`): a viewer's and a removed member's must be refused. */
export const writeMethods: ReadonlySet<string> = new Set(["BeginBlob", "PutBlobChunk", "CommitBlob", "CommitRevision"]);

/** A user of the run: its token, and the membership API with that token. */
interface User {
  /** Empty for a member until it has joined. */
  userId: string;
  role: MemberRole;
  membership: Client<typeof MembershipService>;
}

/** The invitation lifetime of the run's invitations: long enough for any run. */
const invitationTtlSeconds = 24 * 60 * 60;

export class Members {
  /** Role changes made so far, by kind, for the members suite's summary. */
  readonly changes = { demoted: 0, promoted: 0, removed: 0, rejoined: 0 };

  private constructor(
    private readonly vaultId: string,
    private readonly users: User[],
    /** Scripted clients; client i belongs to user i % users. Engines (index ≥ clients) belong to the owner. */
    private readonly clients: number,
  ) {}

  /**
   * The run's users: the owner (`tokens[0]`, who created the vault) and one
   * member per further token, each joined as an editor through an invitation
   * the owner created.
   */
  static async join(transport: Transport, vaultId: string, tokens: readonly string[], clients: number): Promise<Members> {
    const users = tokens.map((token, index): User => ({ userId: "", role: index === 0 ? "owner" : "removed", membership: createClient(MembershipService, withBearerToken(transport, () => token)) }));
    const members = new Members(vaultId, users, clients);
    const owner = members.owner;
    const [ownerMember] = (await owner.membership.listMembers({ vaultId })).members;
    if (ownerMember === undefined) throw new Error("ListMembers returned no owner");
    owner.userId = ownerMember.userId;
    for (const user of users.slice(1)) await members.invite(user, VaultRole.EDITOR);
    return members;
  }

  /** How many users the run has, the owner included. */
  get count(): number {
    return this.users.length;
  }

  /** The user scripted client or engine `client` belongs to. */
  userOf(client: number): number {
    return client < this.clients ? client % this.users.length : 0;
  }

  /** The role `client`'s user has now. */
  roleOf(client: number): MemberRole {
    return this.users[this.userOf(client)]?.role ?? "removed";
  }

  /** Whether `client`'s user can lose access during the run: every user but the owner. */
  mayLoseAccess(client: number): boolean {
    return this.userOf(client) !== 0;
  }

  /**
   * A membership step: the owner changes one member's role. `pick` chooses
   * the member and the change its role allows: an editor is demoted to
   * viewer or removed, a viewer promoted back to editor or removed, and a
   * removed member invited again as an editor or a viewer. Returns the trace
   * entry.
   */
  async change(pick: number): Promise<string> {
    const candidates = this.users.length - 1;
    if (candidates === 0) return "membership: no member";
    const index = 1 + (pick % candidates);
    const user = this.users[index];
    if (user === undefined) throw new Error("unreachable: membership pick out of range");
    const name = `u${String(index)}`;
    const second = Math.floor(pick / candidates) % 2 === 0;
    switch (user.role) {
      case "editor":
        return second ? this.setRole(user, name, VaultRole.VIEWER) : this.remove(user, name);
      case "viewer":
        return second ? this.setRole(user, name, VaultRole.EDITOR) : this.remove(user, name);
      case "removed":
        await this.invite(user, second ? VaultRole.EDITOR : VaultRole.VIEWER);
        this.changes.rejoined++;
        return `membership: ${name} invited again and joined as ${user.role}`;
      case "owner":
        throw new Error("unreachable: the owner is never a membership step's member");
    }
  }

  /** Demotes or promotes user `index` (not the owner) to `role`; for scripted scenarios. */
  async setRoleOf(index: number, role: "editor" | "viewer"): Promise<string> {
    const user = this.member(index);
    return this.setRole(user, `u${String(index)}`, role === "editor" ? VaultRole.EDITOR : VaultRole.VIEWER);
  }

  /** Removes user `index` (not the owner); for scripted scenarios. */
  async removeMember(index: number): Promise<string> {
    return this.remove(this.member(index), `u${String(index)}`);
  }

  /** Invites user `index` (removed) again and has it join with `role`; for scripted scenarios. */
  async rejoin(index: number, role: "editor" | "viewer"): Promise<string> {
    const user = this.member(index);
    await this.invite(user, role === "editor" ? VaultRole.EDITOR : VaultRole.VIEWER);
    this.changes.rejoined++;
    return `membership: u${String(index)} invited again and joined as ${user.role}`;
  }

  /**
   * The authorization violations of one call of `client`'s device the
   * server just answered, given its user's role while the server ran it
   * (membership changes run between deliveries, never during one):
   *
   * - `revoked-write`: a viewer's or a removed member's write was accepted.
   * - `removed-read`: a removed member's read was answered, so it received
   *   the vault's changes after its removal.
   * - `authorization`: a refusal with the wrong code (a viewer's write gets
   *   PERMISSION_DENIED, every call of a non-member NOT_FOUND, SPEC.md §9.3),
   *   or a member refused what its role allows.
   */
  check(client: number, method: string, outcome: Outcome): Violation[] {
    const role = this.roleOf(client);
    return authorizationViolations(role, `c${String(client)} (u${String(this.userOf(client))}, ${role})`, method, outcome);
  }

  private get owner(): User {
    const owner = this.users[0];
    if (owner === undefined) throw new Error("a run has an owner");
    return owner;
  }

  private member(index: number): User {
    const user = index === 0 ? undefined : this.users[index];
    if (user === undefined) throw new Error(`no member u${String(index)}`);
    return user;
  }

  private async setRole(user: User, name: string, role: VaultRole): Promise<string> {
    await this.owner.membership.updateMemberRole({ vaultId: this.vaultId, userId: user.userId, role });
    const before = user.role;
    user.role = roleName(role);
    if (user.role === "viewer") this.changes.demoted++;
    else this.changes.promoted++;
    return `membership: ${name} changed from ${before} to ${user.role}`;
  }

  private async remove(user: User, name: string): Promise<string> {
    await this.owner.membership.removeMember({ vaultId: this.vaultId, userId: user.userId });
    const before = user.role;
    user.role = "removed";
    this.changes.removed++;
    return `membership: ${name} removed (was ${before})`;
  }

  /** The owner invites `user` with `role` and the user redeems the code; learns its user id. */
  private async invite(user: User, role: VaultRole): Promise<void> {
    const { code } = await this.owner.membership.createInvitation({ vaultId: this.vaultId, role, ttlSeconds: invitationTtlSeconds });
    await user.membership.redeemInvitation({ code });
    if (user.userId === "") {
      const known = new Set(this.users.map((candidate) => candidate.userId));
      const joined = (await this.owner.membership.listMembers({ vaultId: this.vaultId })).members.filter((member) => !known.has(member.userId));
      const [member] = joined;
      if (member === undefined || joined.length !== 1) throw new Error(`expected one new member after a redemption, found ${String(joined.length)}`);
      user.userId = member.userId;
    }
    user.role = roleName(role);
  }
}

function roleName(role: VaultRole): MemberRole {
  switch (role) {
    case VaultRole.OWNER:
      return "owner";
    case VaultRole.EDITOR:
      return "editor";
    case VaultRole.VIEWER:
      return "viewer";
    default:
      throw new Error(`unexpected vault role ${String(role)}`);
  }
}

/**
 * The authorization violations of one call by `who`, whose user had `role`
 * while the server ran it (Members.check).
 */
export function authorizationViolations(role: MemberRole, who: string, method: string, outcome: Outcome): Violation[] {
  const write = writeMethods.has(method);
  const code = outcome.ok ? undefined : errorCode(outcome.error);
  if (role === "removed") {
    if (outcome.ok) return [{ invariant: write ? "revoked-write" : "removed-read", detail: `the server answered ${method} of ${who} after the member's removal` }];
    if (code !== Code.NotFound) return [{ invariant: "authorization", detail: `${method} of ${who} failed with ${Code[code ?? Code.Unknown]}, not NOT_FOUND` }];
    return [];
  }
  if (role === "viewer" && write) {
    if (outcome.ok) return [{ invariant: "revoked-write", detail: `the server accepted ${method} of ${who}` }];
    if (code !== Code.PermissionDenied) return [{ invariant: "authorization", detail: `${method} of ${who} failed with ${Code[code ?? Code.Unknown]}, not PERMISSION_DENIED` }];
    return [];
  }
  // A member's feed is never NOT_FOUND, and nothing its role allows is PERMISSION_DENIED.
  if (code === Code.PermissionDenied || (code === Code.NotFound && method === "ListChanges")) {
    return [{ invariant: "authorization", detail: `${method} of ${who} was refused with ${Code[code]}` }];
  }
  return [];
}
