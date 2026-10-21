import { sha256Hex } from "../hash";
import { priorRevisionLimit, type ConflictRecord, type DocumentState, type Intent, type Journal, type JournalChanges, type PendingOperation } from "../journal/journal";
import { isVaultError } from "../vault/adapter";
import { hasBase, type Bindings } from "./bindings";
import type { PathSpace } from "./pathspace";

/**
 * The steps of a `displace` or `detach` intent (design §4.4): the file at
 * `from` with content `hash` moves to `to`, and `record` goes to the
 * conflict log when the intent finishes. `recreate`: the document is one
 * the server lost in a restore, so it is committed again as a create at
 * `to` (decide.ts, ruleW).
 */
interface MoveSteps {
  from: string;
  to: string;
  hash: string;
  record: ConflictRecord;
  recreate: boolean;
}

/** What the intents need of the engine. */
export interface IntentsHost {
  journal: Pick<Journal, "putIntent" | "listIntents" | "getDocument" | "listPending">;
  bindings: Bindings;
  space: PathSpace;
  read: (path: string) => Promise<Uint8Array | null>;
  /** Moves a file, with the engine's echo expectation, leaving bindings to the intent's final transaction. */
  rename: (from: string, to: string) => Promise<void>;
  newId: () => string;
  /** A path a push should look at again. */
  markDirty: (path: string) => void;
  /** Finishes or drops an open `apply` intent from the disk (engine.ts, recoverApply). */
  recoverApply: (intent: Intent) => Promise<void>;
  /** Finishes or drops an open `merge` intent from the disk and its recorded steps (engine.ts, recoverMerge). */
  recoverMerge: (intent: Intent) => Promise<void>;
}

/**
 * The intents of rule W (design §4.4, §4.5, PO-4, PO-8), which move one
 * document's file off a path the server gives another document:
 *
 * - `displace`: the document keeps its file at the new path, under its own
 *   id, and the push commits it there (a rename, or a create for a
 *   document the server lost).
 * - `detach`: the document gives its file up (`absence = released`) and
 *   its outbox is dropped; the file at the new path is untracked, and the
 *   push commits it as a new document, so its bytes survive (principle 1).
 *
 * The `apply` and `merge` intents of a remote revision are the engine's
 * (engine.ts): `recover` hands them back to it.
 *
 * Each is recorded before its rename and finished by one journal
 * transaction (Bindings.transact) that changes the binding, the outbox and
 * the conflict log and removes the intent. `recover` finishes or drops
 * every open one from the disk alone, at the start of every pull and push.
 */
export class Intents {
  constructor(private readonly host: IntentsHost) {}

  /** Moves `documentId`'s file from `from` to `to` under its own id (W(a)); `recreate` for a document the server lost. */
  displace(documentId: string, from: string, to: string, record: ConflictRecord, recreate = false): Promise<boolean> {
    return this.move("displace", documentId, from, to, record, recreate);
  }

  /** Moves `documentId`'s file from `from` to `to` and gives it up (W(b)): the file is untracked there. */
  detach(documentId: string, from: string, to: string, record: ConflictRecord): Promise<boolean> {
    return this.move("detach", documentId, from, to, record, false);
  }

  /**
   * Finishes or drops every open `displace` and `detach` intent, by what the
   * disk shows: the file at `to` with the recorded content means the move
   * happened, and the intent is finished; the file still at `from` means it
   * did not, and it is moved now; neither means the user deleted it (the
   * document becomes `user-deleted`). Anything else is the user's change,
   * which is left alone: the intent is dropped.
   */
  async recover(): Promise<void> {
    for (const intent of await this.host.journal.listIntents()) {
      if (intent.kind === "apply") await this.host.recoverApply(intent);
      if (intent.kind === "merge") await this.host.recoverMerge(intent);
      if (intent.kind !== "displace" && intent.kind !== "detach") continue;
      const steps = intent.steps as unknown as MoveSteps;
      const atTo = await this.host.read(steps.to);
      if (atTo !== null && sha256Hex(atTo) === steps.hash) {
        await this.finish(intent, steps);
        continue;
      }
      const atFrom = steps.from === steps.to ? atTo : await this.host.read(steps.from);
      if (atFrom !== null && sha256Hex(atFrom) === steps.hash && (atTo === null || steps.from === steps.to)) {
        if (await this.rename(steps)) await this.finish(intent, steps);
        else await this.host.bindings.transact(() => Promise.resolve({ removeIntents: [intent.id] }));
        continue;
      }
      if (atTo === null && atFrom === null) {
        await this.host.bindings.transact(async () => this.deleted(intent));
        continue;
      }
      await this.host.bindings.transact(() => Promise.resolve({ removeIntents: [intent.id] }));
    }
  }

