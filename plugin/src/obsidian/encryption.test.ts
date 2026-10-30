import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Argon2Params } from "../core/e2ee/e2ee";
import { MAX_FAILED_ATTEMPTS, MemoryUserKeyServer } from "../core/keys/memory-user-keys";
import { WeakerPassphraseParamsError, WrongPassphraseError } from "../core/keys/user-key";
import { ageRecipient, generateKeyPair } from "../core/e2ee/hybrid";
import { signPublicKey } from "../core/e2ee/identity";
import { createProtocolClient } from "../core/protocol/client";
import { parsePluginData, type PluginData } from "./data";
import { changePassphraseOnDevice, enableOnDevice, encryptionState, forgetEncryptionKeys, passphraseErrorMessage, pluginDataEpochKeyStore, pluginDataEscrowPin, unlockedUserKey, unlockOnDevice, type EncryptionOptions } from "./encryption";

const cheap: Argon2Params = {
  memory: 19 * 1024,
  iterations: 2,
  parallelism: 1,
};
const passphrase = "correct horse battery staple";

// Every test here derives Argon2id keys (a few hundred milliseconds each at
// the cheapest bounds, several times that on a loaded machine), so they get a
// timeout sized to that work instead of vitest's 5 s default.
const ARGON2_TIMEOUT = { timeout: 60_000 };
const tokenFor = (subject: string) => `e30.${btoa(JSON.stringify({ sub: subject, exp: 4_000_000_000 })).replace(/=+$/, "")}.sig`;

/** A device: its own plugin data, as saved to data.json, talking to `server` as `subject`. */
function device(server: MemoryUserKeyServer, subject = "alice") {
  const data: PluginData = parsePluginData({
    serverUrl: "https://sync.example",
    oidcIssuer: "https://auth.example/",
  });
  const saved: string[] = [];
  const options: EncryptionOptions = {
    data,
    save: () => {
      saved.push(JSON.stringify(data));
      return Promise.resolve();
    },
    client: createProtocolClient({ transport: server.transport }).userKeys,
    accessToken: () => Promise.resolve(tokenFor(subject)),
    params: cheap,
  };
  return { data, saved, options };
}

