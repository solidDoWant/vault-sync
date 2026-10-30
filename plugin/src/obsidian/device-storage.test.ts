import { describe, expect, it } from "vitest";

import { parsePluginData, persistRefreshToken, type PluginData } from "./data";
import { forgetEncryptionKeys } from "./encryption";
import {
  loadDeviceSecrets,
  refreshTokenLost,
  savePluginData,
  type DeviceStorage,
} from "./device-storage";

/** Obsidian's local storage and the plugin's data.json, in memory. */
function device(
  initial: { file?: unknown; local?: Record<string, unknown> } = {},
) {
  const local = new Map<string, unknown>(Object.entries(initial.local ?? {}));
  const storage: DeviceStorage = {
    loadLocalStorage: (key) => local.get(key) ?? null,
    saveLocalStorage: (key, value) => {
      if (value === null) local.delete(key);
      else local.set(key, value);
    },
  };
  const disk = { file: initial.file };
  const save = (data: PluginData) =>
    savePluginData(data, storage, (file) => {
      disk.file = structuredClone(file);
      return Promise.resolve();
    });
  /** Loads the plugin data as onload does: data.json, then the secrets from local storage, saving if data.json held any. */
  const load = async (): Promise<PluginData> => {
    const data = parsePluginData(disk.file);
    if (loadDeviceSecrets(data, storage)) await save(data);
    return data;
  };
  return { local, storage, disk, save, load };
}

const provider = { issuer: "https://idp.example/", clientId: "vault-sync" };
const settings = {
  serverUrl: "https://sync.example",
  oidcIssuer: "",
  oidcClientId: "",
  deviceName: "",
};
const tokenKey = "vault-sync-refresh-token";

describe("the refresh token in device-local storage", () => {
  it("stores a sign-in's refresh token in local storage under a vault-sync key, never in data.json", async () => {
    const { local, disk, save, load } = device({ file: settings });
    const data = await load();

    await persistRefreshToken(data, "secret", provider, () => save(data));

    expect(local.get(tokenKey)).toBe("secret");
    expect(disk.file).toEqual({ ...settings, identityProvider: provider });
    expect(JSON.stringify(disk.file)).not.toContain("secret");
    expect((await load()).refreshToken).toBe("secret");
  });

  it("stores a rotated refresh token in local storage too", async () => {
    const { local, disk, save, load } = device({
      file: { ...settings, identityProvider: provider },
      local: { [tokenKey]: "secret" },
    });
    const data = await load();

    await persistRefreshToken(data, "rotated", undefined, () => save(data));

    expect(local.get(tokenKey)).toBe("rotated");
    expect(JSON.stringify(disk.file)).not.toContain("rotated");
    expect(await load()).toEqual({
      ...settings,
      identityProvider: provider,
      refreshToken: "rotated",
    });
  });

  it("clears the token from local storage on sign-out", async () => {
    const { local, disk, save, load } = device({
      file: { ...settings, identityProvider: provider },
      local: { [tokenKey]: "secret" },
    });
    const data = await load();

    await persistRefreshToken(data, undefined, undefined, () => save(data));

    expect(local.has(tokenKey)).toBe(false);
    expect(disk.file).toEqual(settings);
  });

  it("moves a token data.json still holds to local storage and removes it from data.json, staying signed in", async () => {
    const { local, disk, load } = device({
      file: { ...settings, refreshToken: "legacy", identityProvider: provider },
    });

    const data = await load();

    expect(data.refreshToken).toBe("legacy");
    expect(local.get(tokenKey)).toBe("legacy");
    expect(disk.file).toEqual({ ...settings, identityProvider: provider });
    expect((await load()).refreshToken).toBe("legacy");
  });

  it("keeps data.json's token over an older one in local storage", async () => {
    const { local, load } = device({
      file: { ...settings, refreshToken: "newer", identityProvider: provider },
      local: { [tokenKey]: "older" },
    });

    expect((await load()).refreshToken).toBe("newer");
    expect(local.get(tokenKey)).toBe("newer");
  });

  it("needs a sign-in when local storage was cleared after a sign-in", async () => {
    const { local, load } = device({
      file: { ...settings, identityProvider: provider },
      local: { [tokenKey]: "secret" },
    });
    local.clear();

    const data = await load();

    expect(data.refreshToken).toBeUndefined();
    expect(refreshTokenLost(data)).toBe(true);
  });

  it("does not ask for a sign-in again after a sign-out", async () => {
    const { save, load } = device({
      file: { ...settings, identityProvider: provider },
      local: { [tokenKey]: "secret" },
    });
    const data = await load();
    await persistRefreshToken(data, undefined, undefined, () => save(data));

    expect(refreshTokenLost(await load())).toBe(false);
  });

  it("ignores a local storage entry that is not a token", async () => {
    const { load } = device({ file: settings, local: { [tokenKey]: 42 } });

    expect((await load()).refreshToken).toBeUndefined();
  });
});

