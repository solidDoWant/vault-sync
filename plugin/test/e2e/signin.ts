import { browser } from "@wdio/globals";

import type VaultSyncPlugin from "../../src/main";
import { e2eEnvironment, pluginId } from "./environment";

// Signing in through vault-sync's device flow inside Obsidian, for the specs
// that need a signed-in plugin (signin.e2e.ts, sync.e2e.ts).

/** Points vault-sync at the harness-started server and the fake issuer. */
export function configure(serverUrl = e2eEnvironment.serverUrl, issuer = e2eEnvironment.issuerUrl, clientId = e2eEnvironment.clientId) {
  return browser.executeObsidian(
    async ({ app }, id, values) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      plugin.data.serverUrl = values.serverUrl;
      plugin.data.oidcIssuer = values.issuer;
      plugin.data.oidcClientId = values.clientId;
      await plugin.saveSettings();
    },
    pluginId,
    { serverUrl, issuer, clientId },
  );
}

/** Starts a sign-in without waiting for it; its result lands in window.vaultSyncSignIn. */
export function startSignIn() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    const state = window as unknown as { vaultSyncSignIn?: boolean | string };
    delete state.vaultSyncSignIn;
    plugin.signIn().then(
      (result) => (state.vaultSyncSignIn = result),
      (error: unknown) => (state.vaultSyncSignIn = String(error)),
    );
  }, pluginId);
}

export function signInResult() {
  return browser.executeObsidian(() => (window as unknown as { vaultSyncSignIn?: boolean | string }).vaultSyncSignIn ?? null);
}

/** What the sign-in dialog shows, or null while it shows no code. */
export function dialog() {
  return browser.executeObsidian(() => {
    const code = document.querySelector(".vault-sync-user-code");
    const link = document.querySelector<HTMLAnchorElement>(".vault-sync-verification-uri");
    if (code === null || link === null) return null;
    return { userCode: code.textContent, linkText: link.textContent, href: link.getAttribute("href") };
  });
}

export function isDialogOpen() {
  return browser.executeObsidian(() => document.querySelector(".vault-sync-user-code, .vault-sync-sign-in-error") !== null);
}

/** POSTs a form to the fake issuer and returns the status. */
export async function issuerPost(path: string, form: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${e2eEnvironment.issuerUrl}${path}`, { method: "POST", body: new URLSearchParams(form) });
  return response.status;
}

/**
 * Signs in end to end: starts the device flow, approves its code at the
 * issuer as `subject` (the issuer's default user if omitted, standing in for
 * the user's browser), and waits for the plugin to finish.
 */
export async function signInAs(subject?: string): Promise<boolean | string | null> {
  await startSignIn();
  await browser.waitUntil(async () => (await dialog()) !== null, { timeoutMsg: "the sign-in dialog never showed a user code" });
  const status = await issuerPost("/device/approve", { user_code: (await dialog())?.userCode ?? "", ...(subject === undefined ? {} : { subject }) });
  if (status !== 204) throw new Error(`the issuer refused the approval with ${String(status)}`);
  await browser.waitUntil(async () => (await signInResult()) !== null, { timeoutMsg: "the sign-in never finished" });
  await browser.waitUntil(async () => !(await isDialogOpen()), { timeoutMsg: "the sign-in dialog stayed open" });
  return await signInResult();
}
