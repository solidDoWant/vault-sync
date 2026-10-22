import { priorRevisionLimit, releasedRows, type Absence, type Binding, type DocumentKindName, type DocumentState, type Journal, type JournalChanges, type PendingOperation } from "../journal/journal";
import { sha256Hex } from "../hash";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import type { PathSpace } from "./pathspace";
import { classifyByExtension } from "./remote";

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
type BindingsVault = Pick<VaultAdapter, "stat" | "list" | "read" | "isSynced">;

/**
 * The owner of every document's `binding` and `absence` (design §4.1, §9.1):
 * which local file is the document on this device. It maintains bindings
 * from vault events (E1–E5), from the engine's own changes and from the
 * start-up scan (E7, with its content match since refactor step R11). Since refactor step
 * R7 the engine decides which file is a document's by them alone (PO-1).
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
  /**
   * The file keys a create, delete or rename event named while the scan ran,
   * as the events arrived (observe): the scan may have read the disk after
   * them, and their transitions run after it.
   */
  private readonly raced = new Set<string>();
  /** How many rounds are running, and the document rows they read (round). */
  private rounds = 0;
  private snapshot: Map<string, DocumentState> | undefined;
  /**
   * The documents the scan unbound for a file missing at their binding's
   * file key: the file there before the scan, which a rename event during
   * the scan may have moved (see renamed). An event that puts another file
   * at the key (appeared, renamed) ends the entry.
   */
  private readonly missing = new Map<string, { documentId: string; seen: string }>();
  /** The documents the scan's content match bound to another file, by that file's key, with the key of the file it found missing (see renamed, deleted). */
  private readonly matched = new Map<string, { documentId: string; from: string }>();

  constructor(
    private readonly journal: BindingsJournal,
    private readonly vault: BindingsVault,
    private readonly space: PathSpace,
    /** The kind of a file, by path, as the push classifies a new document (E7 matches only a file of the document's kind). */
    private readonly classify: (path: string) => DocumentKindName = classifyByExtension,
  ) {
    // The start-up scan runs before any event's transition, since events
    // lost to a crash or made while the app was closed are only seen there.
    // A failed scan fails every later transition and write (serialize).
    this.serialize(() => this.scan())
      .finally(() => {
        this.scanPending = false;
        this.raced.clear();
      })
      .catch(() => undefined);
  }

  /**
   * Notes a vault event as it arrives, before its transition is queued, and
   * returns whether the start-up scan is still running (`duringScan` of
   * renamed and deleted). While it runs, the file keys a create, delete or
   * rename names are kept: a rename cycle the scan finds at one of them is
   * left to the events (cycleMatch, #921).
   */
  observe(event: VaultEvent): boolean {
    if (!this.scanPending) return false;
    if (event.type === "rename") this.raced.add(this.space.filesystemKey(event.oldPath));
    if (event.type !== "modify") this.raced.add(this.space.filesystemKey(event.path));
    return true;
  }

  /**
   * Runs `task` with the journal's document rows read once and kept in
   * memory (`documents`) until it ends: a pull reads them per revision
   * (rule W's file holders), and an IndexedDB journal reads every row per
   * call. Every write of a document row goes through here (write), so the
   * copy stays the journal's.
   */
  async round<T>(task: () => Promise<T>): Promise<T> {
    this.rounds++;
    try {
      return await task();
    } finally {
      if (--this.rounds === 0) this.snapshot = undefined;
    }
  }

  /** Every document row, in id order as the journal lists them, once every transition and write queued so far has finished. */
  documents(): Promise<DocumentState[]> {
    return this.serialize(async () => {
      if (this.rounds === 0) return this.journal.listDocuments();
      this.snapshot ??= new Map((await this.journal.listDocuments()).map((state) => [state.documentId, state]));
      return [...this.snapshot.values()].sort((left, right) => (left.documentId < right.documentId ? -1 : left.documentId > right.documentId ? 1 : 0)).map((state) => ({ ...state }));
    });
  }

  /**
   * Resolves once every transition and write queued so far has finished.
   * A failed one rejected to its caller, and fails every later one.
   */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /**
   * Writes `state` with the binding `change` gives it (see BindingChange),
   * together with `alongside` in the same transaction: the final step
   * of an `apply`, `merge` or `commit` (design §4.4), which also removes the
   * outbox, the deferral or the intent and moves the cursor.
   */
  put(state: DocumentState, change: BindingChange, alongside: JournalChanges = {}): Promise<void> {
    return this.serialize(async () => {
      const current = await this.journal.getDocument(state.documentId);
      const next = { ...state, ...this.bindingAfter(state, current, change), ...priorAfter(state, current) };
      if (change.kind === "applied" || change.kind === "merged") next.binding = await this.keptName(current?.binding, next.binding);
      const others = next.binding === null ? [] : await this.unbindOthers(next.documentId, next.binding.spelling, "released");
      await this.write({ ...alongside, putDocuments: [...(alongside.putDocuments ?? []), ...others, next] });
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
      await this.write({ addPending: [operation], putDocuments: [...others, row] });
    });
  }

  /**
   * The push read `hash` in the file at `spelling` of a document it held
   * back without an outbox (E4, #877): it is the binding's `seen` if the
   * document is still bound to that file, so the start-up scan (E7) still
   * finds the file by content after a rename made while the app was closed.
   */
  read(documentId: string, spelling: string, hash: string): Promise<void> {
    return this.serialize(async () => {
      const state = await this.journal.getDocument(documentId);
      const binding = state?.binding;
      if (state === undefined || binding === null || binding === undefined) return;
      if (binding.fileKey !== this.space.filesystemKey(spelling) || binding.seen === hash) return;
      await this.write({ putDocuments: [{ ...state, binding: { ...binding, seen: hash } }] });
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
      if (changes !== undefined) await this.write(changes);
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
      await this.write({ addPending: [operation], putDocuments: [...others, { ...state, binding: this.bound(operation.path, operation.contentHash), absence: null }] });
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
      await this.write({ removePending: revisionIds, removeDocuments: [...documents] });
    });
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
    // the event arrived) moved. The vault moves only an existing file, and
    // no event put another one at `from` since the scan began (missing), so
    // it is the document's own file, whatever its content (E1, PO-1, #758).
    const early = duringScan;
    return this.serialize(async () => {
      const key = this.space.filesystemKey(from);
      const missing = early ? this.missing.get(key) : undefined;
      this.missing.delete(key);
      // The file now at `to` is another one than any the scan found missing there.
      this.missing.delete(this.space.filesystemKey(to));
      // The scan's content match already followed this rename: its document is bound at `to`.
      const followed = early ? this.matched.get(this.space.filesystemKey(to)) : undefined;
      if (followed !== undefined && followed.from === key) {
        this.matched.delete(this.space.filesystemKey(to));
        return;
      }
      // Every row at the key: a v2 journal's migration may have bound several
      // documents to the file (indexeddb.ts deriveV3Records). The first, the
      // lowest id, keeps it; the others are released, not user-deleted, as
      // the user deleted nothing (C1, #641).
      const [found, ...duplicates] = await this.journal.documentsByFileKey(key);
      // A new file the user made at the old path, or moved there, and moved
      // away is another one (PO-1, INV-3): its event ended `missing`, which
      // leaves the document deleted.
      const lost = found === undefined && missing !== undefined ? await this.journal.getDocument(missing.documentId) : undefined;
      const moved = found ?? (lost === undefined || lost.binding !== null ? undefined : { ...lost, binding: { spelling: from, fileKey: key, seen: missing?.seen ?? lost.baseHash } });
      const changes = this.space.oneFile(from, to) ? [] : await this.unbindOthers(moved?.documentId, to, "user-deleted");
      changes.push(...duplicates.map((other) => ({ ...other, ...unbound("released") })));
      if (moved !== undefined) changes.push({ ...moved, binding: { spelling: to, fileKey: this.space.filesystemKey(to), seen: moved.binding?.seen ?? moved.baseHash }, absence: null });
      if (changes.length > 0) await this.write({ putDocuments: changes });
    });
  }

  /**
   * The file at `path` was deleted: by the user (E3), whose delete leaves
   * the document `user-deleted`, or by the engine, which gives the file up
   * (`released`) unless the write that follows says otherwise.
   */
  deleted(path: string, by: "user" | "engine", duringScan = false): Promise<void> {
    return this.serialize(async () => {
      // A file the scan's content match bound a document to, still there:
      // the delete was of the file there before it (E7b's other document's,
      // which the vault removed before the rename that put this file there).
      const key = this.space.filesystemKey(path);
      const followed = duringScan ? this.matched.get(key) : undefined;
      if (followed !== undefined && (await this.vault.stat(path)) !== null) return;
      this.matched.delete(key);
      const changes = await this.unbindOthers(undefined, path, by === "user" ? "user-deleted" : "released");
      if (changes.length > 0) await this.write({ putDocuments: changes });
    });
  }

  /**
   * A file was created at `path` (E5): an untracked file, which changes no
   * binding. It is not the file the scan found missing at its key, so a
   * later rename of it is not that document's (renamed, #671).
   */
  appeared(path: string): Promise<void> {
    return this.serialize(() => {
      this.missing.delete(this.space.filesystemKey(path));
      return Promise.resolve();
    });
  }

  /**
   * Runs `task` after every transition and write queued before it. A task
   * that failed leaves the journal's bindings short of a transition, so
   * every later one fails with its error: nothing may decide by bindings
   * until a restart's scan (E7) has reconciled them with the disk (PO-3).
   */
  /** Applies `changes` to the journal, and to the rows `documents` keeps for a round. */
  private async write(changes: JournalChanges): Promise<void> {
    try {
      await this.journal.transact(changes);
    } catch (error) {
      this.snapshot = undefined;
      throw error;
    }
    const snapshot = this.snapshot;
    if (snapshot === undefined) return;
    for (const state of changes.putDocuments ?? []) snapshot.set(state.documentId, { ...state });
    for (const documentId of changes.removeDocuments ?? []) snapshot.delete(documentId);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run;
    return run;
  }

  /**
   * E7: a document bound to a file the vault no longer has was renamed or
   * deleted while the app was not watching (or by a change whose event a
   * kill lost). Its binding moves to the one file that holds its `seen`
   * content, when the content match is unique (contentMatch); otherwise
   * the document is `user-deleted`. A row without a recorded binding gets one derived from its
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
    const lost = new Map<string, Binding>();
    const scanned: DocumentState[] = [];
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
        lost.set(state.documentId, binding);
        binding = null;
        absence = "user-deleted";
      }
      if (binding !== null && !listed.includes(binding.spelling)) {
        const key = binding.fileKey;
        const spellings = listed.filter((path) => this.space.filesystemKey(path) === key);
        // Folders are not respelled (INV-9, #737): a folder has one spelling
        // on disk, which the engine never chases. A binding spelled like the
        // file but for such folders (the server's `Notes/a.md` for the file
        // `notes/a.md`) keeps its spelling, or the push would take the
        // folder's disk spelling for the user's rename.
        if (spellings.length === 1 && spellings[0] !== undefined && !this.space.sameButFolderSpelling(spellings[0], binding.spelling)) binding = { spelling: spellings[0], fileKey: binding.fileKey, seen: binding.seen };
      }
      scanned.push({ ...state, binding, absence });
    }
    const transferred = lost.size === 0 ? new Map<string, Binding | null>() : await this.contentMatch(scanned, lost);
    for (const [documentId, binding] of await this.cycleMatch(scanned, transferred)) transferred.set(documentId, binding);
    const read = new Map(documents.map((state) => [state.documentId, state]));
    for (const state of scanned) {
      const before = read.get(state.documentId);
      const binding = transferred.has(state.documentId) ? (transferred.get(state.documentId) ?? null) : state.binding;
      const absence = binding === null ? (state.absence ?? "user-deleted") : null;
      const missing = binding === null ? lost.get(state.documentId) : undefined;
      if (missing !== undefined) this.missing.set(missing.fileKey, { documentId: state.documentId, seen: missing.seen });
      if (before !== undefined && (binding !== before.binding || absence !== (before.absence ?? null))) changes.set(state.documentId, { ...state, binding, absence });
    }
    if (changes.size > 0) await this.write({ putDocuments: [...changes.values()] });
  }

  /**
   * E7's content match (decision 4, design §4.3): the new binding of each
   * document whose bound file the scan found missing (`lost`, its binding
   * then), and null for each document whose file such a match took. A
   * missing document takes the file that holds its `seen` content, of its
   * kind, in the vault's scope, when that match is one-to-one: exactly one
   * such file, and no other missing document with that content. The file
   * is untracked, or (E7b) bound to another document but holding that
   * content and not its own `seen`: the vault moves nothing onto an
   * existing file, so that document's own file was gone, and it is
   * `user-deleted` (PO-1, PO-3; #793). An in-place overwrite with that
   * content is byte-identical and is taken the same way (design §4.3's
   * known limit, #827). It may then take another file
   * itself (a rename chain), until no match is left. Two identical files
   * match nothing: they stay a delete plus a create. Only a file that could
   * match is read: one of a missing document's kind and, when every such
   * document's content size is known, of one of those sizes (#826).
   */
  private async contentMatch(scanned: readonly DocumentState[], lost: ReadonlyMap<string, Binding>): Promise<Map<string, Binding | null>> {
    const kinds = new Map(scanned.map((state) => [state.documentId, state.kind]));
    // The size of the content a document's binding saw, where the row knows it: its live base's.
    const sizes = new Map(scanned.flatMap((state) => (state.deleted || state.baseHash === "" ? [] : [[state.documentId, { hash: state.baseHash, size: Number(state.size) }] as const])));
    const sizeOf = (documentId: string, binding: Binding): number | undefined => {
      const known = sizes.get(documentId);
      return known !== undefined && known.hash === binding.seen ? known.size : undefined;
    };
    const bindings = new Map(scanned.flatMap((state) => (state.binding == null ? [] : [[state.documentId, state.binding] as const])));
    const missing = new Map(lost);
    const result = new Map<string, Binding | null>();
    const hashes = new Map<string, string | null>();
    const hashOf = async (path: string): Promise<string | null> => {
      if (!hashes.has(path)) hashes.set(path, await this.hashAt(path));
      return hashes.get(path) ?? null;
    };
    const stats = new Map<string, number>();
    const sizeAt = async (path: string): Promise<number> => {
      if (!stats.has(path)) stats.set(path, (await this.vault.stat(path))?.size ?? -1);
      return stats.get(path) ?? -1;
    };
    const listed = (await this.vault.list()).filter((path) => this.vault.isSynced?.(path) ?? true);
    // A file a match bound is never a candidate again, so each round that moves a binding takes a file for good, and the rounds end.
    const assigned = new Set<string>();
    for (;;) {
      const owners = new Map([...bindings].map(([documentId, binding]) => [binding.fileKey, documentId]));
      // Only a file of a missing document's kind, and of its content's size
      // where every such document's is known, can match: the others are
      // never read, so the scan of a large vault reads only what may match.
      const wanted = new Map<DocumentKindName, Set<number> | null>();
      for (const [documentId, binding] of missing) {
        const kind = kinds.get(documentId);
        if (kind === undefined) continue;
        const known = wanted.get(kind);
        const size = sizeOf(documentId, binding);
        if (known !== null) wanted.set(kind, size === undefined ? null : (known ?? new Set<number>()).add(size));
      }
      // Every file that may be a missing document's: untracked, or bound to a document whose content it no longer holds.
      const candidates: { path: string; hash: string; owner: string | undefined }[] = [];
      for (const path of listed) {
        // A file an event named while the scan ran is the events' to place (E1, #921): following it here too would apply that move twice.
        if (assigned.has(path) || this.raced.has(this.space.filesystemKey(path))) continue;
        const kind = this.classify(path);
        if (!wanted.has(kind)) continue;
        const wantedSizes = wanted.get(kind);
        if (wantedSizes != null && !wantedSizes.has(await sizeAt(path))) continue;
        const owner = owners.get(this.space.filesystemKey(path));
        const hash = await hashOf(path);
        if (hash === null) continue;
        // The owner's file is the one listed at its binding's spelling, or at
        // that spelling but for folders `F` takes for one: a folder has one
        // spelling on disk, which the scan never chases (INV-9, #737), so a
        // folder re-created in another case while the app was closed still
        // holds the owner's file (#868).
        const ownSpelling = owner === undefined ? undefined : bindings.get(owner)?.spelling;
        if (owner !== undefined && (bindings.get(owner)?.seen === hash || ownSpelling === undefined || (ownSpelling !== path && !this.space.sameButFolderSpelling(path, ownSpelling)))) continue;
        candidates.push({ path, hash, owner });
      }
      const moves: { documentId: string; candidate: (typeof candidates)[number] }[] = [];
      for (const [documentId, binding] of missing) {
        const kind = kinds.get(documentId);
        const files = candidates.filter((candidate) => candidate.hash === binding.seen && this.classify(candidate.path) === kind);
        const rivals = [...missing].filter(([other, otherBinding]) => otherBinding.seen === binding.seen && kinds.get(other) === kind);
        const [file] = files;
        if (files.length === 1 && rivals.length === 1 && file !== undefined) moves.push({ documentId, candidate: file });
      }
      if (moves.length === 0) break;
      for (const { documentId, candidate } of moves) {
        const before = missing.get(documentId);
        if (before === undefined) continue;
        const binding = { spelling: candidate.path, fileKey: this.space.filesystemKey(candidate.path), seen: before.seen };
        assigned.add(candidate.path);
        missing.delete(documentId);
        bindings.set(documentId, binding);
        result.set(documentId, binding);
        this.matched.set(binding.fileKey, { documentId, from: before.fileKey });
        if (candidate.owner === undefined) continue;
        const taken = bindings.get(candidate.owner);
        bindings.delete(candidate.owner);
        result.set(candidate.owner, null);
        if (taken !== undefined) missing.set(candidate.owner, taken);
      }
    }
    return result;
  }

  /**
   * E7c, rename cycles (design §4.3, #921): files the user swapped or
   * rotated while the app was not running, through a temporary name. No
   * bound file is missing then, so E7 and E7b never start: each file is
   * still at a binding's path, holding another document's `seen`. Each
   * document of a cycle takes the file that holds its `seen` when the match
   * is one-to-one: the document's file holds another document's `seen` and
   * not its own, no other file read holds that content, and no other
   * document of its kind has it as `seen`; and following those files closes
   * a cycle. Cross-overwrites that leave exactly these bytes are taken the
   * same way, as E7b takes an in-place overwrite (#827): no bytes are lost.
   * Only a document whose `seen` size is known (its live base's) is in a
   * cycle, and only a file whose `stat` size is another such document's of
   * its kind is read (#826). A cycle with a file key that an event named
   * while the scan ran is left alone: those events, applied after the scan
   * (E1), are the moves it would follow, and following them again on top of
   * its result would undo it (#921).
   */
  private async cycleMatch(scanned: readonly DocumentState[], transferred: ReadonlyMap<string, Binding | null>): Promise<Map<string, Binding>> {
    const result = new Map<string, Binding>();
    const bindings = new Map(scanned.flatMap((state) => {
      const binding = transferred.has(state.documentId) ? transferred.get(state.documentId) : state.binding;
      return binding == null ? [] : [[state.documentId, binding] as const];
    }));
    // The documents that may be in a cycle: bound, not matched already, with their `seen` content's size known.
    const members = new Map(scanned.flatMap((state) => {
      const binding = bindings.get(state.documentId);
      if (binding === undefined || transferred.has(state.documentId) || state.deleted || state.baseHash === "" || binding.seen !== state.baseHash) return [];
      return [[state.documentId, { binding, kind: state.kind, size: Number(state.size) }] as const];
    }));
    if (members.size < 2) return result;
    // How many members of each kind have each size: a file can hold another member's `seen` only at a size some other member has.
    const sizes = new Map<DocumentKindName, Map<number, number>>();
    for (const member of members.values()) {
      const counts = sizes.get(member.kind) ?? new Map<number, number>();
      counts.set(member.size, (counts.get(member.size) ?? 0) + 1);
      sizes.set(member.kind, counts);
    }
    const owners = new Map([...bindings].map(([documentId, binding]) => [binding.fileKey, documentId]));
    // Every file read that may hold a member's `seen`: bound to a document, or untracked.
    const holders = new Map<string, { kind: DocumentKindName; path: string }[]>();
    const held = new Map<string, string>();
    for (const path of (await this.vault.list()).filter((listed) => this.vault.isSynced?.(listed) ?? true)) {
      const kind = this.classify(path);
      const counts = sizes.get(kind);
      if (counts === undefined) continue;
      const owner = owners.get(this.space.filesystemKey(path));
      const ownerBinding = owner === undefined ? undefined : bindings.get(owner);
      // A bound file listed at another spelling than its binding's is not read: the respelling above already took the vault's.
      if (ownerBinding !== undefined && ownerBinding.spelling !== path) continue;
      // A transferred document's file is E7's already.
      if (owner !== undefined && transferred.has(owner)) continue;
      const size = (await this.vault.stat(path))?.size;
      if (size === undefined) continue;
      const others = (counts.get(size) ?? 0) - (owner !== undefined && members.get(owner)?.size === size && members.get(owner)?.kind === kind ? 1 : 0);
      if (others < 1) continue;
      const hash = await this.hashAt(path);
      if (hash === null) continue;
      holders.set(hash, [...(holders.get(hash) ?? []), { kind, path }]);
      if (owner !== undefined) held.set(owner, hash);
    }
    // next(D): the member that takes D's file, the one whose `seen` D's file holds, one-to-one.
    const next = new Map<string, string>();
    for (const [documentId, member] of members) {
      const hash = held.get(documentId);
      if (hash === undefined || hash === member.binding.seen) continue;
      const files = (holders.get(hash) ?? []).filter((holder) => holder.kind === member.kind);
      const takers = scanned.filter((state) => state.kind === member.kind && bindings.get(state.documentId)?.seen === hash);
      const [taker] = takers;
      if (files.length !== 1 || takers.length !== 1 || taker === undefined || !members.has(taker.documentId)) continue;
      next.set(documentId, taker.documentId);
    }
    const visited = new Set<string>();
    for (const start of next.keys()) {
      if (visited.has(start)) continue;
      const cycle: string[] = [];
      let at: string | undefined = start;
      while (at !== undefined && !visited.has(at) && !cycle.includes(at)) {
        cycle.push(at);
        at = next.get(at);
      }
      for (const documentId of cycle) visited.add(documentId);
      if (at !== start) continue;
      if (cycle.some((documentId) => this.raced.has(members.get(documentId)?.binding.fileKey ?? ""))) continue;
      for (const documentId of cycle) {
        const taker = next.get(documentId);
        const file = members.get(documentId)?.binding;
        const seen = taker === undefined ? undefined : members.get(taker)?.binding.seen;
        if (taker === undefined || file === undefined || seen === undefined) continue;
        result.set(taker, { spelling: file.spelling, fileKey: file.fileKey, seen });
      }
    }
    return result;
  }

  /** The content hash of the vault's file at `path`, or null if it has none there. */
  private async hashAt(path: string): Promise<string | null> {
    try {
      return sha256Hex(await this.vault.read(path));
    } catch (error) {
      if (isVaultError(error)) return null;
      throw error;
    }
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
   * the file's name, so the binding keeps its spelling, and who put the
   * file there (Binding.displaced, Binding.userSpelling).
   */
  private written(kept: Binding | null | undefined, path: string, seen: string): Binding {
    const binding = this.bound(path, seen);
    if (kept === undefined || kept === null || kept.fileKey !== binding.fileKey) return binding;
    if (kept.displaced !== true) return { ...binding, spelling: kept.spelling };
    return { ...binding, spelling: kept.spelling, displaced: true, ...(kept.userSpelling === undefined ? {} : { userSpelling: kept.userSpelling }) };
  }

  /**
   * The binding of an engine write at `written`'s spelling into the file
   * the document was bound to at another spelling that the vault takes for
   * the same file: it lists the bound spelling, not the written one, and
   * finds a file at the written one. The vault keeps the file's name, so
   * the binding keeps its spelling (as NTFS and APFS keep the name of a
   * file written under another spelling `F` takes for it, design §3.1).
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

/**
 * Whether the journal has a server revision of the document: false for the
 * row of a create not acknowledged yet (Bindings.created), which has none.
 */
export function hasBase(state: DocumentState): boolean {
  return state.revisionId !== "";
}

/**
 * Whether two reads of a document's row bind it to the same file: the same
 * spelling, or no file for the same reason. A user transition (E1–E3,
 * PO-2) changes one or the other.
 */
export function sameBinding(before: DocumentState | undefined, after: DocumentState | undefined): boolean {
  return (before?.binding?.spelling ?? null) === (after?.binding?.spelling ?? null) && (before?.absence ?? null) === (after?.absence ?? null);
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
