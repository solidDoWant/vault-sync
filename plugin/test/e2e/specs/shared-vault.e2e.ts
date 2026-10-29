import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { VaultRole } from "../../../src/gen/vaultsync/v1/types_pb";
import {
  conflictCopies,
  contentOf,
  converged,
  currentDevice,
  fileText,
  goOffline,
  goOnline,
  openSecondDevice,
  serverHeads,
  setUpDevice,
  use,
  waitForIdle,
  waitForServer,
  waitForText,
  writeNote,
  type Device,
} from "../devices";
import { e2eEnvironment, pluginId } from "../environment";
import { answerModal, clickButton, notices, openSettings, recordNotices, type, type SettingsApp } from "../settings-ui";
import { configure, signInAs } from "../signin";

// A vault shared by two users (docs/acceptance/phase-3.md, P3-01 to P3-05):
// the owner on device A, the primary test vault, and an invited user on
// device B, a second vault open in its own window of the same Obsidian
// (devices.ts). The two are different accounts on the identity provider,
// with the display names the e2e driver gives them (Olivia Owner, Max
// Member), and each device has its own name. The member joins with a code
// typed into the settings, as a user does.

const ownerSubject = "plugin-e2e-shared-owner";
const memberSubject = "plugin-e2e-shared-member";
const ownerName = "Olivia Owner";
const memberName = "Max Member";
const ownerDevice = "Owner laptop";
const memberDevice = "Member phone";
const remoteVaultName = "e2e shared vault";
const refusedCode = "could not join: This invite code is invalid, has expired or was already used. Ask the vault's owner for a new one.";

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

/** Names the current device: the name it registers with when it signs in. */
function nameDevice(name: string) {
  return browser.executeObsidian(
    async ({ app }, id, deviceName) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      plugin.data.deviceName = deviceName;
      await plugin.saveSettings();
    },
    pluginId,
    name,
  );
}

/** The connected vault's id on the current device, or null. */
function connectedVaultId() {
  return browser.executeObsidian(({ app }, id) => (app as unknown as Plugins).plugins.plugins[id]?.data.vault?.id ?? null, pluginId);
}

/** Creates an invitation to the connected vault on the current device (an owner's) and returns its code and id; `ttlSeconds` 0 is the server's default. */
function invite(role: VaultRole, ttlSeconds = 0) {
  return browser.executeObsidian(
    async ({ app }, id, invitedRole, ttl) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      const vaultId = plugin?.data.vault?.id;
      if (plugin === undefined || vaultId === undefined) throw new Error("vault-sync is not connected");
      const response = await plugin.protocolClient().membership.createInvitation({ vaultId, role: invitedRole, ttlSeconds: ttl });
      return { code: response.code, id: response.invitation?.id ?? "" };
    },
    pluginId,
    role,
    ttlSeconds,
  );
}

function revoke(invitationId: string) {
  return browser.executeObsidian(
    async ({ app }, id, invitation) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      await plugin.revokeInvitation(invitation);
    },
    pluginId,
    invitationId,
  );
}

/** Sets the role of the connected vault's other member, from the current device (an owner's). */
function setMemberRole(role: VaultRole) {
  return browser.executeObsidian(
    async ({ app }, id, newRole, ownerRole) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      const sharing = await plugin.loadSharing();
      if (sharing.kind !== "owner") throw new Error(`not an owner: ${sharing.kind}`);
      const member = sharing.members.find((candidate) => candidate.role !== ownerRole);
      if (member === undefined) throw new Error("the vault has no other member");
      await plugin.setMemberRole(member.userId, newRole);
    },
    pluginId,
    role,
    VaultRole.OWNER,
  );
}

/** Dismisses the notices on screen, as a click does, waits until they are gone, and forgets the ones recorded, so the next notice is a new one. */
async function dismissNotices(): Promise<void> {
  await browser.executeObsidian(() => {
    for (const notice of document.querySelectorAll<HTMLElement>(".notice")) notice.click();
  });
  await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".notice") === null), { timeoutMsg: "the notices stayed on screen" });
  await browser.executeObsidian(() => {
    (window as unknown as { vaultSyncNotices?: Set<Element> }).vaultSyncNotices?.clear();
  });
}

