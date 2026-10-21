import { priorRevisionLimit, releasedRows, type Absence, type Binding, type DocumentState, type Journal, type JournalChanges, type PendingOperation } from "../journal/journal";
import type { VaultAdapter } from "../vault/adapter";
import type { PathSpace } from "./pathspace";

/**
 * What an engine write of a document's state did to its local file, which
 * decides the binding the row is written with (docs/design/engine-path-ownership.md
 * §4.3, §4.4):
 *
 * - `applied`: a remote revision was applied to disk (or found applied). A
 *   live one binds the document to the file at its path with the revision's
 *   content; a tombstone leaves it no file (`never`).
 * - `merged`: a merge result is on disk at `path` with content `hash`, or,
 *   with `hash` null, the result deleted the file.
 * - `acknowledged`: the server acknowledged this device's own commit. The
 *   document keeps the file it is bound to (the engine read `hash` there), a
 *   delete leaves it none (`user-deleted`), and a document the journal did
 *   not have yet is bound to the file at the commit's path.
 * - `released`: the engine gave up the document's file (an unmaterializable
 *   or otherwise blocked path), so it has none (`released`). The base stays
 *   as it is: `deleted` is the base's own flag (journal v5).
 * - `moved`: the engine moved the document's file to the state's path.
 * - `adopted`: the engine found the document's synced content back in the
 *   file at `path` after the user deleted the document's file, and takes
 *   that file as the document's again.
 * - `kept`: only base fields changed; the binding stays as it is.
 */
export type BindingChange =
  | { kind: "applied" }
  | { kind: "merged"; path: string; hash: string | null }
  | { kind: "acknowledged"; hash: string }
  | { kind: "released" }
  | { kind: "moved" }
  | { kind: "adopted"; path: string }
  | { kind: "kept" };

type BindingsJournal = Pick<Journal, "getDocument" | "listDocuments" | "listPending" | "listDeferred" | "documentsByFileKey" | "transact">;
type BindingsVault = Pick<VaultAdapter, "stat" | "list">;

/**
 * The owner of every document's `binding` and `absence` (design §4.1, §9.1):
 * which local file is the document on this device. Refactor step R4 runs it
 * in shadow mode: it maintains bindings from vault events (E1–E5), from the
 * engine's own changes and from the start-up scan (E7, without the content
 * match of R11), and nothing decides by them yet; SyncEngine.bindingShadow
 * compares them with the ownership the engine still derives.
 *
 * Every write of a document row goes through here, one at a time, and reads
 * the row's binding as it is when written: an event's transition and an
 * engine write of the same row never lose each other's change.
 */
export class Bindings {
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether the start-up scan has not finished: an event now may be one whose result the scan reads from the disk. */
  get scanning(): boolean {
    return this.scanPending;
  }
  private scanPending = true;
  /** The documents the scan unbound for a file missing at their binding's file key (see renamed). */
  private readonly missing = new Map<string, { documentId: string; seen: string }>();

  constructor(
    private readonly journal: BindingsJournal,
    private readonly vault: BindingsVault,
    private readonly space: PathSpace,
  ) {
    // The start-up scan runs before any event's transition, since events
    // lost to a crash or made while the app was closed are only seen there.
    // A failed scan fails every later transition and write (serialize).
    this.serialize(() => this.scan())
      .finally(() => {
        this.scanPending = false;
      })
      .catch(() => undefined);
  }

  /**
   * Resolves once every transition and write queued so far has finished.
   * A failed one rejected to its caller, and fails every later one.
   */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Writes `state` with the binding `change` gives it (see BindingChange). */
  put(state: DocumentState, change: BindingChange): Promise<void> {
    return this.serialize(async () => {
      const current = await this.journal.getDocument(state.documentId);
      const next = { ...state, ...this.bindingAfter(state, current, change), ...priorAfter(state, current) };
      if (change.kind === "applied" || change.kind === "merged") next.binding = await this.keptName(current?.binding, next.binding);
      const others = next.binding === null ? [] : await this.unbindOthers(next.documentId, next.binding.spelling, "released");
      await this.journal.transact({ putDocuments: [...others, next] });
    });
  }

  /**
   * Records `operation`, a create of a document the journal does not have
   * yet, with the document's row: no base (hasBase), bound to the file the
   * create reads (design §4.3, E2 note). A rename of the file before the
   * commit is acknowledged is then E1, and the acknowledgement keeps the
   * file the binding names.
   */
  created(operation: PendingOperation): Promise<void> {
    return this.serialize(async () => {
      const row = this.createRow(operation);
      const others = await this.unbindOthers(operation.documentId, operation.path, "released");
      await this.journal.transact({ addPending: [operation], putDocuments: [...others, row] });
    });
  }

