import type { App, DataAdapter, EventRef } from "obsidian";

import { configReloadMessage } from "../core/config/policy";
import { VaultError, type FileStat, type VaultAdapter, type VaultListener } from "../core/vault/adapter";

// Type-only Obsidian imports: the unit tests run this on a fake DataAdapter.

/** What ObsidianConfigAdapter needs of Obsidian's vault. */
export interface ConfigFolderHost {
  /** The config folder, vault-relative (`app.vault.configDir`; `.obsidian` unless the user renamed it). */
  readonly configDir: string;
  readonly adapter: Pick<DataAdapter, "stat" | "list" | "readBinary" | "writeBinary" | "mkdir" | "remove" | "rename">;
  /**
   * Subscribes to Obsidian's "raw" vault event, which names every path that
   * changed on disk, hidden folders included (desktop; Obsidian indexes no
   * files in the config folder, so it reports no other events for them).
   * Returns an unsubscribe function.
   */
  onRaw(listener: (path: string) => void): () => void;
}

/** The config folder host of the open vault. */
export function configFolderHost(app: App): ConfigFolderHost {
  const vault = app.vault;
  return {
    configDir: vault.configDir,
    adapter: vault.adapter,
    onRaw: (listener) => {
      // "raw" is not in Obsidian's public typings.
      const on = vault.on.bind(vault) as unknown as (name: "raw", callback: (path: string) => void) => EventRef;
      const reference = on("raw", listener);
      return () => {
        vault.offref(reference);
      };
    },
  };
}

/**
 * The config folder as a VaultAdapter over Obsidian's DataAdapter (SPEC.md
 * §8, #28), with paths relative to the folder ("hotkeys.json"), whatever the
 * folder is called. ConfigSyncVault (src/core/config/config-vault.ts) decides
 * which of its files sync and is the only caller.
 *
 * Changes are reported from Obsidian's "raw" events, each as a "modify" of
 * the path: the engine tells by content hash whether the file was created,
 * changed or deleted. Where Obsidian reports no raw events (the mobile apps),
 * changes are found by the scan of every engine start.
 */
export class ObsidianConfigAdapter implements VaultAdapter {
  constructor(private readonly host: ConfigFolderHost) {}

  private get adapter() {
    return this.host.adapter;
  }

  async list(): Promise<string[]> {
    const root = this.host.configDir;
    if ((await this.adapter.stat(root))?.type !== "folder") return [];
    const files: string[] = [];
    const folders = [root];
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
      const listed = await this.adapter.list(folder);
      files.push(...listed.files);
      folders.push(...listed.folders);
    }
    return files.map((path) => this.relative(path)).filter((path): path is string => path !== undefined);
  }

  async read(path: string): Promise<Uint8Array> {
    await this.requireFile(path);
    return new Uint8Array(await this.adapter.readBinary(this.full(path)));
  }

  async stat(path: string): Promise<FileStat | null> {
    const stat = await this.adapter.stat(this.full(path));
    return stat?.type === "file" ? { size: stat.size, mtime: stat.mtime } : null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if ((await this.adapter.stat(this.full(path)))?.type === "folder") throw new VaultError("path-conflict", path);
    await this.ensureParentFolders(path);
    await this.adapter.writeBinary(this.full(path), new Uint8Array(data).buffer);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.requireFile(from);
    if (from === to) return;
    const target = await this.adapter.stat(this.full(to));
    if (target?.type === "folder") throw new VaultError("path-conflict", to);
    // A rename that changes only letter case finds the file itself at `to` on a case-insensitive disk.
    if (target !== null && from.toLowerCase() !== to.toLowerCase()) throw new VaultError("already-exists", to);
    await this.ensureParentFolders(to);
    await this.adapter.rename(this.full(from), this.full(to));
  }

  async delete(path: string): Promise<void> {
    await this.requireFile(path);
    await this.adapter.remove(this.full(path));
  }

  watch(listener: VaultListener): () => void {
    return this.host.onRaw((path) => {
      const relative = this.relative(path);
      if (relative !== undefined && relative !== "") listener({ type: "modify", path: relative });
    });
  }

  private full(path: string): string {
    return `${this.host.configDir}/${path}`;
  }

  /** A vault-relative path as a path in the config folder, if it is in it. */
  private relative(path: string): string | undefined {
    const prefix = `${this.host.configDir}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  private async requireFile(path: string): Promise<void> {
    if ((await this.adapter.stat(this.full(path)))?.type !== "file") throw new VaultError("not-found", path);
  }

  /** Creates the missing ancestor folders of `path`; "path-conflict" if one of them is a file. */
  private async ensureParentFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index++) {
      const folder = this.full(segments.slice(0, index).join("/"));
      const stat = await this.adapter.stat(folder);
      if (stat?.type === "file") throw new VaultError("path-conflict", path);
      if (stat === null) await this.adapter.mkdir(folder);
    }
  }
}

/**
 * Collects the config files sync changed (paths relative to the config
 * folder) and, `delayMs` after the last one of a burst, shows one message
 * asking the user to reload Obsidian (configReloadMessage). Obsidian is never
 * reloaded on its own: the user may be in the middle of something.
 */
export function reloadNotifier(show: (message: string) => void, delayMs: number): (relative: string) => void {
  let changed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (relative) => {
    changed.push(relative);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const message = configReloadMessage(changed);
      changed = [];
      if (message !== undefined) show(message);
    }, delayMs);
  };
}
