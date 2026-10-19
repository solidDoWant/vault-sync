import { describe, expect, it } from "vitest";

import { configSyncSettings, oidcConfig, parsePluginData, serialized, serverBaseUrl, signInProblem, type PluginData } from "./data";

const complete: PluginData = { serverUrl: "https://sync.example", oidcIssuer: "https://auth.example/o/vs/", oidcClientId: "vault-sync", deviceName: "" };

describe("parsePluginData", () => {
  it("defaults everything when nothing is stored", () => {
    expect(parsePluginData(null)).toEqual({ serverUrl: "", oidcIssuer: "", oidcClientId: "", deviceName: "" });
  });

  it("keeps stored fields, including the refresh token, the device and the connected vault", () => {
    const stored: PluginData = {
      ...complete,
      deviceName: "Laptop",
      refreshToken: "secret",
      identityProvider: { issuer: "https://auth.example/o/vs/", clientId: "vault-sync" },
      device: { id: "device-1", serverUrl: "https://sync.example", issuer: "https://auth.example/o/vs/", subject: "user-1" },
      vault: { id: "vault-1", name: "Notes", serverUrl: "https://sync.example" },
    };
    expect(parsePluginData(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("ignores fields of the wrong type, an empty refresh token, and incomplete device and vault records", () => {
    const stored = {
      serverUrl: 5,
      oidcIssuer: "https://auth.example/",
      refreshToken: "",
      identityProvider: { issuer: "https://auth.example/" },
      device: { id: "device-1", serverUrl: "https://sync.example", issuer: "https://auth.example/" },
      vault: { id: "", name: "Notes", serverUrl: "https://sync.example" },
    };
    expect(parsePluginData(stored)).toEqual({ serverUrl: "", oidcIssuer: "https://auth.example/", oidcClientId: "", deviceName: "" });
  });
});

describe("config sync settings", () => {
  it("are off when nothing is stored", () => {
    expect(configSyncSettings(parsePluginData(null)).enabled).toBe(false);
    expect(configSyncSettings(parsePluginData({ configSync: "yes" })).enabled).toBe(false);
  });

  it("keep what this device stored, turning a switch on only for true", () => {
    const stored = { configSync: { enabled: true, categories: { themes: false, snippets: true, hotkeys: "yes", pluginList: true, plugins: 1 } } };
    expect(configSyncSettings(parsePluginData(stored))).toEqual({ enabled: true, categories: { themes: false, snippets: true, hotkeys: true, pluginList: true, plugins: false } });
    expect(configSyncSettings(parsePluginData({ configSync: { enabled: "true" } })).enabled).toBe(false);
  });
});

describe("signInProblem", () => {
  it("accepts complete https settings", () => {
    expect(signInProblem(complete)).toBeUndefined();
  });

  it("asks for the server URL", () => {
    expect(signInProblem({ ...complete, serverUrl: " " })).toBe("Enter the server URL.");
  });

  it("needs only the server URL: the issuer and client id are optional overrides of what the server advertises", () => {
    expect(signInProblem({ ...complete, oidcIssuer: "", oidcClientId: "" })).toBeUndefined();
    expect(signInProblem({ ...complete, oidcIssuer: " ", oidcClientId: "" })).toBeUndefined();
  });

  it("refuses plain http except to localhost, so tokens never travel in the clear", () => {
    expect(signInProblem({ ...complete, serverUrl: "http://sync.example" })).toMatch(/server URL must use https/);
    expect(signInProblem({ ...complete, oidcIssuer: "http://auth.example/" })).toMatch(/issuer URL must use https/);
    expect(signInProblem({ ...complete, serverUrl: "http://127.0.0.1:8080", oidcIssuer: "http://localhost:9000/" })).toBeUndefined();
    expect(signInProblem({ ...complete, serverUrl: "sync.example" })).toMatch(/not a valid URL/);
  });
});

describe("oidcConfig", () => {
  it("is the identity provider resolved at sign-in while one is stored, whatever the settings say", () => {
    const identityProvider = { issuer: "https://discovered.example/", clientId: "discovered" };
    expect(oidcConfig({ ...complete, identityProvider })).toEqual(identityProvider);
  });

  it("falls back to the settings, trimmed, for a sign-in from before the provider was stored", () => {
    expect(oidcConfig({ ...complete, oidcIssuer: " https://auth.example/o/vs/ ", oidcClientId: " vault-sync " })).toEqual({ issuer: "https://auth.example/o/vs/", clientId: "vault-sync" });
  });
});

describe("serverBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(serverBaseUrl({ ...complete, serverUrl: " https://sync.example/base// " })).toBe("https://sync.example/base");
  });
});

describe("serialized", () => {
  /** A saveData stand-in: it snapshots the data when called, and the snapshot lands on disk when the test completes the write. */
  function fakeStorage() {
    const data: PluginData = { ...complete, refreshToken: "old-session" };
    const disk: { stored: PluginData | undefined } = { stored: undefined };
    const writes: { complete: () => void; fail: () => void }[] = [];
    const saveData = (snapshot: PluginData) =>
      new Promise<void>((resolve, reject) => {
        writes.push({
          complete: () => {
            disk.stored = snapshot;
            resolve();
          },
          fail: () => {
            reject(new Error("disk full"));
          },
        });
      });
    return { data, disk, writes, save: serialized(() => saveData({ ...data })) };
  }

  it("starts a save only after the previous one finished, so the last data saved is what ends on disk", async () => {
    const { data, disk, writes, save } = fakeStorage();

    const first = save();
    await settle();
    delete data.refreshToken;
    const second = save();
    await settle();
    // The sign-out's save waits for the earlier one instead of racing it.
    expect(writes).toHaveLength(1);

    writes[0]?.complete();
    await first;
    await settle();
    expect(writes).toHaveLength(2);
    writes[1]?.complete();
    await second;

    expect(disk.stored).toEqual(complete);
  });

  it("runs the next save after one fails, and reports each save's own outcome", async () => {
    const { disk, writes, save } = fakeStorage();

    const first = save();
    const second = save();
    await settle();
    writes[0]?.fail();
    await expect(first).rejects.toThrow(/disk full/);
    await settle();
    writes[1]?.complete();

    await expect(second).resolves.toBeUndefined();
    expect(disk.stored).toEqual({ ...complete, refreshToken: "old-session" });
  });
});

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
