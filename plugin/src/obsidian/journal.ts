import type { App } from "obsidian";

import { IndexedDbJournal } from "../core/journal/indexeddb";

/** Which server vault a local vault syncs with. */
export interface JournalKey {
  /** The sync server's base URL. */
  serverUrl: string;
  /** The server's vault id. */
  vaultId: string;
}

/**
 * The IndexedDB database name of the journal for `key` in the local vault
 * `localVaultId`. Every vault of one Obsidian install shares one IndexedDB
 * origin, and the journal describes one local disk syncing one server vault,
 * so the name has all three: two local vaults never share a journal, even
 * when they sync the same server vault, and switching a local vault to
 * another server or vault starts a separate one.
 */
export function journalDatabaseName(localVaultId: string, key: JournalKey): string {
  if (localVaultId === "") throw new Error("the local vault id is empty");
  if (key.vaultId === "") throw new Error("the server vault id is empty");
  return ["vault-sync-journal", localVaultId, key.vaultId, normalizeServerUrl(key.serverUrl)].map(encodeURIComponent).join("/");
}

/**
 * Opens the durable journal for `key` in the open vault (SPEC.md §8),
 * creating or upgrading it as needed.
 */
export async function openVaultJournal(app: App, key: JournalKey, factory: IDBFactory = window.indexedDB): Promise<IndexedDbJournal> {
  return await IndexedDbJournal.open(factory, journalDatabaseName(localVaultId(app), key));
}

/**
 * Obsidian's id for the open vault: random, assigned when the vault is first
 * opened on the device, and stable across restarts and renames of the vault
 * folder. It is not in Obsidian's public typings, but plugins have long used
 * it to key per-vault storage for exactly this reason. Without it there is
 * no safe per-vault key, so opening the journal fails rather than share one.
 */
export function localVaultId(app: App): string {
  const id = (app as unknown as { appId?: unknown }).appId;
  if (typeof id !== "string" || id === "") throw new Error("Obsidian did not provide the vault's id (app.appId)");
  return id;
}

/** One spelling per server: URL parsing folds case and default ports, and trailing slashes are dropped. */
function normalizeServerUrl(serverUrl: string): string {
  return new URL(serverUrl).href.replace(/\/+$/, "");
}
