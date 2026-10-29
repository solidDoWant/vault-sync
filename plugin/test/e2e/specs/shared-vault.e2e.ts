import { writeFile } from "node:fs/promises";
import path from "node:path";

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
  syncStatus,
  use,
  vaultFiles,
  waitForIdle,
  waitForServer,
  waitForText,
  writeNote,
  type Device,
} from "../devices";
import { e2eEnvironment, pluginId } from "../environment";
import { answerModal, clickButton, modals, notices, openSettings, recordNotices, type, type SettingsApp } from "../settings-ui";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// A vault shared by two users (docs/acceptance/phase-3.md, P3-01 to P3-05):
// the owner on device A, the primary test vault, and an invited user on
// device B, a second vault open in its own window of the same Obsidian
// (devices.ts). The two are different accounts on the identity provider,
// with the display names the e2e driver gives them (Olivia Owner, Max
// Member), and each device has its own name. The member joins with a code
// typed into the settings, as a user does. P3-06 to P3-12 go on from there:
// the member as a viewer who then leaves, the last owner handing the vault
// over and leaving, deleting the vault (each user who left joins again with
// a new code first), then a second vault of the new owner's, whose other
// member is removed.

const ownerSubject = "plugin-e2e-shared-owner";
const memberSubject = "plugin-e2e-shared-member";
const ownerName = "Olivia Owner";
const memberName = "Max Member";
const ownerDevice = "Owner laptop";
const memberDevice = "Member phone";
const remoteVaultName = "e2e shared vault";
const secondVaultName = "e2e second shared vault";
const lastOwner = "A vault must keep at least one owner. Make another member an owner first.";
const viewerRefused = "Vault Sync: this vault is shared with you as a viewer, so files cannot be created, renamed or deleted in it.";
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

/** Opens the settings on the current device, recording notices, and waits for the Sharing section to load. */
async function openSharing(): Promise<void> {
  await openSettings();
  await recordNotices();
  await browser.waitUntil(async () => !(await settingsText()).includes("Loading the vault's members"), { timeoutMsg: "the Sharing section never loaded" });
}

/** The text of the open settings tab on the current device. */
function settingsText() {
  return browser.executeObsidian(({ app }) => (app as unknown as SettingsApp).setting.activeTab?.containerEl.textContent ?? "");
}

/** Clicks the button labelled `label` in the settings' Sharing section on the current device. */
function clickSharingButton(label: string) {
  return browser.executeObsidian(({ app }, text) => {
    const buttons = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll<HTMLButtonElement>(".vault-sync-sharing button") ?? [];
    const button = [...buttons].find((candidate) => candidate.textContent === text);
    if (button === undefined) throw new Error(`no ${text} button in the Sharing section`);
    button.click();
  }, label);
}

/** Picks `role` in the role menu of the member named `name` in the settings' member list on the current device (an owner's). */
function pickMemberRole(name: string, role: VaultRole) {
  return browser.executeObsidian(
    ({ app }, memberName, value) => {
      const rows = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll(".vault-sync-members .setting-item") ?? [];
      const row = [...rows].find((candidate) => candidate.querySelector(".setting-item-name")?.textContent.replace(/[⁦-⁩]/gu, "") === memberName);
      const select = row?.querySelector("select");
      if (select === null || select === undefined) throw new Error(`no role menu for ${memberName}`);
      select.value = value;
      select.dispatchEvent(new Event("change"));
    },
    name,
    String(role),
  );
}

/** Types `value` into the text field of the open modal titled `title`. */
async function typeInModal(title: string, value: string): Promise<void> {
  await browser.waitUntil(async () => (await modals(title)).length === 1, { timeoutMsg: `no "${title}" modal opened` });
  await browser.executeObsidian(
    ({ app }, wanted, text) => {
      const modal = [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === wanted);
      const input = modal?.querySelector<HTMLInputElement>("input");
      if (input === null || input === undefined) throw new Error(`the "${wanted}" modal has no text field`);
      input.value = text;
      input.dispatchEvent(new Event("input"));
    },
    title,
    value,
  );
}

