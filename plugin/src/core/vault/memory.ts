import { VaultError, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener } from "./adapter";

export interface InMemoryVaultOptions {
  /** Clock for mtimes; inject a deterministic one in the simulation. Defaults to Date.now. */
  now?: () => number;
}

interface StoredFile {
  data: Uint8Array;
  mtime: number;
}

/**
 * A VaultAdapter backed by a Map, for unit tests and the simulation harness.
 * Events are delivered synchronously, in order, after each change is applied.
 */
export class InMemoryVault implements VaultAdapter {
  private readonly files = new Map<string, StoredFile>();
  private readonly listeners = new Set<VaultListener>();
  private readonly now: () => number;

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
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  read(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (file === undefined) return Promise.reject(new VaultError("not-found", path));
    return Promise.resolve(file.data.slice());
  }

  write(path: string, data: Uint8Array): Promise<void> {
    const existing = this.files.get(path);
    if (existing === undefined && this.conflicts(path)) {
      return Promise.reject(new VaultError("path-conflict", path));
    }
    this.files.set(path, { data: data.slice(), mtime: this.now() });
    this.emit(existing === undefined ? { type: "create", path } : { type: "modify", path });
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (file === undefined) return Promise.reject(new VaultError("not-found", from));
    if (from === to) return Promise.resolve();
    if (this.files.has(to)) return Promise.reject(new VaultError("already-exists", to));
    if (this.conflicts(to)) return Promise.reject(new VaultError("path-conflict", to));
    this.files.delete(from);
    this.files.set(to, file);
    this.emit({ type: "rename", path: to, oldPath: from });
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    if (!this.files.delete(path)) return Promise.reject(new VaultError("not-found", path));
    this.emit({ type: "delete", path });
    return Promise.resolve();
  }

  stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(path);
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

  /** Whether a new file at `path` would collide with a folder or sit under a file. */
  private conflicts(path: string): boolean {
    const folderPrefix = `${path}/`;
    for (const existing of this.files.keys()) {
      if (existing.startsWith(folderPrefix) || path.startsWith(`${existing}/`)) return true;
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
