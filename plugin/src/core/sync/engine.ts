import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { errorCode, headMoved } from "../engine/errors";
import { baseContent, downloadContent, toIncoming, type PullApi } from "../engine/remote";
import { uploadContent } from "../engine/upload";
import { sha256Hex } from "../hash";
import { pathKey } from "../pathkey/pathkey";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { uuidv7 } from "../uuid";
import { conflictCopyName } from "./conflict-name";
import { detectChanges, HashCache, kindOfPath, project, type Projection, type RenameHint } from "./detect";
import { applyChange, type DocEntry, type JournalChange, type JournalState, type PendingKind, type PendingOp, type SyncJournal, type SyncKind } from "./journal";
import { mergeContent } from "./merge-rules";

/** The protocol calls the engine makes. */
export type SyncApi = PullApi;

export interface SyncEngineOptions {
  api: SyncApi;
  vaultId: string;
  /** This device's id (RegisterDevice), sent with every commit. */
  deviceId: string;
  /** The device's name, in the names of its conflict copies (rule C). Defaults to the device id. */
  deviceName?: string;
  vault: VaultAdapter;
  journal: SyncJournal;
  /** ListChanges page size; 0 lets the server choose. */
  pageSize?: number;
  /** The clock, for new ids. */
  now?: () => number;
  /** Timers for the debounce, the fallback interval and the backoff. */
  timers?: Timers;
  /** Delay after the last local change before a cycle starts, in ms. */
  debounceMs?: number;
  /** Fallback interval between cycles, in ms. */
  intervalMs?: number;
  backoff?: Backoff;
  random?: () => number;
}

export type SyncStatus = "idle" | "syncing" | "error";

/**
 * A remote revision the engine cannot apply now (the file changed since this
 * cycle's detection, or the decision table has no row for its local state):
 * the pull stops before it, leaving the cursor, the file and the pending
 * operations as they are, and the next cycle decides it again.
 */
const undecided = Symbol("undecided");
type Outcome = JournalChange | typeof undecided;

/** A remote revision as the decision table reads it. */
interface Remote {
  documentId: string;
  path: string;
  hash: string;
  size: bigint;
  deleted: boolean;
  /** The revision's `create_time`, in ms since the epoch. */
  time: number;
}

/** The server reported that its database was restored to before this device's cursor (SPEC.md §6.1). */
export class DivergedError extends Error {
  override readonly name = "DivergedError";
}

const encoder = new TextEncoder();

/**
 * The plugin's sync engine (docs/design/engine.md): one sync loop over one
 * device journal. A cycle detects local changes (§4), pulls the change list
 * and applies each revision with the decision table (§5), then pushes the
 * pending operations oldest first (§3).
 */
export class SyncEngine {
  status: SyncStatus = "idle";
  /** The last cycle's error, while the status is `error`. */
  lastError: unknown;

  private readonly api: SyncApi;
  private readonly vaultId: string;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly vault: VaultAdapter;
  private readonly journal: SyncJournal;
  private readonly pageSize: number;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly backoff: Backoff;
  private readonly random: () => number;

  private state: JournalState | undefined;
  private readonly cache = new HashCache();
  private renames: RenameHint[] = [];
  /** Hash of each file the engine wrote, until its event arrives. */
  private readonly ownWrites = new Map<string, string>();
  /** Renames and deletes the engine made, until their events arrive. */
  private readonly ownRenames = new Map<string, number>();
  private readonly ownDeletes = new Map<string, number>();

  private running: Promise<void> | undefined;
  private again = false;
  private failures = 0;
  private stopped = true;
  private unwatch: (() => void) | undefined;
  private debounceTimer: unknown;
  private intervalTimer: unknown;
  private retryTimer: unknown;

  constructor(options: SyncEngineOptions) {
    this.api = options.api;
    this.vaultId = options.vaultId;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName ?? options.deviceId;
    this.vault = options.vault;
    this.journal = options.journal;
    this.pageSize = options.pageSize ?? 0;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalTimers;
    this.debounceMs = options.debounceMs ?? 2_000;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.backoff = options.backoff ?? { initialMs: 1_000, maxMs: 5 * 60_000 };
    this.random = options.random ?? Math.random;
  }

