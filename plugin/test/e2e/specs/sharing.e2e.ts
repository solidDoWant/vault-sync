import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { VaultRole } from "../../../src/gen/vaultsync/v1/types_pb";
import { e2eEnvironment, pluginId } from "../environment";
import { configure, signInAs } from "../signin";

// The settings' Sharing section and joining by invite code (#34), driven
// through the settings UI in a real Obsidian against the real server. The
// owner signs in as this spec's own user, creates a vault and manages it;
// the e2e test token's user (another account) redeems codes over Connect
// JSON from here, standing in for an invited person; a third account joins
// from a second Obsidian vault with a code typed into the settings.

const ownerSubject = "plugin-e2e-sharing-owner";
const joinerSubject = "plugin-e2e-sharing-joiner";
const vaultName = "e2e sharing";

interface Row {
  name: string;
  description: string;
  buttons: string[];
  /** The row's dropdown value, or null when it has none. */
  select: string | null;
}

type SettingsApp = { setting: { activeTab?: { containerEl: HTMLElement }; open(): void; openTabById(id: string): void; close(): void } };

/** The sync status of vault-sync in the running Obsidian. */
function syncStatus() {
  return browser.executeObsidian(({ app }, id) => {
    const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (target === undefined) throw new Error("vault-sync is not loaded");
    return target.syncStatus;
  }, pluginId);
}

/** The vault this Obsidian vault is connected to, or null. */
function connectedVault() {
  return browser.executeObsidian(({ app }, id) => {
    const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (target === undefined) throw new Error("vault-sync is not loaded");
    return target.data.vault === undefined ? null : { id: target.data.vault.id, name: target.data.vault.name };
  }, pluginId);
}

/** Creates a vault on the server, connects this vault to it and returns its id. */
function createAndConnect(name: string) {
  return browser.executeObsidian(
    async ({ app }, id, vaultName) => {
      const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (target === undefined) throw new Error("vault-sync is not loaded");
      const vault = await target.createRemoteVault(vaultName);
      if ((await target.connectVault(vault)) !== "connected") throw new Error("the new vault was not connected");
      return vault.id;
    },
    pluginId,
    name,
  );
}

/** The ids of the vaults the signed-in user is a member of. */
function remoteVaultIds() {
  return browser.executeObsidian(async ({ app }, id) => {
    const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (target === undefined) throw new Error("vault-sync is not loaded");
    return (await target.listRemoteVaults()).map((vault) => vault.id);
  }, pluginId);
}

/** Renders vault-sync's settings tab again, which reads the Sharing section from the server. */
function renderSettings() {
  return browser.executeObsidian(({ app }, id) => {
    const target = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    const tab = (target as unknown as { settingTab?: { display(): void } } | undefined)?.settingTab;
    if (tab === undefined) throw new Error("vault-sync has no settings tab");
    tab.display();
  }, pluginId);
}

function openSettings() {
  return browser.executeObsidian(({ app }, id) => {
    const setting = (app as unknown as SettingsApp).setting;
    setting.open();
    setting.openTabById(id);
  }, pluginId);
}

/** The setting rows inside the open settings tab's element matching `selector`. */
function rows(selector: string): Promise<Row[]> {
  return browser.executeObsidian(({ app }, within) => {
    const container = (app as unknown as SettingsApp).setting.activeTab?.containerEl;
    return [...(container?.querySelectorAll(`${within} .setting-item`) ?? [])].map((item) => ({
      name: item.querySelector(".setting-item-name")?.textContent ?? "",
      description: item.querySelector(".setting-item-description")?.textContent ?? "",
      buttons: [...item.querySelectorAll(".setting-item-control button")].map((button) => button.textContent),
      select: item.querySelector("select")?.value ?? null,
    }));
  }, selector);
}