  /**
   * Applies the changes `build` returns, read and written in one turn of the
   * queue: the final transaction of an intent (intents.ts), which changes a
   * binding together with other rows.
   */
  transact(build: () => Promise<JournalChanges | undefined>): Promise<void> {
    return this.serialize(async () => {
      const changes = await build();
      if (changes !== undefined) await this.journal.transact(changes);
    });
  }

  /**
   * Records `operation`, the next revision of a tombstoned document that an
   * untracked file at its path brings back (decision #17, PO-13; design
   * §4.8), with the document bound to that file, in one transaction.
   */
  revived(operation: PendingOperation): Promise<void> {
    return this.serialize(async () => {
      const state = await this.journal.getDocument(operation.documentId);
      if (state === undefined) throw new Error(`no document ${operation.documentId} to bring back`);
      const others = await this.unbindOthers(operation.documentId, operation.path, "released");
      await this.journal.transact({ addPending: [operation], putDocuments: [...others, { ...state, binding: this.bound(operation.path, operation.contentHash), absence: null }] });
    });
  }

  /**
   * Removes pending operations that will not be committed. A create's
   * document that has no base and no other operation left has no row any
   * more, in the same transaction: its file, if any, is untracked (E5).
   */
  dropped(revisionIds: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      const pending = await this.journal.listPending();
      const removed = new Set(revisionIds);
      const left = new Set(pending.filter((operation) => !removed.has(operation.revisionId)).map((operation) => operation.documentId));
      const documents = new Set<string>();
      for (const operation of pending) {
        if (!removed.has(operation.revisionId) || left.has(operation.documentId)) continue;
        const state = await this.journal.getDocument(operation.documentId);
        if (state !== undefined && !hasBase(state)) documents.add(operation.documentId);
      }
      await this.journal.transact({ removePending: revisionIds, removeDocuments: [...documents] });
    });
  }

  /**
   * The local moves not pushed yet (design §4.3 E1): each document whose
   * file is bound at a spelling other than its synced path, or, for a
   * create not acknowledged yet, other than the path its create reads.
   * `from` is that path, `to` the binding's spelling.
   */
  async moves(): Promise<LocalMove[]> {
    await this.idle();
    const creates = new Map<string, string>();
    for (const operation of await this.journal.listPending()) {
      if (operation.baseRevisionId === "" && !operation.deleted && !creates.has(operation.documentId)) creates.set(operation.documentId, operation.path);
    }
    const moves: LocalMove[] = [];
    for (const state of await this.journal.listDocuments()) {
      const binding = state.binding;
      if (binding === undefined || binding === null) continue;
      // A document bound on a tombstone (a local change that won over a remote delete) holds its file as a move from the tombstone's path.
      const from = hasBase(state) ? state.path : creates.get(state.documentId);
      if (from !== undefined && from !== binding.spelling) moves.push({ documentId: state.documentId, from, to: binding.spelling, created: !hasBase(state) });
    }
    return moves;
  }

  /**
   * A file moved from `from` to `to`, by the user (E1, E2) or by the
   * engine. The document bound to the file keeps it at `to`. A document
   * still bound at `to` (another file) has none any more: the vault moves
   * nothing onto an existing file, so its file was gone. Of several
   * documents a v2 migration bound to the file, the lowest id keeps it and
   * the others are released.
   */
  renamed(from: string, to: string, duringScan = false): Promise<void> {
    // The scan reads the disk after events it races with: a file it found
    // missing may be one that a rename made while it ran (`duringScan`, as
    // the event arrived) moved, which keeps its document's binding (the
    // vault moves only an existing file).
    const early = duringScan;
    return this.serialize(async () => {
      const key = this.space.filesystemKey(from);
      const missing = early ? this.missing.get(key) : undefined;
      this.missing.delete(key);
      // Every row at the key: a v2 journal's migration may have bound several
      // documents to the file (indexeddb.ts deriveV3Records). The first, the
      // lowest id, keeps it; the others are released, not user-deleted, as
      // the user deleted nothing (C1, #641).
      const [found, ...duplicates] = await this.journal.documentsByFileKey(key);
      const lost = found === undefined && missing !== undefined ? await this.journal.getDocument(missing.documentId) : undefined;
      const moved = found ?? (lost === undefined || lost.binding !== null ? undefined : { ...lost, binding: { spelling: from, fileKey: key, seen: missing?.seen ?? lost.baseHash } });
      const changes = this.space.oneFile(from, to) ? [] : await this.unbindOthers(moved?.documentId, to, "user-deleted");
      changes.push(...duplicates.map((other) => ({ ...other, ...unbound("released") })));
      if (moved !== undefined) changes.push({ ...moved, binding: { spelling: to, fileKey: this.space.filesystemKey(to), seen: moved.binding?.seen ?? moved.baseHash }, absence: null });
      if (changes.length > 0) await this.journal.transact({ putDocuments: changes });
    });
  }

  /**
   * The file at `path` was deleted: by the user (E3), whose delete leaves
   * the document `user-deleted`, or by the engine, which gives the file up
   * (`released`) unless the write that follows says otherwise.
   */
  deleted(path: string, by: "user" | "engine"): Promise<void> {
    return this.serialize(async () => {
      const changes = await this.unbindOthers(undefined, path, by === "user" ? "user-deleted" : "released");
      if (changes.length > 0) await this.journal.transact({ putDocuments: changes });
    });
  }

  /**
   * Runs `task` after every transition and write queued before it. A task
   * that failed leaves the journal's bindings short of a transition, so
   * every later one fails with its error: nothing may decide by bindings
   * until a restart's scan (E7) has reconciled them with the disk (PO-3).
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run;
    return run;
  }

  /**
   * E7 without the content match (refactor step R11): a document bound to a
   * file the vault no longer has was deleted while the app was not
   * watching. A row without a recorded binding gets one derived from its
   * base, as the v3 migration derives it (indexeddb.ts deriveV3Records),
   * and a create pending without a row (recorded before refactor step R5)
   * gets the row `created` writes.
   */
  private async scan(): Promise<void> {
    const changes = new Map<string, DocumentState>();
    // A row written with `deleted` doubling as "released" (before refactor
    // step R7b) gets its live base back, as journal v5 migrates an
    // IndexedDB journal; an in-memory journal has no migrations.
    const released = new Map(releasedRows(await this.journal.listDocuments(), await this.journal.listDeferred()).map((state) => [state.documentId, state]));
    for (const state of released.values()) changes.set(state.documentId, state);
    const documents = (await this.journal.listDocuments()).map((state) => released.get(state.documentId) ?? state);
    const known = new Set(documents.map((state) => state.documentId));
    for (const operation of await this.journal.listPending()) {
      if (operation.baseRevisionId !== "" || operation.deleted || known.has(operation.documentId)) continue;
      known.add(operation.documentId);
      const row = this.createRow(operation);
      documents.push(row);
      changes.set(row.documentId, row);
    }
    // A file the vault holds under another spelling than its binding's was
    // respelled while the app was not watching: the binding takes the
    // vault's spelling, as a rename event (E1) would have given it.
    const listed = this.space.rules.platform === "posix" ? [] : await this.vault.list();
    for (const state of documents) {
      let binding = state.binding;
      let absence = state.absence ?? null;
      if (binding === undefined) {
        binding = state.deleted ? null : this.bound(state.path, state.baseHash);
        absence = state.deleted ? "never" : null;
      }
      // A binding keyed by another `F` than the platform's (recorded before
      // Android's shared storage got its case-insensitive fold, #699) takes
      // the platform's, or documentByFileKey would not find it.
      if (binding !== null && binding.fileKey !== this.space.filesystemKey(binding.spelling)) binding = { ...binding, fileKey: this.space.filesystemKey(binding.spelling) };
      if (binding !== null && (await this.vault.stat(binding.spelling)) === null) {
        this.missing.set(binding.fileKey, { documentId: state.documentId, seen: binding.seen });
        binding = null;
        absence = "user-deleted";
      }
      if (binding !== null && !listed.includes(binding.spelling)) {
        const key = binding.fileKey;
        const spellings = listed.filter((path) => this.space.filesystemKey(path) === key);
        if (spellings.length === 1 && spellings[0] !== undefined) binding = { ...binding, spelling: spellings[0] };
      }
      if (binding !== state.binding || absence !== (state.absence ?? null)) changes.set(state.documentId, { ...state, binding, absence });
    }
    if (changes.size > 0) await this.journal.transact({ putDocuments: [...changes.values()] });
  }

  /** The row of a create not acknowledged yet: no base, bound to the file the create reads. */
  private createRow(operation: PendingOperation): DocumentState {
    return {
      documentId: operation.documentId,
      path: operation.path,
      revisionId: "",
      seq: 0n,
      baseHash: "",
      size: 0n,
      kind: operation.kind,
      deleted: true,
      binding: this.bound(operation.path, operation.contentHash),
      absence: null,
    };
  }

  private bindingAfter(state: DocumentState, current: DocumentState | undefined, change: BindingChange): { binding: Binding | null; absence: Absence | null } {
    const kept = current?.binding;
    switch (change.kind) {
      case "applied":
        return state.deleted ? unbound("never") : { binding: this.written(kept, state.path, state.baseHash), absence: null };
      case "merged":
        if (change.hash !== null) return { binding: this.written(kept, change.path, change.hash), absence: null };
        return unbound(current?.absence === "user-deleted" ? "user-deleted" : "never");
      case "acknowledged":
        if (state.deleted) return unbound("user-deleted");
        // A document the journal did not have: its create, bound where it was committed.
        if (current === undefined || kept === undefined) return { binding: this.bound(state.path, change.hash), absence: null };
        // The user deleted the file the commit read (E3): a file there now is another one.
        if (kept === null) return unbound(current.absence ?? "user-deleted");
        return { binding: { ...kept, seen: change.hash }, absence: null };
      case "released":
        return unbound("released");
      case "moved":
        return { binding: this.bound(state.path, kept?.seen ?? state.baseHash), absence: null };
      case "adopted":
        return { binding: this.bound(change.path, state.baseHash), absence: null };
      case "kept":
        if (kept === undefined) return state.deleted ? unbound("never") : { binding: this.bound(state.path, state.baseHash), absence: null };
        return { binding: kept, absence: current?.absence ?? null };
    }
  }

  /** The rows that leave every document other than `documentId` bound to the file at `path` with none, for `absence`. */
  private async unbindOthers(documentId: string | undefined, path: string, absence: Absence): Promise<DocumentState[]> {
    // Every row at the key, not one probe: a v2 journal's migration may have
    // bound two documents to one file key (indexeddb.ts deriveV3Records),
    // and a probe that finds `documentId` itself would hide the other.
    const bound = await this.journal.documentsByFileKey(this.space.filesystemKey(path));
    return bound.filter((other) => other.documentId !== documentId).map((other) => ({ ...other, ...unbound(absence) }));
  }

  /**
   * The binding of the file the engine wrote at `path` with content `seen`.
   * A write into the file the document is bound to under another spelling
   * of one file (a case-only rename on a case-insensitive platform) keeps
   * the file's name, so the binding keeps its spelling.
   */
  private written(kept: Binding | null | undefined, path: string, seen: string): Binding {
    const binding = this.bound(path, seen);
    return kept !== undefined && kept !== null && kept.fileKey === binding.fileKey ? { ...binding, spelling: kept.spelling } : binding;
  }

  /**
   * The binding of an engine write at `written`'s spelling into the file
   * the document was bound to at another spelling that the vault takes for
   * the same file: it lists the bound spelling, not the written one, and
   * finds a file at the written one. The vault keeps the file's name, so
   * the binding keeps its spelling (a vault that folds names more than the
   * platform's file key does, design §3.1, X-18).
   */
  private async keptName(kept: Binding | null | undefined, written: Binding | null): Promise<Binding | null> {
    if (written === null || kept === undefined || kept === null || kept.spelling === written.spelling) return written;
    const listed = await this.vault.list();
    if (!listed.includes(kept.spelling) || listed.includes(written.spelling) || (await this.vault.stat(written.spelling)) === null) return written;
    return { ...kept, seen: written.seen };
  }

  private bound(spelling: string, seen: string): Binding {
    return { spelling, fileKey: this.space.filesystemKey(spelling), seen };
  }
}

