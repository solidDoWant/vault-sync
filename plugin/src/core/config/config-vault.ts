import { isVaultError, VaultError, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener } from "../vault/adapter";
import { configPathSynced, neverSynced, type ConfigSyncSettings } from "./policy";

/**
 * The folder config files sync under on the server, whatever the config
 * folder is called on each device: a device whose config folder is
 * `.obsidian-mobile` keeps `.obsidian/hotkeys.json` in
 * `.obsidian-mobile/hotkeys.json`.
 */
export const configPrefix = ".obsidian";

export interface ConfigSyncVaultOptions {
  /** The vault without its config folder (ObsidianVaultAdapter in the plugin, which never holds hidden paths). */
  notes: VaultAdapter;
  /** The config folder, with paths relative to it ("hotkeys.json"). Never touched while config sync is off. */
  config: VaultAdapter;
  settings: ConfigSyncSettings;
  /** This plugin's own folders, relative to the config folder (policy.ts, neverSynced). */
  ownFolders?: readonly string[];
  /**
   * Called after this adapter wrote, renamed or deleted a config file, with
   * the path relative to the config folder. Only the engine writes through
   * this adapter, so these are changes sync made, which Obsidian picks up
   * only after a reload (configReloadMessage).
   */
  onConfigChange?: (relative: string) => void;
}

/**
 * The vault the engine syncs when config sync may be on (SPEC.md §8, #28):
 * the notes vault plus the config folder, under the `.obsidian/` prefix.
 *
 * - list() and the change events cover only what syncs: the notes, and the
 *   config files the device's settings select (configPathSynced).
 * - isSynced() tells the engine the same, so a config file that goes out of
 *   scope (the toggle or a category turned off) is left alone, never pushed
 *   as a delete, and a remote revision for one is deferred, not applied.
 * - With config sync off, the config folder is not touched at all: reads find
 *   nothing and writes are refused as "path-conflict", as for any hidden path.
 * - With it on, files that never sync (neverSynced: device-local files and
 *   this plugin's own folder) can still not be read or written. Other config
 *   files can, so a conflict copy next to a synced config file can be made
 *   and is never confused with a free name.
 */
export class ConfigSyncVault implements VaultAdapter {
  private readonly notes: VaultAdapter;
  private readonly config: VaultAdapter;
  private readonly settings: ConfigSyncSettings;
  private readonly ownFolders: readonly string[];
  private readonly onConfigChange: (relative: string) => void;

  constructor(options: ConfigSyncVaultOptions) {
    this.notes = options.notes;
    this.config = options.config;
    this.settings = structuredClone(options.settings);
    this.ownFolders = [...(options.ownFolders ?? [])];
    this.onConfigChange = options.onConfigChange ?? (() => undefined);
  }

  /** Whether the engine syncs `path`: any path outside the config folder, and the config files the settings select. */
  isSynced(path: string): boolean {
    const relative = configRelative(path);
    return relative === undefined || configPathSynced(relative, { settings: this.settings, ownFolders: this.ownFolders });
  }

  async list(): Promise<string[]> {
    const notes = (await this.notes.list()).filter((path) => configRelative(path) === undefined);
    if (!this.settings.enabled) return notes;
    const config = (await this.config.list()).map((relative) => `${configPrefix}/${relative}`).filter((path) => this.isSynced(path));
    return [...notes, ...config];
  }

  read(path: string): Promise<Uint8Array> {
    const relative = configRelative(path);
    if (relative === undefined) return this.notes.read(path);
    if (!this.accessible(relative)) return Promise.reject(new VaultError("not-found", path));
    return this.inConfig(path, () => this.config.read(relative));
  }

  stat(path: string): Promise<FileStat | null> {
    const relative = configRelative(path);
    if (relative === undefined) return this.notes.stat(path);
    if (!this.accessible(relative)) return Promise.resolve(null);
    return this.inConfig(path, () => this.config.stat(relative));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const relative = configRelative(path);
    if (relative === undefined) return this.notes.write(path, data);
    if (!this.accessible(relative)) throw new VaultError("path-conflict", path);
    await this.inConfig(path, () => this.config.write(relative, data));
    this.changed(relative);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = configRelative(from);
    const target = configRelative(to);
    if (source === undefined && target === undefined) return this.notes.rename(from, to);
    if (source === undefined || target === undefined) {
      // Between the notes and the config folder: not a move either side can make.
      if ((await this.stat(from)) === null) throw new VaultError("not-found", from);
      throw new VaultError("path-conflict", to);
    }
    if (!this.accessible(source)) throw new VaultError("not-found", from);
    if (!this.accessible(target)) throw new VaultError("path-conflict", to);
    await this.inConfig(from, () => this.config.rename(source, target), to);
    this.changed(source);
    this.changed(target);
  }

  async delete(path: string): Promise<void> {
    const relative = configRelative(path);
    if (relative === undefined) return this.notes.delete(path);
    if (!this.accessible(relative)) throw new VaultError("not-found", path);
    await this.inConfig(path, () => this.config.delete(relative));
    this.changed(relative);
  }

  watch(listener: VaultListener): () => void {
    const stopNotes = this.notes.watch((event) => {
      if (configRelative(event.path) === undefined && (event.type !== "rename" || configRelative(event.oldPath) === undefined)) listener(event);
    });
    if (!this.settings.enabled) return stopNotes;
    const stopConfig = this.config.watch((event) => {
      for (const mapped of this.configEvents(event)) listener(mapped);
    });
    return () => {
      stopNotes();
      stopConfig();
    };
  }

  /** A config folder event as the engine sees it: only synced paths, a rename across the scope's edge as a delete or a create. */
  private configEvents(event: VaultEvent): VaultEvent[] {
    const path = `${configPrefix}/${event.path}`;
    const synced = this.isSynced(path);
    if (event.type !== "rename") return synced ? [{ type: event.type, path }] : [];
    const oldPath = `${configPrefix}/${event.oldPath}`;
    const wasSynced = this.isSynced(oldPath);
    if (synced && wasSynced) return [{ type: "rename", path, oldPath }];
    if (synced) return [{ type: "create", path }];
    if (wasSynced) return [{ type: "delete", path: oldPath }];
    return [];
  }

  /** Whether a config path may be read or written at all: config sync is on and the path is not one that never syncs. */
  private accessible(relative: string): boolean {
    return this.settings.enabled && !neverSynced(relative, this.ownFolders);
  }

  private changed(relative: string): void {
    try {
      this.onConfigChange(relative);
    } catch (error) {
      setTimeout(() => {
        throw error;
      });
    }
  }

  /** Runs a config folder operation, reporting its VaultErrors under the vault's paths (`path`, or `to` for a rename's target errors). */
  private async inConfig<T>(path: string, operation: () => Promise<T>, to?: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isVaultError(error)) throw error;
      const target = to !== undefined && error.code !== "not-found" ? to : path;
      throw new VaultError(error.code, target);
    }
  }
}

/** `path` relative to the config folder, if it is inside it (".obsidian" itself counts, as ""). */
export function configRelative(path: string): string | undefined {
  if (path === configPrefix) return "";
  return path.startsWith(`${configPrefix}/`) ? path.slice(configPrefix.length + 1) : undefined;
}
