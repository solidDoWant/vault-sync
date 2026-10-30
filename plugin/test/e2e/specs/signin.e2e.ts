import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { reloadPlugin } from "../obsidian";
import { closeSettings, openSettings } from "../settings-ui";
import { configure, dialog, isDialogOpen, issuerPost, signInResult, startSignIn } from "../signin";

// Signing in with the OAuth device flow inside real Obsidian (SPEC.md §9.1),
// against the harness-started server and the driver's fake OIDC issuer:
// the dialog shows the verification URL and user code, "the user" approves
// the code at the issuer, and the plugin stores the refresh token in
// Obsidian's device-local storage, never in data.json, and the identity
// provider that issued it in data.json. Access tokens are kept in memory
// only, so every check after a plugin reload goes through the refresh grant.

/** The outcome of ListVaults through the plugin's authenticated client. */
type CallResult = { ok: true; vaults: number } | { ok: false; code: number | null; message: string };

/** Connect's code for UNAUTHENTICATED. */
const unauthenticated = 16;

/** The identity provider the server advertises (the plugin's settings name none), stored with the refresh token at sign-in. */
const issuer = () => ({ issuer: e2eEnvironment.issuerUrl, clientId: e2eEnvironment.clientId });

/** Dismisses the sign-in dialog with Escape, as a user cancelling the sign-in does. */
function closeDialog() {
  return browser.keys("Escape");
}

/** The local storage key the plugin keeps the refresh token under. */
const refreshTokenKey = "vault-sync-refresh-token";

/**
 * The plugin's auth state and what it stored: whether local storage holds a
 * refresh token, and the identity provider in data.json. data.json must
 * never hold a refresh token.
 */
async function pluginStatus() {
  const status = await browser.executeObsidian(
    async ({ app }, id, key) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      const path = `${plugin.manifest.dir ?? ""}/data.json`;
      const stored = (await app.vault.adapter.exists(path)) ? (JSON.parse(await app.vault.adapter.read(path)) as Record<string, unknown>) : {};
      const local: unknown = app.loadLocalStorage(key);
      // Only whether a refresh token is stored: the token itself never leaves Obsidian.
      return {
        authState: plugin.authState,
        storedRefreshToken: typeof local === "string" && local !== "",
        storedIdentityProvider: stored.identityProvider ?? null,
        tokenInDataJson: "refreshToken" in stored,
        statusState: plugin.syncStatus.state,
      };
    },
    pluginId,
    refreshTokenKey,
  );
  const { tokenInDataJson, statusState, ...rest } = status;
  expect(tokenInDataJson).toBe(false);
  if (rest.authState === "sign-in-required") expect(statusState).toBe("sign-in-required");
  return rest;
}

/** Disables the plugin, runs `change` on the vault's local storage and data.json, and enables the plugin again; resolves whether it loaded. */
function withPluginDisabled(change: "move-token-to-data-json" | "clear-local-storage" | "restore-local-storage") {
  return browser.executeObsidian(
    async ({ app }, id, key, step) => {
      const registry = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin>; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> } }).plugins;
      const dir = registry.plugins[id]?.manifest.dir ?? "";
      await registry.disablePlugin(id);
      // The token is parked in the page, never handed to the test runner.
      const parked = window as unknown as { vaultSyncParkedToken?: unknown };
      if (step === "move-token-to-data-json") {
        const path = `${dir}/data.json`;
        const stored = JSON.parse(await app.vault.adapter.read(path)) as Record<string, unknown>;
        await app.vault.adapter.write(path, JSON.stringify({ ...stored, refreshToken: app.loadLocalStorage(key) as unknown }));
        app.saveLocalStorage(key, null);
      } else if (step === "clear-local-storage") {
        parked.vaultSyncParkedToken = app.loadLocalStorage(key);
        app.saveLocalStorage(key, null);
      } else {
        app.saveLocalStorage(key, parked.vaultSyncParkedToken ?? null);
        delete parked.vaultSyncParkedToken;
      }
      return registry.enablePlugin(id);
    },
    pluginId,
    refreshTokenKey,
    change,
  );
}

