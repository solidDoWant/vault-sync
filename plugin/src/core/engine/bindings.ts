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

type BindingsJournal = Pick<Journal, "getDocument" | "putDocument" | "listDocuments" | "documentByFileKey">;
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
    void this.serialize(() => this.scan()).catch(() => undefined);
  }

  /** Resolves once every transition and write queued so far is in the journal. */
  async idle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Writes `state` with the binding `change` gives it (see BindingChange). */
  put(state: DocumentState, change: BindingChange): Promise<void> {
    return this.serialize(async () => {
      const current = await this.journal.getDocument(state.documentId);
      const next = { ...state, ...this.bindingAfter(state, current, change) };
      if (next.binding !== null) await this.unbindOthers(next.documentId, next.binding.spelling, "released");
      await this.journal.putDocument(next);
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
      const moved = await this.probe(this.space.filesystemKey(from));
      if (!this.space.oneFile(from, to)) await this.unbindOthers(moved?.documentId, to, "user-deleted");
      if (moved === undefined) return;
      await this.journal.putDocument({ ...moved, binding: { spelling: to, fileKey: this.space.filesystemKey(to), seen: moved.binding?.seen ?? moved.baseHash }, absence: null });
    });
  }

  /**
   * The file at `path` was deleted: by the user (E3), whose delete leaves
   * the document `user-deleted`, or by the engine, which gives the file up
   * (`released`) unless the write that follows says otherwise.
   */
  deleted(path: string, by: "user" | "engine"): Promise<void> {
    return this.serialize(() => this.unbindOthers(undefined, path, by === "user" ? "user-deleted" : "released"));
  }

  /** Runs `task` after every transition and write queued before it. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
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
      if (binding !== state.binding || absence !== (state.absence ?? null)) await this.journal.putDocument({ ...state, binding, absence });
    }
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

  /** Every document other than `documentId` bound to the file at `path` has none any more, for `absence`. */
  private async unbindOthers(documentId: string | undefined, path: string, absence: Absence): Promise<void> {
    // Writes through here never leave two bindings at one file key, so a
    // probe that finds `documentId` itself hides no other.
    const key = this.space.filesystemKey(path);
    for (;;) {
      const state = await this.probe(key);
      if (state === undefined || state.documentId === documentId) return;
      await this.journal.putDocument({ ...state, ...unbound(absence) });
    }
  }

  /**
   * The document bound to file key `key`, or undefined, also if the probe
   * fails. Shadow mode (refactor step R4): nothing decides by bindings yet,
   * so the engine's own write goes ahead and a binding left stale shows in
   * bindingShadow. A journal opened at a schema older than v3 has no index
   * to probe (only tests run an engine over one).
   */
  private async probe(key: string): Promise<DocumentState | undefined> {
    try {
      return await this.journal.documentByFileKey(key);
    } catch {
      return undefined;
    }
  }

  private bound(spelling: string, seen: string): Binding {
    return { spelling, fileKey: this.space.filesystemKey(spelling), seen };
  }
}

function unbound(absence: Absence): { binding: null; absence: Absence } {
  return { binding: null, absence };
}
