import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { e2eEnvironment, pluginId } from "../environment";

type Clamp = (x: number, lo: number, hi: number) => number;

/**
 * Calls the Dafny-compiled clamp (plugin/verified/Clamp.dfy) through the
 * loaded plugin's `verified` wrappers inside Obsidian, once per case, and
 * returns each result or the error it threw.
 */
function clampInObsidian(cases: [number, number, number][]) {
  return browser.executeObsidian(
    ({ app }, id, inputs) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, { verified?: { clamp?: Clamp } } | undefined> } }).plugins.plugins[id];
      const clamp = plugin?.verified?.clamp;
      if (typeof clamp !== "function") throw new Error(`plugin ${id} exposes no verified.clamp`);
      return inputs.map(([x, lo, hi]) => {
        try {
          return { value: clamp(x, lo, hi) };
        } catch (error) {
          return { error: error instanceof Error ? error.name : String(error) };
        }
      });
    },
    pluginId,
    cases,
  );
}

describe("Dafny-verified code in Obsidian (#946)", function () {
  it("runs the compiled module from the plugin bundle on this platform", async function () {
    // The platform this leg claims to run on, so a pass is evidence for it.
    const platform = await obsidianPage.getPlatform();
    expect(platform.isMobile).toBe(e2eEnvironment.emulateMobile || e2eEnvironment.android);

    expect(
      await clampInObsidian([
        [5, 0, 10],
        [-3, 0, 10],
        [42, 0, 10],
        [10, 0, 10],
        [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 7],
        [1, 2, 1],
      ]),
    ).toEqual([{ value: 5 }, { value: 0 }, { value: 10 }, { value: 10 }, { value: 7 }, { error: "RangeError" }]);
  });
});
