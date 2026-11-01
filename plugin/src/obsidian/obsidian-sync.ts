/** The id of Obsidian's own Sync core plugin. */
const obsidianSyncId = "sync";

/**
 * Whether Obsidian's own Sync core plugin is turned on in `app`'s vault.
 * Obsidian exposes core plugins only through its private `internalPlugins`.
 * When that is missing or has another shape, this answers false, so the
 * settings show no warning rather than a wrong one.
 */
export function obsidianSyncEnabled(app: unknown): boolean {
  const internal = (app as { internalPlugins?: { getEnabledPluginById?: unknown } } | null | undefined)?.internalPlugins;
  if (typeof internal?.getEnabledPluginById !== "function") return false;
  try {
    return (internal.getEnabledPluginById as (id: string) => unknown).call(internal, obsidianSyncId) != null;
  } catch {
    return false;
  }
}