const account = {
  serverUrl: "https://sync.example",
  issuer: "https://idp.example/",
  subject: "alice",
};
const userKey = {
  publicKey: "ab".repeat(1216),
  privateKey: "cd".repeat(32),
  signSeed: "ef".repeat(32),
  userId: "0190a5b4-0000-7000-8000-000000000101",
  ...account,
};
const vaultKeys = {
  ...account,
  vaultId: "vault-1",
  epochs: { "1": "ef".repeat(32), "2": "12".repeat(32) },
};
const userKeyKey = "vault-sync-user-key";
const vaultKeysKey = "vault-sync-vault-keys";

describe("the encryption keys in device-local storage", () => {
  it("stores the unlocked user key and the epoch keys in local storage, never in data.json", async () => {
    const { local, disk, save, load } = device({ file: settings });
    const data = await load();

    data.userKey = structuredClone(userKey);
    data.vaultKeys = structuredClone(vaultKeys);
    await save(data);

    expect(local.get(userKeyKey)).toEqual(userKey);
    expect(local.get(vaultKeysKey)).toEqual(vaultKeys);
    expect(disk.file).toEqual(settings);
    const file = JSON.stringify(disk.file);
    expect(file).not.toContain(userKey.privateKey);
    for (const key of Object.values(vaultKeys.epochs))
      expect(file).not.toContain(key);
    const reloaded = await load();
    expect(reloaded.userKey).toEqual(userKey);
    expect(reloaded.vaultKeys).toEqual(vaultKeys);
  });

  it("moves keys data.json still holds to local storage and rewrites data.json without them", async () => {
    const { local, disk, load } = device({
      file: { ...settings, userKey, vaultKeys },
    });

    const data = await load();

    expect(data.userKey).toEqual(userKey);
    expect(data.vaultKeys).toEqual(vaultKeys);
    expect(local.get(userKeyKey)).toEqual(userKey);
    expect(local.get(vaultKeysKey)).toEqual(vaultKeys);
    expect(disk.file).toEqual(settings);
    expect(JSON.stringify(disk.file)).not.toContain(userKey.privateKey);
    const reloaded = await load();
    expect(reloaded.userKey).toEqual(userKey);
    expect(reloaded.vaultKeys).toEqual(vaultKeys);
  });

  it("moves epoch keys alone when data.json holds no user key", async () => {
    const { local, disk, load } = device({ file: { ...settings, vaultKeys } });

    await load();

    expect(local.get(vaultKeysKey)).toEqual(vaultKeys);
    expect(disk.file).toEqual(settings);
  });

  it("clears the keys from local storage when they are forgotten on sign-out", async () => {
    const { local, save, load } = device({
      file: settings,
      local: { [userKeyKey]: userKey, [vaultKeysKey]: vaultKeys },
    });
    const data = await load();

    forgetEncryptionKeys(data);
    await save(data);

    expect(local.has(userKeyKey)).toBe(false);
    expect(local.has(vaultKeysKey)).toBe(false);
  });

  it("ignores malformed keys in local storage", async () => {
    const { load } = device({
      file: settings,
      local: {
        [userKeyKey]: { ...userKey, privateKey: "zz" },
        [vaultKeysKey]: "keys",
      },
    });

    const data = await load();

    expect(data.userKey).toBeUndefined();
    expect(data.vaultKeys).toBeUndefined();
  });
});
