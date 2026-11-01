import { describe, expect, it } from "vitest";
import { obsidianSyncEnabled } from "./obsidian-sync";

/** An app whose core plugins are `enabled`, the way Obsidian's internalPlugins answers. */
function appWith(enabled: string[]) {
  return {
    internalPlugins: {
      plugins: Object.fromEntries(enabled.map((id) => [id, { id }])),
      getEnabledPluginById(this: { plugins: Record<string, unknown> }, id: string) {
        return this.plugins[id] ?? null;
      },
    },
  };
}

describe("obsidianSyncEnabled", () => {
  it("is true while the Sync core plugin is turned on", () => {
    expect(obsidianSyncEnabled(appWith(["file-explorer", "sync"]))).toBe(true);
  });

  it("is false while the Sync core plugin is turned off", () => {
    expect(obsidianSyncEnabled(appWith(["file-explorer"]))).toBe(false);
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
  ])("is false, showing no warning, with %s", (_, app) => {
    expect(obsidianSyncEnabled(app)).toBe(false);
  });
});
