import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { VerifiedLogStore } from "../core/keys/verified-log";
import { sameAccount, type Account } from "./controller";
import { parseUserKey, parseVaultKeys, type PluginData } from "./data";

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

/** The plugin data fields that are secrets: kept in local storage, never in `data.json`. */
type DeviceSecret = "refreshToken" | "userKey" | "vaultKeys";

/** What `saveFile` writes to `data.json`: the plugin data without its secrets. */
export type PluginFile = Omit<PluginData, DeviceSecret>;

/** The local storage key of the device's refresh token. */
export const refreshTokenStorageKey = "vault-sync-refresh-token";
/** The local storage key of the unlocked end-to-end encryption key pair. */
export const userKeyStorageKey = "vault-sync-user-key";
/** The local storage key of the connected vault's epoch keys. */
export const vaultKeysStorageKey = "vault-sync-vault-keys";

/**
 * Sets the device's secrets in `data` (the refresh token, the unlocked user
 * key pair and the epoch keys) from local storage, for plugin data just read
 * from `data.json`. Returns true if `data.json` still holds any of them, as
 * versions that kept them there wrote them: such a secret is kept (only such
 * a version could have written it, so it is the newest) and the caller
 * saves, which moves it to local storage and removes it from `data.json`.
 */
export function loadDeviceSecrets(data: PluginData, storage: DeviceStorage): boolean {
  const inFile = data.refreshToken !== undefined || data.userKey !== undefined || data.vaultKeys !== undefined;
  if (data.refreshToken === undefined) {
    const stored = storage.loadLocalStorage(refreshTokenStorageKey);
    if (typeof stored === "string" && stored !== "") data.refreshToken = stored;
  }
  if (data.userKey === undefined) {
    const stored = parseUserKey(storage.loadLocalStorage(userKeyStorageKey));
    if (stored !== undefined) data.userKey = stored;
  }
  if (data.vaultKeys === undefined) {
    const stored = parseVaultKeys(storage.loadLocalStorage(vaultKeysStorageKey));
    if (stored !== undefined) data.vaultKeys = stored;
  }
  return inFile;
}

/**
 * Saves `data`: the secrets to local storage (each cleared when absent),
 * then the rest with `saveFile`, which writes `data.json`. The secrets are
 * stored first, so a failed file write never leaves the device without them.
 */
export async function savePluginData(data: PluginData, storage: DeviceStorage, saveFile: (data: PluginFile) => Promise<void>): Promise<void> {
  storage.saveLocalStorage(refreshTokenStorageKey, data.refreshToken ?? null);
  storage.saveLocalStorage(userKeyStorageKey, data.userKey ?? null);
  storage.saveLocalStorage(vaultKeysStorageKey, data.vaultKeys ?? null);
  const file: PluginFile & Partial<Pick<PluginData, DeviceSecret>> = { ...data };
  delete file.refreshToken;
  delete file.userKey;
  delete file.vaultKeys;
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

/** The local storage key of the membership log positions and anchor list version this device verified. */
export const verifiedLogsStorageKey = "vault-sync-verified-logs";

interface StoredVerifiedLogs {
  account: Account;
  anchorListVersion: number;
  checkpoints: Record<string, { seq: number; hash: string }>;
}

function parseVerifiedLogs(value: unknown, account: Account): StoredVerifiedLogs {
  const empty: StoredVerifiedLogs = { account, anchorListVersion: 0, checkpoints: {} };
  if (typeof value !== "object" || value === null) return empty;
  const stored = value as Partial<StoredVerifiedLogs>;
  if (typeof stored.account !== "object" || !sameAccount(stored.account, account)) return empty;
  const checkpoints: StoredVerifiedLogs["checkpoints"] = {};
  if (typeof stored.checkpoints === "object") {
    for (const [vaultId, checkpoint] of Object.entries(stored.checkpoints)) {
      if (Number.isSafeInteger(checkpoint.seq) && checkpoint.seq > 0 && /^[0-9a-f]{64}$/u.test(checkpoint.hash)) checkpoints[vaultId] = checkpoint;
    }
  }
  const version = Number.isSafeInteger(stored.anchorListVersion) ? Number(stored.anchorListVersion) : 0;
  return { account, anchorListVersion: version, checkpoints };
}

/**
 * The {@link VerifiedLogStore} of `account` on this device, in local
 * storage: like the epoch keys, it must not travel with the vault folder,
 * or an old copy of it would hide a rollback.
 */
export function deviceVerifiedLogStore(storage: DeviceStorage, account: Account): VerifiedLogStore {
  const load = (): StoredVerifiedLogs => parseVerifiedLogs(storage.loadLocalStorage(verifiedLogsStorageKey), account);
  const save = (stored: StoredVerifiedLogs): Promise<void> => {
    storage.saveLocalStorage(verifiedLogsStorageKey, stored);
    return Promise.resolve();
  };
  return {
    checkpoint: (vaultId) => {
      const checkpoint = load().checkpoints[vaultId];
      return Promise.resolve(checkpoint === undefined ? undefined : { seq: checkpoint.seq, hash: hexToBytes(checkpoint.hash) });
    },
    saveCheckpoint: (vaultId, checkpoint) => {
      const stored = load();
      stored.checkpoints[vaultId] = { seq: checkpoint.seq, hash: bytesToHex(checkpoint.hash) };
      return save(stored);
    },
    anchorListVersion: () => Promise.resolve(load().anchorListVersion),
    saveAnchorListVersion: (version) => save({ ...load(), anchorListVersion: version }),
  };
}
