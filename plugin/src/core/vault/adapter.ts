/**
 * The sync engine's only view of a vault (SPEC.md §4). The Obsidian adapter
 * (src/obsidian) implements it on top of Obsidian's Vault API; InMemoryVault
 * implements it for unit tests. Every
 * implementation must pass the conformance suite in ./conformance.ts.
 *
 * Paths are vault-relative, "/"-separated, without a leading or trailing
 * slash, and given as the engine means them. On a case-insensitive platform
 * the vault may resolve a path of another spelling to the same file, and
 * keeps the spelling the file has (collision handling is the engine's job,
 * via path keys and its platform path rules, SPEC.md §8). Files and folders
 * are modelled: a folder stays when its last file leaves it, as on disk, and
 * every folder is a document of its own (docs/design/engine.md §2).
 */
export interface VaultAdapter {
  /** Lists the paths of all files in the vault, in no particular order. */
  list(): Promise<string[]>;

  /** Lists the paths of all folders in the vault (not the vault's root), in no particular order. */
  listFolders(): Promise<string[]>;

  /**
   * Creates a folder and its missing parent folders. Resolves, changing
   * nothing, if the folder exists. Rejects with "path-conflict" if a file is
   * at the path or at one of its ancestors, and with "unmaterializable" if
   * the platform cannot hold a folder there.
   */
  createFolder(path: string): Promise<void>;

  /**
   * Deletes an empty folder. Rejects with "not-found" if there is no folder
   * at the path, and with "changed", deleting nothing, if anything (a file
   * or a folder) is in it.
   */
  deleteFolder(path: string): Promise<void>;

  /** Reads a file's bytes. Rejects with VaultError "not-found" if it does not exist. */
  read(path: string): Promise<Uint8Array>;

  /**
   * Creates or overwrites a file, creating missing parent folders. Rejects
   * with VaultError "path-conflict" if the path or one of its ancestors is
   * occupied by the other kind of entry (a folder where the file should go, or
   * a file where a folder should go), and with "unmaterializable" if the
   * platform cannot hold a file at the path.
   *
   * With a precondition, the write happens only if the file still holds what
   * the caller last saw (see WritePrecondition), checked atomically with the
   * write. Otherwise it rejects with "changed" and changes nothing.
   */
  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void>;

  /**
   * Moves a file. Rejects with "not-found" if `from` does not exist,
   * "already-exists" if a different file already exists at `to`, and
   * "path-conflict" and "unmaterializable" as for write. A rename that
   * changes only letter case is allowed.
   */
  rename(from: string, to: string): Promise<void>;

  /**
   * Deletes a file. Rejects with "not-found" if it does not exist. With a
   * precondition, it deletes only a file whose content hash is
   * `expectedHash`, and rejects with "changed" otherwise, changing nothing.
   * An adapter that knows of unsaved state for the file (an open editor whose
   * content differs from the disk) never discards it (#181): it deletes
   * nothing and rejects, with "changed" under a precondition, and with an
   * error of its own without one (the Obsidian adapter's UnsavedEditsError).
   */
  delete(path: string, precondition?: DeletePrecondition): Promise<void>;

  /**
   * Optional: moves the file `from` over `to` in one atomic step of the file
   * system (a rename over the target), if `to` still holds what the caller
   * last saw. Otherwise it rejects with "changed" and moves nothing; "not-found"
   * if `from` does not exist, "path-conflict" and "unmaterializable" as for
   * write. Present only where the platform has an atomic replace (desktop);
   * without it the engine deletes the target and then renames
   * (docs/design/engine.md §8).
   */
  replace?(from: string, to: string, precondition: WritePrecondition): Promise<void>;

  /**
   * Optional: whether `path` is open in an editor view that may hold unsaved
   * state. The engine writes such a file with write(), the editor-safe write
   * in place (docs/design/engine.md §4, §8), rather than replacing it.
   */
  isOpenInEditor?(path: string): boolean;

  /** Returns a file's metadata, or null if it does not exist. */
  stat(path: string): Promise<FileStat | null>;

  /**
   * Subscribes to changes of files and folders made through this adapter or by anything else
   * (the user, other plugins). Engine-initiated writes are reported too; echo
   * suppression is the engine's job (SPEC.md §8). Returns an unsubscribe
   * function. Events may be delivered synchronously or asynchronously, but in
   * the order the changes happened. A folder rename is reported as a
   * `folder-rename` of the folder and of each folder in it, and a `rename` of
   * each file in it.
   */
  watch(listener: VaultListener): () => void;
}

/**
 * What a write expects to replace: the SHA-256 (lowercase hex, as sha256Hex)
 * of the file's current bytes, or null for "no file there" (a create). The
 * engine passes the hash it checked against the journal's base, so a change
 * the user saved after that check (Obsidian's autosave, say) is never
 * overwritten (SPEC.md §8).
 */
export interface WritePrecondition {
  expectedHash: string | null;
}

/** What a delete expects to remove: the SHA-256 of the file's current bytes. */
export interface DeletePrecondition {
  expectedHash: string;
}

export interface FileStat {
  /** Size in bytes. */
  size: number;
  /**
   * Last-modified time in milliseconds since the epoch. Informational only:
   * change detection must use content hashes, never mtimes (SPEC.md §8).
   */
  mtime: number;
}

export type VaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; oldPath: string }
  | { type: "folder-create"; path: string }
  | { type: "folder-delete"; path: string }
  | { type: "folder-rename"; path: string; oldPath: string };

/** Whether `event` is about a folder rather than a file. */
export function isFolderEvent(event: VaultEvent): event is Extract<VaultEvent, { type: `folder-${string}` }> {
  return event.type.startsWith("folder-");
}

export type VaultListener = (event: VaultEvent) => void;

/**
 * - `not-found`, `already-exists`, `path-conflict`: as documented per method.
 * - `unmaterializable`: the local platform cannot hold a file at the path
 *   (SPEC.md §8, platform path rules), e.g. a Windows reserved name. A write
 *   or rename may reject with it; the engine then tracks the document as
 *   unmaterializable instead of failing.
 * - `changed`: a write's or delete's precondition did not hold; the file is
 *   not what the caller last saw.
 */
export type VaultErrorCode = "not-found" | "already-exists" | "path-conflict" | "unmaterializable" | "changed";

/** The error every VaultAdapter rejects with for the documented failure cases. */
export class VaultError extends Error {
  override readonly name = "VaultError";

  constructor(
    readonly code: VaultErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

/**
 * Reports whether `error` is a VaultError (optionally with the given code).
 * Duck-typed so it also recognizes errors from another bundle or realm, e.g.
 * when the conformance suite runs inside Obsidian.
 */
export function isVaultError(error: unknown, code?: VaultErrorCode): error is VaultError {
  return (
    error instanceof Error &&
    error.name === "VaultError" &&
    "code" in error &&
    (code === undefined || error.code === code)
  );
}
