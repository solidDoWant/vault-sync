import { Code } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { backoffDelay, globalTimers, type Backoff, type Timers } from "../backoff";
import { errorCode, headMoved } from "../engine/errors";
import { downloadContent, toIncoming, type PullApi } from "../engine/remote";
import { uploadContent } from "../engine/upload";
import { sha256Hex } from "../hash";
import { pathKey } from "../pathkey/pathkey";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { detectChanges, HashCache, type RenameHint } from "./detect";
import { applyChange, type DocEntry, type JournalChange, type JournalState, type PendingOp, type SyncJournal, type SyncKind } from "./journal";

/** The protocol calls the engine makes. */
export type SyncApi = PullApi;

export interface SyncEngineOptions {
  api: SyncApi;
  vaultId: string;
  /** This device's id (RegisterDevice), sent with every commit. */
  deviceId: string;
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
 * A remote revision whose local state is not one rows A1–A5 decide
 * (docs/design/engine.md §5): the pull stops before it, leaving the cursor,
 * the file and the pending operations as they are.
 */
const undecided = Symbol("undecided");
type Outcome = JournalChange | typeof undecided;

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
    return pulled || pushed;
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
    const kind = syncKind(revision.kind);
    const target: Omit<DocEntry, "path"> = { documentId: id, kind: entry?.kind ?? kind, baseRevId: remote.revisionId, baseHash: remote.contentHash, baseSize: Number(remote.size) };

    if (entry === undefined) {
      if (ops.length > 0) return undecided;
      // A2: absent, tombstone.
      if (remote.deleted) return {};
      // A1: absent, live.
      const occupant = await this.cache.read(this.vault, remote.path);
      if (occupant !== null) {
        if (occupant.hash !== remote.contentHash || this.claimed(state, remote.path)) return undecided;
        return { putDocs: [{ ...target, path: remote.path }] };
      }
      const content = await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size);
      if (!(await this.write(remote.path, content, null))) return undecided;
      return { putDocs: [{ ...target, path: remote.path }] };
    }

    if (ops.length > 0) return undecided;
    const local = await this.cache.read(this.vault, entry.path);
    if (local?.hash !== entry.baseHash) return undecided;

    // A5: clean, tombstone.
    if (remote.deleted) {
      if (!(await this.delete(entry.path, entry.baseHash))) return undecided;
      return { deleteDocs: [id] };
    }
    // A4: clean, live, new path.
    if (remote.path !== entry.path) {
      const sameFile = pathKey(remote.path) === pathKey(entry.path);
      if (!sameFile && ((await this.cache.read(this.vault, remote.path)) !== null || this.claimed(state, remote.path))) return undecided;
      await this.rename(entry.path, remote.path);
      if (remote.contentHash !== entry.baseHash) {
        const content = await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size);
        // The file was edited after it was checked: it stays at the new path on its old base, an edit the next cycle resolves.
        if (!(await this.write(remote.path, content, entry.baseHash))) {
          await this.record({ putDocs: [{ ...entry, path: remote.path }] });
          return undecided;
        }
      }
      return { putDocs: [{ ...target, path: remote.path }] };
    }
    // A3: clean, live, same path.
    if (remote.contentHash !== entry.baseHash) {
      const content = await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size);
      if (!(await this.write(entry.path, content, entry.baseHash))) return undecided;
    }
    return { putDocs: [{ ...target, path: entry.path }] };
  }

  /** Whether a document of this device holds `path`: its synced path or a pending operation's target. */
  private claimed(state: JournalState, path: string): boolean {
    return state.pending.some((op) => op.kind !== "delete" && op.path === path) || [...state.docs.values()].some((entry) => entry.path === path);
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

  private async push(): Promise<boolean> {
    const state = await this.loadState();
    const blocked = new Set<string>();
    let progress = false;
    for (const queued of [...state.pending]) {
      if (blocked.has(queued.documentId)) continue;
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
        // P1 (the head moved) and P2 (the path is taken): keep the operation; the next pull brings what the server holds.
        if (headMoved(error) || errorCode(error) === Code.AlreadyExists) {
          blocked.add(op.documentId);
          continue;
        }
        throw error;
      }
      if (revision === undefined) throw new Error("CommitRevision returned no revision");
      await this.record(this.acknowledge(op, revision));
      progress = true;
    }
    return progress;
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
