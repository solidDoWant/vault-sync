import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { currentDevice, waitForIdle, writeNote, type Device } from "../devices";
import { e2eEnvironment, pluginId } from "../environment";
import { closeSettings, modals, openSettings, type SettingsApp } from "../settings-ui";
import { configure, signInAs } from "../signin";

// An escrow reset end to end (docs/design/encryption.md, "Escrow fingerprint
// and escrow reset"; docs/admin/encryption.md, "Reset the escrow chain"). The
// e2e driver runs a second server with an escrow key, and does the admin's
// steps when asked (e2e_escrow_test.go): the signing key of the escrow key is
// lost, so the admin runs `export reset-escrow` to a new key pair and
// restarts the server on it. The vault's owner compares the fingerprints,
// accepts the new key in the plugin, and the owner's next key rotation adopts
// it in the vault's log. Then `export rotate-escrow` moves the vault's older escrow slots to
// the new key, and an export with the new identity alone, the old one
// destroyed, reads the whole vault.

const ownerSubject = "plugin-e2e-escrow-owner";
const passphrase = "correct horse battery staple escrow e2e";
const vaultName = "e2e escrow reset";
const resetTitle = "The server's escrow key changed";
const acceptLabel = "Accept the new escrow key";

const notes = {
  "Diary.md": "# Diary\n\nOnly escrow brings this back.\n",
  "Taxes/return.md": "- refund owed\n",
};

type Plugins = { plugins: { plugins: Record<string, VaultSyncPlugin> } };

interface CommandResult {
  code: number;
  summary: Record<string, unknown>;
}

interface ExportResult extends CommandResult {
  /** The exported files, by vault id and path. */
  files: Record<string, Record<string, string> | undefined>;
}

/** Asks the e2e driver to run one of the admin's steps on the escrow server. */
async function admin<Result>(action: "reset" | "rotate" | "export", body: object = {}): Promise<Result> {
  const response = await fetch(`${escrowControlUrl()}/${action}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`the admin's ${action} step failed: ${text}`);
  return JSON.parse(text) as Result;
}

function escrowControlUrl(): string {
  const url = process.env.VAULT_SYNC_E2E_ESCROW_CONTROL_URL;
  if (url === undefined || url === "") throw new Error("VAULT_SYNC_E2E_ESCROW_CONTROL_URL is not set; run the e2e suite with `make test-e2e`");
  return url;
}

function escrowServerUrl(): string {
  const url = process.env.VAULT_SYNC_E2E_ESCROW_SERVER_URL;
  if (url === undefined || url === "") throw new Error("VAULT_SYNC_E2E_ESCROW_SERVER_URL is not set; run the e2e suite with `make test-e2e`");
  return url;
}

/** Runs the export job with the named escrow identities in its identity file. */
function exportWith(...identities: ("old" | "new")[]): Promise<ExportResult> {
  return admin<ExportResult>("export", { identities });
}

/** Turns on encryption, creates a plaintext vault, connects this vault to it, and returns its id. */
function createVault(name: string, secret: string) {
  return browser.executeObsidian(
    async ({ app }, id, vault, words) => {
      const plugin = (app as unknown as Plugins).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      await plugin.enableEncryption(words);
      const created = await plugin.createRemoteVault(vault);
      if ((await plugin.connectVault(created)) !== "connected") throw new Error("the new vault was not connected");
      return created.id;
    },
    pluginId,
    name,
    secret,
  );
}

/**
 * Converts the connected vault to end-to-end encryption with escrow, as the
 * owner's Convert action does, and re-encrypts its history, so every note is
 * under an escrowed epoch.
 */
function convertWithEscrow() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    await plugin.convertVault(await plugin.conversionMembers(), true);
    await plugin.reencryptHistory();
  }, pluginId);
}

/** The owner's Rotate key action on the connected vault. */
function rotateVaultKey() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    await plugin.rotateVaultKey();
  }, pluginId);
}

/** The escrow key fingerprint the connected vault's verified log names, as its encryption details show it. */
function vaultEscrowFingerprint() {
  return browser.executeObsidian(async ({ app }, id) => {
    const plugin = (app as unknown as Plugins).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    const sharing = await plugin.loadSharing();
    return sharing.kind !== "not-member" && sharing.keys?.kind === "verified" ? (sharing.keys.escrow?.vault ?? null) : null;
  }, pluginId);
}

