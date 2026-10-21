import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Argon2Params } from "../core/e2ee/e2ee";
import { MAX_FAILED_ATTEMPTS, MemoryUserKeyServer } from "../core/keys/memory-user-keys";
import { WrongPassphraseError } from "../core/keys/user-key";
import { createProtocolClient } from "../core/protocol/client";
import { parsePluginData, type PluginData } from "./data";
import { enableOnDevice, encryptionState, passphraseErrorMessage, unlockOnDevice, type EncryptionOptions } from "./encryption";

const cheap: Argon2Params = {
  memory: 19 * 1024,
  iterations: 2,
  parallelism: 1,
};
const passphrase = "correct horse battery staple";
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

describe("end-to-end encryption on a device", () => {
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

  it(`shows the server's retry time once ${String(MAX_FAILED_ATTEMPTS)} wrong passphrases were tried`, async () => {
    const server = new MemoryUserKeyServer(() => Date.parse("2026-10-21T12:00:00Z"));
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
  });
});
