import type { DocumentState, RemoteRevision } from "../journal/journal";

/**
 * Everything the merge path needs for a remote revision that the engine could
 * not apply because it would overwrite unsynced local content (SPEC.md §7, §8).
 */
export interface MergeRequest {
  /** The remote revision that was not applied. */
  remote: RemoteRevision;
  /**
   * The merge base: what the journal last synced for this document, or
   * undefined if this device never synced it (e.g. a remote create whose path
   * is taken by a local file).
   */
  base: DocumentState | undefined;
  /**
   * The local file in the way: the document's own file, or whatever occupies
   * the remote revision's path. `content` is null if no file is there (it was
   * deleted or moved locally).
   */
  local: { path: string; content: Uint8Array | null };
  /** Downloads the remote revision's content (verified against its hash); null for a tombstone. */
  readRemoteContent(): Promise<Uint8Array | null>;
  /** Fetches the base revision's content from the server by revision id (SPEC.md §8); null without a base. */
  readBaseContent(): Promise<Uint8Array | null>;
}

/**
 * What the merge hook decided.
 *
 * - `deferred`: nothing is written. The engine records the remote revision as
 *   pending in the journal, and the merge path owns the document (every later
 *   remote revision of it goes to the hook too, and the engine pushes none of
 *   its local changes) until a later call resolves it. The hook is asked again
 *   on every push while the deferral stands.
 * - `merged`: the document's merged state, which must contain the local
 *   changes (or a conflict copy must, SPEC.md §7). The engine makes the disk
 *   show it at `path` (`content: null` for a deleted document), provided the
 *   local file still holds the content the hook was given, rebases the
 *   document onto the remote revision and drops the unacknowledged local
 *   operations of the document it replaces. It then pushes the result as a new
 *   revision based on the remote one (SPEC.md §6.2 step 3). If the local file
 *   changed in the meantime, the engine defers instead and asks again later.
 *
 * The merge algorithm itself (three-way text merge, conflict copies) is #18.
 */
export type MergeOutcome = { status: "deferred" } | { status: "merged"; path: string; content: Uint8Array | null };

/**
 * The engine's hand-off to the merge path. It may be called again for the
 * same remote revision (after a crash, or on a later push while the revision
 * is deferred), so it must be idempotent. It must never discard the local
 * content (SPEC.md §2 principle 1).
 */
export type MergeHook = (request: MergeRequest) => Promise<MergeOutcome>;

/**
 * The default merge hook until the merge algorithm (#18) exists: it never
 * touches the local file and keeps the remote revision pending in the
 * journal, so the document's local changes stay on disk and unpushed.
 */
export const deferMerge: MergeHook = () => Promise.resolve({ status: "deferred" });
