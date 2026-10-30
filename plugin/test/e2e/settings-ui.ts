import { browser } from "@wdio/globals";

import { pluginId } from "./environment";

// Driving vault-sync's settings tab, its modals and its notices as the user
// does, for the specs that use the Sharing section (sharing.e2e.ts,
// shared-vault.e2e.ts).

export type SettingsApp = { setting: { activeTab?: { containerEl: HTMLElement }; open(): void; openTabById(id: string): void; close(): void } };

export function openSettings() {
  return browser.executeObsidian(({ app }, id) => {
    const setting = (app as unknown as SettingsApp).setting;
    setting.open();
    setting.openTabById(id);
  }, pluginId);
}

export function closeSettings() {
  return browser.executeObsidian(({ app }) => {
    (app as unknown as SettingsApp).setting.close();
  });
}

/** Clicks the button labelled `text` in the `index`th row matching `selector`. */
export function clickButton(selector: string, index: number, text: string) {
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

/** Types `value` into the text field of the first row matching `selector`. */
export function type(selector: string, value: string) {
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
export function modals(title: string): Promise<string[]> {
  return browser.executeObsidian(
    ({ app }, wanted) =>
      [...((app as unknown as SettingsApp).setting.activeTab?.containerEl.ownerDocument ?? document).querySelectorAll(".modal")]
        .filter((modal) => modal.querySelector(".modal-title")?.textContent === wanted)
        .map((modal) => modal.textContent),
    title,
  );
}

/** Clicks `text` in the open modal titled `title`, and waits for the modal to close. */
export async function answerModal(title: string, text: string): Promise<void> {
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

/** Records the text of every notice shown from now on. */
export function recordNotices() {
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

export async function notices(): Promise<string[]> {
  return (await browser.executeObsidian(() => [...((window as unknown as { vaultSyncNotices?: Set<Element> }).vaultSyncNotices ?? [])].map((notice) => notice.textContent))).filter((text) => text !== "");
}
