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
 * What the merge hook did. `deferred`: nothing was written; the engine records
 * the remote revision as pending in the journal, and the merge path owns the
 * document (every later remote revision for it goes to the hook too) until it
 * resolves the deferral. The three-way merge (#18) adds outcomes.
 */
export interface MergeOutcome {
  status: "deferred";
}

/**
 * The engine's hand-off to the merge path. It is called at most once per
 * remote revision and document per pull, but may be called again for the same
 * revision after a crash, so it must be idempotent. It must never discard the
 * local content (SPEC.md §2 principle 1).
 */
export type MergeHook = (request: MergeRequest) => Promise<MergeOutcome>;

/**
 * The default merge hook until the merge algorithm exists: it never touches
 * the local file and keeps the remote revision pending in the journal.
 */
export const deferMerge: MergeHook = () => Promise.resolve({ status: "deferred" });
