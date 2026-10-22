import type { DeferredRevision, DocumentState, PendingOperation, RemoteRevision } from "../journal/journal";
import { hasBase } from "./bindings";
import type { PathSpace } from "./pathspace";

/**
 * Whether `remote` is this device's own create of the document, which it
 * moved on (to a path-taken copy, #286) before learning that the commit had
 * landed (design §4.5 step 1): the document has no base here, the revision is
 * the document's live first revision, every outbox operation of the document
 * is a create or already rebased onto it, and the server says this device
 * committed it. Document ids are shared, so the outbox alone does not make the
 * create this device's: after a restore every device that held the document
 * keeps it as a ghost and re-creates it under the same id (§4.6). Another
 * device's re-create is that device's revision of a document with local
 * changes here, so it takes the merge path (step 4, PO-12, INV-4), never this
 * step, which would commit this device's version over it (#816).
 */
export function ownMovedCreate(state: DocumentState | undefined, remote: RemoteRevision, outbox: readonly PendingOperation[], deviceId: string): boolean {
  if (state !== undefined && hasBase(state)) return false;
  if (remote.deleted || remote.parentRevisionId !== "" || outbox.length === 0) return false;
  if (remote.deviceId === undefined || remote.deviceId === "" || remote.deviceId !== deviceId) return false;
  return outbox.every((operation) => operation.baseRevisionId === "" || operation.baseRevisionId === remote.revisionId);
}

/**
 * The path merge of design §4.7 (PO-9), for the remote decision
 * (`decideRemote`, §4.5 step 4, whose rest lands with refactor step R7):
 * the bound file that is the document's local change when `remote`
 * arrives, as far as the document's binding alone tells (PO-1). Returns its
 * spelling, or undefined when the binding alone makes no local change.
 *
 * - A remote delete of a document whose file the user moved and has not
 *   pushed yet meets a local change: the user's rename, which wins over the
 *   delete as an edit does (PO-7, PO-9; decision #52 as revised for R5).
 *   The document keeps its id and comes back on its tombstone at the bound
 *   spelling.
 * - A document bound on its tombstone (the rename above, after the delete
 *   was pulled and before the push re-creates it; or an untracked file the
 *   push took for the tombstone, PO-13) is a local change against any
 *   remote revision: its file is the document's (PO-1, INV-3), so a
 *   revision that brings it back on the server meets that file in the merge
 *   path, never as a document with no file here (#790). Writing the
 *   revision as a new file would leave the bound file untracked, and the
 *   next push would commit the document's file as another document.
 */
export function boundLocalChange(state: DocumentState | undefined, remote: RemoteRevision): string | undefined {
  const binding = state?.binding;
  if (state === undefined || binding === undefined || binding === null) return undefined;
  if (state.deleted) return binding.spelling;
  if (!remote.deleted || binding.spelling === state.path) return undefined;
  return binding.spelling;
}

/**
 * What rule W (design §4.5, PO-4) does with another document `holder`
 * whose file is in the way of a path the server gives a document (or whose
 * synced path collides with it under the server's key, for a document the
 * server lost):
 *
 * - `displace` (W(a)): the holder is there by a local move (its binding
 *   left its synced path, it is bound on a tombstone, or its outbox moves
 *   it there), so its file moves on to a conflict-copy name under its own
 *   id, which its push commits.
 * - `recreate`: the server lost the holder in a restore (its base has seq
 *   0, SyncEngine.resync): its only claim on the path is the local intent
 *   to create it again, so it is displaced as a create of its own id.
 * - `resolve` (W(b)): the holder is at its synced path, but the server has
 *   moved it away and the merge path holds that revision: it is merged
 *   first. If that leaves it in the way (the hook deferred), it keeps the
 *   path for now, and the document waits, listed (`path-conflict`), as for
 *   `keep`: the merge is retried on every push.
 * - `detach` (W(b)): as `resolve`, but a non-disk blocker holds the
 *   revision (an unmaterializable path, out of scope, too large, invalid),
 *   so the holder cannot move: it gives its file up, which stays as an
 *   untracked copy the push commits as a new document (PO-11).
 * - `alias`: the holder's newest server claim is another path under the
 *   server's key but one file on this device (`ı.md` and `I.md` on
 *   Windows, design §3.1, §6.4 item 4). The device can hold only one of the
 *   two live documents: the holder keeps its file, and the document is
 *   unmaterializable here (`alias`), a non-disk blocker that claims no path,
 *   until the server moves the holder away (decision #52).
 * - `follow` (W(b), #792): the pull has a newer revision of the holder in
 *   hand (`newer`, later on the feed page it is applying) than its synced
 *   one and its deferral. That revision is the holder's newest server claim
 *   (§4.5 step 3), so it is decided first: the holder follows it under its
 *   own id, with its local changes, which may move its file off the path. A
 *   deferral it supersedes is stale and never detaches the holder.
 * - `keep` (W(c)): the holder's newest server claim is the path under the
 *   server's key: the path stays its own, and the document waits, listed
 *   (`path-conflict`). So does a holder whose own revision the vault
 *   refused (`path-conflict`: an untracked file is in that revision's way).
 */