/** Waits until a notice recorded on the current device holds `text`. */
async function waitForNotice(text: string): Promise<void> {
  await browser.waitUntil(async () => (await notices()).some((shown) => shown.includes(text)), {
    timeoutMsg: `no notice said ${JSON.stringify(text)}: ${JSON.stringify(await notices())}`,
  });
}

/** Runs the Sync now command on the current device. */
function syncNow() {
  return browser.executeObsidian(({ app }, id) => {
    (app as unknown as { commands: { executeCommandById(command: string): boolean } }).commands.executeCommandById(`${id}:sync-now`);
  }, pluginId);
}

/** Waits until the current device's sync status is `state`. */
async function waitForState(device: Device, state: string): Promise<void> {
  await use(device);
  await browser.waitUntil(async () => (await syncStatus())?.state === state, {
    timeout: 60_000,
    timeoutMsg: `${device.name} never showed ${state}: ${JSON.stringify(await syncStatus())}`,
  });
}

/** Stops syncing the connected vault on the current device. */
function disconnect() {
  return browser.executeObsidian(async ({ app }, id) => {
    await (app as unknown as Plugins).plugins.plugins[id]?.disconnectVault();
  }, pluginId);
}

/** The member list of the connected vault on the current device (an owner's): each member's display name and role. */
function members() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    const sharing = await plugin.loadSharing();
    if (sharing.kind !== "owner") throw new Error(`not an owner: ${sharing.kind}`);
    return sharing.members.map((member) => ({ name: member.label.replace(/[⁦-⁩]/gu, ""), role: member.role }));
  }, pluginId);
}

/** The text of the file at `path` on the current device, read from disk: it may be in a dot folder Obsidian does not index. Null if there is none. */
function diskText(filePath: string) {
  return browser.executeObsidian(async ({ app }, target) => ((await app.vault.adapter.exists(target)) ? app.vault.adapter.read(target) : null), filePath);
}

/**
 * Has `inviter` (an owner) invite `device`'s user with `role`, and joins
 * with the code on `device`, which first disconnects the vault it lost
 * access to. Waits until `device` synced.
 */
async function joinAgain(device: Device, inviter: Device, role: VaultRole): Promise<void> {
  await use(inviter);
  const vaultId = await connectedVaultId();
  const { code } = await invite(role);
  await use(device);
  await disconnect();
  await join(code);
  await answerModal("Connect a vault that has files?", "Connect and combine");
  await browser.waitUntil(async () => (await connectedVaultId()) === vaultId, { timeoutMsg: `${device.name} never connected the vault again` });
  await closeSettings();
  await browser.waitUntil(
    async () => {
      const status = await syncStatus();
      return status?.state === "idle" && status.pending === 0;
    },
    { timeout: 90_000, timeoutMsg: `${device.name} never synced after joining again: ${JSON.stringify(await syncStatus())}` },
  );
}

/**
 * Checks that `device` lost access to the vault the way docs/design/sharing.md
 * says: its status and settings show `shown`, it keeps `files`, and it no
 * longer syncs: a note the owner on `owner` writes does not reach it, and a
 * note it writes is not uploaded.
 */
