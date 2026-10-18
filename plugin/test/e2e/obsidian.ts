import { browser } from "@wdio/globals";

import { harnessId } from "./environment";
import type VaultSyncE2EHarness from "./harness/main";

// Helpers the specs share for reaching into the running Obsidian.

/** Obsidian's plugin registry is not in its public typings. */
export interface PluginRegistry {
  plugins: {
    enabledPlugins: Set<string>;
    plugins: Record<string, { _loaded?: boolean; manifest: { version: string } } | undefined>;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean>;
  };
}

type Harness = VaultSyncE2EHarness;
type HarnessMethod = { [Name in keyof Harness]: Harness[Name] extends (...args: never[]) => unknown ? Name : never }[keyof Harness] & string;
type Method<Name extends HarnessMethod> = Extract<Harness[Name], (...args: never[]) => unknown>;

/** Calls a method of the harness plugin (harness/main.ts) inside Obsidian and returns its (serialized) result. */
export async function callHarness<Name extends HarnessMethod>(
  method: Name,
  ...parameters: Parameters<Method<Name>>
): Promise<Awaited<ReturnType<Method<Name>>>> {
  const name: string = method;
  const result: unknown = await browser.executeObsidian(
    async ({ app }, id, methodName, args) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
      if (plugin === undefined) throw new Error(`plugin ${id} is not loaded`);
      const target = plugin as Record<string, ((...values: unknown[]) => unknown) | undefined>;
      const run = target[methodName];
      if (typeof run !== "function") throw new Error(`plugin ${id} has no method ${methodName}`);
      return await run.apply(plugin, args);
    },
    harnessId,
    name,
    parameters as unknown[],
  );
  return result as Awaited<ReturnType<Method<Name>>>;
}

/**
 * Runs a plugin's load again through Obsidian's own enable path and reports
 * whether it succeeded. The registry state alone cannot tell: Obsidian marks a
 * plugin loaded before calling its `onload`, and when `onload` throws (or its
 * promise rejects) it only logs "Plugin failure" and leaves the plugin
 * registered and enabled. `enablePlugin` resolves only after `onload` has
 * settled and resolves `false` when it failed, so this needs no waiting.
 * `disablePlugin` first (which runs `onunload`), because `enablePlugin` is a
 * no-op for a plugin that is already registered; neither call changes the
 * saved enabled-plugin list.
 */
export async function reloadPlugin(id: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, pluginId) => {
    const registry = (app as unknown as PluginRegistry).plugins;
    await registry.disablePlugin(pluginId);
    return registry.enablePlugin(pluginId);
  }, id);
}
