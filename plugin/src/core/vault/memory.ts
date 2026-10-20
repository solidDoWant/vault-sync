import { sha256Hex } from "../hash";
import { PathSpace } from "../engine/pathspace";
import { posixPathRules, unmaterializableReason, type PathRules } from "../vaultpath/platform";
import { VaultError, type DeletePrecondition, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener, type WritePrecondition } from "./adapter";

export interface InMemoryVaultOptions {
  /** Clock for mtimes; inject a deterministic one in the simulation. Defaults to Date.now. */
  now?: () => number;
  /**
   * The file-name rules of the platform the vault models (SPEC.md §8).
   * Writes and renames to a path the platform cannot hold reject with
   * "unmaterializable". Under `windows` and `macos` rules, paths are matched
   * as those platforms' filesystems match them, ignoring case and Unicode
   * form (by the engine's file key, PathSpace), and a file keeps the spelling it was
   * created with. Defaults to `posix`, which is case-sensitive.
   */
  pathRules?: PathRules;
}

interface StoredFile {
  /** The path as the file was created (or last renamed). */
  path: string;
  data: Uint8Array;
  mtime: number;
}

/**
 * A VaultAdapter backed by a Map, for unit tests and the simulation harness.
 * Events are delivered synchronously, in order, after each change is applied.
 * Preconditions are checked synchronously with the change, so atomically.
 */
export class InMemoryVault implements VaultAdapter {
  /** Files by lookup key: the path itself, or its file key (PathSpace) on a case-insensitive platform. */
  private readonly files = new Map<string, StoredFile>();
  private readonly listeners = new Set<VaultListener>();
  private readonly now: () => number;
  private readonly pathRules: PathRules;
  private readonly key: (path: string) => string;

  /**
   * Called when a listener throws. The change itself has already been applied
   * and other listeners still run. Defaults to rethrowing asynchronously so
   * the error is not swallowed.
   */
  onListenerError: (error: unknown) => void = (error) => {
    setTimeout(() => {
      throw error;
    });
  };

  constructor(options: InMemoryVaultOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pathRules = options.pathRules ?? posixPathRules;
    this.key = new PathSpace(this.pathRules).fileKey;
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.values()].map((file) => file.path));
  }

  read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.key(path));
    if (file === undefined) return Promise.reject(new VaultError("not-found", path));
    return Promise.resolve(file.data.slice());
  }

  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    const existing = this.files.get(this.key(path));
    if (precondition !== undefined && !holds(existing, precondition.expectedHash)) return Promise.reject(new VaultError("changed", path));
    if (existing === undefined) {
      if (unmaterializableReason(path, this.pathRules) !== undefined) return Promise.reject(new VaultError("unmaterializable", path));
      if (this.conflicts(path)) return Promise.reject(new VaultError("path-conflict", path));
    }
    // An existing file keeps its name, as a case-insensitive filesystem keeps it.
    const stored = existing?.path ?? path;
    this.files.set(this.key(path), { path: stored, data: data.slice(), mtime: this.now() });
    this.emit(existing === undefined ? { type: "create", path: stored } : { type: "modify", path: stored });
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    const file = this.files.get(this.key(from));
    if (file === undefined) return Promise.reject(new VaultError("not-found", from));
    if (file.path === to) return Promise.resolve();
    if (this.key(from) !== this.key(to) && this.files.has(this.key(to))) return Promise.reject(new VaultError("already-exists", to));
    if (unmaterializableReason(to, this.pathRules) !== undefined) return Promise.reject(new VaultError("unmaterializable", to));
    // The moving file is no folder in its own way: folders exist only as the ancestors of files.
    if (this.conflicts(to, this.key(from))) return Promise.reject(new VaultError("path-conflict", to));
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...file, path: to });
    this.emit({ type: "rename", path: to, oldPath: file.path });
    return Promise.resolve();
  }

  /**
   * Renames the folder `from` to `to` as a user would in Obsidian's file
   * explorer (not part of VaultAdapter, which models files only): every file
   * in it moves, and each move is reported as a rename, as Obsidian reports
   * them. Rejects, moving nothing, with "not-found" if no file is in `from`,
   * "already-exists" if a file would land on another, "path-conflict" if
   * `to` is a file or under one, and "unmaterializable" if a moved file's
   * path is one the platform cannot hold.
   */
  renameFolder(from: string, to: string): Promise<void> {
    const prefix = `${this.key(from)}/`;
    const depth = from.split("/").length;
    const moves = [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, file]) => [key, file, [to, ...file.path.split("/").slice(depth)].join("/")] as const);
    if (moves.length === 0) return Promise.reject(new VaultError("not-found", from));
    const moving = new Set(moves.map(([key]) => key));
    const clash = moves.find(([, , target]) => this.files.has(this.key(target)) && !moving.has(this.key(target)));
    if (clash !== undefined) return Promise.reject(new VaultError("already-exists", clash[2]));
    const illegal = moves.find(([, , target]) => unmaterializableReason(target, this.pathRules) !== undefined);
    if (illegal !== undefined) return Promise.reject(new VaultError("unmaterializable", illegal[2]));
    const toKey = this.key(to);
    if ([...this.files.keys()].some((key) => !moving.has(key) && (key === toKey || toKey.startsWith(`${key}/`)))) return Promise.reject(new VaultError("path-conflict", to));
    for (const [key] of moves) this.files.delete(key);
    for (const [, file, target] of moves) this.files.set(this.key(target), { ...file, path: target });
    for (const [, file, target] of moves) this.emit({ type: "rename", path: target, oldPath: file.path });
    return Promise.resolve();
  }

  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    const file = this.files.get(this.key(path));
    if (file === undefined) return Promise.reject(new VaultError("not-found", path));
    if (precondition !== undefined && !holds(file, precondition.expectedHash)) return Promise.reject(new VaultError("changed", path));
    this.files.delete(this.key(path));
    this.emit({ type: "delete", path: file.path });
    return Promise.resolve();
  }

  stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(this.key(path));
    return Promise.resolve(file === undefined ? null : { size: file.data.byteLength, mtime: file.mtime });
  }

  watch(listener: VaultListener): () => void {
    // Wrap so the same function can be subscribed twice and unsubscribed independently.
    const subscription: VaultListener = (event) => {
      listener(event);
    };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }

  /** Whether a new file at `path` would collide with a folder or sit under a file (other than the one at `ignored`, a key). */
  private conflicts(path: string, ignored?: string): boolean {
    const key = this.key(path);
    const folderPrefix = `${key}/`;
    for (const existing of this.files.keys()) {
      if (existing === ignored) continue;
      if (existing.startsWith(folderPrefix) || key.startsWith(`${existing}/`)) return true;
    }
    return false;
  }

  private emit(event: VaultEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}

/** Whether `file` is what a precondition expects: absent for null, else content with that hash. */
function holds(file: StoredFile | undefined, expectedHash: string | null): boolean {
  if (file === undefined) return expectedHash === null;
  return expectedHash !== null && sha256Hex(file.data) === expectedHash;
}
