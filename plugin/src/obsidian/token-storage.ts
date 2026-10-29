import type { PluginData } from "./data";

/**
 * Obsidian's per-vault local storage on this device (`App.loadLocalStorage`
 * and `App.saveLocalStorage`). It lives outside the vault's files, so tools
 * that back up or sync the vault folder (Git, a file-sync app) never copy
 * what is kept there.
 */
export interface DeviceStorage {
  loadLocalStorage(key: string): unknown;
  /** Saves `data`; `null` clears the entry. */
  saveLocalStorage(key: string, data: unknown): void;
}

/** The local storage key of the device's refresh token. */
export const refreshTokenStorageKey = "vault-sync-refresh-token";

/**
 * Sets `data.refreshToken` from local storage, for plugin data just read
 * from `data.json`. Returns true if `data.json` still holds a refresh token,
 * as versions that kept it there wrote it: that token is kept (only such a
 * version could have written it, so it is the newest) and the caller saves,
 * which moves it to local storage and removes it from `data.json`.
 */
export function loadRefreshToken(data: PluginData, storage: DeviceStorage): boolean {
  if (data.refreshToken !== undefined) return true;
  const stored = storage.loadLocalStorage(refreshTokenStorageKey);
  if (typeof stored === "string" && stored !== "") data.refreshToken = stored;
  return false;
}

/**
 * Saves `data`: the refresh token to local storage (cleared when signed
 * out), then the rest with `saveFile`, which writes `data.json`. The token
 * is stored first, so a failed file write never leaves the device without it.
 */
export async function savePluginData(data: PluginData, storage: DeviceStorage, saveFile: (data: Omit<PluginData, "refreshToken">) => Promise<void>): Promise<void> {
  storage.saveLocalStorage(refreshTokenStorageKey, data.refreshToken ?? null);
  const file: Omit<PluginData, "refreshToken"> & { refreshToken?: string } = { ...data };
  delete file.refreshToken;
  await saveFile(file);
}

/**
 * Whether the device signed in but its refresh token is gone: the identity
 * provider of the sign-in is still stored (a sign-out or a revoked token
 * drops it with the token), so local storage was cleared. The device then
 * needs a sign-in, as after a revoked token.
 */
export function refreshTokenLost(data: PluginData): boolean {
  return data.refreshToken === undefined && data.identityProvider !== undefined;
}