async function checkAccessLost(scenario: string, device: Device, owner: Device, state: "not-member" | "vault-deleted", shown: string, files: Record<string, string>, owners: "live" | "none"): Promise<void> {
  await waitForState(device, state);
  expect(await browser.executeObsidian(() => document.querySelector(".vault-sync-status")?.textContent ?? null)).toMatch(new RegExp(`^(Vault Sync: ${shown}|null)$`, "u"));
  await openSharing();
  expect(await settingsText()).toContain(shown === "vault deleted" ? "An owner deleted this vault, so it cannot sync." : "You are no longer a member of this vault, so it cannot sync.");
  await closeSettings();
  expect(await vaultFiles()).toEqual(files);

  const marker = `${scenario} ${device.name} after losing access.md`;
  await writeNote(marker, "written after losing access\n");
  if (owners === "live") {
    await use(owner);
    await writeNote(`For ${marker}`, "the owner's note after the loss\n");
    await waitForServer(owner, (heads) => heads[`For ${marker}`] !== undefined, "the owner's note after the loss");
  }
  await use(device);
  await syncNow();
  await waitForState(device, state);
  expect(await fileText(`For ${marker}`)).toBeNull();
  expect(await fileText(marker)).toBe("written after losing access\n");
  if (owners === "live") {
    await use(owner);
    expect((await serverHeads())[marker]).toBeUndefined();
  }
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

  it("[P3-06] a viewer's notes open read-only, with a banner; editing in Obsidian is blocked, and nothing is uploaded", async function () {
    await use(a);
    await setMemberRole(VaultRole.VIEWER);
    await writeNote("For the viewer.md", "the owner's note for the viewer\n");
    await waitForText(b, "For the viewer.md", "the owner's note for the viewer\n");

    await use(b);
    await openNote("Shared.md");
    await browser.waitUntil(viewerBannerShown, { timeout: 60_000, timeoutMsg: "the viewer's note never showed the banner" });
    expect(await browser.executeObsidian(() => document.querySelector(".vault-sync-viewer-banner")?.textContent)).toContain("shared with you as a viewer");
    const shared = await fileText("Shared.md");
    const before = await serverHeads();

    // The note is in reading view, and its editor takes no input.
    const editor = () =>
      browser.executeObsidian(({ app }) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as { getMode?(): string; editor?: { cm?: { state: { readOnly: boolean }; contentDOM: HTMLElement } } } | undefined;
        return { mode: view?.getMode?.() ?? null, readOnly: view?.editor?.cm?.state.readOnly ?? null };
      });
    await browser.waitUntil(async () => (await editor()).mode === "preview", { timeoutMsg: `the viewer's note never opened in reading view: ${JSON.stringify(await editor())}` });
    expect(await editor()).toEqual({ mode: "preview", readOnly: true });
    await browser.executeObsidian(({ app }) => {
      (app.workspace.getMostRecentLeaf()?.view as unknown as { editor?: { cm?: { contentDOM: HTMLElement } } } | undefined)?.editor?.cm?.contentDOM.focus();
    });
    await browser.keys("typed by the viewer");

    // Creating, renaming and deleting through Obsidian are refused with a notice.
    await recordNotices();
    await dismissNotices();
    const outcomes = await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getFileByPath("Shared.md");
      if (file === null) throw new Error("no Shared.md");
      const fileManager = app.fileManager as unknown as { createNewMarkdownFile?(folder: unknown, name: string): Promise<unknown> };
      const actions: Record<string, () => Promise<unknown>> = {
        rename: () => app.fileManager.renameFile(file, "Renamed by the viewer.md"),
        delete: () => app.fileManager.trashFile(file),
        create: () => fileManager.createNewMarkdownFile?.(app.vault.getRoot(), "Created by the viewer") ?? Promise.reject(new Error("no createNewMarkdownFile")),
      };
      const results: Record<string, string> = {};
      for (const [name, action] of Object.entries(actions)) {
        try {
          await action();
          results[name] = "done";
        } catch {
          results[name] = "refused";
        }
      }
      return results;
    });
    expect(outcomes).toEqual({ rename: "refused", delete: "refused", create: "refused" });
    await waitForNotice(viewerRefused);

    await waitForIdle(b);
    expect(await fileText("Shared.md")).toBe(shared);
    expect(await fileText("Renamed by the viewer.md")).toBeNull();
    expect(await fileText("Created by the viewer.md")).toBeNull();
    expect(await serverHeads()).toEqual(before);
  });

  it("[P3-07] a viewer's file changed outside Obsidian is not uploaded: the shared version is restored, and the viewer's version is kept in .vault-sync/local-copies/ with a notice", async function () {
    await use(b);
    const shared = await fileText("From the member.md");
    if (shared === null) throw new Error("the viewer has no From the member.md");
    const before = await serverHeads();
    const base = await callHarness("vaultBasePath");
    if (base === null) throw new Error("the viewer's vault has no base path");
    await recordNotices();
    await dismissNotices();

    await writeFile(path.join(base, "From the member.md"), "changed outside Obsidian by the viewer\n");

    await waitForNotice("so From the member.md was not synced. The shared version is restored, and your version is kept in ");
    const notice = (await notices()).find((text) => text.includes("so From the member.md was not synced"));
    const copy = /kept in (.*)\.$/u.exec(notice ?? "")?.[1];
    expect(copy).toMatch(/^\.vault-sync\/local-copies\/From the member( \d+)?\.md$/u);
    await waitForText(b, "From the member.md", shared);
    expect(await diskText(copy ?? "")).toBe("changed outside Obsidian by the viewer\n");

    await waitForIdle(b);
    expect(await serverHeads()).toEqual(before);
    // The local copy never syncs.
    await use(a);
    await writeNote("After the local copy.md", "the owner's note after the local copy\n");
    await waitForText(b, "After the local copy.md", "the owner's note after the local copy\n");
    await use(a);
    expect(await diskText(copy ?? "")).toBeNull();
    expect(Object.keys(await serverHeads()).filter((file) => file.includes("local-copies"))).toEqual([]);
  });

  it("[P3-09] a member leaves the vault from the plugin: their device stops syncing, keeps its files, and shows no longer a member", async function () {
    await use(b);
    const files = await vaultFiles();
    await openSharing();
    await clickSharingButton("Leave vault");
    await answerModal("Leave this vault?", "Leave vault");
    await closeSettings();

    await checkAccessLost("P3-09", b, a, "not-member", "no longer a member", files, "live");
    await use(a);
    expect(await members()).toEqual([{ name: ownerName, role: VaultRole.OWNER }]);
  });

  it("[P3-10] the last owner can't be demoted or leave, and is told why; promoting another member to owner, then leaving, works", async function () {
    await joinAgain(b, a, VaultRole.EDITOR);

    await use(a);
    await openSharing();
    await dismissNotices();
    await pickMemberRole(ownerName, VaultRole.EDITOR);
    await answerModal("Change this member's role?", "Change role");
    await waitForNotice(`could not change the role: ${lastOwner}`);
    await dismissNotices();
    await clickSharingButton("Leave vault");
    await answerModal("Leave this vault?", "Leave vault");
    await waitForNotice(`could not leave the vault: ${lastOwner}`);
    expect(await members()).toEqual(
      expect.arrayContaining([
        { name: ownerName, role: VaultRole.OWNER },
        { name: memberName, role: VaultRole.EDITOR },
      ]),
    );
    await closeSettings();
    await waitForIdle(a);

    // Ownership moves by promoting the member, then leaving.
    await openSharing();
    await pickMemberRole(memberName, VaultRole.OWNER);
    await answerModal("Change this member's role?", "Change role");
    await browser.waitUntil(async () => (await members()).every((member) => member.role === VaultRole.OWNER), { timeoutMsg: "the member was never made an owner" });
    const files = await vaultFiles();
    await clickSharingButton("Leave vault");
    await answerModal("Leave this vault?", "Leave vault");
    await closeSettings();
    await checkAccessLost("P3-10", a, b, "not-member", "no longer a member", files, "live");

    await use(b);
    expect(await members()).toEqual([{ name: memberName, role: VaultRole.OWNER }]);
    await writeNote("The new owner's.md", "written by the new owner\n");
    await waitForServer(b, (heads) => heads["The new owner's.md"] === contentOf("written by the new owner\n"), "the new owner's note");
  });

  it("[P3-12] an owner deletes the vault after typing its name: every member's device stops syncing, keeps its files, and shows vault deleted", async function () {
    // The user who left in P3-10 joins again, so the vault has two members.
    await joinAgain(a, b, VaultRole.EDITOR);
    await converged(a, b);
    await use(a);
    const memberFiles = await vaultFiles();
    await use(b);
    const ownerFiles = await vaultFiles();

    await openSharing();
    await clickSharingButton("Delete vault");
    // The confirmation works only once the vault's name is typed.
    await browser.waitUntil(async () => (await modals("Delete this vault?")).length === 1, { timeoutMsg: "no delete confirmation opened" });
    const confirmEnabled = () =>
      browser.executeObsidian(({ app }) => {
        const modal = [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === "Delete this vault?");
        const button = [...(modal?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === "Delete vault");
        if (button === undefined) throw new Error("the delete confirmation has no Delete vault button");
        return !button.disabled;
      });
    expect(await confirmEnabled()).toBe(false);
    await typeInModal("Delete this vault?", "e2e shared");
    expect(await confirmEnabled()).toBe(false);
    await typeInModal("Delete this vault?", remoteVaultName);
    expect(await confirmEnabled()).toBe(true);
    await answerModal("Delete this vault?", "Delete vault");
    await closeSettings();

    await checkAccessLost("P3-12", b, a, "vault-deleted", "vault deleted", ownerFiles, "none");
    await use(a);
    await syncNow();
    await checkAccessLost("P3-12", a, b, "vault-deleted", "vault deleted", memberFiles, "none");
  });
  it("[P3-08] an owner removes a member: within one sync cycle the member's device stops syncing, keeps its files, and shows no longer a member", async function () {
    // A new vault of the user who owns the deleted one, joined by the other user.
    await use(b);
    await browser.executeObsidian(
      async ({ app }, id, name) => {
        const plugin = (app as unknown as Plugins).plugins.plugins[id];
        if (plugin === undefined) throw new Error("vault-sync is not loaded");
        await plugin.disconnectVault();
        await plugin.connectVault(await plugin.createRemoteVault(name), true);
      },
      pluginId,
      secondVaultName,
    );
    await waitForIdle(b);
    await joinAgain(a, b, VaultRole.EDITOR);
    await converged(a, b);
    await use(a);
    const files = await vaultFiles();

    await use(b);
    await openSharing();
    await browser.executeObsidian(({ app }, removed) => {
      const rows = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll(".vault-sync-members .setting-item") ?? [];
      const row = [...rows].find((candidate) => candidate.querySelector(".setting-item-name")?.textContent.replace(/[⁦-⁩]/gu, "") === removed);
      const button = [...(row?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === "Remove");
      if (button === undefined) throw new Error(`no Remove button for ${removed}`);
      button.click();
    }, ownerName);
    await answerModal("Remove this member?", "Remove member");
    await browser.waitUntil(async () => (await members()).length === 1, { timeoutMsg: "the member was never removed" });
    await closeSettings();

    // The removed member's next sync cycle finds the membership gone.
    await use(a);
    await syncNow();
    await checkAccessLost("P3-08", a, b, "not-member", "no longer a member", files, "live");
  });

  it("[P3-11] after every other member is removed, the vault keeps working as a normal single-user vault", async function () {
    await use(b);
    expect(await members()).toEqual([{ name: memberName, role: VaultRole.OWNER }]);
    await writeNote("Alone again.md", "a note in the vault with one member\n");
    await writeNote("Shared.md", "edited by the only member\n");
    await waitForServer(b, (heads) => heads["Alone again.md"] === contentOf("a note in the vault with one member\n") && heads["Shared.md"] === contentOf("edited by the only member\n"), "the only member's notes");
    await waitForIdle(b);
    expect((await syncStatus())?.state).toBe("idle");
    const history = await historyRows("Shared.md");
    expect(history[history.length - 1]).toContain(`“${memberName}”, this device · `);
  });
});