export type HolderMove = "displace" | "recreate" | "follow" | "resolve" | "detach" | "alias" | "keep";

export function ruleW(holder: DocumentState, ahead: DeferredRevision | undefined, outbox: readonly PendingOperation[], path: string, space: PathSpace, newer?: RemoteRevision): HolderMove {
  // A create not acknowledged yet that a local rename moved: a local move.
  if (holder.revisionId === "") return "displace";
  if (!holder.deleted && holder.seq === 0n) return "recreate";
  const binding = holder.binding;
  const moved = holder.deleted || (binding !== undefined && binding !== null && binding.spelling !== holder.path) || outbox.some((operation) => !operation.deleted && operation.path !== holder.path);
  if (moved) return "displace";
  if (newer !== undefined && newer.seq > holder.seq && (ahead === undefined || newer.seq > ahead.revision.seq)) return "follow";
  if (ahead === undefined || (!ahead.revision.deleted && space.collides(ahead.revision.path, path, "file"))) {
    const claim = ahead === undefined ? holder.path : ahead.revision.path;
    return space.collides(claim, path, "server") ? "keep" : "alias";
  }
  // The vault refused the holder's own revision: an untracked file is in its
  // way, which a retry (SyncEngine.retryRefusedPaths) or the user clears.
  // The holder's file stays meanwhile.
  if (ahead.reason === "path-conflict") return "keep";
  return ahead.reason === "local-changes" ? "resolve" : "detach";
}

/**
 * The path merge of design §4.7 (PO-9; decision 6): where the merge path's
 * result for `remote` goes, given the document's journal row `state` (the
 * merge base) and the path of its local version (`localPath`, the bound
 * spelling for a document with a file of its own). The merge hook merges
 * content only (merge.ts); this decides the path.
 *
 * - A remote delete: the local version's path. An edit wins over the delete
 *   there, and D is re-created on top of the tombstone at the bound spelling.
 * - A live document this device synced whose local version is at another
 *   path than its synced one (a local rename, a case-only or respelled one
 *   included): the local path. The local rename survives a remote edit and
 *   wins over a concurrent remote rename.
 * - A document bound on its tombstone (boundLocalChange) whose file the
 *   user moved off the tombstone's path: the local path. The user's rename
 *   wins over another device's revision that brings the document back, as
 *   over any remote revision (ruling on decision #52, #802). A file rule
 *   W's `displace` moved aside (`binding.displaced`) is no user's rename.
 * - Otherwise (no local rename, a local delete, a tombstone with no file
 *   here or one the engine moved aside, or a document this device never
 *   synced): the remote revision's path, the remote rename applied.
 */
export function mergePath(state: DocumentState | undefined, localPath: string, remote: RemoteRevision): string {
  if (remote.deleted) return localPath;
  if (state === undefined || localPath === state.path) return remote.path;
  if (!state.deleted) return localPath;
  const binding = state.binding;
  return binding !== undefined && binding !== null && binding.displaced !== true && binding.spelling === localPath ? localPath : remote.path;
}
