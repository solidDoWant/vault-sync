/** The id of Obsidian's own Sync core plugin. */
const obsidianSyncId = "sync";

/** What vault-sync reads of the Sync core plugin's instance: the remote vault it syncs with, if any. */
interface ObsidianSyncInstance {
  getRemoteVaultId?: unknown;
  vaultId?: unknown;
}

/**
 * Whether Obsidian Sync syncs `app`'s vault: its Sync core plugin is enabled
 * and connected to a remote vault. The core plugin is enabled by default in
 * every vault, so being enabled alone means nothing; Obsidian itself treats
 * a vault as set up for Sync once the instance holds a remote vault id.
 *
 * Obsidian exposes core plugins only through its private `internalPlugins`,
 * so this reads them defensively: when anything is missing or has another
 * shape, it answers false, and the settings show no warning rather than a
 * wrong one.
 */
export function obsidianSyncEnabled(app: unknown): boolean {
  const internal = (app as { internalPlugins?: { getEnabledPluginById?: unknown } } | null | undefined)?.internalPlugins;
  if (typeof internal?.getEnabledPluginById !== "function") return false;
  try {
    const instance = (internal.getEnabledPluginById as (id: string) => unknown).call(internal, obsidianSyncId) as ObsidianSyncInstance | null | undefined;
    if (instance === null || typeof instance !== "object") return false;
    const remoteVaultId = typeof instance.getRemoteVaultId === "function" ? (instance.getRemoteVaultId as () => unknown).call(instance) : instance.vaultId;
    return typeof remoteVaultId === "string" && remoteVaultId !== "";
  } catch {
    return false;
  }
}
