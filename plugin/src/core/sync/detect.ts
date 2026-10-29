import { sha256Hex } from "../hash";
import { uuidv7 } from "../uuid";
import { isVaultError, type FileStat, type VaultAdapter } from "../vault/adapter";
import type { DocEntry, JournalChange, JournalState, PendingKind, PendingOp, SyncKind } from "./journal";

/**
 * Change detection (docs/design/engine.md §4). A file is changed when its
 * SHA-256 differs from what the journal says it holds; modification times
 * only decide whether a cached hash may be reused. Live rename events keep
 * the document, so a rename syncs as a rename; a rename the engine did not
 * see (the app was closed) is recognised by hash where it matches one to
 * one, and otherwise syncs as a delete plus a create.
 *
 * Every folder is a document too (docs/design/engine.md §2): a folder with no
 * live document is a create (a re-create on its tombstone, if this device
 * kept it), a folder document whose folder is gone is a delete, and a folder
 * rename event keeps the document.
 */

/**
 * The engine's temporary files (docs/design/engine.md §8), next to the file
 * they become. A `.vault-sync-tmp` file may be partial: it is deleted at
 * startup. A `.vault-sync-new` file replaces an existing file where the
 * platform has no atomic replace; the target is deleted only once it is
 * complete, so one whose target is missing is renamed into place at startup.
 */
const temporarySuffix = ".vault-sync-tmp";
const replacementSuffix = ".vault-sync-new";

/** The temporary file a file at `path` is written to before it replaces the target or is renamed into place. */
export function temporaryPath(path: string): string {
  return `${path}${temporarySuffix}`;
}

/** The temporary file that replaces an existing file at `path` by a delete and a rename. */
export function replacementPath(path: string): string {
  return `${path}${replacementSuffix}`;
}

/** The file a replacement file becomes, or null if `path` is none. */
export function replacementTarget(path: string): string | null {
  return path.endsWith(replacementSuffix) ? path.slice(0, -replacementSuffix.length) : null;
}

/** Whether `path` is one of the engine's temporary files, which are never synced. */
export function isTemporaryPath(path: string): boolean {
  return path.endsWith(temporarySuffix) || path.endsWith(replacementSuffix);
}

/** The kind a new document at `path` gets: Markdown is `text`, everything else a `blob`. */
export function kindOfPath(path: string): SyncKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.slice(dot + 1).toLowerCase() === "md" ? "text" : "blob";
}

/** What a document is on this device once every pending operation is applied. */
export interface Projection {
  documentId: string;
  kind: SyncKind;
  path: string;
  hash: string;
  size: number;
  deleted: boolean;
  base: DocEntry | undefined;
  /** The document's last pending operation, if any. */
  lastOp: PendingOp | undefined;
  /** The state before `lastOp` (undefined: no state, the document is new). */
  beforeLast: State | undefined;
}

interface State {
  path: string;
  hash: string;
  size: number;
  deleted: boolean;
}

/** Each document's projected state: its base, then its pending operations in order. */
export function project(state: JournalState): Map<string, Projection> {
  const projections = new Map<string, Projection>();
  for (const entry of state.docs.values()) {
    projections.set(entry.documentId, {
      documentId: entry.documentId,
      kind: entry.kind,
      path: entry.path,
      hash: entry.baseHash,
      size: entry.baseSize,
      deleted: entry.deleted === true,
      base: entry,
      lastOp: undefined,
      beforeLast: undefined,
    });
  }
  for (const op of state.pending) {
    const current = projections.get(op.documentId);
    const before: State | undefined = current === undefined ? undefined : { path: current.path, hash: current.hash, size: current.size, deleted: current.deleted };
    projections.set(op.documentId, {
      documentId: op.documentId,
      kind: current?.kind ?? op.docKind,
      path: op.path,
      hash: op.contentHash,
      size: op.contentSize,
      deleted: op.kind === "delete",
      base: current?.base,
      lastOp: op,
      beforeLast: before,
    });
  }
  return projections;
}

interface CachedHash {
  size: number;
  mtime: number;
  hash: string;
}

/** Hashes of files on disk, reused while a file's size and mtime are unchanged and no event touched it. */
export class HashCache {
  private readonly hashes = new Map<string, CachedHash>();