/** A local move not pushed yet (Bindings.moves). `created`: the document is a create not acknowledged yet. */
export interface LocalMove {
  documentId: string;
  from: string;
  to: string;
  created: boolean;
}

/**
 * Whether the journal has a server revision of the document: false for the
 * row of a create not acknowledged yet (Bindings.created), which has none.
 */
export function hasBase(state: DocumentState): boolean {
  return state.revisionId !== "";
}

/** Whether the engine gave up the document's file (`absence = released`, design §4.1): it has none here, whatever its base. */
export function released(state: DocumentState): boolean {
  return state.binding === null && state.absence === "released";
}

/**
 * Whether the document is live here: its base is a live revision and the
 * engine has not released its file. Its file may still be gone: the user
 * deleted it (`absence = user-deleted`), and the push deletes it.
 */
export function liveHere(state: DocumentState | undefined): state is DocumentState {
  return state !== undefined && !state.deleted && !released(state);
}

/**
 * The document's earlier revisions once `state` replaces `current`
 * (DocumentState.prior; design §4.6): the base it leaves when the base moves
 * to another revision, then the ones `state` names (a synced revision's
 * parent), then those `current` had. A document's history on a server is a
 * line, so each is an ancestor of the new base.
 */
function priorAfter(state: DocumentState, current: DocumentState | undefined): { prior?: string[] } {
  const left = current !== undefined && hasBase(current) && current.revisionId !== state.revisionId ? [current.revisionId] : [];
  const all = [...left, ...(state.prior ?? []), ...(current?.prior ?? [])].filter((revision) => revision !== "" && revision !== state.revisionId);
  if (all.length === 0 && state.prior === undefined && current?.prior === undefined) return {};
  return { prior: [...new Set(all)].slice(0, priorRevisionLimit) };
}

function unbound(absence: Absence): { binding: null; absence: Absence } {
  return { binding: null, absence };
}