/** Opens the settings on the current device, recording notices, and waits for the join field. */
async function openJoin(): Promise<void> {
  await openSettings();
  await recordNotices();
  await browser.waitUntil(async () => browser.executeObsidian(({ app }) => ((app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelector(".vault-sync-join input[type=text]") ?? null) !== null), {
    timeoutMsg: "the join row never showed",
  });
}

/** Types `code` into the settings' join field on the current device and clicks Join. */
async function join(code: string): Promise<void> {
  await openJoin();
  await type(".vault-sync-join", code);
  await clickButton(".vault-sync-join", 0, "Join");
}

function closeSettings() {
  return browser.executeObsidian(({ app }) => {
    (app as unknown as SettingsApp).setting.close();
  });
}

/** The rows of the history view of `path` on the current device, without the characters that isolate names. */
async function historyRows(path: string): Promise<string[]> {
  await browser.executeObsidian(async ({ app }, id, filePath) => {
    await (app as unknown as Plugins).plugins.plugins[id]?.showHistory(filePath);
  }, pluginId, path);
  let rows: string[] = [];
  await browser.waitUntil(
    async () => {
      rows = await browser.executeObsidian(() => [...document.querySelectorAll<HTMLElement>(".vault-sync-history-entry")].map((row) => row.textContent));
      return rows.length > 0;
    },
    { timeoutMsg: `the history view of ${path} listed no revision` },
  );
  await browser.keys("Escape");
  await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".vault-sync-history") === null), { timeoutMsg: "the history view stayed open" });
  return rows.map((row) => row.replace(/[⁦-⁩]/gu, ""));
}

/** Opens the note at `path` in the current device's workspace. */
function openNote(path: string) {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    if (file === null) throw new Error(`no ${filePath}`);
    await app.workspace.getLeaf(false).openFile(file);
  }, path);
}

/** Whether the current device shows the viewer's read-only banner on its open note. */
function viewerBannerShown() {
  return browser.executeObsidian(() => document.querySelector(".vault-sync-viewer-banner") !== null);
}

