import { describe, expect, it } from "vitest";
import { obsidianSyncEnabled } from "./obsidian-sync";

/**
 * An app whose core plugins are `enabled`, with the given instances, the way
 * Obsidian's internalPlugins answers: getEnabledPluginById returns an enabled
 * plugin's instance, and null otherwise.
 */
function appWith(enabled: Record<string, object>) {
  return {
    internalPlugins: {
      plugins: enabled,
      getEnabledPluginById(this: { plugins: Record<string, object> }, id: string) {
        return this.plugins[id] ?? null;
      },
    },
  };
}

/** The Sync core plugin's instance as Obsidian 1.14 builds it: vaultId is null until the vault is set up for Sync. */
function syncInstance(vaultId: string | null) {
  return {
    vaultId,
    getRemoteVaultId(this: { vaultId: string | null }) {
      return this.vaultId;
    },
  };
}

describe("obsidianSyncEnabled", () => {
  it("is true while the Sync core plugin syncs the vault with a remote vault", () => {
    expect(obsidianSyncEnabled(appWith({ "file-explorer": {}, sync: syncInstance("2f1c0a9e") }))).toBe(true);
  });

  it("is false while the Sync core plugin is on but not set up, as it is by default in every vault", () => {
    expect(obsidianSyncEnabled(appWith({ "file-explorer": {}, sync: syncInstance(null) }))).toBe(false);
    expect(obsidianSyncEnabled(appWith({ sync: syncInstance("") }))).toBe(false);
  });

  it("is false while the Sync core plugin is turned off", () => {
    expect(obsidianSyncEnabled(appWith({ "file-explorer": {} }))).toBe(false);
  });

  it("reads the vaultId field when the instance has no getRemoteVaultId", () => {
    expect(obsidianSyncEnabled(appWith({ sync: { vaultId: "2f1c0a9e" } }))).toBe(true);
    expect(obsidianSyncEnabled(appWith({ sync: { vaultId: null } }))).toBe(false);
  });

  it.each([
    ["no app", undefined],
    ["no internalPlugins", {}],
    ["no getEnabledPluginById", { internalPlugins: {} }],
    [
      "a getEnabledPluginById that throws",
      {
        internalPlugins: {
          getEnabledPluginById: () => {
            throw new Error("changed");
          },
        },
      },
    ],
    [
      "a getRemoteVaultId that throws",
      appWith({
        sync: {
          getRemoteVaultId: () => {
            throw new Error("changed");
          },
        },
      }),
    ],
    ["an instance that is not an object", appWith({ sync: true as unknown as object })],
  ])("is false, showing no warning, with %s", (_, app) => {
    expect(obsidianSyncEnabled(app)).toBe(false);
  });
});
