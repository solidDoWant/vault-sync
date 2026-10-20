import type { Journal, RemoteRevision } from "../journal/journal";
import type { VaultAdapter } from "../vault/adapter";

/**
 * Why a remote revision listed by deferredDocuments waits (SPEC.md §8):
 * - `invalid-path`: its path is not a valid vault path (it breaks the
 *   vault-relative rule of §6.2, or is not valid UTF-8);
 * - `path-conflict`: the vault refused its path (something in the way, or a
 *   path the vault does not hold, such as one Obsidian would store under
 *   another name);
 * - `out-of-scope`: its path is outside what this vault syncs while the
 *   document's local file is inside it, so the file stays parked.
 */
export type DeferredDocumentReason = "invalid-path" | "path-conflict" | "out-of-scope";

/** A remote revision deferred for its path, for the UI (#417). */
export interface DeferredDocument {
  documentId: string;
  /** The path the server has for the document. */
  path: string;
  reason: DeferredDocumentReason;
  /** The remote revision that was not written. */
  revision: RemoteRevision;
  /** Where the document's earlier version stays on disk, if this device has one. */
  localPath: string | undefined;
}

/**
 * The remote revisions the engine deferred for their path and that the UI
 * does not list elsewhere: `invalid-path` and `path-conflict` ones, and
 * `out-of-scope` ones whose document still has a file in scope here (an
 * out-of-scope document with no such file, a config file while config
 * sync is off, is not a problem to report). Unmaterializable and too-large
 * documents have lists of their own (SyncEngine.unmaterializable, tooLarge),
 * and `local-changes` ones are the merge path's. Each stays listed until a
 * later revision of its document applies and drops the deferral.
 */
export async function deferredDocuments(journal: Journal, vault: VaultAdapter): Promise<DeferredDocument[]> {
  const inScope = (path: string) => vault.isSynced?.(path) ?? true;
  const documents: DeferredDocument[] = [];
  for (const { revision, reason } of await journal.listDeferred()) {
    if (reason !== "invalid-path" && reason !== "path-conflict" && reason !== "out-of-scope") continue;
    const state = await journal.getDocument(revision.documentId);
    const live = state !== undefined && !state.deleted ? state : undefined;
    const localPath = live !== undefined && inScope(live.path) && (await vault.stat(live.path)) !== null ? live.path : undefined;
    if (reason === "out-of-scope" && localPath === undefined) continue;
    documents.push({ documentId: revision.documentId, path: revision.path, reason, revision, localPath });
  }
  return documents;
}
