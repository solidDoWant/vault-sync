import { bytesToHex } from "@noble/hashes/utils.js";

import type { Argon2Params } from "../core/e2ee/e2ee";
import { enableEncryption, PassphraseAttemptsExhaustedError, storedPublicKey, unlockUserKey, WrongPassphraseError, type UserKeyClient, type UserKeyPair } from "../core/keys/user-key";
import { currentAccount, sameAccount } from "./controller";
import type { PluginData } from "./data";

/** Where end-to-end encryption stands for the signed-in account on this device. */
export type EncryptionState = "not-enabled" | "locked" | "unlocked";

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
 * holds the account's key pair, locked when the account has a key this
 * device has not unlocked, not enabled when the account has none.
 */
export async function encryptionState(options: EncryptionOptions): Promise<EncryptionState> {
  const account = await currentAccount(options.data, options.accessToken);
  const cached = options.data.userKey;
  if (cached !== undefined && sameAccount(cached, account)) return "unlocked";
  return (await storedPublicKey(options.client)) === undefined ? "not-enabled" : "locked";
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
