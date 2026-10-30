import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { InvitationSchema, ListInvitationsResponseSchema, MemberSchema, MembershipService, type Invitation, type Member } from "../gen/vaultsync/v1/membership_pb";
import { VaultEncryption, VaultRole, VaultSchema, type Vault } from "../gen/vaultsync/v1/types_pb";
import { ListVaultsResponseSchema, VaultService } from "../gen/vaultsync/v1/vault_pb";
import { createProtocolClient, type ProtocolClient } from "../core/protocol/client";
import { generateKeyPair } from "../core/e2ee/hybrid";
import { createEncryptedInvitation } from "../core/keys/encrypted-membership";
import { createEncryptedVault } from "../core/keys/encrypted-vault";
import { MemoryVaultKeyServer } from "../core/keys/memory-vault-keys";
import type { UserKeyPair } from "../core/keys/user-key";
import { MemoryEpochKeyStore } from "../core/keys/vault-keys";
import { MemoryVerifiedLogStore, type LogTrust } from "../core/keys/verified-log";
import { addAnchor } from "../core/keys/anchor-list";
import { bundleOf, fingerprint, formatFingerprint } from "../core/e2ee/identity";
import { entryHash } from "../core/e2ee/memberlog";
import {
  AlreadyMemberError,
  createInvitation,
  InviteCodeError,
  joinVault,
  deleteConfirmed,
  deleteVault,
  leaveVault,
  loadSharing,
  membershipErrorMessage,
  parseInvitationDays,
  removeMember,
  revokeInvitation,
  setMemberRole,
  memberKeyText,
  vaultFingerprint,
  vaultKeysText,
  type Sharing,
} from "./sharing";

const vaultId = "0190a8c0-0000-7000-8000-000000000001";
const ownerId = "0190a8c0-0000-7000-8000-0000000000a1";
const editorId = "0190a8c0-0000-7000-8000-0000000000b2";
const formatDate = (date: Date) => date.toISOString();
const joined = new Date("2026-10-01T12:00:00.000Z");
const now = new Date("2026-10-20T08:00:00.000Z");

/**
 * The vault and membership services of one vault as the server behaves
 * (SPEC.md §9.2), faked for `caller`: owner-only management, the last-owner
 * rule, single-use codes and one NOT_FOUND for every unusable code.
 */
