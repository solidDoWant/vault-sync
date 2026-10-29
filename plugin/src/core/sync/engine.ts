import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { errorCode, headMoved } from "./errors";
import { baseContent, downloadContent, toIncoming, type PullApi } from "./remote";
import { uploadContent } from "./upload";
import { sha256Hex } from "../hash";
import { pathKey } from "../pathkey/pathkey";
import { uuidv7 } from "../uuid";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { posixPathRules, unmaterializableReason, type PathRules } from "../vaultpath/platform";
import { conflictCopyName } from "./conflict-name";
import { detectChanges, HashCache, isTemporaryPath, kindOfPath, project, replacementPath, replacementTarget, temporaryPath, type Projection, type RenameHint } from "./detect";
import { applyChange, type ConflictEntry, type Cursor, type DocEntry, type JournalChange, type JournalState, type PendingKind, type PendingOp, type SkippedEntry, type SkipReason, type SyncJournal, type SyncKind } from "./journal";
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
  /** The signed-in user's display name, in the names of conflict copies (rule C; docs/design/sharing.md, Attribution). Empty or absent: "user". */
  userName?: string;
  vault: VaultAdapter;
  journal: SyncJournal;
  /** ListChanges page size; 0 lets the server choose. */
  pageSize?: number;
  /** The clock, for new ids. */
  now?: () => number;
  /** Timers for the debounce, the fallback interval and the backoff. */
  timers?: Timers;
  /** Delay after the last local change before a cycle starts, in ms; null: local changes start no cycle. */
  debounceMs?: number | null;
  /** Fallback interval between cycles, in ms; null: no fallback timer. */
  intervalMs?: number | null;
  backoff?: Backoff;
  random?: () => number;
  /** Files larger than this, in bytes, are neither uploaded nor downloaded (docs/design/engine.md §7). Defaults to no limit. */
  maxFileBytes?: number;
  /** This device's path rules: a revision at a path the device cannot hold is skipped (§6). Defaults to POSIX. */
  pathRules?: PathRules;
  /** Called when the status changes and after every sync. */
  onChange?: () => void;
  /**
   * Whether this device may only pull: the signed-in user is a `viewer` of
   * the vault (docs/design/sharing.md, Viewer devices). Read at the start of
   * every cycle, so a role change takes effect within one cycle. Defaults to
   * false.
   */
  readOnly?: () => Promise<boolean>;
  /**
   * Keeps `content`, a local version of the file at `path` that a read-only
   * device does not push, outside the synced vault (`.vault-sync/local-copies/`
   * in Obsidian). Must be given with `readOnly`.
   */
  keepLocalCopy?: (path: string, content: Uint8Array) => Promise<void>;
}

/** A local file that is not uploaded because it is larger than the size limit (§7). */
export interface TooLargeFile {
  documentId: string;
  path: string;
  size: number;
}

/** A local file whose name the server refused (rule P3). */
export interface RefusedName {
  documentId: string;
  path: string;
  reason: string;
}

/** What the conflict view lists (docs/design/engine.md §10). */
export interface SyncProblems {
  /** Conflict copies this device created that are still on disk, newest first. */
  conflicts: ConflictEntry[];
  refused: RefusedName[];
  /** Remote documents this device skipped: over the size limit, or at a path it cannot hold. */
  skipped: SkippedEntry[];
  /** Local files over the size limit, not uploaded. */
  tooLarge: TooLargeFile[];
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
  private currentStatus: SyncStatus = "idle";
  /** The last cycle's error, while the status is `error`. */
  lastError: unknown;

  private readonly api: SyncApi;
  private readonly vaultId: string;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly userName: string;
  private readonly vault: VaultAdapter;
  private readonly journal: SyncJournal;
  private readonly pageSize: number;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly debounceMs: number | null;
  private readonly intervalMs: number | null;
  private readonly backoff: Backoff;
  private readonly random: () => number;
  private readonly maxFileBytes: number;
  private readonly pathRules: PathRules;
  private readonly onChange: () => void;
  private readonly readOnly: () => Promise<boolean>;
  private readonly keepLocalCopy: (path: string, content: Uint8Array) => Promise<void>;
  /** Pending operations whose upload the server refused as too large, by op id, with the content hash then. */
  private readonly uploadRefused = new Map<string, string>();

  private state: JournalState | undefined;
  private readonly cache = new HashCache();
  private renames: RenameHint[] = [];
  /** Hash of each file the engine wrote, until its event arrives. */
  private readonly ownWrites = new Map<string, string>();
  /** Renames and deletes the engine made, until their events arrive. */
  private readonly ownRenames = new Map<string, number>();
  private readonly ownDeletes = new Map<string, number>();
  /** Folder creates and deletes the engine made, by event type and path, until their events arrive. */
  private readonly ownFolderChanges = new Map<string, number>();

