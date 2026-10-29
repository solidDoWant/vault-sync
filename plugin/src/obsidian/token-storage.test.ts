import { describe, expect, it } from "vitest";

import { parsePluginData, persistRefreshToken, type PluginData } from "./data";
import { loadRefreshToken, refreshTokenLost, savePluginData, type DeviceStorage } from "./token-storage";

/** Obsidian's local storage and the plugin's data.json, in memory. */
function device(initial: { file?: unknown; local?: Record<string, unknown> } = {}) {
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
  /** Loads the plugin data as onload does: data.json, then the token from local storage, saving if data.json held one. */
  const load = async (): Promise<PluginData> => {
    const data = parsePluginData(disk.file);
    if (loadRefreshToken(data, storage)) await save(data);
    return data;
  };
  return { local, storage, disk, save, load };
}

const provider = { issuer: "https://idp.example/", clientId: "vault-sync" };
const settings = { serverUrl: "https://sync.example", oidcIssuer: "", oidcClientId: "", deviceName: "" };
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
    const { local, disk, save, load } = device({ file: { ...settings, identityProvider: provider }, local: { [tokenKey]: "secret" } });
    const data = await load();

    await persistRefreshToken(data, "rotated", undefined, () => save(data));

    expect(local.get(tokenKey)).toBe("rotated");
    expect(JSON.stringify(disk.file)).not.toContain("rotated");
    expect(await load()).toEqual({ ...settings, identityProvider: provider, refreshToken: "rotated" });
  });

  it("clears the token from local storage on sign-out", async () => {
    const { local, disk, save, load } = device({ file: { ...settings, identityProvider: provider }, local: { [tokenKey]: "secret" } });
    const data = await load();

    await persistRefreshToken(data, undefined, undefined, () => save(data));

    expect(local.has(tokenKey)).toBe(false);
    expect(disk.file).toEqual(settings);
  });

  it("moves a token data.json still holds to local storage and removes it from data.json, staying signed in", async () => {
    const { local, disk, load } = device({ file: { ...settings, refreshToken: "legacy", identityProvider: provider } });

    const data = await load();

    expect(data.refreshToken).toBe("legacy");
    expect(local.get(tokenKey)).toBe("legacy");
    expect(disk.file).toEqual({ ...settings, identityProvider: provider });
    expect((await load()).refreshToken).toBe("legacy");
  });

  it("keeps data.json's token over an older one in local storage", async () => {
    const { local, load } = device({ file: { ...settings, refreshToken: "newer", identityProvider: provider }, local: { [tokenKey]: "older" } });

    expect((await load()).refreshToken).toBe("newer");
    expect(local.get(tokenKey)).toBe("newer");
  });

  it("needs a sign-in when local storage was cleared after a sign-in", async () => {
    const { local, load } = device({ file: { ...settings, identityProvider: provider }, local: { [tokenKey]: "secret" } });
    local.clear();

    const data = await load();

    expect(data.refreshToken).toBeUndefined();
    expect(refreshTokenLost(data)).toBe(true);
  });

  it("does not ask for a sign-in again after a sign-out", async () => {
    const { save, load } = device({ file: { ...settings, identityProvider: provider }, local: { [tokenKey]: "secret" } });
    const data = await load();
    await persistRefreshToken(data, undefined, undefined, () => save(data));

    expect(refreshTokenLost(await load())).toBe(false);
  });

  it("ignores a local storage entry that is not a token", async () => {
    const { load } = device({ file: settings, local: { [tokenKey]: 42 } });

    expect((await load()).refreshToken).toBeUndefined();
  });
});