  /** Subscribes to vault events and starts syncing: now, after local changes, and every interval. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unwatch = this.vault.watch((event) => {
      this.onVaultEvent(event);
    });
    this.scheduleInterval();
    void this.sync().catch(() => undefined);
  }

  /** Stops scheduling cycles; a cycle in progress finishes. */
  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
    for (const timer of [this.debounceTimer, this.intervalTimer, this.retryTimer]) if (timer !== undefined) this.timers.clearTimeout(timer);
    this.debounceTimer = this.intervalTimer = this.retryTimer = undefined;
  }

  /** The realtime channel reported `vault_changed`, or the app came back to the foreground. */
  notifyRemoteChange(): void {
    void this.sync().catch(() => undefined);
  }

  /**
   * Runs cycles until one makes no progress. Calls while a sync runs join
   * it, and it runs once more. Rejects with the error of a failed cycle;
   * when started, the engine then retries after a growing backoff.
   */
  sync(): Promise<void> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      this.status = "syncing";
      try {
        do {
          this.again = false;
          while (await this.cycle()) {
            // Progress: run another cycle at once.
          }
        } while (this.rerunRequested());
        this.failures = 0;
        this.status = "idle";
        this.lastError = undefined;
      } catch (error) {
        this.failures++;
        this.status = "error";
        this.lastError = error;
        this.scheduleRetry();
        throw error;
      } finally {
        this.running = undefined;
      }
    })();
    this.running = run;
    return run;
  }

  /** Whether a sync was asked for while the current one ran. */
  private rerunRequested(): boolean {
    return this.again;
  }

  /** One cycle: detect, pull, push. Returns whether the pull or the push made progress. */
  private async cycle(): Promise<boolean> {
    const state = await this.loadState();
    const renames = this.renames;
    this.renames = [];
    const detected = await detectChanges(state, {
      vault: this.vault,
      cache: this.cache,
      renames,
      nextOrder: (state.pending.at(-1)?.order ?? 0) + 1,
      now: this.now,
    });
    await this.record(detected);
    const pulled = await this.pull();
    const pushed = await this.push();
    // P1, P2: a refused commit is resolved by what the server holds, so pull it now.
    const repulled = pushed.pullAgain && (await this.pull());
    return pulled || pushed.progress || repulled;
  }

  private async loadState(): Promise<JournalState> {
    this.state ??= await this.journal.load();
    return this.state;
  }

  /** Writes `change` to the journal, then to the engine's copy of it. */
  private async record(change: JournalChange): Promise<void> {
    if (Object.keys(change).length === 0) return;
    await this.journal.commit(change);
    if (this.state !== undefined) applyChange(this.state, change);
  }

  // Pull ----------------------------------------------------------------

  private async pull(): Promise<boolean> {
    const state = await this.loadState();
    let progress = false;
    for (;;) {
      const response = await this.api.sync.listChanges({
        vaultId: this.vaultId,
        sinceSeq: state.cursor.seq,
        sinceAnchor: state.cursor.anchor,
        pageSize: this.pageSize,
      });
      if (response.diverged) throw new DivergedError("the server's change list diverged from this device's cursor");
      for (const revision of response.revisions) {
        if (revision.seq <= state.cursor.seq) continue;
        const outcome = await this.apply(state, revision);
        if (outcome === undecided) return progress;
        await this.record({ ...outcome, cursor: { seq: revision.seq, anchor: revision.anchor } });
        progress = true;
      }
      if (!response.hasMore || response.revisions.length === 0) return progress;
    }
  }

  /** Applies one remote revision: the file change first, then the returned journal change. */
  private async apply(state: JournalState, revision: Revision): Promise<Outcome> {
    const incoming = toIncoming(revision);
    const remote = incoming.remote;
    const id = remote.documentId;
    const entry = state.docs.get(id);
    // This device's own revision: already applied.
    if (entry?.baseRevId === remote.revisionId) return {};
    const ops = state.pending.filter((op) => op.documentId === id);
    // This device's commit, whose reply was lost: it is acknowledged now.
    const acknowledged = ops.find((op) => op.sent && op.revisionId === remote.revisionId);
    if (acknowledged !== undefined) return this.acknowledge(acknowledged, revision);
    // A path the protocol does not allow never reaches the disk.
    if (!incoming.pathAllowed) return {};
    const target: Omit<DocEntry, "path"> = {
      documentId: id,
      kind: entry?.kind ?? syncKind(revision.kind),
      baseRevId: remote.revisionId,
      baseHash: remote.contentHash,
      baseSize: Number(remote.size),
    };
    const incomingRevision: Remote = {
      documentId: id,
      path: remote.path,
      hash: remote.contentHash,
      size: remote.size,
      deleted: remote.deleted,
      time: revision.createTime === undefined ? 0 : timestampMs(revision.createTime),
    };

    if (ops.length === 0) {
      // A document deleted on the server whose re-create this device dropped is absent here.
      if (entry === undefined || entry.deleted === true) {
        // A2: absent, tombstone.
        if (remote.deleted) return entry === undefined ? {} : { deleteDocs: [id] };
        // A1: absent, live.
        if ((await this.place(state, incomingRevision)) === undecided) return undecided;
        return { putDocs: [{ ...target, path: remote.path }] };
      }
      return this.applyClean(state, entry, incomingRevision, target);
    }
    // Pending operations of a document the server knows but this device never synced: none of the rows.
    if (entry === undefined) return undecided;
    const last = ops[ops.length - 1] as PendingOp;
    const dropped = ops.map((op) => op.opId);
    if (last.kind === "delete") {
      // A11: deleted, tombstone.
      if (remote.deleted) return { deleteDocs: [id], deletePending: dropped };
      // A8: deleted, live. The edit wins.
      if ((await this.place(state, incomingRevision)) === undecided) return undecided;
      return { putDocs: [{ ...target, path: remote.path }], deletePending: dropped };
    }
    return this.applyChanged(state, entry, last, dropped, incomingRevision, target);
  }

  /** Rows A3–A5: the file is as this device last synced it, and nothing is pending. */
  private async applyClean(state: JournalState, entry: DocEntry, remote: Remote, target: Omit<DocEntry, "path">): Promise<Outcome> {
    const local = await this.cache.read(this.vault, entry.path);
    // Changed since this cycle's detection: the next cycle records it, then decides.
    if (local?.hash !== entry.baseHash) return undecided;

    // A5: clean, tombstone.
    if (remote.deleted) {
      if (!(await this.delete(entry.path, entry.baseHash))) return undecided;
      return { deleteDocs: [entry.documentId] };
    }
    // A4: clean, live, new path.
    if (remote.path !== entry.path) {
      if (pathKey(remote.path) !== pathKey(entry.path)) {
        const cleared = await this.clear(state, entry.documentId, remote.path, remote.hash);
        if (cleared === undecided) return undecided;
        // Rule W: a file with the remote content is already there; it is this document's file now.
        if (cleared === "bound") {
          if (!(await this.delete(entry.path, entry.baseHash))) return undecided;
          return { putDocs: [{ ...target, path: remote.path }] };
        }
      }
      await this.rename(entry.path, remote.path);
      if (remote.hash !== entry.baseHash) {
        const content = await downloadContent(this.api, this.vaultId, remote.hash, remote.size);
        // The file was edited after it was checked: it stays at the new path on its old base, an edit the next cycle resolves.
        if (!(await this.write(remote.path, content, entry.baseHash))) {
          await this.record({ putDocs: [{ ...entry, path: remote.path }] });
          return undecided;
        }
      }
      return { putDocs: [{ ...target, path: remote.path }] };
    }
    // A3: clean, live, same path.
    if (remote.hash !== entry.baseHash) {
      const content = await downloadContent(this.api, this.vaultId, remote.hash, remote.size);
      if (!(await this.write(entry.path, content, entry.baseHash))) return undecided;
    }
    return { putDocs: [{ ...target, path: entry.path }] };
  }

  /**
   * Rows A6, A7, A9 and A10: the document is edited, renamed or both here
   * (`last` is its last pending operation, `dropped` all of them).
   */
  private async applyChanged(state: JournalState, entry: DocEntry, last: PendingOp, dropped: string[], remote: Remote, target: Omit<DocEntry, "path">): Promise<Outcome> {
    const localPath = last.path;
    const file = await this.cache.read(this.vault, localPath);
    // Changed since this cycle's detection: the next cycle records it, then decides.
    if (file === null || file.hash !== last.contentHash) return undecided;
    const keepRefusal = (path: string) => (last.refused !== undefined && path === last.path ? { refused: last.refused } : {});

    if (remote.deleted) {
      // A7, A10: the edit or rename wins. The file stays where it is and is created again on top of the tombstone.
      const recreate: PendingOp = { ...this.newOp(state, entry.documentId, "create", localPath, entry.kind, file.hash, file.size), ...keepRefusal(localPath) };
      return { putDocs: [{ ...target, path: remote.path, deleted: true }], deletePending: dropped, putPending: [recreate] };
    }

    // A6: the server's path. A9: the local path if the server kept the base path; otherwise the server's path wins.
    const renamed = localPath !== entry.path;
    const finalPath = renamed && remote.path === entry.path ? localPath : remote.path;
    const local = await this.vault.read(localPath);
    if (sha256Hex(local) !== file.hash) return undecided;
    const remoteContent = remote.hash === file.hash ? local : await downloadContent(this.api, this.vaultId, remote.hash, remote.size);
    // Rule M.
    const merged = await mergeContent({
      kind: entry.kind,
      local,
      localHash: file.hash,
      localTime: file.mtime,
      remote: remoteContent,
      remoteHash: remote.hash,
      remoteTime: remote.time,
      baseHash: entry.baseHash,
      base: () => baseContent(this.api, this.vaultId, entry.baseRevId),
    });
    const finalHash = sha256Hex(merged.content);

    // Rule C: the losing side is on disk under its copy name before anything is overwritten.
    if (merged.copy !== null) {
      const copyPath = conflictCopyName(finalPath, this.deviceName, new Date(this.now()), await this.taken(state));
      // No copy name fits: nothing is overwritten.
      if (copyPath === null) return undecided;
      if (!(await this.write(copyPath, merged.copy, null))) return undecided;
      const copy = this.newOp(state, uuidv7(this.now()), "create", copyPath, kindOfPath(copyPath), sha256Hex(merged.copy), merged.copy.length);
      await this.record({ putPending: [copy], putConflicts: [{ path: copyPath, documentId: entry.documentId, createdAt: this.now() }] });
    }
    // Rule W at the final path.
    const cleared = pathKey(finalPath) === pathKey(localPath) ? "free" : await this.clear(state, entry.documentId, finalPath, remote.hash);
    if (cleared === undecided) return undecided;
    if (cleared === "bound") {
      // A file with the remote content is already there: it is this document's file now, and the local file moves into it.
      if (finalHash !== remote.hash && !(await this.write(finalPath, merged.content, remote.hash))) return undecided;
      if (!(await this.delete(localPath, file.hash))) return undecided;
    } else {
      if (finalHash !== file.hash && !(await this.write(localPath, merged.content, file.hash))) return undecided;
      if (finalPath !== localPath) await this.rename(localPath, finalPath);
    }

    const change: JournalChange = { putDocs: [{ ...target, path: remote.path }], deletePending: dropped };
    // What differs from the server's head is pushed on top of it.
    if (finalHash !== remote.hash || finalPath !== remote.path) {
      const kind = finalPath !== remote.path ? "rename" : "edit";
      change.putPending = [{ ...this.newOp(state, entry.documentId, kind, finalPath, entry.kind, finalHash, merged.content.length), ...keepRefusal(finalPath) }];
    }
    return change;
  }

  /** Rule W, then writes the remote content at its path unless a file with that content is already there. */
  private async place(state: JournalState, remote: Remote): Promise<"placed" | typeof undecided> {
    const cleared = await this.clear(state, remote.documentId, remote.path, remote.hash);
    if (cleared === undecided) return undecided;
    if (cleared === "free") {
      const content = await downloadContent(this.api, this.vaultId, remote.hash, remote.size);
      if (!(await this.write(remote.path, content, null))) return undecided;
    }
    return "placed";
  }

  /**
   * Rule W: makes `path` free for document `id`. Returns "bound" when a file
   * holding `hash` (null: never) is there and is untracked or an unpushed
   * create, so it becomes the document's file (and the create is dropped).
   * Any other file in the way (an untracked one, an unpushed create, a file
   * renamed here onto the path, or a file where a folder of the path must
   * go) and a folder where the file must go are moved to a conflict copy
   * name, where they stay pending.
   */
  private async clear(state: JournalState, id: string, path: string, hash: string | null): Promise<"free" | "bound" | typeof undecided> {
    const occupant = await this.cache.read(this.vault, path);
    if (occupant !== null) {
      const owner = liveAt(state, path);
      if (owner?.documentId === id) return "bound";
      if (hash !== null && occupant.hash === hash && owner?.base === undefined) {
        if (owner !== undefined) await this.record({ deletePending: state.pending.filter((op) => op.documentId === owner.documentId).map((op) => op.opId) });
        return "bound";
      }
      return (await this.moveAside(state, [path])) ? "free" : undecided;
    }
    // A file where a folder of the path must go.
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const folder = parts.slice(0, length).join("/");
      if ((await this.cache.read(this.vault, folder)) !== null) return (await this.moveAside(state, [folder])) ? "free" : undecided;
    }
    // A folder where the file must go.
    const key = pathKey(path);
    const inside = (await this.vault.list()).filter((file) => pathKey(file).startsWith(`${key}/`));
    if (inside.length > 0) return (await this.moveAside(state, inside, path)) ? "free" : undecided;
    // A document of this device whose file is missing since this cycle's detection still claims the path.
    const claimant = liveAt(state, path);
    if (claimant !== undefined && claimant.documentId !== id) return undecided;
    return "free";
  }

  /**
   * Moves local files out of the way (rule W) to conflict copy names (rule
   * C): each file on its own, or with `folder`, the folder they are in. A
   * moved file of a document stays that document's pending operation under
   * the new name; an untracked one becomes a pending create. Returns false,
   * moving nothing, if a file is a synced document's, which the server
   * cannot also hold at the path, or no copy name fits.
   */
  private async moveAside(state: JournalState, files: readonly string[], folder?: string): Promise<boolean> {
    const owners = new Map<string, Projection>();
    for (const projection of project(state).values()) if (!projection.deleted) owners.set(pathKey(projection.path), projection);
    for (const file of files) {
      const owner = owners.get(pathKey(file));
      if (owner?.base !== undefined && owner.base.deleted !== true && owner.path === owner.base.path) return false;
    }
    const taken = await this.taken(state);
    const date = new Date(this.now());
    const copyFolder = folder === undefined ? undefined : conflictCopyName(folder, this.deviceName, date, taken, true);
    if (copyFolder === null) return false;
    const copies: [string, string][] = [];
    for (const file of files) {
      const copy = folder !== undefined && copyFolder !== undefined ? `${copyFolder}${file.slice(folder.length)}` : conflictCopyName(file, this.deviceName, date, taken);
      if (copy === null) return false;
      copies.push([file, copy]);
    }
    const change: Required<Pick<JournalChange, "putPending" | "putConflicts">> = { putPending: [], putConflicts: [] };
    let order = nextOrder(state);
    for (const [file, copy] of copies) {
      const occupant = await this.cache.read(this.vault, file);
      if (occupant === null) continue;
      await this.rename(file, copy);
      const owner = owners.get(pathKey(file));
      const last = owner?.lastOp;
      let documentId: string;
      if (owner !== undefined && last !== undefined) {
        documentId = owner.documentId;
        // A refused commit was never applied, so an unsent operation keeps its revision id. The new name is not refused.
        const moved: PendingOp = { ...last, path: copy, sent: false, revisionId: last.sent ? uuidv7(this.now()) : last.revisionId };
        delete moved.refused;
        change.putPending.push(moved);
      } else {
        documentId = uuidv7(this.now());
        change.putPending.push({ ...this.newOp(state, documentId, "create", copy, kindOfPath(copy), occupant.hash, occupant.size), order: order++ });
      }
      change.putConflicts.push({ path: copy, documentId, createdAt: this.now() });
    }
    await this.record(change);
    return true;
  }

  /** Whether a path is in use on this device (a file, a folder of one, or a document's path); a name it said is free counts as taken from then on. */
  private async taken(state: JournalState): Promise<(path: string) => boolean> {
    const keys = new Set<string>();
    const add = (path: string) => {
      const parts = pathKey(path).split("/");
      for (let length = 1; length <= parts.length; length++) keys.add(parts.slice(0, length).join("/"));
    };
    for (const file of await this.vault.list()) add(file);
    for (const projection of project(state).values()) if (!projection.deleted) add(projection.path);
    return (path) => {
      if (keys.has(pathKey(path))) return true;
      add(path);
      return false;
    };
  }

  /** A new, unsent pending operation at the end of the queue. */
  private newOp(state: JournalState, documentId: string, kind: PendingKind, path: string, docKind: SyncKind, contentHash: string, contentSize: number): PendingOp {
    return {
      opId: uuidv7(this.now()),
      order: nextOrder(state),
      documentId,
      kind,
      path,
      docKind,
      revisionId: uuidv7(this.now()),
      contentHash,
      contentSize,
      sent: false,
    };
  }

  /** The paths the server refused for this device's pending operations, with the reasons (rule P3), for the conflict view. */
  async refusedNames(): Promise<{ documentId: string; path: string; reason: string }[]> {
    const state = await this.loadState();
    return state.pending.flatMap((op) => (op.refused === undefined ? [] : [{ documentId: op.documentId, path: op.path, reason: op.refused }]));
  }

  private acknowledge(op: PendingOp, revision: Revision): JournalChange {
    const contentRef = revision.contentRef;
    const entry: DocEntry = {
      documentId: op.documentId,
      path: op.path,
      kind: op.docKind,
      baseRevId: revision.id,
      baseHash: op.contentHash,
      baseSize: contentRef === undefined ? op.contentSize : Number(contentRef.size),
    };
    return revision.deleted ? { deleteDocs: [op.documentId], deletePending: [op.opId] } : { putDocs: [entry], deletePending: [op.opId] };
  }

  // Push ----------------------------------------------------------------

  /** Pushes the pending operations; `pullAgain` when a commit was refused by P1 or P2. */
  private async push(): Promise<{ progress: boolean; pullAgain: boolean }> {
    const state = await this.loadState();
    const blocked = new Set<string>();
    let progress = false;
    let pullAgain = false;
    for (const queued of [...state.pending]) {
      if (blocked.has(queued.documentId)) continue;
      // P3: a refused name waits until the file is renamed.
      if (queued.refused !== undefined) {
        blocked.add(queued.documentId);
        continue;
      }
      let op = queued;
      if (op.kind !== "delete") {
        const read = () => this.readFile(op.path);
        const uploaded = await uploadContent(this.api, this.vaultId, op.contentHash, BigInt(op.contentSize), read);
        // The file changed since the operation was recorded: the next detection records the newer content.
        if (uploaded === "missing") {
          blocked.add(op.documentId);
          continue;
        }
      }
      if (!op.sent) {
        op = { ...op, sent: true };
        await this.record({ putPending: [op] });
      }
      const base = state.docs.get(op.documentId);
      let revision: Revision | undefined;
      try {
        revision = (
          await this.api.sync.commitRevision({
            vaultId: this.vaultId,
            documentId: op.documentId,
            revisionId: op.revisionId,
            baseRevId: base?.baseRevId ?? "",
            kind: op.docKind === "text" ? DocumentKind.TEXT : DocumentKind.BLOB,
            contentRef: { blobId: hexToBytes(op.contentHash), size: BigInt(op.contentSize) },
            path: encoder.encode(op.path),
            deleted: op.kind === "delete",
            deviceId: this.deviceId,
          })
        ).revision;
      } catch (error) {
        const refusal = this.refusal(state, op, error);
        if (refusal === undefined) throw error;
        // The server checks a commit's revision id before anything else, so a refused commit was never applied: the operation is unsent again.
        blocked.add(op.documentId);
        await this.record({ putPending: [{ ...op, sent: false, ...("reason" in refusal ? { refused: refusal.reason } : {}) }] });
        if ("pull" in refusal) pullAgain = true;
        continue;
      }
      if (revision === undefined) throw new Error("CommitRevision returned no revision");
      await this.record(this.acknowledge(op, revision));
      progress = true;
    }
    return { progress, pullAgain };
  }

  /**
   * How a refused commit is handled: pull for P1 (the head moved) and P2
   * (another document holds the path, and the pull brings it to meet the
   * file through rule W), the reason for P3 (an unportable name) and for a
   * P2 whose other document this device already holds (a name that differs
   * from it only by case, say), and undefined for any other error.
   */
  private refusal(state: JournalState, op: PendingOp, error: unknown): { pull: true } | { reason: string } | undefined {
    if (headMoved(error)) return { pull: true };
    const code = errorCode(error);
    const base = state.docs.get(op.documentId);
    const newPath = op.kind !== "delete" && (base === undefined || base.deleted === true || base.path !== op.path);
    if (!newPath) return undefined;
    const reason = error instanceof ConnectError ? error.rawMessage : String(error);
    if (code === Code.InvalidArgument) return { reason };
    if (code !== Code.AlreadyExists) return undefined;
    const key = pathKey(op.path);
    for (const entry of state.docs.values()) {
      if (entry.documentId === op.documentId || entry.deleted === true) continue;
      const other = pathKey(entry.path);
      if (other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) return { reason };
    }
    return { pull: true };
  }

  private async readFile(path: string): Promise<Uint8Array | null> {
    try {
      return await this.vault.read(path);
    } catch (error) {
      if (isVaultError(error, "not-found")) return null;
      throw error;
    }
  }

  // Vault effects ----------------------------------------------------------

  /** Writes `content` if the file still holds `expectedHash` (null: no file). Returns false if it changed. */
  private async write(path: string, content: Uint8Array, expectedHash: string | null): Promise<boolean> {
    this.ownWrites.set(path, sha256Hex(content));
    // A rewrite can keep the size and the mtime, which the cache trusts.
    this.cache.invalidate(path);
    try {
      await this.vault.write(path, content, { expectedHash });
      return true;
    } catch (error) {
      this.ownWrites.delete(path);
      if (isVaultError(error, "changed")) return false;
      throw error;
    }
  }

  private async rename(from: string, to: string): Promise<void> {
    const key = `${from}\0${to}`;
    count(this.ownRenames, key, 1);
    this.cache.invalidate(from);
    this.cache.invalidate(to);
    try {
      await this.vault.rename(from, to);
    } catch (error) {
      count(this.ownRenames, key, -1);
      throw error;
    }
  }

  /** Deletes the file if it still holds `expectedHash`. Returns false if it changed. */
  private async delete(path: string, expectedHash: string): Promise<boolean> {
    count(this.ownDeletes, path, 1);
    this.cache.invalidate(path);
    try {
      await this.vault.delete(path, { expectedHash });
      return true;
    } catch (error) {
      count(this.ownDeletes, path, -1);
      if (isVaultError(error, "changed")) return false;
      throw error;
    }
  }

  // Events and scheduling ------------------------------------------------------

  /** A vault event: a hint that something changed. The engine's own changes are recognised and start no cycle. */
  private onVaultEvent(event: VaultEvent): void {
    switch (event.type) {
      case "rename": {
        this.cache.invalidate(event.oldPath);
        this.cache.invalidate(event.path);
        if (count(this.ownRenames, `${event.oldPath}\0${event.path}`, -1)) return;
        this.renames.push([event.oldPath, event.path]);
        this.scheduleLocalChange();
        return;
      }
      case "delete": {
        this.cache.invalidate(event.path);
        if (count(this.ownDeletes, event.path, -1)) return;
        this.scheduleLocalChange();
        return;
      }
      case "create":
      case "modify": {
        this.cache.invalidate(event.path);
        const own = this.ownWrites.get(event.path);
        if (own === undefined) {
          this.scheduleLocalChange();
          return;
        }
        this.ownWrites.delete(event.path);
        void this.readFile(event.path).then(
          (data) => {
            if (data === null || sha256Hex(data) !== own) this.scheduleLocalChange();
          },
          () => {
            this.scheduleLocalChange();
          },
        );
        return;
      }
    }
  }

  private scheduleLocalChange(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== undefined) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.sync().catch(() => undefined);
    }, this.debounceMs);
  }

  private scheduleInterval(): void {
    if (this.stopped) return;
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = undefined;
      this.scheduleInterval();
      void this.sync().catch(() => undefined);
    }, this.intervalMs);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer !== undefined) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.sync().catch(() => undefined);
      },
      backoffDelay(this.failures, this.backoff, this.random()),
    );
  }
}

/** The live document whose file is at `path` on this device once its pending operations apply. */
function liveAt(state: JournalState, path: string): Projection | undefined {
  const key = pathKey(path);
  for (const projection of project(state).values()) if (!projection.deleted && pathKey(projection.path) === key) return projection;
  return undefined;
}

/** The `order` of a new pending operation: after every queued one. */
function nextOrder(state: JournalState): number {
  return (state.pending.at(-1)?.order ?? 0) + 1;
}

function syncKind(kind: DocumentKind): SyncKind {
  return kind === DocumentKind.TEXT ? "text" : "blob";
}

/** Adds `delta` to a counter; for -1, returns whether there was one to take (and takes it). */
function count(counters: Map<string, number>, key: string, delta: 1 | -1): boolean {
  const current = counters.get(key) ?? 0;
  if (delta === -1 && current === 0) return false;
  const next = current + delta;
  if (next === 0) counters.delete(key);
  else counters.set(key, next);
  return true;
}
