import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../protocol/client";
import { generateKeyPair, parsePassphraseHeader, SUITE_V1, unwrapWithPassphrase, wrapWithPassphrase, type Argon2Params } from "../e2ee/e2ee";
import { ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS, MemoryUserKeyServer } from "./memory-user-keys";
import { enableEncryption, NoUserKeyError, PassphraseAttemptsExhaustedError, passphraseProblem, storedPublicKey, unlockUserKey, userKeyAad, WrongPassphraseError } from "./user-key";

/** The cheapest parameters the bounds allow, so the tests stay fast. */
const cheap: Argon2Params = {
  memory: 19 * 1024,
  iterations: 2,
  parallelism: 1,
};
const passphrase = "correct horse battery staple";

function device(server: MemoryUserKeyServer) {
  return createProtocolClient({ transport: server.transport }).userKeys;
}

/** Whether `needle` occurs anywhere in `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let index = 0; index < needle.length; index++) if (haystack[start + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}

describe("enabling end-to-end encryption", () => {
  it("creates the key pair on the device and sends only the public key, the wrapped private key and the verifier", async () => {
    const server = new MemoryUserKeyServer();

    const { key, created } = await enableEncryption(device(server), passphrase, cheap);

    expect(created).toBe(true);
    expect(server.stored?.publicKey).toEqual(key.publicKey);
    expect(server.requests.map((request) => request.procedure)).toEqual(["CreateUserKey"]);
    for (const request of server.requests) expect(contains(request.bytes, key.privateKey)).toBe(false);
    // What was sent is the private key wrapped under the passphrase, bound to its public key.
    const wrapped = server.stored?.wrappedPrivateKey ?? new Uint8Array();
    expect(await unwrapWithPassphrase(passphrase, wrapped, userKeyAad(key.publicKey))).toEqual(key.privateKey);
  });

  it("refuses a passphrase shorter than the minimum before anything is sent", async () => {
    const server = new MemoryUserKeyServer();

    await expect(enableEncryption(device(server), "123456789", cheap)).rejects.toThrow(/at least 10 characters/);

    expect(server.requests).toEqual([]);
    expect(passphraseProblem("123456789")).toBeDefined();
    expect(passphraseProblem("1234567890")).toBeUndefined();
  });

  it("given two devices enabling at once, keeps one key, and the other device unlocks it instead of replacing it", async () => {
    const server = new MemoryUserKeyServer();

    const [first, second] = await Promise.all([enableEncryption(device(server), passphrase, cheap), enableEncryption(device(server), passphrase, cheap)]);

    expect(server.created).toBe(1);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.key.publicKey).toEqual(server.stored?.publicKey);
    expect(second.key).toEqual(first.key);
  });

  it("given another device enabled with a different passphrase, fails as a wrong passphrase and leaves that key in place", async () => {
    const server = new MemoryUserKeyServer();
    const winner = await enableEncryption(device(server), passphrase, cheap);

    await expect(enableEncryption(device(server), "another long passphrase", cheap)).rejects.toBeInstanceOf(WrongPassphraseError);

    expect(server.created).toBe(1);
    expect(server.stored?.publicKey).toEqual(winner.key.publicKey);
  });
});

describe("unlocking on another device", () => {
  it("holds the same key pair as the device that enabled encryption", async () => {
    const server = new MemoryUserKeyServer();
    const { key } = await enableEncryption(device(server), passphrase, cheap);

    const unlocked = await unlockUserKey(device(server), passphrase);

    expect(unlocked.publicKey).toEqual(key.publicKey);
    expect(unlocked.privateKey).toEqual(key.privateKey);
    for (const request of server.requests) expect(contains(request.bytes, key.privateKey)).toBe(false);
  });

  it("fails with a wrong passphrase", async () => {
    const server = new MemoryUserKeyServer();
    await enableEncryption(device(server), passphrase, cheap);

    await expect(unlockUserKey(device(server), "not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it(`after ${String(MAX_FAILED_ATTEMPTS)} wrong passphrases, refuses even the right one and reports the server's retry time`, async () => {
    let now = Date.parse("2026-10-21T12:00:00Z");
    const server = new MemoryUserKeyServer(() => now);
    await enableEncryption(device(server), passphrase, cheap);

    // A wrong passphrase reaches the server only as a wrong auth_key, so all
    // but the last attempt send one directly: each passphrase derivation is
    // costly, and the test must not depend on how fast the runner is (#707).
    const wrongAuthKey = new Uint8Array(32).fill(7);
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt++) {
      const failed = await device(server)
        .unlockUserKey({ authKey: wrongAuthKey })
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(ConnectError);
      expect((failed as ConnectError).code).toBe(Code.PermissionDenied);
      now += 1000;
    }
    await expect(unlockUserKey(device(server), "not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
    now += 1000;
    const refused = await unlockUserKey(device(server), passphrase).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PassphraseAttemptsExhaustedError);
    expect((refused as PassphraseAttemptsExhaustedError).retryTime).toEqual(new Date("2026-10-21T13:00:00Z"));
    expect((refused as Error).message).toContain("2026-10-21T13:00:00.000Z");

    now = Date.parse("2026-10-21T12:00:00Z") + ATTEMPT_WINDOW_MS;
    await expect(unlockUserKey(device(server), passphrase)).resolves.toMatchObject({ publicKey: server.stored?.publicKey });
  }, 30_000);

  it("reports that encryption is not enabled when the user has no key", async () => {
    const server = new MemoryUserKeyServer();

    await expect(unlockUserKey(device(server), passphrase)).rejects.toBeInstanceOf(NoUserKeyError);
    expect(await storedPublicKey(device(server))).toBeUndefined();
  });

  it("refuses a released key that does not belong to the stored public key", async () => {
    const server = new MemoryUserKeyServer();
    await enableEncryption(device(server), passphrase, cheap);
    const stored = server.stored;
    if (stored === undefined) throw new Error("no key stored");
    stored.publicKey = new Uint8Array(32).fill(9);

    await expect(unlockUserKey(device(server), passphrase)).rejects.toThrow(/does not open/);
  });

  it("refuses a released key whose private key opens under the stored public key but does not belong to it", async () => {
    const server = new MemoryUserKeyServer();
    // A device that knows the passphrase stores a mismatched pair: the
    // private key of one pair, wrapped and bound to another pair's public key.
    const claimed = generateKeyPair();
    const actual = generateKeyPair();
    const { wrapped, authKey } = await wrapWithPassphrase(passphrase, actual.privateKey, userKeyAad(claimed.publicKey), cheap);
    const header = parsePassphraseHeader(wrapped);
    await device(server).createUserKey({
      publicKey: claimed.publicKey,
      wrappedPrivateKey: wrapped,
      params: {
        suite: SUITE_V1,
        memoryKib: header.params.memory,
        iterations: header.params.iterations,
        parallelism: header.params.parallelism,
        salt: header.salt,
      },
      authKey,
    });

    await expect(unlockUserKey(device(server), passphrase)).rejects.toThrow("the key the server released does not match its public key");
  });
});
