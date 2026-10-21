import type { DocumentState, RemoteRevision } from "../journal/journal";

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