/** Every console call's arguments, as text. */
function captureConsole(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "debug", "info", "warn", "error", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${String(arg.stack)}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("end-to-end encryption on a device", ARGON2_TIMEOUT, () => {
  it("caches the key pair only in the device's plugin data, for the signed-in account, and logs nothing of it", async () => {
    const lines = captureConsole();
    const server = new MemoryUserKeyServer();
    const first = device(server);
    const second = device(server);

    expect(await encryptionState(first.options)).toBe("not-enabled");
    expect(await enableOnDevice(first.options, passphrase)).toBe(true);
    expect(await encryptionState(second.options)).toBe("locked");
    await expect(unlockOnDevice(second.options, "not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
    await unlockOnDevice(second.options, passphrase);

    const cached = first.data.userKey;
    expect(cached).toMatchObject({
      serverUrl: "https://sync.example",
      issuer: "https://auth.example/",
      subject: "alice",
    });
    expect(cached?.publicKey).toBe(bytesToHex(server.stored?.publicKey ?? new Uint8Array()));
    expect(second.data.userKey).toEqual(cached);
    expect(await encryptionState(second.options)).toBe("unlocked");
    // Saved to data.json, and read back from it after a restart.
    const privateKey = cached?.privateKey ?? "";
    expect(first.saved.at(-1)).toContain(privateKey);
    expect(parsePluginData(JSON.parse(first.saved.at(-1) ?? "{}")).userKey).toEqual(cached);
    // Never logged, as text or bytes.
    expect(lines.join("\n")).not.toContain(privateKey);
    expect(lines.join("\n")).not.toContain(Buffer.from(privateKey, "hex").toString("base64"));
  });

  it("does not use another account's cached key", async () => {
    const server = new MemoryUserKeyServer();
    const alice = device(server, "alice");
    await enableOnDevice(alice.options, passphrase);

    const bob = {
      ...alice.options,
      accessToken: () => Promise.resolve(tokenFor("bob")),
    };

    expect(await encryptionState(bob)).toBe("locked");
  });

  it("reports a cached key that is not the account's key on the server as changed, keeps it, and unlocks the server's key", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    await enableOnDevice(first.options, passphrase);
    const stale = first.data.userKey;
    // The server's key is replaced (a fresh database under the same URL and account).
    server.stored = undefined;
    const other = device(server);
    await enableOnDevice(other.options, "another recovery passphrase");

    expect(await encryptionState(first.options)).toBe("key-changed");
    expect(first.data.userKey).toEqual(stale);

    const replaced = other.data.userKey?.publicKey;
    await unlockOnDevice(first.options, "another recovery passphrase");

    expect(first.data.userKey?.publicKey).toBe(replaced);
    expect(first.data.userKey?.publicKey).not.toBe(stale?.publicKey);
    expect(await encryptionState(first.options)).toBe("unlocked");
  });

  it("does not report a cached key as unlocked when the server has no key", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    await enableOnDevice(first.options, passphrase);
    server.stored = undefined;

    expect(await encryptionState(first.options)).toBe("not-enabled");
  });

  it("drops a malformed cached key when reading plugin data", () => {
    const stored = {
      serverUrl: "https://sync.example",
      userKey: {
        publicKey: "zz",
        privateKey: "00",
        serverUrl: "https://sync.example",
        issuer: "i",
        subject: "s",
      },
    };

    expect(parsePluginData(stored).userKey).toBeUndefined();
  });

  it(`[P4-03] refuses a wrong passphrase, and once ${String(MAX_FAILED_ATTEMPTS)} were tried refuses even the right one until the server's retry time`, async () => {
    let now = Date.parse("2026-10-21T12:00:00Z");
    const server = new MemoryUserKeyServer(() => now);
    await enableOnDevice(device(server).options, passphrase);
    const other = device(server);
    const formatTime = (time: Date) => `at ${time.toISOString()}`;

    for (let attempt = 1; attempt <= MAX_FAILED_ATTEMPTS; attempt++) {
      const error = await unlockOnDevice(other.options, "not the passphrase").catch((failure: unknown) => failure);
      expect(passphraseErrorMessage(error, formatTime)).toBe("The passphrase is wrong.");
    }
    const error = await unlockOnDevice(other.options, passphrase).catch((failure: unknown) => failure);

    expect(passphraseErrorMessage(error, formatTime)).toBe("Too many wrong passphrases. Try again after at 2026-10-21T13:00:00.000Z.");
    expect(other.data.userKey).toBeUndefined();
    expect(await encryptionState(other.options)).toBe("locked");

    now = Date.parse("2026-10-21T13:00:00Z");
    await unlockOnDevice(other.options, passphrase);
    expect(await encryptionState(other.options)).toBe("unlocked");
  });

  it("[P4-04] after a passphrase change, unlocked devices keep their key and a new device needs the new passphrase", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    await enableOnDevice(first.options, passphrase);
    const second = device(server);
    await unlockOnDevice(second.options, passphrase);
    const key = await unlockedUserKey(second.options);
    const newPassphrase = "a different passphrase entirely";

    await changePassphraseOnDevice(first.options, passphrase, newPassphrase);

    for (const unlocked of [first, second]) {
      expect(await encryptionState(unlocked.options)).toBe("unlocked");
      expect(await unlockedUserKey(unlocked.options)).toEqual(key);
    }
    const fresh = device(server);
    await expect(unlockOnDevice(fresh.options, passphrase)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await encryptionState(fresh.options)).toBe("locked");
    await unlockOnDevice(fresh.options, newPassphrase);
    expect(await unlockedUserKey(fresh.options)).toEqual(key);
  });

  it("[P4-14] after the passphrase is lost, unlocked devices keep their key across a restart, and a new device stays locked", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    await enableOnDevice(first.options, passphrase);
    const key = await unlockedUserKey(first.options);

    // The user forgot the passphrase: a new device's guesses are refused.
    const fresh = device(server);
    await expect(unlockOnDevice(fresh.options, "what was it again")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(fresh.data.userKey).toBeUndefined();
    expect(await encryptionState(fresh.options)).toBe("locked");

    // The unlocked device restarts from its saved data.json and still holds the key, without the passphrase.
    const restarted = { ...first.options, data: parsePluginData(JSON.parse(first.saved.at(-1) ?? "{}")) };
    expect(await encryptionState(restarted)).toBe("unlocked");
    expect(await unlockedUserKey(restarted)).toEqual(key);
  });

  it("refuses a passphrase change with a wrong current passphrase and keeps the old one", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    await enableOnDevice(first.options, passphrase);

    await expect(changePassphraseOnDevice(first.options, "not the passphrase", "a different passphrase entirely")).rejects.toBeInstanceOf(WrongPassphraseError);

    const fresh = device(server);
    await unlockOnDevice(fresh.options, passphrase);
    expect(await encryptionState(fresh.options)).toBe("unlocked");
  });
});