describe("a vault shared by two users", function () {
  let a: Device;
  let b: Device;

  before(async function () {
    // The second device is a second vault on disk opened in the same desktop
    // Obsidian (devices.ts), which needs the vault's file-system path: the
    // Android app has none. Desktop and emulated mobile run this spec.
    if (e2eEnvironment.android) this.skip();
    a = await currentDevice("A");
    await use(a);
    await nameDevice(ownerDevice);
    await setUpDevice(a, ownerSubject, remoteVaultName, true);
    await writeNote("Shared.md", "written by the owner\n");
    await waitForServer(a, (heads) => heads["Shared.md"] === contentOf("written by the owner\n"), "the owner's note");

    b = await openSecondDevice("B", "./test/e2e/vaults/second");
    await nameDevice(memberDevice);
    await configure();
    if ((await signInAs(memberSubject)) !== true) throw new Error("B did not sign in");
  });

  it("[P3-04] a revoked invitation code, and an expired one, are refused with a clear message", async function () {
    await use(a);
    const revoked = await invite(VaultRole.EDITOR);
    await revoke(revoked.id);
    const expiring = await invite(VaultRole.EDITOR, 1);
    // The shortest lifetime there is, and then some.
    await browser.pause(2_000);

    // Both typed into the join field of one open settings tab, one after the other.
    await use(b);
    await openJoin();
    for (const [what, code] of [
      ["revoked", revoked.code],
      ["expired", expiring.code],
    ] as const) {
      await dismissNotices();
      await type(".vault-sync-join", code);
      await clickButton(".vault-sync-join", 0, "Join");
      await browser.waitUntil(async () => (await notices()).some((text) => text.includes(refusedCode)), {
        timeoutMsg: `no notice said the ${what} code was refused: ${JSON.stringify(await notices())}`,
      });
      expect(await connectedVaultId()).toBeNull();
    }
    await closeSettings();
  });

  it("[P3-01] an invited user redeems a code, the vault syncs to their device, and both users' edits sync both ways", async function () {
    await use(a);
    const vaultId = await connectedVaultId();
    const { code } = await invite(VaultRole.EDITOR);

    await use(b);
    await join(code);
    // The member's vault has files of its own, so the combine confirmation comes first.
    await answerModal("Connect a vault that has files?", "Connect and combine");
    await browser.waitUntil(async () => (await connectedVaultId()) === vaultId, { timeoutMsg: "the joined vault was never connected" });
    await closeSettings();
    await waitForText(b, "Shared.md", "written by the owner\n");

    await use(b);
    await writeNote("Shared.md", "written by the owner\nand by the member\n");
    await writeNote("From the member.md", "a note of the member's\n");
    await waitForText(a, "Shared.md", "written by the owner\nand by the member\n");
    await waitForText(a, "From the member.md", "a note of the member's\n");

    await use(a);
    await writeNote("Shared.md", "written by the owner\nand by the member\nand the owner again\n");
    await waitForText(b, "Shared.md", "written by the owner\nand by the member\nand the owner again\n");
    await converged(a, b);
  });

  it("[P3-02] history shows which user, and which of their devices, made each change", async function () {
    await use(a);
    const onOwner = await historyRows("Shared.md");
    expect(onOwner).toHaveLength(3);
    expect(onOwner[0]).toContain(`“${ownerName}”, this device · `);
    expect(onOwner[1]).toContain(`“${memberName}”, device “${memberDevice}” · `);
    expect(onOwner[2]).toContain(`“${ownerName}”, this device · `);

    await use(b);
    const onMember = await historyRows("Shared.md");
    expect(onMember).toHaveLength(3);
    expect(onMember[0]).toContain(`“${ownerName}”, device “${ownerDevice}” · `);
    expect(onMember[1]).toContain(`“${memberName}”, this device · `);
    expect(onMember[2]).toContain(`“${ownerName}”, device “${ownerDevice}” · `);
  });

  it("[P3-03] two users edit the same lines: there is exactly one conflict copy, named after the user and device", async function () {
    await use(a);
    await writeNote("Clash.md", "the line both edit\n");
    await waitForText(b, "Clash.md", "the line both edit\n");

    await goOffline(b);
    await use(a);
    await writeNote("Clash.md", "the owner's version of the line\n");
    await waitForServer(a, (heads) => heads["Clash.md"] === contentOf("the owner's version of the line\n"), "the owner's edit");
    await use(b);
    await writeNote("Clash.md", "the member's version of the line\n");
    await goOnline(b, remoteVaultName);

    const files = await converged(a, b);
    const copies = conflictCopies(files);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(new RegExp(`^Clash \\(Conflicted copy ${memberName} ${memberDevice} \\d{12}\\)\\.md$`, "u"));
    expect(files["Clash.md"]).toBe("the owner's version of the line\n");
    expect(files[copies[0] ?? ""]).toBe("the member's version of the line\n");
  });

  it("[P3-05] an owner changes a member's role, editor to viewer and back, and it takes effect on the member's device without signing in again", async function () {
    await use(b);
    await openNote("Shared.md");
    expect(await viewerBannerShown()).toBe(false);

    // Editor to viewer. The owner's next change starts a sync cycle on the member's device, which reads its role.
    await use(a);
    await setMemberRole(VaultRole.VIEWER);
    await writeNote("While a viewer.md", "the owner's note for a viewer\n");
    await waitForText(b, "While a viewer.md", "the owner's note for a viewer\n");
    await use(b);
    await browser.waitUntil(viewerBannerShown, { timeout: 60_000, timeoutMsg: "the member's device never became read-only" });

    // An edit made anyway is not uploaded: the shared version comes back.
    const shared = await fileText("Shared.md");
    await writeNote("Shared.md", "the viewer's edit\n");
    await waitForText(b, "Shared.md", shared);
    await waitForIdle(b);
    expect((await serverHeads())["Shared.md"]).toBe(contentOf(shared ?? ""));

    // Viewer to editor: the member's edits sync again.
    await use(a);
    await setMemberRole(VaultRole.EDITOR);
    await writeNote("While an editor.md", "the owner's note for an editor\n");
    await waitForText(b, "While an editor.md", "the owner's note for an editor\n");
    await use(b);
    await browser.waitUntil(async () => !(await viewerBannerShown()), { timeout: 60_000, timeoutMsg: "the member's device stayed read-only" });
    await writeNote("Shared.md", "the member edits again\n");
    await waitForText(a, "Shared.md", "the member edits again\n");
  });
});
