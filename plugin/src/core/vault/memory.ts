import { sha256Hex } from "../hash";
import { PathSpace } from "../vaultpath/pathspace";
import { posixPathRules, unmaterializableReason, type PathRules } from "../vaultpath/platform";
import { VaultError, type DeletePrecondition, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener, type WritePrecondition } from "./adapter";

export interface InMemoryVaultOptions {
  /** Clock for mtimes; inject a deterministic one in tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * The file-name rules of the platform the vault models (SPEC.md §8).
   * Writes and renames to a path the platform cannot hold reject with
   * "unmaterializable". Under `windows` and `macos` rules, paths are matched
   * as those platforms' filesystems match them (PathSpace.filesystemKey,
   * `F`, docs/design/engine-path-ownership.md §3.1), as NTFS and APFS do:
   * `Straße.md` and `STRASSE.md` are two files, so are NFC and NFD
   * `Café.md` under `windows`, while `ı.md` and `I.md` are one. A file keeps
   * the spelling it was created with. A folder, too, has one spelling: a
   * file written or moved into another spelling of an existing folder lands
   * in it, under the spelling it already has. Defaults to `posix`,
   * which is case-sensitive.
   */
  pathRules?: PathRules;
  /**
   * Whether the vault models a platform with an atomic replace (desktop):
   * then it has `replace`. False models mobile, which has none. Defaults to
   * true.
   */
  atomicReplace?: boolean;
}

/** Who made a change, as tests tell them apart (InMemoryVault.handle). */
export type VaultActor = "user" | "engine";

/**
 * A change as the harness's inode tap sees it (docs/design/engine-path-ownership.md
 * §5.4): the event, the inode of the file it changed and who changed it. A
 * create mints an inode, a write or a rename (by anyone) keeps it, a delete
 * ends it.
 */
export type InodeEvent = VaultEvent & { inode: number; actor: VaultActor };

/** A view of an InMemoryVault whose changes are attributed to one actor. */
export interface VaultHandle extends VaultAdapter {
  /** As InMemoryVault.renameFolder. */
  renameFolder(from: string, to: string): Promise<void>;
}

interface StoredFile {
  /** The path as the file was created (or last renamed). */
  path: string;
  data: Uint8Array;
  mtime: number;
  /** The harness inode: minted on create, kept by writes and renames. */
  inode: number;
}

/**
 * A VaultAdapter backed by a Map, for unit tests.
 * Events are delivered synchronously, in order, after each change is applied.
 * Preconditions are checked synchronously with the change, so atomically.
 */
