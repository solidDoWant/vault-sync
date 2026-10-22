import type { ConflictReason, DocumentState, RemoteRevision } from "../journal/journal";
import { sha256Hex } from "../hash";
import { mergeText } from "../merge/text-merge";

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
   * The document's local version: its own file (where a local rename moved
   * it, if one did), or, if this device has no file of it (no base, or a
   * deleted base), whatever occupies the remote revision's path. A file at a
   * renamed document's new path is never handed over as the document's own:
   * the engine keeps it apart (SPEC.md §7). `content` is null if no file is
   * there (it was deleted or moved locally).
   */
  local: { path: string; content: Uint8Array | null };
  /** Downloads the remote revision's content (verified against its hash); null for a tombstone. */
  readRemoteContent(): Promise<Uint8Array | null>;
  /**
   * Fetches the base revision's content from the server by revision id
   * (SPEC.md §8); null without a base, when the base is a tombstone, or when
   * retention purged the base (§11), so the versions have no common base.
   */
  readBaseContent(): Promise<Uint8Array | null>;
  /**
   * The remote revision descends from `base` (design §4.6): it came from the
   * change feed of a server that had not diverged since this device synced
   * the base. False for a resync's head and every revision deferred behind
   * one, which may be concurrent with a base the restore lost.
   */
  descendsFromBase: boolean;
}

/**
 * What the merge hook decided.
 *
 * - `deferred`: nothing is written. The engine records the remote revision as
 *   pending in the journal, and the merge path owns the document (every later
 *   remote revision of it goes to the hook too, and the engine pushes none of
 *   its local changes) until a later call resolves it. The hook is asked again
 *   on every push while the deferral stands.
 * - `merged`: the document's merged content (`content: null` for a deleted
 *   document). The hook merges content only: the engine decides the result's
 *   path itself (design §4.7, PO-9; decision 6), where a local rename
 *   survives a remote edit and wins over a concurrent remote rename. The
 *   engine makes the disk show the result there, provided the local file
 *   still holds the content the hook was given, rebases the document onto
 *   the remote revision and drops the unacknowledged local operations it
 *   replaces. It then pushes the result as a new revision based on the remote
 *   one (SPEC.md §6.2 step 3). If the local file changed in the meantime, the
 *   engine defers instead and asks again later. A file that is no document's
 *   in the way at a new path is kept as a `concurrent-create` conflict copy
 *   and removed first; if it is another document's, rule W decides (design
 *   §4.5).
 *
 *   The result must contain the local changes, or `conflict` must: then the
 *   engine first writes `conflict.content` (the local version) as a conflict
 *   copy next to the local file, `<name> (conflict <device> <date>).<ext>`,
 *   records the conflict in the journal's conflict log, and pushes the copy as
 *   a document of its own (SPEC.md §7).
 */
export type MergeOutcome =
  | { status: "deferred" }
  | { status: "merged"; content: Uint8Array | null; conflict?: { reason: ConflictReason; content: Uint8Array } };

/**
 * The engine's hand-off to the merge path. It may be called again for the
 * same remote revision (after a crash, or on a later push while the revision
 * is deferred), so it must be idempotent. It must never discard the local
 * content (SPEC.md §2 principle 1).
 */
export type MergeHook = (request: MergeRequest) => Promise<MergeOutcome>;

/** A merge hook that never touches the local file: the remote revision stays pending in the journal, and the document's local changes stay on disk and unpushed. */
export const deferMerge: MergeHook = () => Promise.resolve({ status: "deferred" });

// ignoreBOM keeps a byte-order mark in the text, so the merge result keeps it too.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * The engine's default merge hook, SPEC.md §7's merge rules:
 *
 * - An edit wins over a delete, on either side: the edited content stays (a
 *   remotely deleted document comes back with the local edit).
 * - A `text` document whose three versions are UTF-8 gets a line-level
 *   three-way merge; non-overlapping edits merge silently, and line-ending or
 *   final-newline differences never conflict on their own.
 * - Otherwise (overlapping edits, a `blob` document, or no common base, as
 *   when two devices created a file at the same path) the remote version
 *   stays in place and the local version becomes a conflict copy. Conflict
 *   markers are never written into a note.
 *
 * Content only: the engine merges the path (design §4.7, mergePath).
 *
 * Deterministic, so a repeated call for the same request returns the same outcome.
 */
export const threeWayMerge: MergeHook = async (request) => {
  const { base, local, remote: revision } = request;
  const remote = await request.readRemoteContent();
  if (remote === null) return { status: "merged", content: local.content };
  const ownFile = base !== undefined && !base.deleted;
  if (local.content === null) return { status: "merged", content: remote };
  if (sameBytes(local.content, remote)) return { status: "merged", content: remote };
  const keepBoth = (reason: ConflictReason): MergeOutcome => ({ status: "merged", content: remote, conflict: { reason, content: local.content ?? new Uint8Array() } });
  if (!ownFile) {
    // A tombstone, or no base here: no common base, unless the engine gives
    // the deleted revision's content for a file still holding exactly it
    // (#790): unedited, it is no local change against the document's return.
    const before = await request.readBaseContent();
    if (before !== null && sameBytes(local.content, before)) return { status: "merged", content: remote };
    return keepBoth("concurrent-create");
  }
  const baseContent = await request.readBaseContent();
  if (baseContent === null) {
    // The device synced a base, but the server no longer has it (purged by
    // retention). A local file still at the base's content changed nothing a
    // revision descending from that base could be concurrent with (#719).
    if (request.descendsFromBase && sha256Hex(local.content) === base.baseHash) return { status: "merged", content: remote };
    return keepBoth("base-purged");
  }
  if (sameBytes(local.content, baseContent)) return { status: "merged", content: remote };
  if (sameBytes(remote, baseContent)) return { status: "merged", content: local.content };
  if (revision.kind !== "text" || base.kind !== "text") return keepBoth("binary");
  const texts = [baseContent, local.content, remote].map(decodeText);
  const [baseText, localText, remoteText] = texts;
  if (baseText === undefined || localText === undefined || remoteText === undefined) return keepBoth("binary");
  const merged = mergeText(baseText, localText, remoteText);
  if (merged === null) return keepBoth("overlapping-edits");
  return { status: "merged", content: encoder.encode(merged) };
};

function decodeText(content: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(content);
  } catch {
    return undefined;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