  /** Forgets the hash of `path`. */
  invalidate(path: string): void {
    this.hashes.delete(path);
  }

  /** The file's hash and size, or null if it is gone. */
  async read(vault: VaultAdapter, path: string): Promise<{ hash: string; size: number; mtime: number } | null> {
    let stat: FileStat | null;
    try {
      stat = await vault.stat(path);
    } catch (error) {
      if (isVaultError(error, "not-found")) return null;
      throw error;
    }
    if (stat === null) return null;
    const cached = this.hashes.get(path);
    if (cached !== undefined && cached.size === stat.size && cached.mtime === stat.mtime) return cached;
    let data: Uint8Array;
    try {
      data = await vault.read(path);
    } catch (error) {
      if (isVaultError(error, "not-found")) return null;
      throw error;
    }
    const entry = { size: data.length, mtime: stat.mtime, hash: sha256Hex(data) };
    this.hashes.set(path, entry);
    return entry;
  }
}

/** A file or folder rename the vault reported: [old path, new path]. */
export type RenameHint = readonly [string, string];

interface Observed {
  path: string;
  hash: string;
  size: number;
}

export interface DetectOptions {
  vault: VaultAdapter;
  cache: HashCache;
  /** Renames reported since the last detection, in order. */
  renames: readonly RenameHint[];
  /** The next pending operation's `order`. */
  nextOrder: number;
  now: () => number;
}

/**
 * Compares the vault with the journal and returns the journal change that
 * records every local change as a pending operation (empty when there is
 * none).
 */
export async function detectChanges(state: JournalState, options: DetectOptions): Promise<JournalChange> {
  const projections = project(state);
  // Where each live document's file is now, after the reported renames.
  const pathOf = new Map<string, string>();
  for (const projection of projections.values()) if (!projection.deleted) pathOf.set(projection.documentId, projection.path);
  // A folder rename is reported as one rename per folder and per file in it.
  for (const [from, to] of options.renames) {
    const byPath = new Map([...pathOf].map(([id, path]) => [path, id]));
    const moved = byPath.get(from);
    if (moved === undefined) continue;
    // A file replaced by the rename has lost its file.
    const replaced = byPath.get(to);
    if (replaced !== undefined && replaced !== moved) pathOf.delete(replaced);
    pathOf.set(moved, to);
  }
  const byPath = new Map([...pathOf].map(([id, path]) => [path, id]));

  const isFolder = (id: string) => projections.get(id)?.kind === "folder";
  const changed = new Map<string, State>();
  const untracked: Observed[] = [];
  const seen = new Set<string>();
  for (const path of await options.vault.list()) {
    if (isTemporaryPath(path)) continue;
    const file = await options.cache.read(options.vault, path);
    if (file === null) continue;
    const id = byPath.get(path);
    // A file where a folder document's folder was: the folder is gone, the file is new.
    if (id === undefined || isFolder(id)) {
      untracked.push({ path, hash: file.hash, size: file.size });
      continue;
    }
    seen.add(path);
    const projection = projections.get(id);
    if (projection !== undefined && (projection.path !== path || projection.hash !== file.hash)) {
      changed.set(id, { path, hash: file.hash, size: file.size, deleted: false });
    }
  }
  const folderCreates: Observed[] = [];
  for (const path of await options.vault.listFolders()) {
    const id = byPath.get(path);
    if (id === undefined || !isFolder(id)) {
      // Rule 3 of the folder rules: a folder this device kept after its document was deleted is created again on the tombstone.
      const tombstoned = [...projections.values()].find((projection) => projection.kind === "folder" && projection.deleted && projection.lastOp === undefined && projection.path === path);
      if (tombstoned !== undefined) changed.set(tombstoned.documentId, { path, hash: "", size: 0, deleted: false });
      else folderCreates.push({ path, hash: "", size: 0 });
      continue;
    }
    seen.add(path);
    if (projections.get(id)?.path !== path) changed.set(id, { path, hash: "", size: 0, deleted: false });
  }

  // Documents whose file is gone: renamed while unobserved when one new file has their content and no other document shares it. A folder is matched by its rename event only.
  const missing = [...pathOf].filter(([, path]) => !seen.has(path)).map(([id]) => id);
  const missingByHash = groupBy(
    missing.filter((id) => !isFolder(id)),
    (id) => projections.get(id)?.hash ?? "",
  );
  const untrackedByHash = groupBy(untracked, (file) => file.hash);
  const creates: Observed[] = [];
  for (const file of untracked) {
    const candidates = missingByHash.get(file.hash) ?? [];
    const id = candidates[0];
    if (id !== undefined && candidates.length === 1 && untrackedByHash.get(file.hash)?.length === 1) {
      changed.set(id, { path: file.path, hash: file.hash, size: file.size, deleted: false });
      missingByHash.delete(file.hash);
      continue;
    }
    creates.push(file);
  }
  for (const id of [...missingByHash.values()].flat().concat(missing.filter(isFolder))) {
    const projection = projections.get(id);
    if (projection !== undefined) changed.set(id, { path: projection.path, hash: projection.hash, size: projection.size, deleted: true });
  }

  // A folder and the files in it may arrive on another device in either order: applying either one first is a no-op for the other (Pull's removeEmptied, placeFolder).
  type Step = { id: string; next: State } | { create: Observed; kind: SyncKind };
  const steps: Step[] = [
    ...[...changed].map(([id, next]) => ({ id, next })),
    ...creates.map((file) => ({ create: file, kind: kindOfPath(file.path) })),
    ...folderCreates.map((folder) => ({ create: folder, kind: "folder" as const })),
  ];

  const change: Required<Pick<JournalChange, "putPending" | "deletePending">> = { putPending: [], deletePending: [] };
  let order = options.nextOrder;
  for (const step of steps) {
    if (!("id" in step)) {
      change.putPending.push({
        opId: uuidv7(options.now()),
        order: order++,
        documentId: uuidv7(options.now()),
        kind: "create",
        path: step.create.path,
        docKind: step.kind,
        revisionId: uuidv7(options.now()),
        contentHash: step.create.hash,
        contentSize: step.create.size,
        sent: false,
      });
      continue;
    }
    const projection = projections.get(step.id);
    if (projection === undefined) continue;
    const op = record(projection, step.next, order, options.now);
    if (op === "drop" && projection.lastOp !== undefined) change.deletePending.push(projection.lastOp.opId);
    if (typeof op === "object") {
      change.putPending.push(op);
      if (op.order === order) order++;
    }
  }
  return change.putPending.length === 0 && change.deletePending.length === 0 ? {} : change;
}