function fakeServer(caller = ownerId) {
  const members = new Map<string, Member>([
    [ownerId, create(MemberSchema, { userId: ownerId, displayName: "Ada", role: VaultRole.OWNER, joinTime: timestampFromDate(joined) })],
    [editorId, create(MemberSchema, { userId: editorId, displayName: "", role: VaultRole.EDITOR, joinTime: timestampFromDate(joined) })],
  ]);
  const invitations: { invitation: Invitation; code: string }[] = [];
  const requests: string[] = [];
  let deleted = false;
  const role = () => (deleted ? undefined : members.get(caller)?.role);
  const requireOwner = (requested: string) => {
    if (requested !== vaultId || role() === undefined) throw new ConnectError("vault not found", Code.NotFound);
    if (role() !== VaultRole.OWNER) throw new ConnectError("owner role required", Code.PermissionDenied);
  };
  const owners = () => [...members.values()].filter((member) => member.role === VaultRole.OWNER).length;
  const vault = (): Vault => create(VaultSchema, { id: vaultId, name: "Shared notes", encryption: VaultEncryption.NONE, role: role() ?? VaultRole.UNSPECIFIED, headSeq: 3n });
  const transport = createRouterTransport(({ service }) => {
    service(VaultService, {
      listVaults: () => ({ vaults: role() === undefined ? [] : [vault()], nextPageToken: "" }),
      deleteVault: (request) => {
        requests.push("DeleteVault");
        requireOwner(request.vaultId);
        deleted = true;
        return {};
      },
    });
    service(MembershipService, {
      listMembers: (request) => {
        requests.push("ListMembers");
        requireOwner(request.vaultId);
        return { members: [...members.values()] };
      },
      listInvitations: (request) => {
        requests.push("ListInvitations");
        requireOwner(request.vaultId);
        return { invitations: invitations.map((pending) => pending.invitation) };
      },
      createInvitation: (request) => {
        requests.push(`CreateInvitation ${String(request.ttlSeconds)}`);
        requireOwner(request.vaultId);
        const invitation = create(InvitationSchema, {
          id: `0190a8c0-0000-7000-8000-00000000000${String(invitations.length + 1)}`,
          role: request.role,
          creatorUserId: caller,
          createTime: timestampFromDate(now),
          expireTime: timestampFromDate(new Date(now.getTime() + (request.ttlSeconds === 0 ? 7 * 86400 : request.ttlSeconds) * 1000)),
        });
        const code = `code-${String(invitations.length + 1)}`;
        invitations.push({ invitation, code });
        return { invitation, code };
      },
      revokeInvitation: (request) => {
        requireOwner(request.vaultId);
        const index = invitations.findIndex((pending) => pending.invitation.id === request.invitationId);
        if (index < 0) throw new ConnectError("invitation not found", Code.NotFound);
        invitations.splice(index, 1);
        return {};
      },
      updateMemberRole: (request) => {
        requireOwner(request.vaultId);
        const member = members.get(request.userId);
        if (member === undefined) throw new ConnectError("member not found", Code.NotFound);
        if (member.role === VaultRole.OWNER && request.role !== VaultRole.OWNER && owners() === 1) throw new ConnectError("vault must keep at least one owner", Code.FailedPrecondition);
        member.role = request.role;
        return { member };
      },
      removeMember: (request) => {
        requireOwner(request.vaultId);
        const member = members.get(request.userId);
        if (member === undefined) throw new ConnectError("member not found", Code.NotFound);
        if (member.role === VaultRole.OWNER && owners() === 1) throw new ConnectError("vault must keep at least one owner", Code.FailedPrecondition);
        members.delete(request.userId);
        return {};
      },
      leaveVault: (request) => {
        const member = members.get(caller);
        if (request.vaultId !== vaultId || member === undefined) throw new ConnectError("vault not found", Code.NotFound);
        if (member.role === VaultRole.OWNER && owners() === 1) throw new ConnectError("vault must keep at least one owner", Code.FailedPrecondition);
        members.delete(caller);
        return {};
      },
      redeemInvitation: (request) => {
        requests.push("RedeemInvitation");
        const index = invitations.findIndex((pending) => pending.code === request.code);
        if (index < 0) throw new ConnectError("invitation not found", Code.NotFound);
        if (members.has(caller)) throw new ConnectError("already a member of this vault", Code.AlreadyExists);
        const [pending] = invitations.splice(index, 1);
        members.set(caller, create(MemberSchema, { userId: caller, role: pending?.invitation.role ?? VaultRole.VIEWER, joinTime: timestampFromDate(now) }));
        return { vault: vault() };
      },
    });
  });
  const transportClient = createProtocolClient({ transport });
  const client: ProtocolClient = { ...transportClient, vaults: createClient(VaultService, transport), membership: createClient(MembershipService, transport) };
  return {
    client,
    members,
    requests,
    /** Acts as another user from now on. */
    actAs: (userId: string) => (caller = userId),
    invite: (inviteRole: VaultRole) => {
      const code = `seeded-${String(invitations.length + 1)}`;
      invitations.push({ invitation: create(InvitationSchema, { id: `seeded-${String(invitations.length + 1)}`, role: inviteRole }), code });
      return code;
    },
  };
}

function owned(sharing: Sharing) {
  if (sharing.kind !== "owner") throw new Error(`expected the owner's view, got ${sharing.kind}`);
  return sharing;
}