/** The text of the Sharing section's role line, or null while it is not shown. */
function roleLine(): Promise<string | null> {
  return browser.executeObsidian(({ app }) => (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelector(".vault-sync-sharing-role .setting-item-description")?.textContent ?? null);
}

/** Clicks the button labelled `text` in the `index`th row matching `selector`. */
function clickButton(selector: string, index: number, text: string) {
  return browser.executeObsidian(
    ({ app }, within, at, label) => {
      const item = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll(`${within} .setting-item`)[at];
      const button = [...(item?.querySelectorAll<HTMLButtonElement>(".setting-item-control button") ?? [])].find((candidate) => candidate.textContent === label);
      if (button === undefined) throw new Error(`no ${label} button in row ${String(at)} of ${within}`);
      button.click();
    },
    selector,
    index,
    text,
  );
}

/** Chooses `value` in the dropdown of the `index`th row matching `selector`, as the user does. */
function choose(selector: string, index: number, value: string) {
  return browser.executeObsidian(
    ({ app }, within, at, option) => {
      const select = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelectorAll(`${within} .setting-item`)[at]?.querySelector("select");
      if (select === null || select === undefined) throw new Error(`no dropdown in row ${String(at)} of ${within}`);
      select.value = option;
      select.dispatchEvent(new Event("change"));
    },
    selector,
    index,
    value,
  );
}

/** Types `value` into the text field of the first row matching `selector`. */
function type(selector: string, value: string) {
  return browser.executeObsidian(
    ({ app }, within, text) => {
      const input = (app as unknown as SettingsApp).setting.activeTab?.containerEl.querySelector<HTMLInputElement>(`${within} input[type=text]`);
      if (input === null || input === undefined) throw new Error(`no text field in ${within}`);
      input.value = text;
      input.dispatchEvent(new Event("input"));
    },
    selector,
    value,
  );
}

/** The open modals titled `title`: their texts. */
function modals(title: string): Promise<string[]> {
  return browser.executeObsidian(
    ({ app }, wanted) =>
      [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")]
        .filter((modal) => modal.querySelector(".modal-title")?.textContent === wanted)
        .map((modal) => modal.textContent),
    title,
  );
}

/** Clicks `text` in the open modal titled `title`, and waits for the modal to close. */
async function answerModal(title: string, text: string): Promise<void> {
  await browser.waitUntil(async () => (await modals(title)).length === 1, { timeoutMsg: `no "${title}" modal opened` });
  await browser.executeObsidian(
    ({ app }, wanted, label) => {
      const modal = [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === wanted);
      const button = [...(modal?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === label);
      if (button === undefined) throw new Error(`the "${wanted}" modal has no ${label} button`);
      button.click();
    },
    title,
    text,
  );
  // In mobile mode Obsidian removes a modal only after an animation.
  await browser.waitUntil(async () => (await modals(title)).length === 0, { timeoutMsg: `the "${title}" modal never closed` });
}

/** The code and buttons of the open "Invitation created" modal, or null while none is open. */
function inviteModal(): Promise<{ code: string; buttons: string[] } | null> {
  return browser.executeObsidian(({ app }) => {
    const modal = [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === "Invitation created");
    const code = modal?.querySelector(".vault-sync-invite-code")?.textContent;
    if (modal === undefined || code === undefined) return null;
    return { code, buttons: [...modal.querySelectorAll("button")].map((button) => button.textContent) };
  });
}

/** Creates an invitation for `role` in the settings and returns the code its modal shows once. */
async function createInvitation(role: VaultRole, days: string): Promise<string> {
  await choose(".vault-sync-invite", 0, String(role));
  await type(".vault-sync-invite", days);
  await clickButton(".vault-sync-invite", 0, "Create invitation");
  await browser.waitUntil(async () => (await inviteModal()) !== null, { timeoutMsg: "no invite code was shown" });
  const shown = await inviteModal();
  expect(shown?.buttons).toEqual(["Copy code", "Done"]);
  await answerModal("Invitation created", "Done");
  return shown?.code ?? "";
}

/** Records the text of every notice shown from now on. */
function recordNotices() {
  return browser.executeObsidian(({ app }) => {
    const state = window as unknown as { vaultSyncNotices?: Set<Element> };
    if (state.vaultSyncNotices !== undefined) return;
    const shown = new Set<Element>();
    state.vaultSyncNotices = shown;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".notice")) shown.add(node);
          for (const notice of node.querySelectorAll(".notice")) shown.add(notice);
        }
      }
    });
    for (const shownIn of new Set([document, (app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document])) observer.observe(shownIn.body, { childList: true, subtree: true });
  });
}

