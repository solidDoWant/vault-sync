import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { Argon2Params } from "../core/e2ee/e2ee";
import { enableEncryption, PassphraseAttemptsExhaustedError, storedPublicKey, unlockUserKey, WrongPassphraseError, type UserKeyClient, type UserKeyPair } from "../core/keys/user-key";
import type { EpochKeyStore } from "../core/keys/vault-keys";
import { currentAccount, sameAccount, type Account } from "./controller";
import type { PluginData } from "./data";

/**
 * Where end-to-end encryption stands for the signed-in account on this
 * device. "key-changed" is locked too: this device holds a key it unlocked
 * for the account, but the account's key on the server is now another one,
 * so the cached key is not used and the server's key must be unlocked.
 */
export type EncryptionState = "not-enabled" | "locked" | "key-changed" | "unlocked";

export interface EncryptionOptions {
  data: PluginData;
  save: () => Promise<void>;
  client: UserKeyClient;
  /** The current access token, to tell which account is signed in. */
  accessToken: () => Promise<string>;
  /** Argon2id parameters for a new key; the default (SPEC.md §9.3) unless a test needs it cheaper. */
  params?: Argon2Params;
}

/**
 * The account's encryption state on this device: unlocked when this device
 * holds the account's key pair (the cached public key is the server's), key
 * changed when it holds another key pair for the account, locked when it
 * holds none, not enabled when the account has no key on the server. A
 * cached key is never deleted here: unlocking the server's key replaces it.
 */
export async function encryptionState(options: EncryptionOptions): Promise<EncryptionState> {
  const account = await currentAccount(options.data, options.accessToken);
  const stored = await storedPublicKey(options.client);
  if (stored === undefined) return "not-enabled";
  const cached = options.data.userKey;
  if (cached === undefined || !sameAccount(cached, account)) return "locked";
  return cached.publicKey === bytesToHex(stored) ? "unlocked" : "key-changed";
}

/**
 * Enables encryption for the signed-in account with a new key pair (or, if
 * another device enabled it first, unlocks that one with `passphrase`), and
 * caches the key pair on this device. Resolves whether this device created
 * the key.
 */
export async function enableOnDevice(options: EncryptionOptions, passphrase: string): Promise<boolean> {
  const account = await currentAccount(options.data, options.accessToken);
  const { key, created } = await enableEncryption(options.client, passphrase, options.params);
  await cache(options, account, key);
  return created;
}

/** Unlocks the signed-in account's key pair with `passphrase` and caches it on this device. */
export async function unlockOnDevice(options: EncryptionOptions, passphrase: string): Promise<void> {
  const account = await currentAccount(options.data, options.accessToken);
  await cache(options, account, await unlockUserKey(options.client, passphrase));
}

async function cache(options: EncryptionOptions, account: Awaited<ReturnType<typeof currentAccount>>, key: UserKeyPair): Promise<void> {
  options.data.userKey = {
    publicKey: bytesToHex(key.publicKey),
    privateKey: bytesToHex(key.privateKey),
    ...account,
  };
  await options.save();
}

/**
 * Forgets the device's end-to-end encryption keys on sign-out: the unlocked
 * user key pair and every cached epoch key. Resolves whether anything was
 * dropped (and so the plugin data needs saving).
 */
export function forgetEncryptionKeys(data: PluginData): boolean {
  const had = data.userKey !== undefined || data.vaultKeys !== undefined;
  delete data.userKey;
  delete data.vaultKeys;
  return had;
}

/**
 * The epoch key store of `vaultId` for `account`, in the device's plugin
 * data (data.json, never synced). Keys cached for another account or vault
 * are not read, and are replaced by the first save.
 */
export function pluginDataEpochKeyStore(data: PluginData, save: () => Promise<void>, account: Account, vaultId: string): EpochKeyStore {
  return {
    load: () => {
      const cached = data.vaultKeys;
      const keys = new Map<number, Uint8Array>();
      if (cached !== undefined && sameAccount(cached, account) && cached.vaultId === vaultId) {
        for (const [epoch, key] of Object.entries(cached.epochs)) keys.set(Number(epoch), hexToBytes(key));
      }
      return Promise.resolve(keys);
    },
    save: async (keys) => {
      const epochs: Record<string, string> = {};
      for (const [epoch, key] of keys) epochs[String(epoch)] = bytesToHex(key);
      data.vaultKeys = { serverUrl: account.serverUrl, issuer: account.issuer, subject: account.subject, vaultId, epochs };
      await save();
    },
  };
}

/**
 * What to tell the user when enabling or unlocking failed. The time the
 * server allows the next attempt is shown in `formatTime`'s format.
 */
export function passphraseErrorMessage(error: unknown, formatTime: (time: Date) => string): string {
  if (error instanceof WrongPassphraseError) return "The passphrase is wrong.";
  if (error instanceof PassphraseAttemptsExhaustedError) {
    return error.retryTime === undefined ? "Too many wrong passphrases. Try again later." : `Too many wrong passphrases. Try again after ${formatTime(error.retryTime)}.`;
  }
  return error instanceof Error ? error.message : String(error);
}
