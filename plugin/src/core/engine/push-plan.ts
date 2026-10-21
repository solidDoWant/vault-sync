import { sha256Hex } from "../hash";
import type {
  DocumentKindName,
  DocumentState,
  PendingOperation,
} from "../journal/journal";
import { hasBase } from "./bindings";
import type { PathSpace } from "./pathspace";

/**
 * What the push plan reads: the journal's documents (base and binding), the
 * vault, and the engine's scope, kinds and ids.
 */
export interface PushPlanSource {
  space: PathSpace;
  documents: readonly DocumentState[];
  /** Every pending operation: a document with one has its outbox already, and waits for it. */
  pending: readonly PendingOperation[];
  /** Documents and paths the merge path owns or a blocker keeps (parked). */
  parked: { documents: ReadonlySet<string>; paths: ReadonlySet<string> };
  listed: readonly string[];
  read: (path: string) => Promise<Uint8Array | null>;
  inScope: (path: string) => boolean;
  classify: (path: string) => DocumentKindName;
  newId: () => string;
}

/** The changed paths the push looks at; `all` after a start or a resync, when events may have been lost. */
export interface DirtyPaths {
  all: boolean;
  paths: ReadonlySet<string>;
}

export interface PushPlan {
  /** Deletes first, then renames (in dependency order) and edits, then creates: a path a change frees is free before a create takes it. */
  operations: PendingOperation[];
  /** Dirty paths the plan left for a later push: a document or path busy with an outbox or the merge path has them. */
  waiting: Set<string>;
  /** Documents whose synced content is back in an untracked file at their path after the user deleted their file: the push binds them to it again. */
  adopted: { state: DocumentState; path: string }[];
  /** Operations that bring a tombstoned document back from an untracked file: recorded with the document bound to it (Bindings.revived). */
  revivals: Set<string>;
}

/**
 * The outbox derivation of design §4.8 (refactor step R5, §9.2): the
 * operations that make the server show what the device holds, one per
 * document at most, from each document's base and binding and from the
 * untracked files. Nothing is inferred from paths or contents:
 *
 * - a document whose file the user deleted (`absence = user-deleted`) is
 *   deleted, unless its synced content is back in an untracked file at its
 *   path, which it takes as its file again (`adopted`);
 * - a document bound at another spelling than its synced path is renamed
 *   there, with the file's content;
 * - a dirty bound file whose content differs from the base is an edit;
 * - a bound document on a tombstone (an edit that won over a remote delete,
 *   §4.7) is committed live at its file;
 * - an untracked file is a create, or the next revision of the tombstone
 *   at its path unless the user deleted that document's file since the
 *   tombstone was pulled or the document has an outbox (PO-13).
 *
 * A document with an outbox or parked by the merge path or a blocker waits,
 * and so do its paths: one outbox per document (§4.1).
 */