describe("the Sharing section (#34)", () => {
  it("lists an owner's members with name, role and join date, and the pending invitations with role and expiry", async () => {
    const server = fakeServer();
    await createInvitation(server.client, vaultId, VaultRole.VIEWER, 3, formatDate);

    const sharing = owned(await loadSharing(server.client, vaultId, formatDate));

    expect(sharing.members).toEqual([
      { userId: ownerId, label: "⁨Ada⁩", role: VaultRole.OWNER, description: "Owner. Joined 2026-10-01T12:00:00.000Z." },
      // A member without a display name is shown by the start of their id.
      { userId: editorId, label: "user 0190a8c0", role: VaultRole.EDITOR, description: "Editor. Joined 2026-10-01T12:00:00.000Z." },
    ]);
    expect(sharing.invitations).toEqual([
      {
        id: "0190a8c0-0000-7000-8000-000000000001",
        role: VaultRole.VIEWER,
        label: "Viewer invitation",
        description: "Created 2026-10-20T08:00:00.000Z. Expires 2026-10-23T08:00:00.000Z.",
      },
    ]);
  });

  it("shows an editor and a viewer only their role, without asking for the owner-only lists", async () => {
    for (const role of [VaultRole.EDITOR, VaultRole.VIEWER]) {
      const server = fakeServer(editorId);
      const editor = server.members.get(editorId);
      if (editor !== undefined) editor.role = role;

      expect(await loadSharing(server.client, vaultId, formatDate)).toEqual({ kind: "member", role });
      expect(server.requests).toEqual([]);
    }
  });

  it("says when the user is no longer a member of the connected vault", async () => {
    const server = fakeServer("0190a8c0-0000-7000-8000-0000000000c3");

    expect(await loadSharing(server.client, vaultId, formatDate)).toEqual({ kind: "not-member" });
  });

  it("creates an invitation whose code is returned once and which then appears in the pending list, and revokes it", async () => {
    const server = fakeServer();

    const created = await createInvitation(server.client, vaultId, VaultRole.EDITOR, undefined, formatDate);

    expect(created.code).toBe("code-1");
    expect(created.invitation).toMatchObject({ role: VaultRole.EDITOR, label: "Editor invitation" });
    expect(owned(await loadSharing(server.client, vaultId, formatDate)).invitations.map((row) => row.id)).toEqual([created.invitation.id]);
    // No expiry entered: the server's default.
    expect(server.requests).toContain("CreateInvitation 0");

    await revokeInvitation(server.client, vaultId, created.invitation.id);

    expect(owned(await loadSharing(server.client, vaultId, formatDate)).invitations).toEqual([]);
    server.actAs("0190a8c0-0000-7000-8000-0000000000c3");
    await expect(joinVault(server.client, created.code)).rejects.toBeInstanceOf(InviteCodeError);
  });

  it("sends the expiry entered in days as seconds", async () => {
    const server = fakeServer();

    await createInvitation(server.client, vaultId, VaultRole.VIEWER, 30, formatDate);

    expect(server.requests).toContain(`CreateInvitation ${String(30 * 86400)}`);
  });

  it.each([
    ["", undefined],
    ["  ", undefined],
    ["1", 1],
    [" 7 ", 7],
    ["30", 30],
  ])("accepts %j days as %j", (text, days) => {
    expect(parseInvitationDays(text)).toBe(days);
  });

  it.each(["0", "31", "-1", "1.5", "seven", "1e1"])("refuses %j days", (text) => {
    expect(() => parseInvitationDays(text)).toThrow(/1 to 30 days/);
  });

  it("changes a member's role and removes a member, and the reloaded list shows it", async () => {
    const server = fakeServer();

    await setMemberRole(server.client, vaultId, editorId, VaultRole.VIEWER);
    expect(owned(await loadSharing(server.client, vaultId, formatDate)).members.map((row) => [row.userId, row.role])).toEqual([
      [ownerId, VaultRole.OWNER],
      [editorId, VaultRole.VIEWER],
    ]);

    await removeMember(server.client, vaultId, editorId);
    expect(owned(await loadSharing(server.client, vaultId, formatDate)).members.map((row) => row.userId)).toEqual([ownerId]);
  });

  it("explains the server's last-owner refusal, and the list stays as it was", async () => {
    const server = fakeServer();
    const before = await loadSharing(server.client, vaultId, formatDate);

    const demote = setMemberRole(server.client, vaultId, ownerId, VaultRole.EDITOR);
    await expect(demote).rejects.toThrow();
    const error: unknown = await demote.catch((caught: unknown) => caught);
    expect(membershipErrorMessage(error)).toBe("A vault must keep at least one owner. Make another member an owner first.");
    await expect(removeMember(server.client, vaultId, ownerId)).rejects.toMatchObject({ code: Code.FailedPrecondition });

    expect(await loadSharing(server.client, vaultId, formatDate)).toEqual(before);
  });

  it("shows any other refusal with the server's message", () => {
    expect(membershipErrorMessage(new ConnectError("a vault may have at most 100 pending invitations", Code.ResourceExhausted))).toBe("a vault may have at most 100 pending invitations");
  });

  it("lets an editor leave the vault", async () => {
    const server = fakeServer(editorId);

    await leaveVault(server.client, vaultId);

    expect(await loadSharing(server.client, vaultId, formatDate)).toEqual({ kind: "not-member" });
  });

  it("refuses the last owner's leaving with the reason, and lets them leave once another member is an owner", async () => {
    const server = fakeServer();

    const leave = leaveVault(server.client, vaultId);
    const error: unknown = await leave.catch((caught: unknown) => caught);
    expect(membershipErrorMessage(error)).toBe("A vault must keep at least one owner. Make another member an owner first.");
    expect(owned(await loadSharing(server.client, vaultId, formatDate)).members).toHaveLength(2);

    await setMemberRole(server.client, vaultId, editorId, VaultRole.OWNER);
    await leaveVault(server.client, vaultId);
    expect(await loadSharing(server.client, vaultId, formatDate)).toEqual({ kind: "not-member" });
  });
});