  private async move(kind: "displace" | "detach", documentId: string, from: string, to: string, record: ConflictRecord, recreate: boolean): Promise<boolean> {
    const content = await this.host.read(from);
    // Nothing there to move: its event is still to come.
    if (content === null) return false;
    const steps: MoveSteps = { from, to, hash: sha256Hex(content), record: { ...record, copyHash: sha256Hex(content) }, recreate };
    const id = await this.host.journal.putIntent({ kind, documentId, steps: steps as unknown as Record<string, unknown> });
    const intent: Intent = { id, kind, documentId, steps: steps as unknown as Record<string, unknown> };
    if (!(await this.rename(steps))) {
      await this.host.bindings.transact(() => Promise.resolve({ removeIntents: [id] }));
      return false;
    }
    await this.finish(intent, steps);
    return true;
  }

  /** The intent's rename; false if the vault refuses it (something took `to`, or `from` is gone). */
  private async rename(steps: MoveSteps): Promise<boolean> {
    if (steps.from === steps.to) return true;
    try {
      await this.host.rename(steps.from, steps.to);
      return true;
    } catch (error) {
      if (isVaultError(error)) return false;
      throw error;
    }
  }

  /** The intent's final transaction. */
  private async finish(intent: Intent, steps: MoveSteps): Promise<void> {
    await this.host.bindings.transact(async () => {
      const state = await this.host.journal.getDocument(intent.documentId);
      if (state === undefined) return { removeIntents: [intent.id] };
      const operations = (await this.host.journal.listPending()).filter((operation) => operation.documentId === intent.documentId);
      const binding = { spelling: steps.to, fileKey: this.host.space.filesystemKey(steps.to), seen: steps.hash };
      const changes: JournalChanges = { putConflicts: [steps.record], removeIntents: [intent.id] };
      if (intent.kind === "detach") {
        // Its outbox goes: the file is a new document's now.
        return { ...changes, putDocuments: [{ ...state, binding: null, absence: "released" }], removePending: operations.map((operation) => operation.revisionId) };
      }
      if (steps.recreate) {
        // The server lost the document: it is created again at its file's new path, under its own id.
        const size = BigInt((await this.host.read(steps.to))?.length ?? 0);
        const create: PendingOperation = { revisionId: this.host.newId(), documentId: state.documentId, baseRevisionId: "", path: steps.to, contentHash: steps.hash, size, kind: state.kind, deleted: false };
        // It keeps the revisions this device synced of it (DocumentState.prior): a known document, not a new file (rule W).
        const prior = [state.revisionId, ...(state.prior ?? [])].slice(0, priorRevisionLimit);
        const row: DocumentState = { documentId: state.documentId, path: steps.to, revisionId: "", seq: 0n, baseHash: "", size: 0n, kind: state.kind, deleted: true, binding, absence: null, prior };
        return { ...changes, putDocuments: [row], removePending: operations.map((operation) => operation.revisionId), addPending: [create] };
      }
      // The push derives the document's next operation from its binding: a
      // rename to `to` from its synced path, or its create there.
      const moved = operations.filter((operation) => !operation.deleted);
      const creates = hasBase(state) ? [] : moved.map((operation) => ({ ...operation, revisionId: this.host.newId(), path: steps.to, contentHash: steps.hash }));
      return { ...changes, putDocuments: [{ ...state, binding, absence: null }], removePending: moved.map((operation) => operation.revisionId), addPending: creates.slice(0, 1) };
    });
    if (intent.kind === "detach") this.host.markDirty(steps.to);
    this.host.markDirty(steps.from);
    this.host.markDirty(steps.to);
  }

  /** The intent's file is gone from both paths: the user deleted it (E3). */
  private async deleted(intent: Intent): Promise<JournalChanges> {
    const state = await this.host.journal.getDocument(intent.documentId);
    const operations = (await this.host.journal.listPending()).filter((operation) => operation.documentId === intent.documentId && !operation.deleted);
    const changes: JournalChanges = { removeIntents: [intent.id], removePending: operations.map((operation) => operation.revisionId) };
    if (state === undefined) return changes;
    if (!hasBase(state)) return { ...changes, removeDocuments: [state.documentId] };
    return { ...changes, putDocuments: [{ ...state, binding: null, absence: "user-deleted" }] };
  }
}