  /** Whether this engine has deleted the temporary files a crash left behind. */
  private cleaned = false;
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
    this.userName = options.userName ?? "";
    this.vault = options.vault;
    this.journal = options.journal;
    this.pageSize = options.pageSize ?? 0;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalTimers;
    this.debounceMs = options.debounceMs === undefined ? 2_000 : options.debounceMs;
    this.intervalMs = options.intervalMs === undefined ? 60_000 : options.intervalMs;
    this.backoff = options.backoff ?? { initialMs: 1_000, maxMs: 5 * 60_000 };
    this.random = options.random ?? Math.random;
    this.maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
    this.pathRules = options.pathRules ?? posixPathRules;
    this.onChange = options.onChange ?? (() => undefined);
    this.readOnly = options.readOnly ?? (() => Promise.resolve(false));
    this.keepLocalCopy =
      options.keepLocalCopy ??
      (() => {
        throw new Error("no place to keep local copies on a read-only device");
      });
  }

  /** idle, syncing, or error (the last sync failed; `lastError` says why). */
  get status(): SyncStatus {
    return this.currentStatus;
  }

  private setStatus(status: SyncStatus): void {
    this.currentStatus = status;
    this.onChange();
  }

  /**
   * Subscribes to vault events and starts syncing: now, after local changes,
   * and every interval. Returns the first sync, which rejects if it failed
   * (the engine then retries after a backoff).
   */
  start(): Promise<void> {
    if (!this.stopped) return this.running ?? Promise.resolve();
    this.stopped = false;
    this.unwatch = this.vault.watch((event) => {
      this.onVaultEvent(event);
    });
    this.scheduleInterval();
    const first = this.sync();
    first.catch(() => undefined);
    return first;
  }

  /** Resolves once no cycle runs. */
  async settled(): Promise<void> {
    while (this.running !== undefined) await this.running.catch(() => undefined);
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
      this.setStatus("syncing");
      try {
        do {
          this.again = false;
          while (await this.cycle()) {
            // Progress: run another cycle at once.
          }
        } while (this.rerunRequested());
        this.failures = 0;
        this.lastError = undefined;
        this.setStatus("idle");
      } catch (error) {
        this.failures++;
        this.lastError = error;
        this.setStatus("error");
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
    if (!this.cleaned) await this.removeTemporaryFiles();
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
    // A viewer device never pushes: its local differences are kept aside and the shared version restored.
    if (await this.readOnly()) {
      await this.restoreShared();
      return this.pull();
    }
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
      // The server was restored to before this device's cursor: resync (docs/design/engine.md §9).
      if (response.diverged) return this.resync();
      for (const revision of response.revisions) {
        if (revision.seq <= state.cursor.seq) continue;
        const before = localPath(state, revision.documentId);
        const outcome = await this.applyOrSkip(state, revision);
        if (outcome === undecided) return progress;
        const change: JournalChange = { ...outcome, cursor: { seq: revision.seq, anchor: revision.anchor } };
        // A revision that applied replaces an earlier skip of its document.
        if (outcome.putSkipped === undefined && state.skipped.has(revision.documentId)) change.deleteSkipped = [revision.documentId];
        await this.record(change);
        // The item left its place here: a folder it leaves empty, which no live document holds, goes too.
        if (before !== undefined && localPath(state, revision.documentId)?.path !== before.path) await this.removeEmptied(state, before.path, before.kind === "folder");
        progress = true;
      }
      if (!response.hasMore || response.revisions.length === 0) return progress;
    }
  }

  // Resync -----------------------------------------------------------------

  /**
   * The resync after a server restore (docs/design/engine.md §9). It reads
   * the whole change list, brings every file in line with the restored
   * heads, and records the result and the new cursor in one journal change.
   * The cursor moves only then, so a crash before it restarts the resync
   * from the start; every step finds its own earlier result and repeats
   * nothing. Returns true: the next cycle pushes what only this device holds.
   */
  private async resync(): Promise<boolean> {
    const state = await this.loadState();
    // Step 1: every document's head on the restored server.
    const heads = new Map<string, Revision>();
    let cursor: Cursor = { seq: 0n, anchor: new Uint8Array() };
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: cursor.seq, sinceAnchor: cursor.anchor, pageSize: this.pageSize });
      if (response.diverged) throw new DivergedError("the server's change list changed during a resync");
      for (const revision of response.revisions) {
        if (revision.seq <= cursor.seq) continue;
        heads.set(revision.documentId, revision);
        cursor = { seq: revision.seq, anchor: revision.anchor };
      }
      if (!response.hasMore || response.revisions.length === 0) break;
    }

    const projections = project(state);
    const docs: DocEntry[] = [];
    const pending: PendingOp[] = [];
    const conflicts: ConflictEntry[] = [];
    const skipped: SkippedEntry[] = [];
    const taken = await this.taken(state);
    let order = nextOrder(state);
    const newOp = (documentId: string, path: string, docKind: SyncKind, contentHash: string, contentSize: number): PendingOp => ({
      opId: uuidv7(this.now()),
      order: order++,
      documentId,
      kind: "create",
      path,
      docKind,
      revisionId: uuidv7(this.now()),
      contentHash,
      contentSize,
      sent: false,
    });
    const copyName = (path: string): string => {
      const copy = conflictCopyName(path, this.userName, this.deviceName, new Date(this.now()), taken);
      if (copy === null) throw new Error(`no conflict copy name fits for ${path}`);
      return copy;
    };
    /** Moves the local file at `path` to a conflict copy name (rule C), a new document to push. */
    const moveToCopy = async (path: string, documentId: string, hash: string, size: number): Promise<void> => {
      const copy = copyName(path);
      await this.rename(path, copy);
      pending.push(newOp(uuidv7(this.now()), copy, kindOfPath(copy), hash, size));
      conflicts.push({ path: copy, documentId, createdAt: this.now() });
    };
    /** Writes `content` at the free or freed `path`: a file there with the same content is taken as is, a different one moves to a copy. */
    const placeHead = async (path: string, content: Uint8Array, documentId: string): Promise<boolean> => {
      const occupant = await this.cache.read(this.vault, path);
      if (occupant !== null) {
        if (occupant.hash === sha256Hex(content)) return true;
        await moveToCopy(path, documentId, occupant.hash, occupant.size);
      }
      return this.write(path, content, null);
    };

    // Step 2: every document on the server.
    for (const [id, head] of heads) {
      const incoming = toIncoming(head);
      const remote = incoming.remote;
      // A tombstone (or a path that may not reach the disk) drops the document; a file this device still holds is pushed as a new one.
      if (remote.deleted || !incoming.pathAllowed) continue;
      const projection = projections.get(id);
      const localPath = projection !== undefined && !projection.deleted ? projection.path : null;
      const local = localPath === null ? null : await this.cache.read(this.vault, localPath);
      const entry: DocEntry = { documentId: id, path: remote.path, kind: projection?.kind ?? syncKind(head.kind), baseRevId: remote.revisionId, baseHash: remote.contentHash, baseSize: Number(remote.size) };
      if (entry.kind === "folder") {
        // A folder has no content: it is there or it is created, unless a pending delete is re-applied (step 4). At another path, the next detection records the rename.
        const pendingDelete = projection?.deleted === true && projection.base !== undefined;
        if (!pendingDelete && (localPath === null || !(await this.folderExists(localPath)))) await this.createFolder(remote.path);
        docs.push(entry);
        continue;
      }
      if (localPath !== null && local !== null) {
        if (local.hash !== remote.contentHash) {
          const localContent = await this.readFile(localPath);
          if (localContent === null) continue;
          const content = await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size);
          // Rule M against the head, with no base.
          const outcome = await mergeContent({
            kind: entry.kind,
            local: localContent,
            localHash: local.hash,
            localTime: local.mtime,
            remote: content,
            remoteHash: remote.contentHash,
            remoteTime: head.createTime === undefined ? 0 : timestampMs(head.createTime),
            baseHash: "",
            base: () => Promise.resolve(null),
          });
          if (outcome.copy === null) {
            if (!(await this.write(localPath, outcome.content, local.hash))) continue;
          } else if (outcome.content === content) {
            await moveToCopy(localPath, id, local.hash, local.size);
            if (!(await placeHead(remote.path, content, id))) continue;
          } else {
            // The newer local file stays (a pending edit on top of the head, found by the next detection); the head is the copy.
            const copy = copyName(localPath);
            if (!(await this.write(copy, content, null))) continue;
            pending.push(newOp(uuidv7(this.now()), copy, kindOfPath(copy), remote.contentHash, Number(remote.size)));
            conflicts.push({ path: copy, documentId: id, createdAt: this.now() });
          }
        }
        // At another path than the head's, the next detection records the rename again, on top of the head (step 4).
        docs.push(entry);
        continue;
      }
      if (projection?.deleted === true && projection.base !== undefined) {
        // A pending delete: the next detection records it again, on top of the head (step 4).
        docs.push(entry);
        continue;
      }
      // Unknown to the journal, or missing with no pending delete: write the head, unless this device skips it (§6, §7).
      const skip = this.skipReason(remote.path, remote.size);
      if (skip !== undefined) {
        skipped.push({ documentId: id, path: remote.path, reason: skip, size: Number(remote.size) });
        continue;
      }
      const content = await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size);
      if (await placeHead(remote.path, content, id)) docs.push(entry);
    }

    // Step 3: what the server doesn't know is created again, with its document id and an empty base.
    for (const projection of projections.values()) {
      if (heads.has(projection.documentId) || projection.deleted) continue;
      const local = await this.cache.read(this.vault, projection.path);
      if (local === null) continue;
      pending.push(newOp(projection.documentId, projection.path, projection.kind, local.hash, local.size));
    }

    const keptDocs = new Set(docs.map((entry) => entry.documentId));
    await this.record({
      cursor,
      deleteDocs: [...state.docs.keys()].filter((id) => !keptDocs.has(id)),
      putDocs: docs,
      deletePending: state.pending.map((op) => op.opId),
      putPending: pending,
      putConflicts: conflicts,
      deleteSkipped: [...state.skipped.keys()],
      putSkipped: skipped,
    });
    return true;
  }

  /**
   * Applies one remote revision; a revision whose path the vault refuses to
   * hold (§6: the platform cannot hold it, or Obsidian would store it under
   * another name) is skipped and listed instead, and the pull continues.
   */
  private async applyOrSkip(state: JournalState, revision: Revision): Promise<Outcome> {
    try {
      return await this.apply(state, revision);
    } catch (error) {
      if (!isVaultError(error, "unmaterializable") && !isVaultError(error, "path-conflict")) throw error;
      const { remote } = toIncoming(revision);
      return { putSkipped: [{ documentId: remote.documentId, path: remote.path, reason: "refused-by-vault", size: Number(remote.size) }] };
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
    // §6, §7: a file over the size limit, or at a path this device cannot hold, is skipped here and listed.
    const skip = remote.deleted ? undefined : this.skipReason(remote.path, remote.size);
    if (skip !== undefined) return { putSkipped: [{ documentId: id, path: remote.path, reason: skip, size: Number(remote.size) }] };
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

    if (target.kind === "folder") return this.applyFolder(state, entry, ops, incomingRevision, target);
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
      const copyPath = conflictCopyName(finalPath, this.userName, this.deviceName, new Date(this.now()), await this.taken(state));
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

  /**
   * The rows of §5 for a folder document. A folder has no content, so only
   * the path rules apply (rule M). A live revision puts the folder at its
   * path; the files and folders in it move by their own revisions, and the
   * folder it leaves goes once they have (Pull's removeEmptied). A tombstone
   * deletes the folder only if it is empty; otherwise the folder stays, and
   * the document stays here as a tombstone that the next detection creates
   * again on (a live item keeps its folders live, engine.md §2).
   */
  private async applyFolder(state: JournalState, entry: DocEntry | undefined, ops: PendingOp[], remote: Remote, target: Omit<DocEntry, "path">): Promise<Outcome> {
    const id = remote.documentId;
    if (ops.length === 0) {
      if (entry === undefined || entry.deleted === true) {
        // A2: absent, tombstone.
        if (remote.deleted) return entry === undefined ? {} : { deleteDocs: [id] };
        // A1: absent, live.
        if ((await this.placeFolder(state, id, remote.path)) === undecided) return undecided;
        return { putDocs: [{ ...target, path: remote.path }] };
      }
      // Gone since this cycle's detection: the next cycle records the delete, then decides.
      if (!(await this.folderExists(entry.path))) return undecided;
      // A5: clean, tombstone.
      if (remote.deleted) {
        if (await this.deleteFolder(entry.path)) return { deleteDocs: [id] };
        return { putDocs: [{ ...target, path: entry.path, deleted: true }] };
      }
      // A4: clean, live, new path. A3 (the same path) changes nothing.
      if (pathKey(remote.path) !== pathKey(entry.path) && (await this.placeFolder(state, id, remote.path)) === undecided) return undecided;
      return { putDocs: [{ ...target, path: remote.path }] };
    }
    // Pending operations of a document the server knows but this device never synced: none of the rows.
    if (entry === undefined) return undecided;
    const last = ops[ops.length - 1] as PendingOp;
    const dropped = ops.map((op) => op.opId);
    if (last.kind === "delete") {
      // A11: deleted, tombstone.
      if (remote.deleted) return { deleteDocs: [id], deletePending: dropped };
      // A8: deleted, live. The folder comes back.
      if ((await this.placeFolder(state, id, remote.path)) === undecided) return undecided;
      return { putDocs: [{ ...target, path: remote.path }], deletePending: dropped };
    }
    if (!(await this.folderExists(last.path))) return undecided;
    // A10, A7: the local rename or re-create wins over the tombstone. The folder stays and is created again on it.
    if (remote.deleted) {
      return { putDocs: [{ ...target, path: remote.path, deleted: true }], deletePending: dropped, putPending: [this.newOp(state, id, "create", last.path, "folder", "", 0)] };
    }
    // A9: the local path if the server kept the base path; otherwise the server's path wins.
    if (entry.deleted !== true && remote.path === entry.path && last.path !== remote.path) {
      return { putDocs: [{ ...target, path: remote.path }], deletePending: dropped, putPending: [this.newOp(state, id, "rename", last.path, "folder", "", 0)] };
    }
    if (pathKey(remote.path) !== pathKey(last.path) && (await this.placeFolder(state, id, remote.path)) === undecided) return undecided;
    return { putDocs: [{ ...target, path: remote.path }], deletePending: dropped };
  }

  /**
   * Rule W for a folder: a file at the path, or where one of its folders
   * must go, moves to a conflict copy name; a folder already at the path is
   * the document's folder (another folder document's unpushed operations
   * there are dropped: it is the same folder). Otherwise the folder is
   * created.
   */
  private async placeFolder(state: JournalState, id: string, path: string): Promise<"placed" | typeof undecided> {
    const parts = path.split("/");
    for (let length = parts.length; length >= 1; length--) {
      const prefix = parts.slice(0, length).join("/");
      if ((await this.cache.read(this.vault, prefix)) === null) continue;
      if (!(await this.moveAside(state, id, [prefix]))) return undecided;
      break;
    }
    if (await this.folderExists(path)) {
      const owner = liveAt(state, path);
      if (owner !== undefined && owner.documentId !== id) {
        if (owner.kind !== "folder") return undecided;
        await this.record({ deletePending: state.pending.filter((op) => op.documentId === owner.documentId).map((op) => op.opId) });
      }
      return "placed";
    }
    await this.createFolder(path);
    return "placed";
  }

  /**
   * Removes the folders that `path` (a file's or, with `self`, a folder's)
   * leaves empty, deepest first: each one that no live document of this
   * device holds and that nothing is in. A folder document kept here as a
   * tombstone (applyFolder) is dropped with its folder.
   */
  private async removeEmptied(state: JournalState, path: string, self: boolean): Promise<void> {
    const parts = path.split("/");
    for (let length = self ? parts.length : parts.length - 1; length >= 1; length--) {
      const folder = parts.slice(0, length).join("/");
      if (liveAt(state, folder) !== undefined) return;
      // Already gone (the revision deleted it): its folder may be emptied too.
      if ((await this.folderExists(folder)) && !(await this.deleteFolder(folder))) return;
      const kept = [...state.docs.values()].filter((entry) => entry.kind === "folder" && entry.deleted === true && pathKey(entry.path) === pathKey(folder) && !state.pending.some((op) => op.documentId === entry.documentId));
      if (kept.length > 0) await this.record({ deleteDocs: kept.map((entry) => entry.documentId) });
    }
  }

  private async folderExists(path: string): Promise<boolean> {
    const key = pathKey(path);
    return (await this.vault.listFolders()).some((folder) => pathKey(folder) === key);
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
      return (await this.moveAside(state, id, [path])) ? "free" : undecided;
    }
    // A file where a folder of the path must go.
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const folder = parts.slice(0, length).join("/");
      if ((await this.cache.read(this.vault, folder)) !== null) return (await this.moveAside(state, id, [folder])) ? "free" : undecided;
    }
    // A folder where the file must go.
    const key = pathKey(path);
    const inside = (await this.vault.list()).filter((file) => pathKey(file).startsWith(`${key}/`));
    if (inside.length > 0 || (await this.folderExists(path))) return (await this.moveAside(state, id, inside, path)) ? "free" : undecided;
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
   * moving nothing, if a file (or a folder in `folder`) is a synced
   * document's, which the server cannot also hold at the path, or no copy
   * name fits. Each copy is listed as a conflict with `arriving`, the
   * document that takes the path. With `folder`, its folders move too: they
   * are created under the copy's name (where the next detection finds them
   * as new folders) and removed here, and the unpushed operations of their
   * folder documents are dropped.
   */
  private async moveAside(state: JournalState, arriving: string, files: readonly string[], folder?: string): Promise<boolean> {
    const owners = new Map<string, Projection>();
    for (const projection of project(state).values()) if (!projection.deleted) owners.set(pathKey(projection.path), projection);
    const folderKey = folder === undefined ? undefined : pathKey(folder);
    const tree = folderKey === undefined ? [] : (await this.vault.listFolders()).filter((path) => pathKey(path) === folderKey || pathKey(path).startsWith(`${folderKey}/`));
    for (const file of [...files, ...tree]) {
      const owner = owners.get(pathKey(file));
      if (owner?.base !== undefined && owner.base.deleted !== true && owner.path === owner.base.path) return false;
    }
    const taken = await this.taken(state);
    const date = new Date(this.now());
    const copyFolder = folder === undefined ? undefined : conflictCopyName(folder, this.userName, this.deviceName, date, taken, true);
    if (copyFolder === null) return false;
    const copies: [string, string][] = [];
    for (const file of files) {
      const copy = folder !== undefined && copyFolder !== undefined ? `${copyFolder}${file.slice(folder.length)}` : conflictCopyName(file, this.userName, this.deviceName, date, taken);
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
      if (owner !== undefined && last !== undefined) {
        // A refused commit was never applied, so an unsent operation keeps its revision id. The new name is not refused.
        const moved: PendingOp = { ...last, path: copy, sent: false, revisionId: last.sent ? uuidv7(this.now()) : last.revisionId };
        delete moved.refused;
        change.putPending.push(moved);
      } else {
        change.putPending.push({ ...this.newOp(state, uuidv7(this.now()), "create", copy, kindOfPath(copy), occupant.hash, occupant.size), order: order++ });
      }
      change.putConflicts.push({ path: copy, documentId: arriving, createdAt: this.now() });
    }
    await this.record(change);
    if (folder !== undefined && copyFolder !== undefined && tree.length > 0) {
      // Shallowest first to create, deepest first to remove.
      tree.sort((a, b) => a.length - b.length);
      for (const path of tree) await this.createFolder(`${copyFolder}${path.slice(folder.length)}`);
      const unpushed = tree.flatMap((path) => {
        const owner = owners.get(pathKey(path));
        return owner === undefined ? [] : state.pending.filter((op) => op.documentId === owner.documentId).map((op) => op.opId);
      });
      if (unpushed.length > 0) await this.record({ deletePending: unpushed });
      for (const path of tree.reverse()) await this.deleteFolder(path);
    }
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
    for (const folder of await this.vault.listFolders()) add(folder);
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
  async refusedNames(): Promise<RefusedName[]> {
    const state = await this.loadState();
    return state.pending.flatMap((op) => (op.refused === undefined ? [] : [{ documentId: op.documentId, path: op.path, reason: op.refused }]));
  }

  /** What the conflict view lists: conflict copies still on disk, refused names, skipped remote documents and local files over the size limit. */
  async problems(): Promise<SyncProblems> {
    const state = await this.loadState();
    const conflicts: ConflictEntry[] = [];
    for (const entry of state.conflicts.values()) if ((await this.vault.stat(entry.path)) !== null) conflicts.push(entry);
    conflicts.sort((a, b) => b.createdAt - a.createdAt);
    const tooLarge = state.pending.filter((op) => op.kind !== "delete" && this.tooLargeToUpload(op)).map((op) => ({ documentId: op.documentId, path: op.path, size: op.contentSize }));
    return { conflicts, refused: await this.refusedNames(), skipped: [...state.skipped.values()], tooLarge };
  }

  /** The number of local operations the server has not acknowledged. */
  async pendingCount(): Promise<number> {
    return (await this.loadState()).pending.length;
  }

  /** Where the document's file is on this device once its pending operations apply, if it is live here. */
  async pathOf(documentId: string): Promise<string | undefined> {
    const projection = project(await this.loadState()).get(documentId);
    return projection === undefined || projection.deleted ? undefined : projection.path;
  }

  /** The synced document whose file is at `path` on this device, if any. */
  async documentAt(path: string): Promise<string | undefined> {
    return liveAt(await this.loadState(), path)?.documentId;
  }

  /** Why this device skips a revision at `path` of `size` bytes, if it does (§6, §7). */
  private skipReason(path: string, size: bigint): SkipReason | undefined {
    if (Number(size) > this.maxFileBytes) return "too-large";
    return unmaterializableReason(path, this.pathRules);
  }

  private tooLargeToUpload(op: PendingOp): boolean {
    return op.contentSize > this.maxFileBytes || this.uploadRefused.get(op.opId) === op.contentHash;
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

  // Read-only devices -------------------------------------------------------

  /**
   * Undoes every pending local change of a read-only device
   * (docs/design/sharing.md, Viewer devices): a file that differs from
   * `base` (edited, new, or renamed with other content) is kept with
   * keepLocalCopy and removed or overwritten, every document is restored
   * from `base` at its base path (undoing deletes and renames), new folders
   * are removed once empty, and the pending operations are dropped. A file
   * changed meanwhile stays on disk, and the next cycle's detection records
   * it again.
   */
  private async restoreShared(): Promise<void> {
    const state = await this.loadState();
    if (state.pending.length === 0) return;
    const changed = [...project(state).values()].filter((projection) => projection.lastOp !== undefined);
    const shared = (projection: Projection): DocEntry | undefined => (projection.base?.deleted === true ? undefined : projection.base);
    // The shared folders first, so that files can be restored into them.
    for (const projection of changed) {
      const base = shared(projection);
      if (projection.kind === "folder" && base !== undefined && !(await this.folderExists(base.path))) await this.createFolder(base.path);
    }
    // Every file that is not the shared version at its shared path is kept aside.
    for (const projection of changed) {
      if (projection.kind === "folder" || projection.deleted) continue;
      const file = await this.cache.read(this.vault, projection.path);
      if (file === null) continue;
      const base = shared(projection);
      const atBase = base !== undefined && base.path === projection.path;
      if (atBase && file.hash === base.baseHash) continue;
      if (file.hash !== base?.baseHash) {
        const content = await this.readFile(projection.path);
        if (content === null || sha256Hex(content) !== file.hash) continue;
        await this.keepLocalCopy(projection.path, content);
      }
      if (atBase) await this.write(base.path, await downloadContent(this.api, this.vaultId, base.baseHash, BigInt(base.baseSize)), file.hash);
      else await this.delete(projection.path, file.hash);
    }
    // The shared version of every document whose file is missing at its shared path.
    for (const projection of changed) {
      const base = shared(projection);
      if (projection.kind === "folder" || base === undefined) continue;
      if ((await this.cache.read(this.vault, base.path)) !== null) continue;
      await this.write(base.path, await downloadContent(this.api, this.vaultId, base.baseHash, BigInt(base.baseSize)), null);
    }
    // Folders that are not shared ones, deepest first, where they are empty now.
    const added = changed.filter((projection) => projection.kind === "folder" && !projection.deleted && shared(projection)?.path !== projection.path).map((projection) => projection.path);
    for (const path of added.sort((left, right) => right.length - left.length)) if (await this.folderExists(path)) await this.deleteFolder(path);
    await this.record({ deletePending: state.pending.map((op) => op.opId) });
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
      if (op.kind !== "delete" && op.docKind !== "folder") {
        // §7: a file over the size limit stays local and is listed.
        if (this.tooLargeToUpload(op)) {
          blocked.add(op.documentId);
          continue;
        }
        const read = () => this.readFile(op.path);
        let uploaded;
        try {
          uploaded = await uploadContent(this.api, this.vaultId, op.contentHash, BigInt(op.contentSize), read);
        } catch (error) {
          // The server refuses a size above its limit (CreateUpload: INVALID_ARGUMENT).
          if (errorCode(error) !== Code.InvalidArgument) throw error;
          this.uploadRefused.set(op.opId, op.contentHash);
          blocked.add(op.documentId);
          continue;
        }
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
            kind: documentKind(op.docKind),
            // A folder has no content.
            ...(op.docKind === "folder" ? {} : { contentRef: { blobId: hexToBytes(op.contentHash), size: BigInt(op.contentSize) } }),
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
   * P2 whose other document this device already holds and keeps there (a
   * name that differs from it only by case, say), and undefined for any other error.
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
    const projections = project(state);
    for (const entry of state.docs.values()) {
      if (entry.documentId === op.documentId || entry.deleted === true) continue;
      // A document this device moves off its path with a pending rename or delete holds it only until that operation is pushed.
      const projection = projections.get(entry.documentId);
      if (projection !== undefined && (projection.deleted || pathKey(projection.path) !== pathKey(entry.path))) continue;
      const other = pathKey(entry.path);
      // A folder document may hold other documents (SPEC.md §5).
      if (other === key || (op.docKind !== "folder" && other.startsWith(`${key}/`)) || (entry.kind !== "folder" && key.startsWith(`${other}/`))) return { reason };
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

  /**
   * Writes `content` if the file still holds `expectedHash` (null: no file).
   * Returns false if it changed. A crash leaves the old file or the new one,
   * never half of one (docs/design/engine.md §8):
   * - a file open in the editor: the editor-safe write in place (§4);
   * - with an atomic replace (desktop): a temporary file, then the replace;
   * - without one (mobile): a new file is a temporary file renamed into
   *   place; an existing one is replaced by a complete replacement file, a
   *   delete of the target and a rename.
   */
  private async write(path: string, content: Uint8Array, expectedHash: string | null): Promise<boolean> {
    // A rewrite can keep the size and the mtime, which the cache trusts.
    this.cache.invalidate(path);
    this.ownWrites.set(path, sha256Hex(content));
    let written = false;
    try {
      written = await this.replaceFile(path, content, expectedHash);
      return written;
    } finally {
      if (!written) this.ownWrites.delete(path);
    }
  }

  private async replaceFile(path: string, content: Uint8Array, expectedHash: string | null): Promise<boolean> {
    const precondition = { expectedHash };
    if (expectedHash !== null && this.vault.isOpenInEditor?.(path) === true) return this.unlessChanged(this.vault.write(path, content, precondition));
    if (this.vault.replace !== undefined) {
      const temporary = temporaryPath(path);
      await this.vault.write(temporary, content);
      // The vault may report the replace as a rename of the temporary file or as a change of the target.
      const key = `${temporary}\0${path}`;
      count(this.ownRenames, key, 1);
      let replaced = false;
      try {
        replaced = await this.unlessChanged(this.vault.replace(temporary, path, precondition));
      } finally {
        if (!replaced) count(this.ownRenames, key, -1);
      }
      if (!replaced) await this.removeTemporary(temporary);
      return replaced;
    }
    if (expectedHash === null) {
      const temporary = temporaryPath(path);
      await this.vault.write(temporary, content);
      try {
        await this.rename(temporary, path);
        return true;
      } catch (error) {
        await this.removeTemporary(temporary);
        if (isVaultError(error, "already-exists")) return false;
        throw error;
      }
    }
    const replacement = replacementPath(path);
    await this.vault.write(replacement, content);
    if (!(await this.delete(path, expectedHash))) {
      await this.removeTemporary(replacement);
      return false;
    }
    await this.rename(replacement, path);
    return true;
  }

  /** Resolves true when `change` succeeds, false when it rejects with "changed". */
  private async unlessChanged(change: Promise<void>): Promise<boolean> {
    try {
      await change;
      return true;
    } catch (error) {
      if (isVaultError(error, "changed")) return false;
      throw error;
    }
  }

  /**
   * Recovers from the temporary files a crash left behind
   * (docs/design/engine.md §8). A replacement file whose target is missing is
   * complete, so it is renamed into place; every other one may be partial and
   * is deleted.
   */
  private async removeTemporaryFiles(): Promise<void> {
    for (const path of await this.vault.list()) {
      if (!isTemporaryPath(path)) continue;
      const target = replacementTarget(path);
      if (target !== null && (await this.vault.stat(target)) === null) await this.rename(path, target);
      else await this.removeTemporary(path);
    }
    this.cleaned = true;
  }

  private async removeTemporary(path: string): Promise<void> {
    try {
      await this.vault.delete(path);
    } catch (error) {
      if (!isVaultError(error, "not-found")) throw error;
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

  private async createFolder(path: string): Promise<void> {
    const key = `folder-create\0${path}`;
    count(this.ownFolderChanges, key, 1);
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      count(this.ownFolderChanges, key, -1);
      throw error;
    }
  }

  /** Deletes the folder if it is there and empty. Returns false otherwise. */
  private async deleteFolder(path: string): Promise<boolean> {
    const key = `folder-delete\0${path}`;
    count(this.ownFolderChanges, key, 1);
    try {
      await this.vault.deleteFolder(path);
      return true;
    } catch (error) {
      count(this.ownFolderChanges, key, -1);
      if (isVaultError(error, "changed") || isVaultError(error, "not-found")) return false;
      throw error;
    }
  }

  // Events and scheduling ------------------------------------------------------

  /** A vault event: a hint that something changed. The engine's own changes are recognised and start no cycle. */
  private onVaultEvent(event: VaultEvent): void {
    if (isTemporaryPath(event.path)) return;
    switch (event.type) {
      case "folder-rename":
        this.renames.push([event.oldPath, event.path]);
        this.scheduleLocalChange();
        return;
      case "folder-create":
      case "folder-delete":
        if (count(this.ownFolderChanges, `${event.type}\0${event.path}`, -1)) return;
        this.scheduleLocalChange();
        return;
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
    const debounceMs = this.debounceMs;
    if (this.stopped || debounceMs === null) return;
    if (this.debounceTimer !== undefined) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.sync().catch(() => undefined);
    }, debounceMs);
  }

  private scheduleInterval(): void {
    if (this.stopped) return;
    const intervalMs = this.intervalMs;
    if (intervalMs === null) return;
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = undefined;
      this.scheduleInterval();
      void this.sync().catch(() => undefined);
    }, intervalMs);
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
  if (kind === DocumentKind.FOLDER) return "folder";
  return kind === DocumentKind.TEXT ? "text" : "blob";
}

function documentKind(kind: SyncKind): DocumentKind {
  if (kind === "folder") return DocumentKind.FOLDER;
  return kind === "text" ? DocumentKind.TEXT : DocumentKind.BLOB;
}

/** Where a document's file or folder is on this device once its pending operations apply, and its kind; undefined if it is not live here. */
function localPath(state: JournalState, documentId: string): { path: string; kind: SyncKind } | undefined {
  const entry = state.docs.get(documentId);
  const last = state.pending.filter((op) => op.documentId === documentId).at(-1);
  if (last !== undefined) return last.kind === "delete" ? undefined : { path: last.path, kind: last.docKind };
  return entry === undefined || entry.deleted === true ? undefined : { path: entry.path, kind: entry.kind };
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