describe("deleting a vault", () => {
  it("deletes the vault for an owner, after which it is no longer listed", async () => {
    const server = fakeServer();

    await deleteVault(server.client, vaultId);

    expect(server.requests).toContain("DeleteVault");
    expect(await loadSharing(server.client, vaultId, formatDate)).toEqual({ kind: "not-member" });
  });

  it("passes on an editor's refusal", async () => {
    const server = fakeServer(editorId);

    await expect(deleteVault(server.client, vaultId)).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("is confirmed only by the vault's exact name", () => {
    expect(deleteConfirmed("Shared notes", "Shared notes")).toBe(true);
    expect(deleteConfirmed("", "Shared notes")).toBe(false);
    expect(deleteConfirmed("shared notes", "Shared notes")).toBe(false);
    expect(deleteConfirmed("Shared note", "Shared notes")).toBe(false);
    expect(deleteConfirmed("Shared notes ", "Shared notes")).toBe(false);
    expect(deleteConfirmed("", "")).toBe(false);
  });
});

describe("joining with an invite code (#34)", () => {
  const newcomer = "0190a8c0-0000-7000-8000-0000000000d4";

  it("redeems the code and resolves with the vault joined, with the invitation's role", async () => {
    const server = fakeServer(newcomer);
    const code = server.invite(VaultRole.EDITOR);

    const vault = await joinVault(server.client, `  ${code}\n`);

    expect(vault).toMatchObject({ id: vaultId, name: "Shared notes", role: VaultRole.EDITOR });
    expect(server.members.get(newcomer)?.role).toBe(VaultRole.EDITOR);
  });

  it("refuses an unknown, a used and an empty code with one message that names no code", async () => {
    const server = fakeServer(newcomer);
    const code = server.invite(VaultRole.VIEWER);
    await joinVault(server.client, code);
    server.actAs("0190a8c0-0000-7000-8000-0000000000e5");

    const errors = await Promise.all(["not-a-code", code, " "].map((attempt) => joinVault(server.client, attempt).catch((error: unknown) => error)));

    for (const error of errors) {
      expect(error).toBeInstanceOf(InviteCodeError);
      expect((error as Error).message).toBe("This invite code is invalid, has expired or was already used. Ask the vault's owner for a new one.");
      expect((error as Error).message).not.toContain(code);
    }
    expect(server.members.has("0190a8c0-0000-7000-8000-0000000000e5")).toBe(false);
  });

  it("refuses an empty code without asking the server", async () => {
    const server = fakeServer(newcomer);

    await expect(joinVault(server.client, " \n")).rejects.toBeInstanceOf(InviteCodeError);

    expect(server.requests).toEqual([]);
  });

  it("tells an existing member to connect the vault from the list, and leaves the code usable", async () => {
    const server = fakeServer(editorId);
    const code = server.invite(VaultRole.VIEWER);

    await expect(joinVault(server.client, code)).rejects.toBeInstanceOf(AlreadyMemberError);

    expect(server.members.get(editorId)?.role).toBe(VaultRole.EDITOR);
    server.actAs(newcomer);
    await expect(joinVault(server.client, code)).resolves.toMatchObject({ id: vaultId });
  });

  it("redeems an encrypted vault's link with the user's key, and refuses it once used like any unusable code", async () => {
    const owner: UserKeyPair = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(1), userId: ownerId };
    const joiner: UserKeyPair = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(2), userId: newcomer };
    const server = new MemoryVaultKeyServer(vaultId);
    server.userKeys.set(owner.userId, owner.publicKey);
    server.userKeys.set(joiner.userId, joiner.publicKey);
    const ownerClient = createProtocolClient({ transport: server.transport(owner.userId) });
    const store = new MemoryEpochKeyStore();
    const ownerLogs = new MemoryVerifiedLogStore();
    const vault = await createEncryptedVault({ name: "Secret", escrow: undefined, userKey: owner, vaults: ownerClient.vaults, anchors: ownerClient.userKeys, verifiedLogs: ownerLogs, keys: ownerClient.vaultKeys, membership: ownerClient.membership, store: () => store });
    const created = await createEncryptedInvitation({ vaultId: vault.id, userKey: owner, membership: ownerClient.membership, log: ownerClient.vaultKeys, anchors: ownerClient.userKeys, verifiedLogs: ownerLogs, currentEpoch: 1, epochKey: (epoch) => store.keys.get(epoch) }, VaultRole.EDITOR, 0);
    const client = createProtocolClient({ transport: server.transport(joiner.userId) });
    const redeemer = () => Promise.resolve({ userKey: joiner, membership: client.membership, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: new MemoryVerifiedLogStore() });

    await expect(joinVault(client, ` ${created.link}\n`, redeemer)).resolves.toMatchObject({ id: vault.id, role: VaultRole.EDITOR });
    expect(server.members.get(joiner.userId)?.role).toBe(VaultRole.EDITOR);
    server.members.delete(joiner.userId);
    await expect(joinVault(client, created.link, redeemer)).rejects.toBeInstanceOf(InviteCodeError);
  });

  it("passes on other errors, such as the member limit", async () => {
    const server = fakeServer(newcomer);
    server.client.membership.redeemInvitation = () => Promise.reject(new ConnectError("a vault may have at most 100 members", Code.ResourceExhausted));

    await expect(joinVault(server.client, "code")).rejects.toMatchObject({ code: Code.ResourceExhausted });
  });
});

