import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { e2eEnvironment, pluginId } from "../environment";
import { reloadPlugin } from "../obsidian";
import { configure, dialog, isDialogOpen, issuerPost, signInResult, startSignIn } from "../signin";

// Signing in with the OAuth device flow inside real Obsidian (SPEC.md §9.1),
// against the harness-started server and the driver's fake OIDC issuer:
// the dialog shows the verification URL and user code, "the user" approves
// the code at the issuer, and the plugin stores the refresh token in its
// plugin data. Access tokens are kept in memory only, so every check after a
// plugin reload goes through the refresh grant.

/** The outcome of ListVaults through the plugin's authenticated client. */
type CallResult = { ok: true; vaults: number } | { ok: false; code: number | null; message: string };

/** Connect's code for UNAUTHENTICATED. */
const unauthenticated = 16;

/** Dismisses the sign-in dialog with Escape, as a user cancelling the sign-in does. */
function closeDialog() {
  return browser.keys("Escape");
}

function pluginStatus() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    const path = `${plugin.manifest.dir ?? ""}/data.json`;
    const stored = (await app.vault.adapter.exists(path)) ? (JSON.parse(await app.vault.adapter.read(path)) as Record<string, unknown>) : {};
    return { authState: plugin.authState, storedRefreshToken: typeof stored.refreshToken === "string" && stored.refreshToken !== "" };
  }, pluginId);
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

describe("signing in with the device flow", function () {
  before(async function () {
    await configure(e2eEnvironment.serverUrl, e2eEnvironment.issuerUrl, e2eEnvironment.clientId);
  });

  it("starts signed out, and the server refuses the plugin's calls", async function () {
    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false });
    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
  });

  it("shows the verification URL and user code, and stores the refresh token once the user approves", async function () {
    await startSignIn();

    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    const shown = await dialog();
    expect(shown?.linkText).toBe(`${e2eEnvironment.issuerUrl}/device`);
    expect(shown?.href).toBe(`${e2eEnvironment.issuerUrl}/device?user_code=${shown?.userCode ?? ""}`);
    // Still polling: nothing is stored before the user approves.
    expect(await signInResult()).toBeNull();
    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false });

    // The user enters the code at the identity provider.
    expect(await issuerPost("/device/approve", { user_code: shown?.userCode ?? "" })).toBe(204);

    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });
    expect(await signInResult()).toBe(true);
    // The dialog closes (on mobile after a closing animation, so wait for it).
    await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the sign-in dialog stayed open" });
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("stays signed in across a plugin reload, refreshing the access token with the stored refresh token", async function () {
    expect(await reloadPlugin(pluginId)).toBe(true);

    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("asks for a new sign-in once the refresh token is revoked, and can sign in again", async function () {
    expect(await issuerPost("/test/revoke-refresh-tokens")).toBe(204);
    // The access token is in memory only: after a reload the plugin must refresh.
    expect(await reloadPlugin(pluginId)).toBe(true);

    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
    expect(await pluginStatus()).toEqual({ authState: "sign-in-required", storedRefreshToken: false });

    // Cancelling a sign-in leaves the device needing one.
    await startSignIn();
    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    await closeDialog();
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the cancelled sign-in never finished" });
    expect(await signInResult()).toBe(false);
    expect(await pluginStatus()).toEqual({ authState: "sign-in-required", storedRefreshToken: false });

    await startSignIn();
    await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
    expect(await issuerPost("/device/approve", { user_code: (await dialog())?.userCode ?? "" })).toBe(204);
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });

    expect(await signInResult()).toBe(true);
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("refuses another sign-in while signed in, keeping the current session", async function () {
    // The last sign-in's dialog closes (on mobile after a closing animation).
    await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the previous sign-in dialog stayed open" });

    await startSignIn();
    await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the refused sign-in never finished" });

    expect(await signInResult()).toBe(false);
    expect(await isDialogOpen()).toBe(false);
    expect(await pluginStatus()).toEqual({ authState: "signed-in", storedRefreshToken: true });
    expect(await listVaults()).toEqual({ ok: true, vaults: 0 });
  });

  it("forgets the tokens on sign-out", async function () {
    await browser.executeObsidian(async ({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      await plugin?.signOut();
    }, pluginId);

    expect(await pluginStatus()).toEqual({ authState: "signed-out", storedRefreshToken: false });
    expect(await listVaults()).toMatchObject({ ok: false, code: unauthenticated });
  });
});
