import type { ConflictRecord, DocumentState, Journal } from "../journal/journal";
import { pathKey } from "../pathkey/pathkey";
import type { VaultAdapter } from "../vault/adapter";

/** A conflict of the conflict log (SPEC.md §7) that the user has not resolved yet: what the conflict view lists. */
export interface OpenConflict {
  record: ConflictRecord;
  /**
   * The file of the version that stayed in place, where it is now: the
   * document's current path (it follows later renames), or for `path-taken`
   * the file of the other document, which holds the path (perhaps spelled in
   * another case or Unicode form). Null if no such file is there any more.
   * For a conflict logged without a copy this is the untouched local version.
   */
  original: string | null;
  /** The file of the kept local version (`record.copyPath`); null if no copy could be written. */
  copy: string | null;
}

/**
 * The conflicts of the conflict log that are still open, newest first.
 * A conflict is resolved once the user deletes (or renames) its copy; one
 * logged without a copy (no copy name fit the path limits) is open while the
 * document still waits in the journal, its remote revision deferred or (for
 * `path-taken`) its local operation pending. The log itself is never pruned: the engine reads it to finish an
 * interrupted copy and to never reuse a copy's name.
 */
export async function openConflicts(journal: Journal, vault: VaultAdapter): Promise<OpenConflict[]> {
  const open: OpenConflict[] = [];
  let pending: Set<string> | undefined;
  let documents: DocumentState[] | undefined;
  for (const record of await journal.listConflicts()) {
    if (record.copyPath === null) {
      pending ??= new Set((await journal.listPending()).map((operation) => operation.documentId));
      if ((await journal.getDeferred(record.documentId)) === undefined && !pending.has(record.documentId)) continue;
    } else if ((await vault.stat(record.copyPath)) === null) continue;
    const candidates: string[] = [];
    if (record.reason === "path-taken") {
      candidates.push(record.path);
      documents ??= (await journal.listDocuments()).filter((state) => !state.deleted);
      const key = pathKey(record.path);
      for (const state of documents) if (state.documentId !== record.documentId && pathKey(state.path) === key) candidates.push(state.path);
    } else {
      const state = await journal.getDocument(record.documentId);
      candidates.push(state !== undefined && !state.deleted ? state.path : record.path);
    }
    let original: string | null = null;
    for (const candidate of candidates) {
      if ((await vault.stat(candidate)) !== null) {
        original = candidate;
        break;
      }
    }
    open.push({ record, original, copy: record.copyPath });
  }
  return open.reverse();
}