describe("key fingerprints in an encrypted vault", () => {
  const editorKey: UserKeyPair = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(4), userId: editorId };

  /** An encrypted vault created by an owner with an editor, as `caller` reads it, with the trust its log is verified from. */
  async function encryptedVault(caller: "owner" | "editor") {
    const owner: UserKeyPair = { ...generateKeyPair(), signSeed: new Uint8Array(32).fill(3), userId: ownerId };
    const server = new MemoryVaultKeyServer(vaultId);
    server.userKeys.set(owner.userId, owner.publicKey);
    server.userKeys.set(editorKey.userId, editorKey.publicKey);
    const ownerClient = createProtocolClient({ transport: server.transport(owner.userId) });
    const ownerLogs = new MemoryVerifiedLogStore();
    const store = new MemoryEpochKeyStore();
    const vault = await createEncryptedVault({ name: "Secret", escrow: undefined, userKey: owner, vaults: ownerClient.vaults, anchors: ownerClient.userKeys, verifiedLogs: ownerLogs, keys: ownerClient.vaultKeys, membership: ownerClient.membership, store: () => store });
    server.seedMember(editorKey, VaultRole.EDITOR, owner);
    const callerKey = caller === "owner" ? owner : editorKey;
    if (caller === "editor") {
      // The editor's anchor list names the vault, as redeeming its invitation leaves it.
      const editorClient = createProtocolClient({ transport: server.transport(editorId) });
      await addAnchor(editorClient.userKeys, callerKey, new MemoryVerifiedLogStore(), { vaultId: vault.id, genesisHash: genesisHashOf(server) });
    }
    const base = createProtocolClient({ transport: server.transport(callerKey.userId) });
    const role = caller === "owner" ? VaultRole.OWNER : VaultRole.EDITOR;
    const client: ProtocolClient = {
      ...base,
      vaults: { ...base.vaults, listVaults: () => Promise.resolve(create(ListVaultsResponseSchema, { vaults: [create(VaultSchema, { id: vault.id, name: "Secret", encryption: VaultEncryption.E2EE, role })] })) },
      membership: { ...base.membership, listInvitations: () => Promise.resolve(create(ListInvitationsResponseSchema, {})) },
    };
    const trust = (): Promise<LogTrust> => Promise.resolve({ userKey: callerKey, log: client.vaultKeys, anchors: client.userKeys, verifiedLogs: new MemoryVerifiedLogStore() });
    return { id: vault.id, client, trust, owner, genesis: genesisHashOf(server) };
  }

  function genesisHashOf(server: MemoryVaultKeyServer): Uint8Array {
    const genesis = server.log[0];
    if (genesis === undefined) throw new Error("no genesis");
    return entryHash(genesis);
  }

  function bundleFingerprint(key: UserKeyPair): string {
    return formatFingerprint(fingerprint(bundleOf({ kemSeed: key.privateKey, signSeed: key.signSeed }, key.userId)));
  }

  it("shows every member's key fingerprint and the vault fingerprint to an owner", async () => {
    const { id, client, trust, owner, genesis } = await encryptedVault("owner");

    const sharing = owned(await loadSharing(client, id, formatDate, trust));

    expect(sharing.members.map((member) => [member.userId, member.fingerprint])).toEqual([
      [ownerId, bundleFingerprint(owner)],
      [editorId, bundleFingerprint(editorKey)],
    ]);
    expect(bundleFingerprint(owner)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}( [0-9A-HJKMNP-TV-Z]{4}){7}$/u);
    expect(sharing.keys).toEqual({ kind: "verified", vaultFingerprint: vaultFingerprint(genesis) });
  });

  it("shows an editor the vault fingerprint", async () => {
    const { id, client, trust, genesis } = await encryptedVault("editor");

    expect(await loadSharing(client, id, formatDate, trust)).toEqual({ kind: "member", role: VaultRole.EDITOR, keys: { kind: "verified", vaultFingerprint: vaultFingerprint(genesis) } });
  });

  it("still lists the members, without fingerprints, when the log cannot be verified", async () => {
    const { id, client } = await encryptedVault("owner");

    const sharing = owned(await loadSharing(client, id, formatDate, () => Promise.reject(new Error("Unlock end-to-end encryption on this device first."))));

    expect(sharing.members.map((member) => member.fingerprint)).toEqual([undefined, undefined]);
    expect(sharing.keys).toEqual({ kind: "unavailable", reason: "Unlock end-to-end encryption on this device first." });
  });

  it("shows no fingerprints in a plaintext vault", async () => {
    const server = fakeServer();

    const sharing = owned(await loadSharing(server.client, vaultId, formatDate, () => Promise.reject(new Error("not asked"))));

    expect(sharing.keys).toBeUndefined();
    expect(sharing.members.every((member) => member.fingerprint === undefined)).toBe(true);
  });
});

