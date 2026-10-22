import { sha256Hex } from "../hash";
import type {
  DeferredRevision,
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
  /** Every deferred remote revision (`ahead`, design §4.1): a document whose revision the merge path or a blocker holds waits (busyClaims). */
  deferred: readonly DeferredRevision[];
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
  /**
   * The content the plan read in the bound file of a document it held back
   * without an outbox (a deferral blocks it): the binding's `seen` from now
   * on (design §4.3 E4, #877), so the start-up scan (E7) still finds the
   * file after a rename made while the app was closed.
   */
  read: { documentId: string; spelling: string; hash: string }[];
  /** Documents whose synced content is back in an untracked file at their path after the user deleted their file: the push binds them to it again. */
  adopted: { state: DocumentState; path: string }[];
  /** Operations that bring a tombstoned document back from an untracked file: recorded with the document bound to it (Bindings.revived). */
  revivals: Set<string>;
  /** Documents the restored server lacks whose bound path another claim takes: each is re-created at a copy name (design §4.6, displace intent). */
  yielding: { state: DocumentState; spelling: string }[];
  /** Documents the restored server lacks whose file the user deleted: the journal forgets them. */
  forgotten: string[];
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
 * A document with an outbox, or whose remote revision the merge path or a
 * blocker holds, waits, and so do its paths: one outbox per document
 * (§4.1).
 */
export async function planPush(
  source: PushPlanSource,
  dirty: DirtyPaths,
): Promise<PushPlan> {
  const { space } = source;
  const blocked = busyClaims(source.documents, source.deferred);
  const busyDocuments = new Set([
    ...blocked.documents,
    ...source.pending.map((operation) => operation.documentId),
  ]);
  const outboxes = new Set(source.pending.map((operation) => operation.documentId));
  const busyPaths = new Set([
    ...blocked.paths,
    ...source.pending.map((operation) => operation.path),
  ]);
  // A document waiting for its outbox keeps its synced path: a create
  // there would be refused while the server still has the document there
  // (C3). One whose revision is deferred claims the deferred revision's
  // path instead (busyClaims), the server's newest.
  for (const state of source.documents)
    if (busyDocuments.has(state.documentId) && !blocked.documents.has(state.documentId) && hasBase(state) && !state.deleted) busyPaths.add(state.path);
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
  const read: { documentId: string; spelling: string; hash: string }[] = [];

  const ghosts: { state: DocumentState; spelling: string }[] = [];
  const forgotten: string[] = [];
  for (const state of source.documents) {
    if (!hasBase(state)) continue;
    const binding = state.binding;
    const live = !state.deleted;
    if (ghost(state)) {
      // The restored server lacks it (design §4.6): re-created below, under
      // its own id, from the file it is bound to. Without one there is
      // nothing here to re-create, nor on the server to delete.
      if (binding === null || binding === undefined) {
        // The user deleted its file too: nothing is left of it anywhere, so
        // the journal forgets it (no tombstone to commit on a server that
        // never had it, and no claim on a path it holds nowhere).
        if (state.absence === "user-deleted" && !busyDocuments.has(state.documentId)) forgotten.push(state.documentId);
        continue;
      }
      if (!source.inScope(binding.spelling)) continue;
      if (busyDocuments.has(state.documentId) || busyPaths.has(binding.spelling)) {
        wait(binding.spelling);
        continue;
      }
      ghosts.push({ state, spelling: binding.spelling });
      continue;
    }
    if (binding === null || binding === undefined) {
      if (
        !live ||
        state.absence !== "user-deleted" ||
        !source.inScope(state.path)
      )
        continue;
      // A delete waits for its own busy state only: it leaves its synced
      // path, so no busy path is its claim (waits, #862).
      if (busyDocuments.has(state.documentId)) {
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
    // It waits for its own busy state or a busy path it claims (its file),
    // never for its synced path: a rename leaves that path, so it is no
    // claim on it, and a blocked document's file kept there must not hold
    // it off the server's path for good (PO-11, INV-8, #847).
    if (
      busyDocuments.has(state.documentId) ||
      busyPaths.has(at)
    ) {
      wait(at, ...(live ? [state.path] : []));
      // Held back without an outbox, its edit is still read (E4): `seen` is
      // what the engine last read there, and no acknowledgement will set it.
      if (!outboxes.has(state.documentId) && isDirty(at) && source.inScope(at)) {
        const content = await source.read(at);
        const hash = content === null ? undefined : sha256Hex(content);
        if (hash !== undefined && hash !== binding.seen) read.push({ documentId: state.documentId, spelling: at, hash });
      }
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
  // The row of a create not acknowledged yet (no base) may be among them;
  // it always has its outbox (Bindings.dropped removes the row with its
  // last operation), so it is busy and never revived below.
  const tombstones = new Map<string, DocumentState>();
  for (const state of source.documents) {
    if (!state.deleted || state.binding) continue;
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

  // Each ghost is re-created at its bound spelling, under its own id, unless
  // another claim takes that path (C3): the newest server claim of a document
  // the server has, or another outgoing operation. Then it yields, re-created
  // at a copy name by a displace intent (`yielding`), never refused. Of ghosts
  // that collide with each other under `K`, the first by bound spelling takes
  // the path: a spelling is the disk's and survives a crash, whereas the
  // document ids that order the journal are drawn anew by a restarted push's
  // creates (INV-7, #869).
  const yielding: { state: DocumentState; spelling: string }[] = [];
  if (ghosts.length > 0) {
    ghosts.sort((a, b) => (a.spelling < b.spelling ? -1 : a.spelling > b.spelling ? 1 : 0));
    const ahead = new Map(source.deferred.map((deferred) => [deferred.revision.documentId, deferred.revision]));
    const claims: string[] = [];
    for (const state of source.documents) {
      if (ghost(state) && !ahead.has(state.documentId)) continue;
      const newest = ahead.get(state.documentId) ?? state;
      if (hasBase(state) && !newest.deleted) claims.push(newest.path);
    }
    const outgoing = [...source.pending, ...removals, ...renames.map((rename) => rename.operation), ...edits, ...creates].filter((operation) => !operation.deleted).map((operation) => operation.path);
    for (const { state, spelling } of ghosts) {
      const taken = (path: string) => space.collides(path, spelling, "server");
      if (claims.some(taken) || outgoing.some(taken)) {
        yielding.push({ state, spelling });
        continue;
      }
      const content = await source.read(spelling);
      if (content === null) {
        wait(spelling);
        continue;
      }
      const create: PendingOperation = {
        revisionId: source.newId(),
        documentId: state.documentId,
        baseRevisionId: "",
        path: spelling,
        contentHash: sha256Hex(content),
        size: BigInt(content.length),
        kind: state.kind,
        deleted: false,
      };
      creates.push(create);
      outgoing.push(spelling);
    }
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
    read,
    revivals,
    yielding,
    forgotten,
  };
}

/**
 * A document the restored server lacks (design §4.6, SPEC.md §6.1): a live
 * base this device synced, which a resync found no head of (`seq` 0). The
 * next push re-creates it under its own id.
 */
export function ghost(state: DocumentState): boolean {
  return lost(state) && !state.deleted;
}

/**
 * A document whose base, live or a tombstone, the restored server lacks: a
 * resync found no head of it (`seq` 0, design §4.6). Its document does not
 * exist on the server, so an operation on it is a create under its own id,
 * with no base (PO-12, #829): a ghost, or a tombstone a file at its path
 * revives.
 */
export function lost(state: DocumentState): boolean {
  return hasBase(state) && state.seq === 0n;
}

/** Documents a deferred remote revision keeps from pushing, and the server claims they hold (busyClaims). */
export interface Busy {
  documents: Set<string>;
  paths: Set<string>;
}

/**
 * The documents whose local changes wait because their newest server
 * revision is deferred (design §4.5 step 2, §4.8): the merge path holds it
 * (`local-changes`), or a blocker does (`unmaterializable`, `out-of-scope`,
 * `too-large`). A commit of theirs would be refused, its base being behind
 * the server's head. Their server claims wait with them (C3): the
 * deferred revision's path, where the server has the document, and the
 * file the document is bound to here, wherever a local rename put it. A path is never held
 * for any other reason.
 */
export function busyClaims(documents: readonly DocumentState[], deferred: readonly DeferredRevision[]): Busy {
  const busy: Busy = { documents: new Set(), paths: new Set() };
  const states = new Map(documents.map((state) => [state.documentId, state]));
  for (const { revision, reason, unmaterializable: cause } of deferred) {
    if (reason === "invalid-path" || reason === "path-conflict") continue;
    busy.documents.add(revision.documentId);
    // The deferred revision's path waits with it, unless the revision is an
    // `F`-alias of another document's file (decision #52): that path is then
    // the holder's file here, and a blocker holds no disk claim (PO-11). The
    // holder's own change onto it, a respelling of its file, is sent, and
    // the server's refusal (C3) moves it to a copy name under its own id
    // (§4.5, local commits refused with `ALREADY_EXISTS`; #887).
    if (reason !== "unmaterializable" || cause !== "alias") busy.paths.add(revision.path);
    // Its file waits with it where the file is: a path its file left is
    // free for the document the server has there (PO-11).
    const spelling = states.get(revision.documentId)?.binding?.spelling;
    if (spelling !== undefined) busy.paths.add(spelling);
  }
  return busy;
}

/**
 * Whether an outbox operation waits (design §6.2, #847, #862): for its
 * document's busy state, or for a busy path it claims. A live revision
 * claims its path; a tombstone claims none, since a delete leaves its path,
 * so a blocked document's file kept there never holds it off the server
 * (PO-11, INV-8).
 */
export function waits(busy: Busy, operation: PendingOperation): boolean {
  return busy.documents.has(operation.documentId) || (!operation.deleted && busy.paths.has(operation.path));
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
    // On a base the restored server lost: a create under the document's own id (#829).
    baseRevisionId: lost(state) ? "" : state.revisionId,
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
