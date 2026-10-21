import type { DeferredRevision, DocumentState, PendingOperation, RemoteRevision } from "../journal/journal";
import type { PathSpace } from "./pathspace";

/**
 * The path merge of design §4.7 (PO-9), for the remote decision
 * (`decideRemote`, §4.5, whose rest lands with refactor step R7): the local
 * file that is the document's local change when `remote` arrives, as far as
 * the document's binding alone tells.
 *
 * A remote delete of a document whose file the user moved and has not
 * pushed yet meets a local change: the user's rename, which wins over the
 * delete as an edit does (PO-7, PO-9; decision #52 as revised for R5). The
 * document keeps its id and comes back on its tombstone at the bound
 * spelling. Returns the bound spelling then, and undefined otherwise.
 */
export function movedBeforeDelete(state: DocumentState | undefined, remote: RemoteRevision): string | undefined {
  if (!remote.deleted || state === undefined || state.deleted) return undefined;
  const binding = state.binding;
  if (binding === undefined || binding === null || binding.spelling === state.path) return undefined;
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
 * - `keep` (W(c)): the holder's newest server claim is the path under the
 *   server's key: the path stays its own, and the document waits, listed
 *   (`path-conflict`). So does a holder whose own revision the vault
 *   refused (`path-conflict`: an untracked file is in that revision's way).
 */
export type HolderMove = "displace" | "recreate" | "resolve" | "detach" | "alias" | "keep";

export function ruleW(holder: DocumentState, ahead: DeferredRevision | undefined, outbox: readonly PendingOperation[], path: string, space: PathSpace): HolderMove {
  // A create not acknowledged yet that a local rename moved: a local move.
  if (holder.revisionId === "") return "displace";
  if (!holder.deleted && holder.seq === 0n) return "recreate";
  const binding = holder.binding;
  const moved = holder.deleted || (binding !== undefined && binding !== null && binding.spelling !== holder.path) || outbox.some((operation) => !operation.deleted && operation.path !== holder.path);
  if (moved) return "displace";
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
