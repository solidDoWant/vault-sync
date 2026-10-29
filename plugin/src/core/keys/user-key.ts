/**
 * The user's end-to-end encryption key pair (SPEC.md §9.3): created on a
 * device when the user enables encryption, stored on the server only with its
 * private key wrapped under the recovery passphrase, and released to another
 * device only after the server checked the passphrase's verifier (auth_key).
 *
 * Nothing here logs, and no error message carries a key, the passphrase or
 * anything derived from it.
 */
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import type { PassphraseParams, UserKeyService } from "../../gen/vaultsync/v1/user_key_pb";
import { graphemes } from "../graphemes";
import {
  DEFAULT_ARGON2_PARAMS,
  DecryptError,
  derivePassphraseKeys,
  parsePassphraseHeader,
  SUITE_V2,
  unwrapWithKey,
  wrapWithPassphrase,
  type Argon2Params,
} from "../e2ee/e2ee";
import { generateKeyPair, publicKey as publicKeyOf } from "../e2ee/hybrid";

/** The calls the key manager makes: UserKeyService (ProtocolClient.userKeys). */
export type UserKeyClient = Pick<Client<typeof UserKeyService>, "getUserKeyParams" | "createUserKey" | "unlockUserKey" | "changePassphrase">;

/** An unlocked user key pair. `privateKey` must stay on the device. */
export interface UserKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** The fewest characters (grapheme clusters) a new recovery passphrase may have. */
export const MIN_PASSPHRASE_LENGTH = 10;

const AAD_LABEL = new TextEncoder().encode("vault-sync/v1/user-key");

/**
 * The associated data the wrapped private key binds: the label
 * "vault-sync/v1/user-key" followed by the public key, so a wrapped key
 * cannot be passed off as another key pair's.
 */
export function userKeyAad(publicKey: Uint8Array): Uint8Array {
  const aad = new Uint8Array(AAD_LABEL.length + publicKey.length);
  aad.set(AAD_LABEL);
  aad.set(publicKey, AAD_LABEL.length);
  return aad;
}

/** The server refused the passphrase (its auth_key did not match). The attempt counted against the limit. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("The passphrase is wrong.");
    this.name = "WrongPassphraseError";
  }
}

/** Too many wrong passphrases: the server refuses every attempt until `retryTime`. */
export class PassphraseAttemptsExhaustedError extends Error {
  constructor(readonly retryTime: Date | undefined) {
    super(retryTime === undefined ? "Too many wrong passphrases. Try again later." : `Too many wrong passphrases. Try again after ${retryTime.toISOString()}.`);
    this.name = "PassphraseAttemptsExhaustedError";
  }
}

/** The user has no key on the server: encryption has not been enabled for the account. */
export class NoUserKeyError extends Error {
  constructor() {
    super("End-to-end encryption is not enabled for this account yet.");
    this.name = "NoUserKeyError";
  }
}

/** Why `passphrase` cannot be a new recovery passphrase, or undefined if it can. */
export function passphraseProblem(passphrase: string): string | undefined {
  if (graphemes(passphrase).length < MIN_PASSPHRASE_LENGTH) return `The passphrase must have at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`;
  return undefined;
}

/** The public key of the user's key pair on the server, or undefined when the user has none yet. */
export async function storedPublicKey(client: UserKeyClient): Promise<Uint8Array | undefined> {
  try {
    return (await client.getUserKeyParams({})).publicKey;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    throw error;
  }
}

/**
 * Enables encryption for the user: creates a key pair on this device and
 * stores it on the server with the private key wrapped under `passphrase`
 * (CreateUserKey sends only the public key, the wrapped private key, its
 * parameters and auth_key). The server keeps one key per user and never
 * replaces it: when another device enabled encryption first (ALREADY_EXISTS),
 * this device unlocks that key with `passphrase` instead, and `created` is
 * false. Rejects as {@link unlockUserKey} does then.
 */
export async function enableEncryption(client: UserKeyClient, passphrase: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<{ key: UserKeyPair; created: boolean }> {
  const problem = passphraseProblem(passphrase);
  if (problem !== undefined) throw new Error(problem);
  const key = generateKeyPair();
  const { wrapped, authKey } = await wrapWithPassphrase(passphrase, key.privateKey, userKeyAad(key.publicKey), params);
  const header = parsePassphraseHeader(wrapped);
  try {
    await client.createUserKey({
      publicKey: key.publicKey,
      wrappedPrivateKey: wrapped,
      params: {
        suite: SUITE_V2,
        memoryKib: header.params.memory,
        iterations: header.params.iterations,
        parallelism: header.params.parallelism,
        salt: header.salt,
      },
      authKey,
    });
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.AlreadyExists) {
      return { key: await unlockUserKey(client, passphrase), created: false };
    }
    throw error;
  }
  return { key, created: true };
}