async function notices(): Promise<string[]> {
  return (await browser.executeObsidian(() => [...((window as unknown as { vaultSyncNotices?: Set<Element> }).vaultSyncNotices ?? [])].map((notice) => notice.textContent))).filter((text) => text !== "");
}

/** Calls a MembershipService procedure as the e2e test token's user (Connect JSON) and returns the HTTP status. */
async function asTestUser(procedure: string, body: Record<string, string>): Promise<number> {
  const response = await fetch(`${e2eEnvironment.serverUrl}/vaultsync.v1.MembershipService/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${e2eEnvironment.token}` },
    body: JSON.stringify(body),
  });
  return response.status;
}

async function waitForIdle(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const status = await syncStatus();
      return status.state === "idle" && status.pending === 0;
    },
    { timeoutMsg: "sync never became idle" },
  );
}

describe("sharing a vault from the settings", function () {
  let vaultId = "";

  afterEach(async function () {
    await browser.executeObsidian(({ app }) => {
      (app as unknown as SettingsApp).setting.close();
    });
  });

  after(async function () {
    // The test token's user must leave no membership behind for later specs (smoke.e2e.ts expects none).
    if (vaultId !== "") await asTestUser("LeaveVault", { vaultId });
  });

  it("lets an owner invite, revoke, change roles and remove members, and refuses demoting the last owner", async function () {
    await configure();
    expect(await signInAs(ownerSubject)).toBe(true);
    vaultId = await createAndConnect(vaultName);
    await waitForIdle();
    await openSettings();
    await recordNotices();

    // The owner's view: their role, the members (only them) and no invitations.
    await browser.waitUntil(async () => (await rows(".vault-sync-members")).length === 1, { timeoutMsg: "the member list never showed" });
    expect(await roleLine()).toMatch(/^Your role: Owner\./u);
    expect((await rows(".vault-sync-members")).map((row) => [row.select, row.buttons])).toEqual([[String(VaultRole.OWNER), ["Remove"]]]);
    expect((await rows(".vault-sync-members"))[0]?.description).toMatch(/^Owner\. Joined /u);
    expect((await rows(".vault-sync-invitations")).map((row) => row.description)).toEqual(["No pending invitations."]);

    // Two invitations, each shown once with Copy code; both are pending.
    const editorCode = await createInvitation(VaultRole.EDITOR, "");
    const viewerCode = await createInvitation(VaultRole.VIEWER, "2");
    expect(editorCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(viewerCode).not.toBe(editorCode);
    await browser.waitUntil(async () => (await rows(".vault-sync-invitations")).length === 2, { timeoutMsg: "the invitations never appeared in the pending list" });
    const pending = await rows(".vault-sync-invitations");
    expect(pending.map((row) => [row.name, row.buttons])).toEqual([
      ["Editor invitation", ["Revoke"]],
      ["Viewer invitation", ["Revoke"]],
    ]);
    expect(pending.every((row) => /Expires /u.test(row.description))).toBe(true);
    expect(pending.some((row) => row.description.includes(editorCode))).toBe(false);

    // Revoked, the viewer code no longer works; the editor code does.
    await clickButton(".vault-sync-invitations", 1, "Revoke");
    await browser.waitUntil(async () => (await rows(".vault-sync-invitations")).length === 1, { timeoutMsg: "the revoked invitation stayed listed" });
    expect(await asTestUser("RedeemInvitation", { code: viewerCode })).toBe(404);
    expect(await asTestUser("RedeemInvitation", { code: editorCode })).toBe(200);

    // The new member shows once the section is read again.
    await renderSettings();
    await browser.waitUntil(async () => (await rows(".vault-sync-members")).length === 2, { timeoutMsg: "the new member never showed" });
    expect((await rows(".vault-sync-members")).map((row) => row.select)).toEqual([String(VaultRole.OWNER), String(VaultRole.EDITOR)]);
    expect((await rows(".vault-sync-invitations")).map((row) => row.description)).toEqual(["No pending invitations."]);

    // A role change waits for the confirmation; cancelled, nothing changes.
    await choose(".vault-sync-members", 1, String(VaultRole.VIEWER));
    await answerModal("Change this member's role?", "Cancel");
    await browser.waitUntil(async () => (await rows(".vault-sync-members"))[1]?.select === String(VaultRole.EDITOR), { timeoutMsg: "the cancelled role change stayed in the dropdown" });
    await choose(".vault-sync-members", 1, String(VaultRole.VIEWER));
    await answerModal("Change this member's role?", "Change role");
    await browser.waitUntil(async () => (await rows(".vault-sync-members"))[1]?.description.startsWith("Viewer.") === true, { timeoutMsg: "the role change never showed" });

    // Demoting the last owner: the server refuses, a notice says why, and the list is as it was.
    await choose(".vault-sync-members", 0, String(VaultRole.EDITOR));
    await answerModal("Change this member's role?", "Change role");
    await browser.waitUntil(async () => (await notices()).some((text) => text.includes("could not change the role: A vault must keep at least one owner")), {
      timeoutMsg: "no notice said the last owner cannot be demoted",
    });
    await browser.waitUntil(async () => (await rows(".vault-sync-members"))[0]?.select === String(VaultRole.OWNER), { timeoutMsg: "the refused demotion stayed in the dropdown" });
    expect((await rows(".vault-sync-members")).map((row) => row.description.split(" ")[0])).toEqual(["Owner.", "Viewer."]);

    // Removing a member, after the confirmation.
    await clickButton(".vault-sync-members", 1, "Remove");
    await answerModal("Remove this member?", "Remove member");
    await browser.waitUntil(async () => (await rows(".vault-sync-members")).length === 1, { timeoutMsg: "the removed member stayed listed" });
    expect(await asTestUser("LeaveVault", { vaultId })).toBe(404);
  });

  it("joins a vault with an invite code from another Obsidian vault, after refusing an unusable code", async function () {
    await openSettings();
    await browser.waitUntil(async () => (await rows(".vault-sync-invite")).length === 1, { timeoutMsg: "the invite row never showed" });
    const code = await createInvitation(VaultRole.EDITOR, "");

    await browser.reloadObsidian({ vault: "./test/e2e/vaults/second" });
    await configure();
    expect(await signInAs(joinerSubject)).toBe(true);
    await openSettings();
    await recordNotices();
    await browser.waitUntil(async () => (await rows(".vault-sync-join")).length === 1, { timeoutMsg: "the join row never showed" });
    // No vault connected: no Sharing section.
    expect(await roleLine()).toBeNull();

    // An unusable code: one message, and nothing is connected.
    await type(".vault-sync-join", "not-a-real-invite-code");
    await clickButton(".vault-sync-join", 0, "Join");
    await browser.waitUntil(async () => (await notices()).some((text) => text.includes("could not join: This invite code is invalid, has expired or was already used.")), {
      timeoutMsg: "no notice said the invite code is unusable",
    });
    expect(await connectedVault()).toBeNull();

    // The real code: both vaults have files, so the combine confirmation comes first.
    await type(".vault-sync-join", code);
    await clickButton(".vault-sync-join", 0, "Join");
    await answerModal("Connect a vault that has files?", "Connect and combine");
    await browser.waitUntil(async () => (await connectedVault())?.id === vaultId, { timeoutMsg: "the joined vault was never connected" });
    await waitForIdle();
    expect((await connectedVault())?.name).toBe(vaultName);

    // An editor's Sharing section: their role and Leave vault, no management controls.
    await openSettings();
    await browser.waitUntil(async () => (await roleLine()) !== null, { timeoutMsg: "the Sharing section never showed the role" });
    expect(await roleLine()).toMatch(/^Your role: Editor\./u);
    expect(await rows(".vault-sync-sharing")).toEqual([expect.objectContaining({ name: "Leave vault", buttons: ["Leave vault"] }) as unknown as Row]);

    // The same code again: already used.
    expect(await asTestUser("RedeemInvitation", { code })).toBe(404);

    // Leaving disconnects this vault and ends the membership.
    await clickButton(".vault-sync-sharing", 0, "Leave vault");
    await answerModal("Leave this vault?", "Leave vault");
    await browser.waitUntil(async () => (await connectedVault()) === null, { timeoutMsg: "leaving never disconnected the vault" });
    expect(await remoteVaultIds()).toEqual([]);
  });
});