export async function planPush(
  source: PushPlanSource,
  dirty: DirtyPaths,
): Promise<PushPlan> {
  const { space, parked } = source;
  const busyDocuments = new Set([
    ...parked.documents,
    ...source.pending.map((operation) => operation.documentId),
  ]);
  const busyPaths = new Set([
    ...parked.paths,
    ...source.pending.map((operation) => operation.path),
  ]);
  // A busy document's synced path waits with it: a create there would be
  // refused while the server still has the document there (C3).
  for (const state of source.documents)
    if (busyDocuments.has(state.documentId) && hasBase(state) && !state.deleted)
      busyPaths.add(state.path);
  const dirtyFiles = new Set(
    [...dirty.paths].map((path) => space.filesystemKey(path)),
  );
  const isDirty = (path: string) =>
    dirty.all || dirtyFiles.has(space.filesystemKey(path));
  const listedByFile = new Map(
    source.listed.map((path) => [space.filesystemKey(path), path]),
  );
  const waiting = new Set<string>();
  const wait = (...paths: string[]) => {
    for (const path of paths) if (isDirty(path)) waiting.add(path);
  };

  // The file keys bound to a document (C1): a file at one of them is that document's, never untracked.
  // A document synced outside the scope holds no file here: its bound file in the scope is untracked.
  const bound = new Set<string>();
  for (const state of source.documents) {
    if (state.binding === null || state.binding === undefined) continue;
    if (hasBase(state) && !state.deleted && !source.inScope(state.path))
      continue;
    bound.add(state.binding.fileKey);
  }

  const removals: PendingOperation[] = [];
  const renames: { operation: PendingOperation; from: string }[] = [];
  const edits: PendingOperation[] = [];
  const creates: PendingOperation[] = [];
  const adopted: { state: DocumentState; path: string }[] = [];
  const revivals = new Set<string>();
  const adopting = new Set<string>();

  for (const state of source.documents) {
    if (!hasBase(state)) continue;
    const binding = state.binding;
    const live = !state.deleted;
    if (binding === null || binding === undefined) {
      if (
        !live ||
        state.absence !== "user-deleted" ||
        !source.inScope(state.path)
      )
        continue;
      if (busyDocuments.has(state.documentId) || busyPaths.has(state.path)) {
        wait(state.path);
        continue;
      }
      // The same content back at its path, in a file no other document has: the document's file again.
      const back = listedByFile.get(space.filesystemKey(state.path));
      if (
        back !== undefined &&
        !bound.has(space.filesystemKey(back)) &&
        sameHash(await source.read(back), state.baseHash)
      ) {
        adopted.push({ state, path: back });
        adopting.add(space.filesystemKey(back));
        continue;
      }
      removals.push(operation(source, state, state.path, null));
      continue;
    }
    if (live && !source.inScope(state.path)) continue;
    const at = binding.spelling;
    const moved = !live || at !== state.path;
    if (!moved && !isDirty(at)) continue;
    if (
      busyDocuments.has(state.documentId) ||
      busyPaths.has(at) ||
      (live && busyPaths.has(state.path))
    ) {
      wait(at, ...(live ? [state.path] : []));
      continue;
    }
    if (!source.inScope(at)) {
      // Moved out of the scope: a delete of the side in it (SPEC.md §8, config sync).
      if (live) removals.push(operation(source, state, state.path, null));
      continue;
    }
    const content = await source.read(at);
    if (content === null) {
      // Its event is still to come; the push after it looks again.
      wait(at);
      continue;
    }
    if (!live) edits.push(operation(source, state, at, content));
    else if (moved)
      renames.push({
        operation: operation(source, state, at, content),
        from: state.path,
      });
    else if (sha256Hex(content) !== state.baseHash)
      edits.push(operation(source, state, at, content));
  }

  // The tombstone at each path, the newest of its documents (decision #17).
  const tombstones = new Map<string, DocumentState>();
  for (const state of source.documents) {
    if (!hasBase(state) || !state.deleted || state.binding) continue;
    const known = tombstones.get(state.path);
    if (known === undefined || known.seq < state.seq)
      tombstones.set(state.path, state);
  }

  const candidates = dirty.all ? source.listed : [...dirty.paths];
  const seen = new Set<string>();
  for (const path of [...candidates].sort()) {
    const key = space.filesystemKey(path);
    // The vault's own spelling of the file, if it holds one.
    const file = listedByFile.get(key);
    if (
      file === undefined ||
      seen.has(key) ||
      bound.has(key) ||
      adopting.has(key)
    )
      continue;
    seen.add(key);
    // Outside the scope, a changed file is no create (SPEC.md §8, config sync).
    if (!source.inScope(file)) continue;
    if (busyPaths.has(file) || busyPaths.has(path)) {
      wait(path);
      continue;
    }
    const content = await source.read(file);
    if (content === null) continue;
    // A file where a deleted document was brings that document back
    // (SPEC.md §8, decision #17), unless the user deleted the document's
    // file since its tombstone was pulled, or it has an outbox (PO-13).
    const tombstone = tombstones.get(file);
    if (
      tombstone !== undefined &&
      tombstone.absence !== "user-deleted" &&
      !busyDocuments.has(tombstone.documentId)
    ) {
      const revival = operation(source, tombstone, file, content);
      revivals.add(revival.revisionId);
      edits.push(revival);
      continue;
    }
    creates.push({
      revisionId: source.newId(),
      documentId: source.newId(),
      baseRevisionId: "",
      path: file,
      contentHash: sha256Hex(content),
      size: BigInt(content.length),
      kind: source.classify(file),
      deleted: false,
    });
  }

  return {
    operations: [
      ...removals,
      ...dependencyOrder(renames, space),
      ...edits,
      ...creates,
    ],
    waiting,
    adopted,
    revivals,
  };
}

/** A new revision of a known document: `content` at `path`, or a tombstone (null). */
function operation(
  source: PushPlanSource,
  state: DocumentState,
  path: string,
  content: Uint8Array | null,
): PendingOperation {
  return {
    revisionId: source.newId(),
    documentId: state.documentId,
    baseRevisionId: state.revisionId,
    path,
    contentHash: content === null ? state.baseHash : sha256Hex(content),
    size: content === null ? state.size : BigInt(content.length),
    kind: state.kind,
    deleted: content === null,
  };
}

/**
 * Renames ordered so that a document moves onto a path only after the
 * document synced there moved away. In a cycle (two files swapped) the rest
 * go in their own order: the server refuses one, which then moves to a
 * conflict-copy path (SPEC.md §6.3). Paths compare as the vault compares
 * them: a rename onto a case variant of a path waits for the rename away
 * from it.
 */
function dependencyOrder(
  renames: readonly { operation: PendingOperation; from: string }[],
  space: PathSpace,
): PendingOperation[] {
  const ordered: PendingOperation[] = [];
  let remaining = [...renames];
  const vacates = (other: { from: string }, path: string) =>
    space.fileKey(other.from) === space.fileKey(path);
  while (remaining.length > 0) {
    const ready = remaining.filter(
      (rename) =>
        !remaining.some(
          (other) => other !== rename && vacates(other, rename.operation.path),
        ),
    );
    const next = ready.length > 0 ? ready : remaining;
    ordered.push(...next.map((rename) => rename.operation));
    remaining = remaining.filter((rename) => !next.includes(rename));
  }
  return ordered;
}

function sameHash(content: Uint8Array | null, hash: string): boolean {
  return content !== null && sha256Hex(content) === hash;
}