export class InMemoryVault implements VaultAdapter {
  /** Files by lookup key: the path itself, or (on a case-insensitive platform) its filesystem key (PathSpace.filesystemKey, `F`). */
  private readonly files = new Map<string, StoredFile>();
  /** Folders by lookup key, with the path each is spelled as. A folder stays when its last file leaves it, as on disk. */
  private readonly folders = new Map<string, string>();
  private readonly listeners = new Set<VaultListener>();
  private readonly inodeTaps = new Set<(event: InodeEvent) => void>();
  private lastInode = 0;
  /** Who is making the change being applied: a handle's actor while its call runs, else the user. */
  private actor: VaultActor = "user";
  private readonly now: () => number;
  private readonly pathRules: PathRules;
  /** Harness only: the paths open in an editor (isOpenInEditor). */
  readonly openInEditor = new Set<string>();
  /** The atomic replace, on a vault modelling desktop (InMemoryVaultOptions.atomicReplace). */
  readonly replace?: (from: string, to: string, precondition: WritePrecondition) => Promise<void>;
  /** The key a file's or a folder's spellings share, as on a real filesystem (PathSpace.filesystemKey, `F`). */
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
    const space = new PathSpace(this.pathRules);
    this.key = (path) => space.filesystemKey(path);
    if (options.atomicReplace ?? true) this.replace = (from, to, precondition) => this.replaceFile(from, to, precondition);
  }

  isOpenInEditor(path: string): boolean {
    return this.openInEditor.has(path);
  }

  /** The atomic replace: `from`'s content lands at `to` (kept as `to` is spelled) and `from` is gone, in one step. */
  private replaceFile(from: string, to: string, precondition: WritePrecondition): Promise<void> {
    const file = this.files.get(this.key(from));
    if (file === undefined) return Promise.reject(new VaultError("not-found", from));
    const target = this.files.get(this.key(to));
    if (!holds(target, precondition.expectedHash)) return Promise.reject(new VaultError("changed", to));
    if (target === undefined) return this.rename(from, to);
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...target, data: file.data, mtime: this.now() });
    this.emit({ type: "delete", path: file.path }, file.inode);
    this.emit({ type: "modify", path: target.path }, target.inode);
    return Promise.resolve();
  }

  /**
   * Harness only: the inode of the file at `path` (any spelling of it), or
   * undefined. The engine never sees inodes (docs/design/engine-path-ownership.md §5.4).
   */
  inodeOf(path: string): number | undefined {
    return this.files.get(this.key(path))?.inode;
  }

  /**
   * Harness only: calls `listener` with every change, tagged with its inode
   * and actor, synchronously and before the watchers. Returns the unsubscribe.
   */
  tapInodes(listener: (event: InodeEvent) => void): () => void {
    const subscription = (event: InodeEvent) => {
      listener(event);
    };
    this.inodeTaps.add(subscription);
    return () => {
      this.inodeTaps.delete(subscription);
    };
  }

  /**
   * Harness only: this vault as `actor` changes it. Reads and watches are the
   * vault's own; every change made through the handle is tapped as
   * `actor`'s. Changes made on the vault itself are the user's.
   */
  handle(actor: VaultActor): VaultHandle {
    const as =
      <A extends unknown[]>(change: (...args: A) => Promise<void>) =>
      (...args: A): Promise<void> => {
        const previous = this.actor;
        this.actor = actor;
        try {
          // Every change is applied (or refused) synchronously, so the actor covers exactly its events.
          return change(...args);
        } finally {
          this.actor = previous;
        }
      };
    return {
      list: () => this.list(),
      listFolders: () => this.listFolders(),
      createFolder: as((path: string) => this.createFolder(path)),
      deleteFolder: as((path: string) => this.deleteFolder(path)),
      read: (path) => this.read(path),
      stat: (path) => this.stat(path),
      watch: (listener) => this.watch(listener),
      write: as((path: string, data: Uint8Array, precondition?: WritePrecondition) => this.write(path, data, precondition)),
      rename: as((from: string, to: string) => this.rename(from, to)),
      ...(this.replace === undefined ? {} : { replace: as((from: string, to: string, precondition: WritePrecondition) => this.replaceFile(from, to, precondition)) }),
      isOpenInEditor: (path) => this.isOpenInEditor(path),
      renameFolder: as((from: string, to: string) => this.renameFolder(from, to)),
      delete: as((path: string, precondition?: DeletePrecondition) => this.delete(path, precondition)),
    };
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.values()].map((file) => file.path));
  }

  listFolders(): Promise<string[]> {
    return Promise.resolve([...this.folders.values()]);
  }

  createFolder(requested: string): Promise<void> {
    const path = this.spelled(requested, folderCount(requested) + 1);
    if (this.folders.has(this.key(path))) return Promise.resolve();
    if (unmaterializableReason(path, this.pathRules) !== undefined) return Promise.reject(new VaultError("unmaterializable", path));
    if (this.files.has(this.key(path)) || this.underFile(path)) return Promise.reject(new VaultError("path-conflict", path));
    this.addFolders(path, true);
    return Promise.resolve();
  }

  deleteFolder(path: string): Promise<void> {
    const key = this.key(path);
    const folder = this.folders.get(key);
    if (folder === undefined) return Promise.reject(new VaultError("not-found", path));
    const prefix = `${key}/`;
    if ([...this.files.keys(), ...this.folders.keys()].some((other) => other.startsWith(prefix))) return Promise.reject(new VaultError("changed", path));
    this.folders.delete(key);
    this.emit({ type: "folder-delete", path: folder }, 0);
    return Promise.resolve();
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
    // An existing file keeps its name, as a case-insensitive filesystem
    // keeps it; a new one goes into its folders as they are spelled.
    const stored = existing?.path ?? this.spelled(path, folderCount(path));
    const inode = existing?.inode ?? ++this.lastInode;
    if (existing === undefined) this.addFolders(stored, false);
    this.files.set(this.key(path), { path: stored, data: data.slice(), mtime: this.now(), inode });
    this.emit(existing === undefined ? { type: "create", path: stored } : { type: "modify", path: stored }, inode);
    return Promise.resolve();
  }

  rename(from: string, requested: string): Promise<void> {
    const file = this.files.get(this.key(from));
    if (file === undefined) return Promise.reject(new VaultError("not-found", from));
    // The target's folders as they are spelled, the moving file's own among them: they stay when it leaves.
    const to = this.spelled(requested, folderCount(requested));
    if (file.path === to) return Promise.resolve();
    if (this.key(from) !== this.key(to) && this.files.has(this.key(to))) return Promise.reject(new VaultError("already-exists", to));
    if (unmaterializableReason(to, this.pathRules) !== undefined) return Promise.reject(new VaultError("unmaterializable", to));
    // A folder at the target, or a file above it, is in the way; the moving file itself is not.
    if (this.conflicts(to, this.key(from))) return Promise.reject(new VaultError("path-conflict", to));
    this.addFolders(to, false);
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...file, path: to });
    this.emit({ type: "rename", path: to, oldPath: file.path }, file.inode);
    return Promise.resolve();
  }

  /**
   * Renames the folder `from` to `to` as a user would in Obsidian's file
   * explorer: the folder and everything in it move, reported as a
   * `folder-rename` of the folder and of each folder in it, then a `rename`
   * of each file in it, as Obsidian reports them. Rejects, moving nothing,
   * with "not-found" if there is no folder `from`, "already-exists" if a
   * folder `to` exists, "path-conflict" if `to` is a file or under one, and
   * "unmaterializable" if a moved path is one the platform cannot hold.
   */
  renameFolder(from: string, to: string): Promise<void> {
    const fromKey = this.key(from);
    const folder = this.folders.get(fromKey);
    if (folder === undefined) return Promise.reject(new VaultError("not-found", from));
    const prefix = `${fromKey}/`;
    const depth = folder.split("/").length;
    const movingFolders = new Set([fromKey, ...[...this.folders.keys()].filter((key) => key.startsWith(prefix))]);
    // The new parent's folders as they are spelled (the moving folder's
    // parents stay when it leaves). A case-only rename respells the folder.
    const parents = folderCount(to);
    const target = this.spelled(this.spelled(to, parents), parents + 1, (key) => movingFolders.has(key));
    if (target === folder) return Promise.resolve();
    const toKey = this.key(target);
    if (this.folders.has(toKey) && !movingFolders.has(toKey)) return Promise.reject(new VaultError("already-exists", target));
    if (this.files.has(toKey) || this.underFile(target)) return Promise.reject(new VaultError("path-conflict", target));
    const moved = (path: string) => [target, ...path.split("/").slice(depth)].join("/");
    const fileMoves = [...this.files.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, file]) => [key, file, moved(file.path)] as const);
    const folderMoves = [...this.folders.entries()].filter(([key]) => movingFolders.has(key)).map(([key, path]) => [key, path, moved(path)] as const);
    const illegal = [...fileMoves, ...folderMoves].find(([, , path]) => unmaterializableReason(path, this.pathRules) !== undefined);
    if (illegal !== undefined) return Promise.reject(new VaultError("unmaterializable", illegal[2]));
    for (const [key] of folderMoves) this.folders.delete(key);
    for (const [key] of fileMoves) this.files.delete(key);
    this.addFolders(target, false);
    for (const [, , path] of folderMoves) this.folders.set(this.key(path), path);
    for (const [, file, path] of fileMoves) this.files.set(this.key(path), { ...file, path });
    for (const [, path, next] of folderMoves) this.emit({ type: "folder-rename", path: next, oldPath: path }, 0);
    for (const [, file, path] of fileMoves) this.emit({ type: "rename", path, oldPath: file.path }, file.inode);
    return Promise.resolve();
  }

  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    const file = this.files.get(this.key(path));
    if (file === undefined) return Promise.reject(new VaultError("not-found", path));
    if (precondition !== undefined && !holds(file, precondition.expectedHash)) return Promise.reject(new VaultError("changed", path));
    this.files.delete(this.key(path));
    this.emit({ type: "delete", path: file.path }, file.inode);
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

  /**
   * `path` with its first `folders` segments, each a folder, spelled as the
   * folder of that name already is (under the vault's matching), so a
   * folder has one spelling as on a case-insensitive filesystem. Folders
   * whose key `skip` accepts do not count. Under posix rules this is `path`.
   */
  private spelled(path: string, folders: number, skip: (key: string) => boolean = () => false): string {
    const segments = path.split("/");
    for (let depth = 1; depth <= Math.min(folders, segments.length); depth++) {
      const key = this.key(segments.slice(0, depth).join("/"));
      const folder = skip(key) ? undefined : this.folders.get(key);
      // A folder that does not exist has no folders in it either.
      if (folder === undefined) break;
      segments.splice(0, depth, ...folder.split("/"));
    }
    return segments.join("/");
  }

  /** Adds the folders of `path` (spelled as they are to be stored), and `path` itself if `self`, that do not exist yet. */
  private addFolders(path: string, self: boolean): void {
    const segments = path.split("/");
    for (let depth = 1; depth <= (self ? segments.length : segments.length - 1); depth++) {
      const folder = segments.slice(0, depth).join("/");
      const key = this.key(folder);
      if (this.folders.has(key)) continue;
      this.folders.set(key, folder);
      this.emit({ type: "folder-create", path: folder }, 0);
    }
  }

  /** Whether one of the folders of `path` is a file. */
  private underFile(path: string): boolean {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) if (this.files.has(this.key(segments.slice(0, depth).join("/")))) return true;
    return false;
  }

  /** Whether a new file at `path` would collide with a folder or sit under a file (other than the one at `ignored`, a key). */
  private conflicts(path: string, ignored?: string): boolean {
    const key = this.key(path);
    if (this.folders.has(key)) return true;
    for (const existing of this.files.keys()) {
      if (existing === ignored) continue;
      if (key.startsWith(`${existing}/`)) return true;
    }
    return false;
  }

  private emit(event: VaultEvent, inode: number): void {
    for (const tap of [...this.inodeTaps]) tap({ ...event, inode, actor: this.actor });
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}

/** How many folders a file at `path` is in (or a folder at `path`'s parents): its segments but the last. */
function folderCount(path: string): number {
  return path.split("/").length - 1;
}

/** Whether `file` is what a precondition expects: absent for null, else content with that hash. */
function holds(file: StoredFile | undefined, expectedHash: string | null): boolean {
  if (file === undefined) return expectedHash === null;
  return expectedHash !== null && sha256Hex(file.data) === expectedHash;
}
