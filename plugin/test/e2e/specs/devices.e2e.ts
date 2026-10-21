import { browser, expect } from "@wdio/globals";

import type VaultSyncPlugin from "../../../src/main";
import { pluginId } from "../environment";
import { callHarness } from "../obsidian";
import { configure, signInAs } from "../signin";

// The settings device list's Remove (#590, #630): two registered devices;
// in this device's settings, remove the other one. A failed removal must
// show a notice and leave the button usable; one in flight must keep its
// button disabled, also after a re-render; the removal must send exactly
// one RemoveDevice and the reloaded list must no longer show the device.
// The harness fails or holds the RemoveDevice call (interceptRemoveDevice),
// so nothing here depends on timing. The user is this spec's own.

const subject = "plugin-e2e-devices-user";
const otherDeviceName = "e2e device to remove";

interface Row {
  name: string;
  description: string;
  /** The Remove button's state, or null when the row has none (this device). */
  button: { text: string; disabled: boolean } | null;
}

/** The rows of the open settings tab's device list, read from the tab's own element. */
function deviceRows(): Promise<Row[]> {
  return browser.executeObsidian(({ app }) =>
    [...((app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.querySelectorAll(".vault-sync-devices .setting-item") ?? [])].map((item) => {
      const button = item.querySelector<HTMLButtonElement>(".setting-item-control button");
      return {
        name: item.querySelector(".setting-item-name")?.textContent ?? "",
        description: item.querySelector(".setting-item-description")?.textContent ?? "",
        button: button === null ? null : { text: button.textContent, disabled: button.disabled },
      };
    }),
  );
}

// The list shows a device's name isolated (U+2068 … U+2069), so it cannot reorder the text around it.
async function rowNamed(name: string): Promise<Row | undefined> {
  return (await deviceRows()).find((row) => row.name === `\u2068${name}\u2069`);
}

function otherRow(): Promise<Row | undefined> {
  return rowNamed(otherDeviceName);
}

/** Lets vault-sync handle what the server or the harness answered meanwhile, so a check that something did not happen does not come too early. */
function settle() {
  return browser.executeObsidian(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
}

function openSettings() {
  return browser.executeObsidian(({ app }, id) => {
    const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(id);
  }, pluginId);
}

/** Clicks the Remove button of the named row (a disabled button ignores the click, as it does for the user). */
function clickRemove(name: string) {
  return browser.executeObsidian(({ app }, rowName) => {
    const items = (app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.querySelectorAll(".vault-sync-devices .setting-item") ?? [];
    const item = [...items].find((candidate) => candidate.querySelector(".setting-item-name")?.textContent === `\u2068${rowName}\u2069`);
    const button = item?.querySelector<HTMLButtonElement>(".setting-item-control button");
    if (button === undefined || button === null) throw new Error(`no Remove button in the row of ${rowName}`);
    button.click();
  }, name);
}

/** The open "Remove this device?" modals' texts. */
function confirmModals(): Promise<string[]> {
  return browser.executeObsidian(({ app }) =>
    [...((app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].filter((modal) => modal.querySelector(".modal-title")?.textContent === "Remove this device?").map((modal) => modal.textContent),
  );
}

/** Clicks "Remove device" in the open confirmation. */
async function confirmRemove(): Promise<void> {
  await browser.waitUntil(async () => (await confirmModals()).length === 1, { timeoutMsg: "the removal was never asked to be confirmed" });
  await browser.executeObsidian(({ app }) => {
    const modal = [...((app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")].find((candidate) => candidate.querySelector(".modal-title")?.textContent === "Remove this device?");
    const button = [...(modal?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === "Remove device");
    if (button === undefined) throw new Error("the confirmation has no Remove device button");
    button.click();
  });
  // The confirmation closes; in mobile mode Obsidian removes it only after an animation.
  await browser.waitUntil(async () => (await confirmModals()).length === 0, { timeoutMsg: "the confirmation never closed" });
}

/**
 * Records the text of every notice shown from now on, so a check cannot miss
 * one that Obsidian hid again before it looked.
 */
function recordNotices() {
  return browser.executeObsidian(({ app }) => {
    const state = window as unknown as { vaultSyncNotices?: Set<Element> };
    if (state.vaultSyncNotices !== undefined) return;
    const shown = new Set<Element>();
    state.vaultSyncNotices = shown;
    // Kept as elements, read when checked: a notice's text may be set after it is added.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".notice")) shown.add(node);
          for (const notice of node.querySelectorAll(".notice")) shown.add(notice);
        }
      }
    });
    for (const shownIn of new Set([document, (app as unknown as { setting: { activeTab?: { containerEl: HTMLElement } } }).setting.activeTab?.containerEl.ownerDocument ?? document])) observer.observe(shownIn.body, { childList: true, subtree: true });
  });
}

/** The notices shown since recordNotices that say a device could not be removed. */
async function removalFailedNotices(): Promise<number> {
  const shown = await browser.executeObsidian(() => [...((window as unknown as { vaultSyncNotices?: Set<Element> }).vaultSyncNotices ?? [])].map((notice) => notice.textContent));
  return shown.filter((notice) => notice.includes("could not remove the device")).length;
}

/** Renders vault-sync's settings tab again, as a status change does. */
function renderSettings() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    const tab = (plugin as unknown as { settingTab?: { display(): void } } | undefined)?.settingTab;
    if (tab === undefined) throw new Error("vault-sync has no settings tab");
    tab.display();
  }, pluginId);
}

function syncStatus() {
  return browser.executeObsidian(({ app }, id) => {
    const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    return plugin.syncStatus;
  }, pluginId);
}

describe("the settings device list", function () {
  afterEach(async function () {
    // An open settings window must not outlive the test that opened it, even when it failed.
    await browser.executeObsidian(({ app }) => {
      (app as unknown as { setting: { close(): void } }).setting.close();
    });
  });

  it("removes another device once, and keeps its Remove usable after a failed attempt", async function () {
    await configure();
    expect(await signInAs(subject)).toBe(true);
    // Connecting registers this device.
    const connected = await browser.executeObsidian(async ({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error("vault-sync is not loaded");
      return await plugin.connectVault(await plugin.createRemoteVault("e2e devices"));
    }, pluginId);
    expect(connected).toBe("connected");
    await browser.waitUntil(
      async () => {
        const status = await syncStatus();
        return status.state === "idle" && status.pending === 0;
      },
      { timeoutMsg: "sync never became idle" },
    );
    const thisDevice = await browser.executeObsidian(({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      return plugin?.data.device?.id ?? null;
    }, pluginId);
    expect(thisDevice).not.toBeNull();
    const otherDevice = await callHarness("registerAnotherDevice", otherDeviceName);
    expect((await callHarness("serverDeviceIds")).sort()).toEqual([thisDevice, otherDevice].sort());
    await callHarness("interceptRemoveDevice");

    await openSettings();
    await browser.waitUntil(async () => (await deviceRows()).length === 2, { timeoutMsg: "the device list never showed both devices" });
    // Once the settings are open: they, their modals and notices may be in a document of their own.
    await recordNotices();
    const rows = await deviceRows();
    expect(rows.filter((row) => row.button === null).map((row) => row.description)).toEqual([expect.stringMatching(/^This device\./u) as unknown as string]);
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: false });

    // A failed removal: the notice, and the button is enabled again.
    await callHarness("failNextRemoveDevice");
    await clickRemove(otherDeviceName);
    await confirmRemove();
    await browser.waitUntil(async () => (await removalFailedNotices()) === 1, {
      timeoutMsg: "no notice said the device could not be removed",
    });
    expect(await callHarness("removeDeviceCalls")).toEqual([{ deviceId: otherDevice, forwarded: false }]);
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: false });

    // A retry held at the harness: its button is disabled, also in a list
    // rendered again meanwhile, and a click there sends nothing. When it
    // fails, the list on screen shows the notice and a usable button.
    await callHarness("holdNextRemoveDevice");
    await clickRemove(otherDeviceName);
    await confirmRemove();
    await browser.waitUntil(async () => (await callHarness("removeDeviceCalls")).length === 2, { timeoutMsg: "the retry sent no RemoveDevice" });
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: true });
    await renderSettings();
    await browser.waitUntil(async () => (await deviceRows()).length === 2, { timeoutMsg: "the re-rendered device list never showed both devices" });
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: true });
    await clickRemove(otherDeviceName);
    expect(await confirmModals()).toEqual([]);
    expect(await callHarness("releaseRemoveDevice", true)).toBe(true);
    await browser.waitUntil(async () => (await removalFailedNotices()) === 2, {
      timeoutMsg: "no second notice said the device could not be removed",
    });
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: false });

    // Held again, the list rendered again, then sent: the server removes it
    // and the list on screen, reloaded, no longer shows it.
    await callHarness("holdNextRemoveDevice");
    await clickRemove(otherDeviceName);
    await confirmRemove();
    await browser.waitUntil(async () => (await callHarness("removeDeviceCalls")).length === 3, { timeoutMsg: "the last attempt sent no RemoveDevice" });
    await renderSettings();
    await browser.waitUntil(async () => (await deviceRows()).length === 2, { timeoutMsg: "the re-rendered device list never showed both devices" });
    expect((await otherRow())?.button).toEqual({ text: "Remove", disabled: true });
    expect(await callHarness("releaseRemoveDevice")).toBe(true);
    await browser.waitUntil(async () => (await deviceRows()).length === 1, { timeoutMsg: "the removed device's row never went away" });
    expect((await deviceRows()).map((row) => row.button)).toEqual([null]);
    expect(await callHarness("removeDeviceCalls")).toEqual([
      { deviceId: otherDevice, forwarded: false },
      { deviceId: otherDevice, forwarded: false },
      { deviceId: otherDevice, forwarded: true },
    ]);
    expect(await callHarness("serverDeviceIds")).toEqual([thisDevice]);
  });

  // Runs after the test above, signed in with this device the only one.
  it("does not let an older list repaint a removed device, and reloads nothing once the settings are closed (#634)", async function () {
    const thisDevice = await browser.executeObsidian(({ app }, id) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, VaultSyncPlugin> } }).plugins.plugins[id];
      return plugin?.data.device?.id ?? null;
    }, pluginId);
    expect(thisDevice).not.toBeNull();
    const staleName = "e2e device of a stale list";
    const closedName = "e2e device removed after closing";
    const stale = await callHarness("registerAnotherDevice", staleName);
    const closed = await callHarness("registerAnotherDevice", closedName);
    await callHarness("interceptRemoveDevice");
    await openSettings();
    await browser.waitUntil(async () => (await deviceRows()).length === 3, { timeoutMsg: "the device list never showed the three devices" });
    await recordNotices();
    const failedBefore = await removalFailedNotices();

    // A removal held while the list is rendered again, whose ListDevices the
    // server answers with the device still in it and the harness holds. The
    // removal then succeeds and reloads the list; the held, older response
    // arrives last and must not bring the removed device back.
    const removalsBefore = (await callHarness("removeDeviceCalls")).length;
    await callHarness("holdNextRemoveDevice");
    await clickRemove(staleName);
    await confirmRemove();
    await browser.waitUntil(async () => (await callHarness("removeDeviceCalls")).length === removalsBefore + 1, { timeoutMsg: "the removal sent no RemoveDevice" });
    await callHarness("holdNextListDevices");
    await renderSettings();
    await browser.waitUntil(() => callHarness("listDevicesHeld"), { timeoutMsg: "the re-rendered list sent no ListDevices" });
    expect(await callHarness("releaseRemoveDevice")).toBe(true);
    await browser.waitUntil(async () => (await deviceRows()).length === 2, { timeoutMsg: "the reloaded list never showed the two devices left" });
    expect(await rowNamed(staleName)).toBeUndefined();
    expect(await callHarness("releaseListDevices")).toBe(true);
    await settle();
    expect(await rowNamed(staleName)).toBeUndefined();
    expect((await deviceRows()).length).toBe(2);

    // A removal held until the settings were closed: when it succeeds, the
    // closed tab's list is not loaded again.
    await callHarness("holdNextRemoveDevice");
    await clickRemove(closedName);
    await confirmRemove();
    await browser.waitUntil(async () => (await callHarness("removeDeviceCalls")).length === removalsBefore + 2, { timeoutMsg: "the second removal sent no RemoveDevice" });
    await browser.executeObsidian(({ app }) => {
      (app as unknown as { setting: { close(): void } }).setting.close();
    });
    const listings = await callHarness("listDevicesCalls");
    expect(await callHarness("releaseRemoveDevice")).toBe(true);
    await browser.waitUntil(async () => (await callHarness("serverDeviceIds")).length === 1, { timeoutMsg: "the server never removed the device" });
    await settle();
    expect(await callHarness("listDevicesCalls")).toBe(listings);
    expect(await removalFailedNotices()).toBe(failedBefore);
    expect(await callHarness("serverDeviceIds")).toEqual([thisDevice]);
    expect((await callHarness("removeDeviceCalls")).slice(removalsBefore)).toEqual([
      { deviceId: stale, forwarded: true },
      { deviceId: closed, forwarded: true },
    ]);
  });
});