/**
 * The pending operation that takes `projection` to `next`: its last
 * operation rewritten when that was never sent, a new one otherwise. "drop"
 * removes the unsent last operation (the change was undone), "none" changes
 * nothing.
 */
function record(projection: Projection, next: State, nextOrder: number, now: () => number): PendingOp | "drop" | "none" {
  const unsent = projection.lastOp !== undefined && !projection.lastOp.sent ? projection.lastOp : undefined;
  const before: State | undefined = unsent !== undefined ? projection.beforeLast : { path: projection.path, hash: projection.hash, size: projection.size, deleted: projection.deleted };
  if (before === undefined && next.deleted) return unsent !== undefined ? "drop" : "none";
  if (before !== undefined && sameState(before, next)) return unsent !== undefined ? "drop" : "none";
  // A delete names the content it deletes, which the server already holds: the state before this operation.
  const content = next.deleted && before !== undefined ? before : next;
  const kind: PendingKind = next.deleted ? "delete" : before === undefined || before.deleted ? "create" : before.path !== next.path ? "rename" : "edit";
  return {
    opId: unsent?.opId ?? uuidv7(now()),
    order: unsent?.order ?? nextOrder,
    documentId: projection.documentId,
    kind,
    path: next.path,
    docKind: projection.kind,
    revisionId: unsent?.revisionId ?? uuidv7(now()),
    contentHash: content.hash,
    contentSize: content.size,
    sent: false,
    // A refused path stays refused until the file is renamed.
    ...(unsent?.refused !== undefined && unsent.path === next.path ? { refused: unsent.refused } : {}),
  };
}

function sameState(a: State, b: State): boolean {
  return a.deleted === b.deleted && a.path === b.path && (a.deleted || a.hash === b.hash);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return groups;
}
