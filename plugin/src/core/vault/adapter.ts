/**
 * The sync engine's only view of a vault (SPEC.md §4). The Obsidian adapter
 * (src/obsidian) implements it on top of Obsidian's Vault API; InMemoryVault
 * implements it for unit tests and the simulation harness. Every
 * implementation must pass the conformance suite in ./conformance.ts.
 *
 * Paths are vault-relative, "/"-separated, without a leading or trailing
 * slash, and given as the engine means them. On a case-insensitive platform
 * the vault may resolve a path of another spelling to the same file, and
 * keeps the spelling the file has (collision handling is the engine's job,
 * via path keys and its platform path rules, SPEC.md §8). Only files are
 * modelled; folders exist implicitly as the ancestors of files.
 */
export interface VaultAdapter {
  /** Lists the paths of all files in the vault, in no particular order. */
  list(): Promise<string[]>;

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
   * content differs from the disk) rejects with "changed" too.
   */
  delete(path: string, precondition?: DeletePrecondition): Promise<void>;

  /** Returns a file's metadata, or null if it does not exist. */
  stat(path: string): Promise<FileStat | null>;

  /**
   * Subscribes to file changes (folders are not reported) made through this adapter or by anything else
   * (the user, other plugins). Engine-initiated writes are reported too; echo
   * suppression is the engine's job (SPEC.md §8). Returns an unsubscribe
   * function. Events may be delivered synchronously or asynchronously, but in
   * the order the changes happened.
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
  | { type: "rename"; path: string; oldPath: string };

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