/** Types `value` into the text field of the open modal titled `title`, as the user does. */
function typeInModal(title: string, value: string) {
  return browser.executeObsidian(
    ({ app }, wanted, text) => {
      const shownIn = (app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document;
      const modal = [...shownIn.querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === wanted);
      const input = modal?.querySelector<HTMLInputElement>("input[type=text]");
      if (input === null || input === undefined) throw new Error(`the "${wanted}" modal has no text field`);
      input.value = text;
      input.dispatchEvent(new Event("input"));
    },
    title,
    value,
  );
}

/** Clicks the button labelled `label` in the open modal titled `title` when it is enabled, and resolves whether it was: null when there is no such button. */
function clickIfEnabled(title: string, label: string) {
  return browser.executeObsidian(
    ({ app }, wanted, text) => {
      const shownIn = (app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document;
      const modal = [...shownIn.querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === wanted);
      const button = [...(modal?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === text);
      if (button === undefined) return null;
      if (!button.disabled) button.click();
      return !button.disabled;
    },
    title,
    label,
  );
}

describe("Escrow reset", function () {
  let device: Device;
  let vaultId: string;

  before(async function () {
    // The escrow server is not reachable from the Android emulator: the
    // Android config maps only the main server's and the issuer's ports.
    // The export job runs only on Linux (its atomic directory swap uses
    // renameat2), and the driver runs it on the test host.
    if (e2eEnvironment.android || process.platform !== "linux") this.skip();
    device = await currentDevice("Owner laptop");
    await configure(escrowServerUrl());
    expect(await signInAs(ownerSubject)).toBe(true);
    // The plugin syncs only plaintext vaults so far: the notes sync first, then the owner converts the vault with escrow.
    vaultId = await createVault(vaultName, passphrase);
    for (const [path, text] of Object.entries(notes)) await writeNote(path, text);
    await waitForIdle(device);
    await convertWithEscrow();
  });

  after(async function () {
    if (e2eEnvironment.android || process.platform !== "linux") return;
    await closeSettings();
  });

  it("after a lost escrow signing key, the owner adopts the reset key and a new export reads the vault with the new key alone", async function () {
    // The export job reads the vault with the old escrow key.
    const before = await exportWith("old");
    expect(before.files[vaultId]).toMatchObject(notes);

    // The signing key of the escrow key is lost: the admin resets the escrow chain to a new key pair and restarts the server on it.
    const fingerprints = await admin<{ previous: string; current: string }>("reset");
    expect(fingerprints.current).not.toBe(fingerprints.previous);

    // Until the owner adopts the new key, the vault stays escrowed to the old one: the new identity alone does not read it.
    expect(await vaultEscrowFingerprint()).toBe(fingerprints.previous);
    const unread = (await exportWith("new")).files[vaultId] ?? {};
    expect(Object.keys(notes).filter((path) => path in unread)).toEqual([]);

    // The owner's settings show the reset prompt with both fingerprints, as the admin publishes them.
    await openSettings();
    await browser.waitUntil(async () => (await modals(resetTitle)).length === 1, { timeout: 30_000, timeoutMsg: "the escrow reset prompt never opened" });
    const [prompt] = await modals(resetTitle);
    expect(prompt).toContain(`Previous escrow key fingerprint: ${fingerprints.previous}`);
    expect(prompt).toContain(`New escrow key fingerprint: ${fingerprints.current}`);

    // A wrong group keeps Accept disabled; the new fingerprint's last group enables it.
    const lastGroup = fingerprints.current.split(" ").at(-1) ?? "";
    const previousGroup = fingerprints.previous.split(" ").at(-1) ?? "";
    await typeInModal(resetTitle, previousGroup === lastGroup ? "ZZZZ" : previousGroup);
    expect(await clickIfEnabled(resetTitle, acceptLabel)).toBe(false);
    await typeInModal(resetTitle, lastGroup.toLowerCase());
    expect(await clickIfEnabled(resetTitle, acceptLabel)).toBe(true);
    await browser.waitUntil(async () => (await modals(resetTitle)).length === 0, { timeoutMsg: "the escrow reset prompt never closed" });
    await closeSettings();

    // The owner's next key rotation adopts the new key in the vault's log.
    await rotateVaultKey();
    expect(await vaultEscrowFingerprint()).toBe(fingerprints.current);

    // The admin moves the vault's older escrow slots to the new key.
    const rotation = await admin<CommandResult>("rotate");
    expect(rotation.summary).toMatchObject({ status: "ok", old_key_slots: 0, failed_slots: 0 });
    expect(rotation.code).toBe(0);

    // The old identity is destroyed: an export with the new identity alone reads every note.
    const after = await exportWith("new");
    expect(after.summary).toMatchObject({ status: "ok" });
    expect(after.code).toBe(0);
    expect(after.files[vaultId]).toMatchObject(notes);
  });
});