describe("vault epoch keys on a device", ARGON2_TIMEOUT, () => {
  const account = { serverUrl: "https://sync.example", issuer: "https://auth.example/", subject: "alice" };
  const vaultId = "0190a5b4-0000-7000-8000-000000000001";
  const key = (byte: number) => new Uint8Array(32).fill(byte);

  it("keeps epoch keys only in the device's plugin data, for its account and vault, across a restart", async () => {
    const { data, saved } = device(new MemoryUserKeyServer());
    const save = () => {
      saved.push(JSON.stringify(data));
      return Promise.resolve();
    };
    await pluginDataEpochKeyStore(data, save, account, vaultId).save(
      new Map([
        [1, key(1)],
        [2, key(2)],
      ]),
    );

    const restarted = parsePluginData(JSON.parse(saved.at(-1) ?? "{}"));
    const keys = await pluginDataEpochKeyStore(restarted, save, account, vaultId).load();

    expect([...keys]).toEqual([
      [1, key(1)],
      [2, key(2)],
    ]);
    expect((await pluginDataEpochKeyStore(restarted, save, { ...account, subject: "bob" }, vaultId).load()).size).toBe(0);
    expect((await pluginDataEpochKeyStore(restarted, save, account, "0190a5b4-0000-7000-8000-000000000002").load()).size).toBe(0);
  });

  it("drops malformed cached epoch keys when reading plugin data", () => {
    const parsed = parsePluginData({ vaultKeys: { ...account, vaultId, epochs: { "1": bytesToHex(key(1)), "0": bytesToHex(key(2)), "2": "zz", x: bytesToHex(key(3)) } } });

    expect(parsed.vaultKeys?.epochs).toEqual({ "1": bytesToHex(key(1)) });
    expect(parsePluginData({ vaultKeys: { epochs: {} } }).vaultKeys).toBeUndefined();
  });

  it("drops the epoch keys on sign-out together with the user key", async () => {
    const server = new MemoryUserKeyServer();
    const { data, options } = device(server);
    await enableOnDevice(options, passphrase);
    await pluginDataEpochKeyStore(data, options.save, account, vaultId).save(new Map([[1, key(7)]]));
    expect(data.vaultKeys).toBeDefined();

    expect(forgetEncryptionKeys(data)).toBe(true);

    const written = JSON.stringify(data);
    expect(written).not.toContain(bytesToHex(key(7)));
    expect(data.userKey).toBeUndefined();
    expect(data.vaultKeys).toBeUndefined();
    expect(forgetEncryptionKeys(data)).toBe(false);
  });
});

describe("remembered Argon2id parameters on a device", ARGON2_TIMEOUT, () => {
  it("refuses to unlock the account's key once the server lowers its parameters, even after sign-out and a restart", async () => {
    const server = new MemoryUserKeyServer();
    const first = device(server);
    first.options.params = { ...cheap, iterations: cheap.iterations + 1 };
    await enableOnDevice(first.options, passphrase);
    expect(first.data.passphraseParams).toEqual([
      { serverUrl: "https://sync.example", issuer: "https://auth.example/", subject: "alice", ...first.options.params },
    ]);
    // A hostile server lowers the parameters it hands out.
    if (server.stored === undefined) throw new Error("no stored key");
    server.stored.params = { ...server.stored.params, iterations: cheap.iterations };
    forgetEncryptionKeys(first.data);
    const restarted = { ...first.options, data: parsePluginData(JSON.parse(first.saved.at(-1) ?? "{}")) };
    forgetEncryptionKeys(restarted.data);

    await expect(unlockOnDevice(restarted, passphrase)).rejects.toBeInstanceOf(WeakerPassphraseParamsError);
    expect(restarted.data.userKey).toBeUndefined();
  });

  it("does not hold another account's remembered parameters against this one", async () => {
    const server = new MemoryUserKeyServer();
    const alice = device(server, "alice");
    alice.options.params = { ...cheap, iterations: cheap.iterations + 1 };
    await enableOnDevice(alice.options, passphrase);
    if (server.stored === undefined) throw new Error("no stored key");
    server.stored.params = { ...server.stored.params, iterations: cheap.iterations };
    const bob = { ...alice.options, accessToken: () => Promise.resolve(tokenFor("bob")) };

    // Bob's unlock derives with the lowered parameters (and so gets the passphrase wrong) instead of being refused.
    await expect(unlockOnDevice(bob, passphrase)).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe("the pinned escrow bundle on a device", () => {
  it("keeps one pin per server in the device's plugin data, across a restart and sign-out", async () => {
    const { data, saved, options } = device(new MemoryUserKeyServer());
    const bundle = { signPub: signPublicKey(new Uint8Array(32).fill(9)), recipient: ageRecipient(generateKeyPair().publicKey) };
    const other = { signPub: signPublicKey(new Uint8Array(32).fill(10)), recipient: ageRecipient(generateKeyPair().publicKey) };
    expect(await pluginDataEscrowPin(data, options.save, "https://sync.example").load()).toBeUndefined();
    await pluginDataEscrowPin(data, options.save, "https://sync.example").save(bundle);
    await pluginDataEscrowPin(data, options.save, "https://other.example").save(other);

    const restarted = parsePluginData(JSON.parse(saved.at(-1) ?? "{}"));
    forgetEncryptionKeys(restarted);
    expect(await pluginDataEscrowPin(restarted, options.save, "https://sync.example").load()).toEqual(bundle);
    expect(await pluginDataEscrowPin(restarted, options.save, "https://other.example").load()).toEqual(other);
  });
});
