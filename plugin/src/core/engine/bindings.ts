import type { Absence, Binding, DocumentState, Journal } from "../journal/journal";
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
 *   or otherwise blocked path), so it has none (`released`).
 * - `moved`: the engine moved the document's file to the state's path.
 * - `kept`: only base fields changed; the binding stays as it is.
 */
export type BindingChange =
  | { kind: "applied" }
  | { kind: "merged"; path: string; hash: string | null }
  | { kind: "acknowledged"; hash: string }
  | { kind: "released" }
  | { kind: "moved" }
  | { kind: "kept" };

type BindingsJournal = Pick<Journal, "getDocument" | "listDocuments" | "documentByFileKey" | "documentsByFileKey" | "transact">;
type BindingsVault = Pick<VaultAdapter, "stat">;

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

  constructor(
    private readonly journal: BindingsJournal,
    private readonly vault: BindingsVault,
    private readonly space: PathSpace,
  ) {
    // The start-up scan runs before any event's transition, since events
    // lost to a crash or made while the app was closed are only seen there.
    // A failed scan fails every later transition and write (serialize).
    this.serialize(() => this.scan()).catch(() => undefined);
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
      const next = { ...state, ...this.bindingAfter(state, current, change) };
      const others = next.binding === null ? [] : await this.unbindOthers(next.documentId, next.binding.spelling, "released");
      await this.journal.transact({ putDocuments: [...others, next] });
    });
  }

  /**
   * A file moved from `from` to `to`, by the user (E1, E2) or by the
   * engine. The document bound to the file keeps it at `to`. A document
   * still bound at `to` (another file) has none any more: the vault moves
   * nothing onto an existing file, so its file was gone.
   */
  renamed(from: string, to: string): Promise<void> {
    return this.serialize(async () => {
      const moved = await this.journal.documentByFileKey(this.space.filesystemKey(from));
      const changes = this.space.oneFile(from, to) ? [] : await this.unbindOthers(moved?.documentId, to, "user-deleted");
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
   * base, as the v3 migration derives it (indexeddb.ts deriveV3Records).
   */
  private async scan(): Promise<void> {
    const changes: DocumentState[] = [];
    for (const state of await this.journal.listDocuments()) {
      let binding = state.binding;
      let absence = state.absence ?? null;
      if (binding === undefined) {
        binding = state.deleted ? null : this.bound(state.path, state.baseHash);
        absence = state.deleted ? "never" : null;
      }
      if (binding !== null && (await this.vault.stat(binding.spelling)) === null) {
        binding = null;
        absence = "user-deleted";
      }
      if (binding !== state.binding || absence !== (state.absence ?? null)) changes.push({ ...state, binding, absence });
    }
    if (changes.length > 0) await this.journal.transact({ putDocuments: changes });
  }

  private bindingAfter(state: DocumentState, current: DocumentState | undefined, change: BindingChange): { binding: Binding | null; absence: Absence | null } {
    const kept = current?.binding;
    switch (change.kind) {
      case "applied":
        return state.deleted ? unbound("never") : { binding: this.bound(state.path, state.baseHash), absence: null };
      case "merged":
        if (change.hash !== null) return { binding: this.bound(change.path, change.hash), absence: null };
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

  private bound(spelling: string, seen: string): Binding {
    return { spelling, fileKey: this.space.filesystemKey(spelling), seen };
  }
}

function unbound(absence: Absence): { binding: null; absence: Absence } {
  return { binding: null, absence };
}