/**
 * Unlocks the user's key pair on this device: derives auth_key and the wrap
 * key from `passphrase` with the stored parameters, has the server release
 * the wrapped private key for auth_key (UnlockUserKey), and unwraps it here.
 * Rejects with {@link WrongPassphraseError}, {@link
 * PassphraseAttemptsExhaustedError} (with the server's retry time) or
 * {@link NoUserKeyError}; and with an Error when what the server released
 * does not open or does not match the stored public key.
 */
export async function unlockUserKey(client: UserKeyClient, passphrase: string): Promise<UserKeyPair> {
  const stored = await call(() => client.getUserKeyParams({}));
  const params = argon2Params(stored.params);
  return release(client, await derivePassphraseKeys(passphrase, params.argon2, params.salt));
}

/** Has the server release the wrapped private key for `keys.authKey`, and unwraps it with `keys.wrapKey`. */
async function release(client: UserKeyClient, keys: { wrapKey: Uint8Array; authKey: Uint8Array }): Promise<UserKeyPair> {
  const released = await call(() => client.unlockUserKey({ authKey: keys.authKey }));
  let privateKey: Uint8Array;
  try {
    privateKey = unwrapWithKey(keys.wrapKey, released.wrappedPrivateKey, userKeyAad(released.publicKey));
  } catch (error) {
    if (error instanceof DecryptError) throw new Error("the key the server released does not open with this passphrase", { cause: error });
    throw error;
  }
  if (!equalBytes(publicKeyOf(privateKey), released.publicKey)) throw new Error("the key the server released does not match its public key");
  return { publicKey: released.publicKey, privateKey };
}

/**
 * Changes the recovery passphrase: unlocks the key pair with `current` (so a
 * wrong one fails as {@link unlockUserKey} does, and counts against the
 * limit), wraps the same private key under `next`, and has the server replace
 * the wrapping and the verifier in one compare-and-swap on the public key
 * (ChangePassphrase). The key pair never changes, so devices that hold it
 * keep working; a new device needs `next`. Resolves the key pair.
 */
export async function changePassphrase(client: UserKeyClient, current: string, next: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<UserKeyPair> {
  const problem = passphraseProblem(next);
  if (problem !== undefined) throw new Error(problem);
  const stored = argon2Params((await call(() => client.getUserKeyParams({}))).params);
  const currentKeys = await derivePassphraseKeys(current, stored.argon2, stored.salt);
  const key = await release(client, currentKeys);
  const { wrapped, authKey } = await wrapWithPassphrase(next, key.privateKey, userKeyAad(key.publicKey), params);
  const header = parsePassphraseHeader(wrapped);
  await call(() =>
    client.changePassphrase({
      authKey: currentKeys.authKey,
      publicKey: key.publicKey,
      newWrappedPrivateKey: wrapped,
      newParams: {
        suite: SUITE_V2,
        memoryKib: header.params.memory,
        iterations: header.params.iterations,
        parallelism: header.params.parallelism,
        salt: header.salt,
      },
      newAuthKey: authKey,
    }),
  );
  return key;
}

/** The Argon2id parameters and salt of a stored wrapping; refuses a suite this device does not know. */
function argon2Params(params: PassphraseParams | undefined): {
  argon2: Argon2Params;
  salt: Uint8Array;
} {
  if (params?.suite !== SUITE_V2) throw new Error("the server's key uses an unknown crypto suite; update Vault Sync");
  return {
    argon2: {
      memory: params.memoryKib,
      iterations: params.iterations,
      parallelism: params.parallelism,
    },
    salt: params.salt,
  };
}

/** Runs a UserKeyService call, mapping the refusals the user can act on to typed errors. */
async function call<Response>(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    const reasons = error.findDetails(ErrorDetailSchema);
    if (error.code === Code.NotFound) throw new NoUserKeyError();
    if (error.code === Code.PermissionDenied && reasons.some((detail) => detail.reason === ErrorReason.WRONG_PASSPHRASE)) {
      throw new WrongPassphraseError();
    }
    const exhausted = reasons.find((detail) => detail.reason === ErrorReason.PASSPHRASE_ATTEMPTS_EXHAUSTED);
    if (error.code === Code.ResourceExhausted && exhausted !== undefined) {
      throw new PassphraseAttemptsExhaustedError(exhausted.retryTime === undefined ? undefined : timestampDate(exhausted.retryTime));
    }
    throw error;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
