import { sha256Hex } from "../hash";
import { PathSpace } from "../engine/pathspace";
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
   * in it, under the spelling it already has (#377). Defaults to `posix`,
   * which is case-sensitive.
   */
  pathRules?: PathRules;
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
  private readonly listeners = new Set<VaultListener>();
  private readonly inodeTaps = new Set<(event: InodeEvent) => void>();
  private lastInode = 0;
  /** Who is making the change being applied: a handle's actor while its call runs, else the user. */
  private actor: VaultActor = "user";
  private readonly now: () => number;
  private readonly pathRules: PathRules;
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
      read: (path) => this.read(path),
      stat: (path) => this.stat(path),
      watch: (listener) => this.watch(listener),
      write: as((path: string, data: Uint8Array, precondition?: WritePrecondition) => this.write(path, data, precondition)),
      rename: as((from: string, to: string) => this.rename(from, to)),
      renameFolder: as((from: string, to: string) => this.renameFolder(from, to)),
      delete: as((path: string, precondition?: DeletePrecondition) => this.delete(path, precondition)),
    };
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
    // An existing file keeps its name, as a case-insensitive filesystem
    // keeps it; a new one goes into its folders as they are spelled.
    const stored = existing?.path ?? this.spelled(path, folderCount(path));
    const inode = existing?.inode ?? ++this.lastInode;
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
    // The moving file is no folder in its own way: folders exist only as the ancestors of files.
    if (this.conflicts(to, this.key(from))) return Promise.reject(new VaultError("path-conflict", to));
    this.files.delete(this.key(from));
    this.files.set(this.key(to), { ...file, path: to });
    this.emit({ type: "rename", path: to, oldPath: file.path }, file.inode);
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
    const moving = new Set([...this.files.keys()].filter((key) => key.startsWith(prefix)));
    // The new parent's folders as they are spelled (the moving folder's
    // parents stay when it leaves), and the folder itself if another file
    // than the moving ones is in it already. A case-only rename respells it.
    const parents = folderCount(to);
    const target = this.spelled(this.spelled(to, parents), parents + 1, (key) => moving.has(key));
    const moves = [...this.files.entries()]
      .filter(([key]) => moving.has(key))
      .map(([key, file]) => [key, file, [target, ...file.path.split("/").slice(depth)].join("/")] as const);
    if (moves.length === 0) return Promise.reject(new VaultError("not-found", from));
    const clash = moves.find(([, , target]) => this.files.has(this.key(target)) && !moving.has(this.key(target)));
    if (clash !== undefined) return Promise.reject(new VaultError("already-exists", clash[2]));
    const illegal = moves.find(([, , target]) => unmaterializableReason(target, this.pathRules) !== undefined);
    if (illegal !== undefined) return Promise.reject(new VaultError("unmaterializable", illegal[2]));
    const toKey = this.key(target);
    if ([...this.files.keys()].some((key) => !moving.has(key) && (key === toKey || toKey.startsWith(`${key}/`)))) return Promise.reject(new VaultError("path-conflict", target));
    for (const [key] of moves) this.files.delete(key);
    for (const [, file, target] of moves) this.files.set(this.key(target), { ...file, path: target });
    for (const [, file, target] of moves) this.emit({ type: "rename", path: target, oldPath: file.path }, file.inode);
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
   * folder has one spelling as on a case-insensitive filesystem. Files whose
   * key `skip` accepts do not count. Under posix rules this is `path`.
   */
  private spelled(path: string, folders: number, skip: (key: string) => boolean = () => false): string {
    const segments = path.split("/");
    for (let depth = 1; depth <= Math.min(folders, segments.length); depth++) {
      const folder = `${this.key(segments.slice(0, depth).join("/"))}/`;
      const inside = [...this.files.entries()].find(([key]) => !skip(key) && key.startsWith(folder))?.[1];
      // A folder that does not exist has no folders in it either.
      if (inside === undefined) break;
      segments.splice(0, depth, ...inside.path.split("/").slice(0, depth));
    }
    return segments.join("/");
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