async function listVaults(): Promise<CallResult> {
  // Typed through unknown: the function's own return type is a Promise.
  const result: unknown = await browser.executeObsidian(async ({ app }, id): Promise<CallResult> => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    try {
      const response = await plugin.protocolClient().vaults.listVaults({});
      return { ok: true, vaults: response.vaults.length };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { ok: false, code: typeof code === "number" ? code : null, message: String(error) };
    }
  }, pluginId);
  return result as CallResult;
}

/**
 * vault-sync's settings tab as built now: the section headings outside the
 * Advanced group in order, whether that group is open, the headings inside
 * it, and the open state saved in the plugin's data.
 */
function settingsLayout(build = true) {
  return browser.executeObsidian(({ app }, id, rebuild) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    const tab = (plugin as unknown as { settingTab?: { containerEl: HTMLElement; display(): void } } | undefined)?.settingTab;
    if (plugin === undefined || tab === undefined) throw new Error("vault-sync has no settings tab");
    if (rebuild) tab.display();
    const advanced = tab.containerEl.querySelector<HTMLDetailsElement>("details.vault-sync-advanced");
    const headings = (within: Element | null, outside?: Element | null) =>
      [...(within?.querySelectorAll(".setting-item-heading") ?? [])].filter((heading) => outside === undefined || outside === null || !outside.contains(heading)).map((heading) => heading.querySelector(".setting-item-name")?.textContent ?? "");
    return {
      sections: headings(tab.containerEl, advanced),
      advanced: advanced?.querySelector("summary")?.textContent ?? null,
      advancedOpen: advanced?.open ?? null,
      advancedSections: headings(advanced),
      advancedFields: [...(advanced?.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name") ?? [])].map((name) => name.textContent),
      saved: (plugin as unknown as { data: { advancedSettingsOpen?: boolean } }).data.advancedSettingsOpen ?? null,
      lastChild: tab.containerEl.lastElementChild === advanced,
    };
  }, pluginId, build);
}

/** Clicks the Advanced group's toggle in the settings tab, as the user opens or closes it. */
function toggleAdvanced() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    const tab = (plugin as unknown as { settingTab?: { containerEl: HTMLElement } } | undefined)?.settingTab;
    const summary = tab?.containerEl.querySelector<HTMLElement>("details.vault-sync-advanced > summary");
    if (summary === null || summary === undefined) throw new Error("the settings tab has no Advanced group");
    summary.click();
  }, pluginId);
}