describe("what the member list says about keys", () => {
  const member = { userId: ownerId, label: "Ada", role: VaultRole.OWNER, description: "Owner." };
  const verified = { kind: "verified", vaultFingerprint: "0008 1018" } as const;

  it("shows a member's fingerprint, says when the verified log names no key, and says nothing in a plaintext vault or without a verified log", () => {
    expect(memberKeyText({ ...member, fingerprint: "ABCD EFGH" }, verified)).toBe("Key fingerprint: ABCD EFGH");
    expect(memberKeyText(member, verified)).toBe("No key for this member in the verified membership log.");
    expect(memberKeyText({ ...member, fingerprint: "ABCD EFGH" }, undefined)).toBeUndefined();
    expect(memberKeyText(member, { kind: "unavailable", reason: "locked" })).toBeUndefined();
  });

  it("shows the vault fingerprint, or why no fingerprints are shown", () => {
    expect(vaultKeysText(verified)).toContain("Vault fingerprint: 0008 1018.");
    expect(vaultKeysText({ kind: "unavailable", reason: "Unlock end-to-end encryption on this device first." })).toBe("Key fingerprints are not shown: Unlock end-to-end encryption on this device first.");
  });
});

describe("the vault fingerprint", () => {
  it("is the whole genesis hash as 64 hex digits in groups of four", () => {
    const hash = Uint8Array.from({ length: 32 }, (_, index) => index * 8);

    expect(vaultFingerprint(hash)).toBe("0008 1018 2028 3038 4048 5058 6068 7078 8088 9098 a0a8 b0b8 c0c8 d0d8 e0e8 f0f8");
  });
});