describe("signing in with the device flow", function () {
  before(async function () {
    // Only the server URL: the plugin takes the issuer and client id the
    // server advertises in GetServerInfo (#194). sync.e2e.ts enters them.
    await configure(e2eEnvironment.serverUrl, "", "");
  });

  it("starts signed out, and the server refuses the plugin's calls", async function () {
    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false, storedIdentityProvider: null });
    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
  });

  it("lays out the settings in setup order, the sync status first and the identity provider in a closed Advanced group", async function () {
    expect(await settingsLayout()).toEqual({
      sections: ["Sync", "Server", "Account"],
      advanced: "Advanced",
      advancedOpen: false,
      advancedSections: ["Identity provider"],
      advancedFields: ["OIDC issuer URL", "OIDC client ID"],
      saved: null,
      lastChild: true,
    });
  });

  it("shows the verification URL and user code, and stores the refresh token once the user approves", async function () {
    await startSignIn();

    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    const shown = await dialog();
    expect(shown?.linkText).toBe(`${e2eEnvironment.issuerUrl}/device`);
    expect(shown?.href).toBe(`${e2eEnvironment.issuerUrl}/device?user_code=${shown?.userCode ?? ""}`);
    // Still polling: nothing is stored before the user approves.
    expect(await signInResult()).toBeNull();
    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false, storedIdentityProvider: null });

    // The user enters the code at the identity provider.
    expect(await issuerPost("/device/approve", { user_code: shown?.userCode ?? "" })).toBe(204);

    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });
    expect(await signInResult()).toBe(true);
    // The dialog closes (on mobile after a closing animation, so wait for it).
    await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the sign-in dialog stayed open" });
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("stays signed in across a plugin reload, refreshing the access token with the stored refresh token", async function () {
    expect(await reloadPlugin(pluginId)).toBe(true);

    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("orders the signed-in sections by setup step, and remembers whether Advanced is open across reloads", async function () {
    const closed = await settingsLayout();
    expect(closed.sections).toEqual(["Sync", "Server", "Account", "End-to-end encryption", "Remote vault", "Devices"]);
    expect(closed.advancedOpen).toBe(false);
    expect(closed.lastChild).toBe(true);

    // Opened in the settings window, as the user does.
    await openSettings();
    await toggleAdvanced();
    await browser.waitUntil(async () => (await settingsLayout(false)).saved === true, { timeoutMsg: "opening Advanced was never saved" });
    expect(await reloadPlugin(pluginId)).toBe(true);
    expect(await settingsLayout()).toMatchObject({ advancedOpen: true, saved: true });

    await openSettings();
    await toggleAdvanced();
    await browser.waitUntil(async () => (await settingsLayout(false)).saved === null, { timeoutMsg: "closing Advanced was never saved" });
    expect(await reloadPlugin(pluginId)).toBe(true);
    expect(await settingsLayout()).toMatchObject({ advancedOpen: false, saved: null });
    await closeSettings();
  });

  it("moves a refresh token that data.json still holds to local storage on load, staying signed in", async function () {
    expect(await withPluginDisabled("move-token-to-data-json")).toBe(true);

    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("shows sign-in needed when local storage was cleared, and works again once the token is back", async function () {
    expect(await withPluginDisabled("clear-local-storage")).toBe(true);

    expect(await pluginStatus()).toEqual({ authState: "sign-in-required", storedRefreshToken: false, storedIdentityProvider: issuer() });
    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });

    expect(await withPluginDisabled("restore-local-storage")).toBe(true);
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("asks for a new sign-in once the refresh token is revoked, and can sign in again", async function () {
    expect(await issuerPost("/test/revoke-refresh-tokens")).toBe(204);
    // The access token is in memory only: after a reload the plugin must refresh.
    expect(await reloadPlugin(pluginId)).toBe(true);

    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
    expect(await pluginStatus()).toEqual({ authState: "sign-in-required", storedRefreshToken: false, storedIdentityProvider: null });

    // Cancelling a sign-in leaves the device needing one.
    await startSignIn();
    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    await closeDialog();
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the cancelled sign-in never finished" });
    expect(await signInResult()).toBe(false);
    expect(await pluginStatus()).toEqual({ authState: "sign-in-required", storedRefreshToken: false, storedIdentityProvider: null });

    await startSignIn();
    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    expect(await issuerPost("/device/approve", { user_code: (await dialog())?.userCode ?? "" })).toBe(204);
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });

    expect(await signInResult()).toBe(true);
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("refuses another sign-in while signed in, keeping the current session", async function () {
    // The last sign-in's dialog closes (on mobile after a closing animation).
    await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the previous sign-in dialog stayed open" });

    await startSignIn();
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the refused sign-in never finished" });

    expect(await signInResult()).toBe(false);
    expect(await isDialogOpen()).toBe(false);
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true, storedIdentityProvider: issuer() });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("forgets the tokens on sign-out", async function () {
    await browser.executeObsidian(async ({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      await plugin?.signOut();
    }, pluginId);

    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false, storedIdentityProvider: null });
    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
  });
});
