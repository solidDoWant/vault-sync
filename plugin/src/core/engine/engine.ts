import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentSchema } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import type { ConflictReason, ConflictRecord, DeferReason, DocumentKindName, DocumentState, Journal, PendingOperation, RemoteRevision } from "../journal/journal";
import { conflictCopyPath } from "../merge/conflict-name";
import { uuidv7 } from "../uuid";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { isVaultRelativePath } from "../vaultpath/vaultpath";
import { EchoSuppressor } from "./echo";
import { threeWayMerge, type MergeHook, type MergeOutcome } from "./merge";
import { classifyByExtension, downloadContent, kindValue, RemoteContentError, revisionContent, toIncoming, type IncomingRevision, type PullApi } from "./remote";
import { uploadContent } from "./upload";

export interface SyncEngineOptions {
  /** The vault to sync. Plaintext vaults only until end-to-end encryption exists (SPEC.md §9.3). */
  vaultId: string;
  /** This install's registered device, recorded with every commit (SPEC.md §6.2). */
  deviceId: string;
  api: PullApi;
  vault: VaultAdapter;
  journal: Journal;
  /**
   * The device's name as the user knows it, used in the names of conflict
   * copies (SPEC.md §7). Defaults to `deviceId`.
   */
  deviceName?: string;
  /** Receives remote revisions that would overwrite unsynced local content. Defaults to threeWayMerge (SPEC.md §7). */
  merge?: MergeHook;
  /**
   * Called, in order, for every vault change that is not an echo of the
   * engine's own writes (SPEC.md §8): the user's edits, which the engine pushes.
   */
  onLocalChange?: (event: VaultEvent) => void;
  /** ListChanges page size; the server caps it (SPEC.md §6.1). */
  pageSize?: number;
  /**
   * How long after the last local change of a burst the engine pushes on its
   * own, in milliseconds. Every change restarts the wait, and the push reads
   * the disk when it runs, so a burst of edits becomes one revision holding
   * the last of them. null turns automatic pushes off (call push()).
   * Defaults to 2000.
   */
  pushDebounceMs?: number | null;
  /** Receives the error of an automatic push. Its operations stay pending and are retried by the next push. */
  onPushError?: (error: unknown) => void;
  /** Called for every revision of this device the server acknowledged (SPEC.md §6.2). */
  onAcknowledged?: (revision: RemoteRevision) => void;
  /** The kind of a new document, by path (SPEC.md §7). Defaults to classifyByExtension. */
  classify?: (path: string) => DocumentKindName;
  /** Generates document and revision ids. Defaults to random UUIDv7s. */
  newId?: () => string;
  /** The clock for conflict-copy names and the conflict log. Defaults to the system clock. */
  now?: () => Date;
}

export interface PullSummary {
  /** The journal cursor after the pull. */
  cursor: bigint;
  /** Remote revisions written to (or already reflected on) disk. */
  applied: number;
  /** Remote revisions recorded as pending in the journal instead of applied. */
  deferred: number;
  /** Remote revisions the merge hook merged with local changes. */
  merged: number;
  /** Whether the server's history had diverged from the cursor and a resync ran. */
  resynced: boolean;
}

/**
 * A local operation the server refused for good; it stays pending (surfacing
 * it is #100): INVALID_ARGUMENT, or ALREADY_EXISTS when no conflict-copy name
 * for the document fits the path limits.
 */
export interface RejectedOperation {
  operation: PendingOperation;
  error: ConnectError;
}

export interface PushSummary {
  /** Revisions of this device the server acknowledged. */
  committed: number;
  /** Commits refused because the document's head had moved or another document held its path; each pulled and went to the merge path. */
  conflicts: number;
  /** Local operations still waiting in the journal after the push. */
  pending: number;
  /** Operations refused for good. */
  rejected: RejectedOperation[];
}

/** What the disk shows for a document, relative to its base and a remote revision. */
type Inspection =
  /** The disk already shows the remote revision (e.g. an apply interrupted after its disk step). */
  | { kind: "applied" }
  /** The disk shows the synced base; `source` is the document's file to move or replace, if any. */
  | { kind: "clean"; source: string | undefined; sourceHash: string | undefined }
  /** Applying would overwrite or lose local content. */
  | { kind: "dirty"; path: string; content: Uint8Array | null };

type ApplyOutcome = "applied" | "deferred" | "merged" | "skipped";

/** What a push examines: changed paths, and renames (new path to the path the file had at the last sync). */
interface Changes {
  all: boolean;
  paths: Set<string>;
  renames: Map<string, string>;
}

/** Documents and paths the merge path owns: the engine pushes none of their changes. */
interface Parked {
  documents: Set<string>;
  paths: Set<string>;
}

const defaultPageSize = 500;
const defaultPushDebounceMs = 2000;
/** Rounds of one push: a merge or a superseded upload leaves changes the next round pushes. */
const maxPushRounds = 4;
/** Attempts of one CommitRevision within a push after transient failures; backing off is #146. */
const maxCommitAttempts = 3;
/** Numbered conflict-copy names tried before giving up on finding a free one. */
const maxConflictNameAttempts = 100;

/**
 * The platform-independent sync engine (SPEC.md §4). It pulls the change feed
 * from the journal's cursor and applies it to the vault without ever
 * overwriting unsynced local edits (§6.1, §8), and pushes local changes with
 * optimistic concurrency (§6.2).
 *
 * Every step is resumable from the journal. A pulled revision's disk changes
 * are made first, then its journal state, then the cursor, and each disk
 * check compares content hashes (never mtimes), so a revision interrupted at
 * any point is recognized and finished when it is pulled again. A local change
 * is recorded as a pending operation, with its revision id, before anything is
 * sent; it is retried with identical fields until the commit is acknowledged,
 * and only then removed (§8).
 */
export class SyncEngine {
  private readonly vaultId: string;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly api: PullApi;
  private readonly vault: VaultAdapter;
  private readonly journal: Journal;
  private readonly merge: MergeHook;
  private readonly onLocalChange: (event: VaultEvent) => void;
  private readonly pageSize: number;
  private readonly pushDebounceMs: number | null;
  private readonly onPushError: (error: unknown) => void;
  private readonly onAcknowledged: (revision: RemoteRevision) => void;
  private readonly classify: (path: string) => DocumentKindName;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly echoes = new EchoSuppressor();
  private readonly unsubscribe: () => void;
  private events: Promise<void> = Promise.resolve();
  /** Pulls and pushes, one at a time. */
  private work: Promise<unknown> = Promise.resolve();
  /** Local changes not yet pushed. Events are lost when the app dies, so the first push scans everything. */
  private changes: Changes = { all: true, paths: new Set(), renames: new Map() };
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: SyncEngineOptions) {
    this.vaultId = options.vaultId;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName ?? options.deviceId;
    this.api = options.api;
    this.vault = options.vault;
    this.journal = options.journal;
    this.merge = options.merge ?? threeWayMerge;
    this.onLocalChange = options.onLocalChange ?? (() => undefined);
    this.pageSize = options.pageSize ?? defaultPageSize;
    this.pushDebounceMs = options.pushDebounceMs === undefined ? defaultPushDebounceMs : options.pushDebounceMs;
    this.onPushError =
      options.onPushError ??
      ((error) => {
        setTimeout(() => {
          throw error;
        });
      });
    this.onAcknowledged = options.onAcknowledged ?? (() => undefined);
    this.classify = options.classify ?? classifyByExtension;
    this.newId = options.newId ?? (() => uuidv7());
    this.now = options.now ?? (() => new Date());
    this.unsubscribe = this.vault.watch((event) => {
      this.events = this.events.then(() => this.handleEvent(event));
    });
  }

  /** Stops watching the vault and cancels a scheduled push. */
  dispose(): void {
    this.disposed = true;
    this.cancelScheduledPush();
    this.unsubscribe();
  }

  /**
   * Resolves once every vault event received so far has been classified (and
   * reported if it is a local change), and every pull and push started so far
   * has finished.
   */
  async settled(): Promise<void> {
    await this.events;
    await this.work;
  }

  /**
   * Pulls and applies every remote change since the cursor. Pulls and pushes
   * run one after another. Rejects if a call fails; the cursor then stands at
   * the last revision that was fully applied, and the next pull resumes there.
   */
  pull(): Promise<PullSummary> {
    return this.serialize(() => this.pullOnce());
  }

  /**
   * Pushes every local change (SPEC.md §6.2). It pulls first, so the bases are
   * fresh and interrupted applies are finished, then resumes the journal's
   * pending operations with their original revision ids, then records and
   * commits an operation for each changed file. When a commit finds the head
   * moved, it pulls, which hands the document to the merge hook, and pushes
   * the merge result against the new head.
   *
   * Rejects on a failed call (a network failure, for example); what was not
   * acknowledged stays pending in the journal and is retried, with the same
   * revision ids, by the next push.
   */
  push(): Promise<PushSummary> {
    this.cancelScheduledPush();
    return this.serialize(() => this.pushOnce());
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.work.then(task);
    this.work = run.catch(() => undefined);
    return run;
  }

  private async pullOnce(): Promise<PullSummary> {
    const summary: PullSummary = { cursor: await this.journal.getCursor(), applied: 0, deferred: 0, merged: 0, resynced: false };
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: summary.cursor, pageSize: this.pageSize });
      if (response.headSeq < summary.cursor) {
        // The server lost history this device already applied (e.g. a
        // database restore). That is divergence, not "nothing new".
        await this.resync(summary);
        return summary;
      }
      for (const revision of response.revisions) {
        if (revision.seq <= summary.cursor) {
          throw new RemoteContentError(`change feed went from seq ${String(summary.cursor)} back to ${String(revision.seq)}`);
        }
        this.count(summary, await this.applyRevision(toIncoming(revision)));
        await this.journal.setCursor(revision.seq);
        summary.cursor = revision.seq;
      }
      if (!response.hasMore) return summary;
      if (response.revisions.length === 0) throw new RemoteContentError("change feed page claims more revisions but has none");
    }
  }

  private count(summary: PullSummary, outcome: ApplyOutcome): void {
    if (outcome === "applied") summary.applied++;
    if (outcome === "deferred") summary.deferred++;
    if (outcome === "merged") summary.merged++;
  }

  /**
   * Applies one remote revision, or defers it. Idempotent: a revision whose
   * apply was interrupted at any step is finished, not repeated.
   */
  private async applyRevision(incoming: IncomingRevision): Promise<ApplyOutcome> {
    const { remote } = incoming;
    const state = await this.journal.getDocument(remote.documentId);
    const pending = (await this.journal.listPending()).filter((operation) => operation.documentId === remote.documentId);
    if (pending.some((operation) => operation.revisionId === remote.revisionId)) {
      // This device's own commit, whose response was lost. The disk already
      // holds it, or a newer local edit, which the next push sends on top.
      if (state?.revisionId !== remote.revisionId) await this.journal.putDocument(syncedState(remote));
      await this.journal.removePending(remote.revisionId);
      return "applied";
    }
    if (state?.revisionId === remote.revisionId) return "skipped";
    const deferred = await this.journal.getDeferred(remote.documentId);
    if (deferred?.reason === "local-changes" || pending.length > 0) {
      return this.handToMerge(remote, state, await this.localFile(state, remote));
    }
    if (state !== undefined && remote.seq <= state.seq) return "skipped";
    if (!remote.deleted && !incoming.pathAllowed) return this.defer(remote, "invalid-path");

    // Download before looking at the disk, so the check-then-write window is short.
    const needsContent = !remote.deleted && (state === undefined || state.deleted || state.baseHash !== remote.contentHash);
    const content = needsContent ? await downloadContent(this.api, this.vaultId, remote.contentHash, remote.size) : undefined;

    const inspection = await this.inspect(state, remote);
    if (inspection.kind === "dirty") return this.handToMerge(remote, state, inspection);
    if (inspection.kind === "clean") {
      try {
        await this.writeToDisk(remote, inspection, content);
      } catch (error) {
        if (isVaultError(error, "path-conflict") || isVaultError(error, "already-exists")) return this.defer(remote, "path-conflict");
        throw error;
      }
    }
    // A newer revision supersedes one deferred for its path. Removed before
    // the journal update, so an interruption leaves nothing stale behind: the
    // re-pulled revision then finds the disk already applied.
    if (deferred !== undefined) await this.journal.removeDeferred(remote.documentId);
    await this.journal.putDocument(syncedState(remote));
    return "applied";
  }

  /** Classifies the disk by content hash against the base (`state`) and the remote revision. */
  private async inspect(state: DocumentState | undefined, remote: RemoteRevision): Promise<Inspection> {
    const basePath = state !== undefined && !state.deleted ? state.path : undefined;
    const baseContent = basePath === undefined ? null : await this.readOrNull(basePath);
    const baseHash = state?.baseHash;
    const baseOnDisk = baseContent !== null && sha256Hex(baseContent) === baseHash;

    if (remote.deleted) {
      // Nothing there: the engine already deleted it, or the user deleted it too. Both agree.
      if (basePath === undefined || baseContent === null) return { kind: "applied" };
      if (baseOnDisk) return { kind: "clean", source: basePath, sourceHash: baseHash };
      return { kind: "dirty", path: basePath, content: baseContent };
    }

    const target = remote.path;
    const targetContent = target === basePath ? baseContent : await this.readOrNull(target);
    const targetHash = targetContent === null ? null : sha256Hex(targetContent);

    if (basePath === undefined) {
      // A new document here (or a deleted one coming back).
      if (targetContent === null) return { kind: "clean", source: undefined, sourceHash: undefined };
      if (targetHash === remote.contentHash) return { kind: "applied" };
      return { kind: "dirty", path: target, content: targetContent };
    }
    if (basePath === target) {
      if (targetHash === remote.contentHash) return { kind: "applied" };
      if (baseOnDisk) return { kind: "clean", source: target, sourceHash: baseHash };
      // Edited, or deleted locally (content null): a local change either way.
      return { kind: "dirty", path: target, content: targetContent };
    }
    // A rename, possibly with an edit.
    if (baseContent === null) {
      // The engine moved the file before an interruption, or the user moved or deleted it.
      if (targetHash === remote.contentHash) return { kind: "applied" };
      if (targetHash === baseHash) return { kind: "clean", source: target, sourceHash: baseHash };
      return { kind: "dirty", path: basePath, content: null };
    }
    if (!baseOnDisk) return { kind: "dirty", path: basePath, content: baseContent };
    if (targetContent === null) return { kind: "clean", source: basePath, sourceHash: baseHash };
    // Something else holds the target path; never overwrite it.
    return { kind: "dirty", path: target, content: targetContent };
  }

  /** Makes the disk show `remote`, given a clean inspection. Every change is registered for echo suppression first. */
  private async writeToDisk(remote: RemoteRevision, inspection: Extract<Inspection, { kind: "clean" }>, content: Uint8Array | undefined): Promise<void> {
    const { source } = inspection;
    if (remote.deleted) {
      if (source !== undefined) await this.echoed(this.echoes.expectDelete(source), () => this.vault.delete(source));
      return;
    }
    if (source !== undefined && source !== remote.path) {
      await this.echoed(this.echoes.expectRename(source, remote.path), () => this.vault.rename(source, remote.path));
    }
    if (inspection.sourceHash === remote.contentHash) return;
    if (content === undefined) throw new Error(`content of ${remote.revisionId} was not downloaded`);
    await this.echoed(this.echoes.expectWrite(remote.path, remote.contentHash), () => this.vault.write(remote.path, content));
  }

  private async echoed(cancel: () => void, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      cancel();
      throw error;
    }
  }

  private async handToMerge(remote: RemoteRevision, state: DocumentState | undefined, found: { path: string; content: Uint8Array | null }): Promise<"deferred" | "merged"> {
    const local = await this.followRename(state, found);
    // A merge of this revision that was interrupted after its result reached
    // the disk is finished as it was, without asking the hook again.
    const deferred = await this.journal.getDeferred(remote.documentId);
    const merging = deferred?.revision.revisionId === remote.revisionId ? deferred.merging : undefined;
    if (merging !== undefined) {
      const there = await this.readOrNull(merging.path);
      if ((there === null ? null : sha256Hex(there)) === merging.contentHash) {
        const resumed = { path: merging.path, content: there };
        if (await this.applyMerge(remote, state, resumed, { status: "merged", ...resumed })) return "merged";
      }
    }
    const outcome = await this.merge({
      remote,
      base: state,
      local: { path: local.path, content: local.content },
      readRemoteContent: () => (remote.deleted ? Promise.resolve(null) : downloadContent(this.api, this.vaultId, remote.contentHash, remote.size)),
      // A tombstone has no content of its own to merge against.
      readBaseContent: () => (state === undefined || state.deleted ? Promise.resolve(null) : revisionContent(this.api, this.vaultId, state.revisionId)),
    });
    if (outcome.status === "merged" && (await this.applyMerge(remote, state, local, outcome))) return "merged";
    return this.defer(remote, "local-changes");
  }

  /**
   * Makes the disk show a merge result and rebases the document onto the
   * remote revision, so that the next push commits the result with the remote
   * revision as its base (SPEC.md §6.2 step 3). Returns false, writing
   * nothing, if the local file no longer holds what the merge hook was given
   * (the user changed it meanwhile), if it belongs to another document, or if
   * a conflict copy has no name that fits the path limits; and false, keeping
   * whatever it already wrote, if a file is in the way.
   *
   * Crash-safe, journal before act, whether the merge came from a pull or a
   * push: the result's path and hash are first recorded on the document's
   * deferral; then a conflict, if any, is recorded in the conflict log and its
   * copy written; then the result is written; then the superseded pending
   * operations are dropped, the base moves to the remote revision, and the
   * deferral is removed. Until the base moves, the remote revision counts as
   * unapplied: a pull does not advance the cursor past it before this returns,
   * and the deferral keeps it with the merge path, so the next pull or push
   * hands it to handToMerge again. That finishes the merge from the record if
   * the disk already shows the result, and otherwise asks the hook again,
   * which reuses the logged copy's name. Interrupted after the rebase, the
   * result is an ordinary local edit on top of the remote revision, and a
   * conflict copy an ordinary new file, and both are pushed as such.
   */
  private async applyMerge(
    remote: RemoteRevision,
    state: DocumentState | undefined,
    local: { path: string; content: Uint8Array | null },
    outcome: Extract<MergeOutcome, { status: "merged" }>,
  ): Promise<boolean> {
    if (outcome.content !== null && !isVaultRelativePath(outcome.path)) throw new Error(`the merge hook returned a path that is not vault-relative: ${outcome.path}`);
    const current = await this.readOrNull(local.path);
    if (!sameContent(current, local.content)) return false;
    // Another document's file is not this merge's to replace.
    const holder = await this.journal.findDocumentByPath(local.path);
    if (holder !== undefined && holder.documentId !== remote.documentId) return false;
    await this.journal.putDeferred({
      revision: remote,
      reason: "local-changes",
      merging: { path: outcome.path, contentHash: outcome.content === null ? null : sha256Hex(outcome.content) },
    });
    let copyPath: string | null = null;
    try {
      if (outcome.conflict !== undefined) {
        copyPath = await this.writeConflictCopy(remote, local.path, outcome.conflict);
        if (copyPath === null) return false;
      }
      if (outcome.content === null) {
        if (current !== null) await this.echoed(this.echoes.expectDelete(local.path), () => this.vault.delete(local.path));
      } else {
        let there = outcome.path === local.path ? current : await this.readOrNull(outcome.path);
        if (outcome.path !== local.path && current !== null) {
          if (there !== null) return false;
          await this.echoed(this.echoes.expectRename(local.path, outcome.path), () => this.vault.rename(local.path, outcome.path));
          there = current;
        }
        const merged = outcome.content;
        const hash = sha256Hex(merged);
        if (there === null || sha256Hex(there) !== hash) {
          await this.echoed(this.echoes.expectWrite(outcome.path, hash), () => this.vault.write(outcome.path, merged));
        }
      }
    } catch (error) {
      if (isVaultError(error, "path-conflict") || isVaultError(error, "already-exists")) return false;
      throw error;
    }
    // The document's unacknowledged operations are superseded: their commits
    // were refused (the head had moved past their base), and their content is
    // part of the merge result on disk or of the conflict copy. So are those
    // of a local file that stood at the remote revision's path without being
    // this document's (a local create the remote one collided with), whose
    // content the result or the copy now holds. They go before the rebase, so
    // a document never has the remote revision as its base while an operation
    // based on an older head is still pending.
    const ownFile = state !== undefined && !state.deleted;
    for (const operation of await this.journal.listPending()) {
      const occupant = !ownFile && operation.documentId !== remote.documentId && operation.path === local.path && !operation.deleted;
      if (operation.documentId === remote.documentId || occupant) await this.journal.removePending(operation.revisionId);
    }
    await this.journal.putDocument(syncedState(remote));
    await this.journal.removeDeferred(remote.documentId);
    this.changes.paths.add(local.path);
    this.changes.paths.add(outcome.path);
    if (copyPath !== null) this.changes.paths.add(copyPath);
    // A local rename the merge kept is pushed as a rename of the document.
    if (outcome.content !== null && !remote.deleted && outcome.path !== remote.path) this.changes.renames.set(outcome.path, remote.path);
    // A merge made by a pull is pushed like a local edit.
    this.schedulePush();
    return true;
  }

  /**
   * Keeps the local version of a conflict as a copy next to `localPath`
   * (SPEC.md §7). The conflict is logged first, so a copy interrupted by a
   * crash is finished under the same name rather than written twice. Returns
   * the copy's path, or null if no name fits the path limits: the conflict is
   * then logged without a copy and nothing is written, so the local version
   * stays where it is.
   */
  private async writeConflictCopy(remote: RemoteRevision, localPath: string, conflict: { reason: ConflictReason; content: Uint8Array }): Promise<string | null> {
    const hash = sha256Hex(conflict.content);
    const logged = (await this.journal.listConflicts()).filter((record) => record.documentId === remote.documentId && record.copyHash === hash);
    let copyPath: string | null = null;
    for (const record of logged) {
      if (record.copyPath === null) continue;
      const there = await this.readOrNull(record.copyPath);
      if (there === null || sha256Hex(there) === hash) {
        copyPath = record.copyPath;
        break;
      }
    }
    if (copyPath === null) {
      copyPath = await this.freeConflictPath(localPath);
      const unresolved = copyPath === null && logged.some((record) => record.copyPath === null && record.remoteRevisionId === remote.revisionId);
      if (!unresolved) {
        await this.journal.putConflict(this.conflictRecord(remote.documentId, remote.path, conflict.reason, copyPath, hash, remote.revisionId));
      }
      if (copyPath === null) return null;
    }
    const there = await this.readOrNull(copyPath);
    if (there === null || sha256Hex(there) !== hash) {
      const target = copyPath;
      await this.echoed(this.echoes.expectWrite(target, hash), () => this.vault.write(target, conflict.content));
    }
    return copyPath;
  }

  private conflictRecord(documentId: string, path: string, reason: ConflictReason, copyPath: string | null, copyHash: string, remoteRevisionId: string): ConflictRecord {
    return { id: this.newId(), documentId, path, reason, copyPath, copyHash, remoteRevisionId, at: this.now().getTime() };
  }

  /**
   * A conflict-copy path for `path` that no file, document, pending
   * operation or logged conflict uses yet, or null if no name fits the path
   * limits.
   */
  private async freeConflictPath(path: string): Promise<string | null> {
    const date = this.now();
    const taken = new Set<string>();
    for (const operation of await this.journal.listPending()) taken.add(operation.path);
    for (const record of await this.journal.listConflicts()) if (record.copyPath !== null) taken.add(record.copyPath);
    for (let attempt = 1; attempt <= maxConflictNameAttempts; attempt++) {
      const candidate = conflictCopyPath(path, this.deviceName, date, attempt);
      if (candidate === null) return null;
      if (taken.has(candidate) || (await this.vault.stat(candidate)) !== null || (await this.journal.findDocumentByPath(candidate)) !== undefined) continue;
      return candidate;
    }
    return null;
  }

  private async defer(remote: RemoteRevision, reason: DeferReason): Promise<"deferred"> {
    await this.journal.putDeferred({ revision: remote, reason });
    return "deferred";
  }

  /** The document's local file: its synced path if it has one, else the remote revision's path. */
  private async localFile(state: DocumentState | undefined, remote: RemoteRevision): Promise<{ path: string; content: Uint8Array | null }> {
    const path = state !== undefined && !state.deleted ? state.path : remote.path;
    return { path, content: await this.readOrNull(path) };
  }

  /**
   * Where the document's file went if it is gone from its synced path: the
   * path of a pending rename, or of a rename event not yet pushed, if a file
   * is there. Otherwise `local` as it is (a local delete).
   */
  private async followRename(state: DocumentState | undefined, local: { path: string; content: Uint8Array | null }): Promise<{ path: string; content: Uint8Array | null }> {
    if (local.content !== null || state === undefined || state.deleted || local.path !== state.path) return local;
    const pending = (await this.journal.listPending()).filter((operation) => operation.documentId === state.documentId && !operation.deleted && operation.path !== state.path);
    const candidates = [...pending.map((operation) => operation.path).reverse(), ...[...this.changes.renames].filter(([, from]) => from === state.path).map(([to]) => to)];
    for (const path of candidates) {
      const content = await this.readOrNull(path);
      if (content !== null) return { path, content };
    }
    return local;
  }

  /**
   * Reconciles with a server whose history no longer contains the cursor.
   * Scans the whole feed for each document's head, applies heads of documents
   * this device does not know, and hands every document the journal knows at
   * another revision to the merge path, since the server may have lost
   * acknowledged revisions that only this device still has. Only then is the
   * cursor reset to the server's head, so an interrupted resync runs again.
   */
  private async resync(summary: PullSummary): Promise<void> {
    summary.resynced = true;
    const heads = new Map<string, IncomingRevision>();
    let seq = 0n;
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: seq, pageSize: this.pageSize });
      for (const revision of response.revisions) {
        if (revision.seq <= seq) throw new RemoteContentError(`change feed went from seq ${String(seq)} back to ${String(revision.seq)}`);
        heads.set(revision.documentId, toIncoming(revision));
        seq = revision.seq;
      }
      if (!response.hasMore) break;
      if (response.revisions.length === 0) throw new RemoteContentError("change feed page claims more revisions but has none");
    }
    const ordered = [...heads.values()].sort((left, right) => (left.remote.seq < right.remote.seq ? -1 : 1));
    for (const incoming of ordered) {
      const { remote } = incoming;
      const state = await this.journal.getDocument(remote.documentId);
      if (state === undefined) {
        this.count(summary, await this.applyRevision(incoming));
      } else if (state.revisionId === remote.revisionId) {
        // Same revision; renumber it, as the restored server's seq values may differ.
        if (state.seq !== remote.seq) await this.journal.putDocument({ ...state, seq: remote.seq });
      } else {
        const local = await this.localFile(state, remote);
        this.count(summary, await this.handToMerge(remote, state, local));
      }
    }
    await this.journal.resetCursor(seq);
    summary.cursor = seq;
  }

  private async pushOnce(): Promise<PushSummary> {
    // Classify every vault event so far, so the push sees the latest changes.
    await this.events;
    const summary: PushSummary = { committed: 0, conflicts: 0, pending: 0, rejected: [] };
    await this.pullOnce();
    await this.retryMerges();
    for (let round = 0; round < maxPushRounds; round++) {
      const changes = this.changes;
      this.changes = { all: false, paths: new Set(), renames: new Map() };
      try {
        await this.pushRound(changes, summary, round === 0);
      } catch (error) {
        this.restoreChanges(changes);
        throw error;
      }
      if (!this.changes.all && this.changes.paths.size === 0) break;
    }
    summary.pending = (await this.journal.listPending()).length;
    if (this.changes.all || this.changes.paths.size > 0) this.schedulePush();
    return summary;
  }

  /** Asks the merge hook again about every document it deferred: a merge may now succeed. */
  private async retryMerges(): Promise<void> {
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason !== "local-changes") continue;
      const state = await this.journal.getDocument(deferred.revision.documentId);
      await this.handToMerge(deferred.revision, state, await this.localFile(state, deferred.revision));
    }
  }

  /** Resumes pending operations (first round only), then records and commits an operation per changed file. */
  private async pushRound(changes: Changes, summary: PushSummary, resume: boolean): Promise<void> {
    let parked = await this.parked();
    if (resume) {
      for (const operation of await this.journal.listPending()) {
        if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) continue;
        await this.commitOperation(operation, summary);
        parked = await this.parked();
      }
    }
    for (const operation of await this.detectChanges(changes, parked)) {
      // An earlier commit's pull may have handed this document or path to the merge path.
      parked = await this.parked();
      if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) continue;
      await this.journal.addPending(operation);
      await this.commitOperation(operation, summary);
    }
  }

  /** Documents and paths the merge path owns, and documents and paths with an operation still pending. */
  private async parked(): Promise<Parked> {
    const parked: Parked = { documents: new Set(), paths: new Set() };
    for (const deferred of await this.journal.listDeferred()) {
      if (deferred.reason !== "local-changes") continue;
      const { revision } = deferred;
      parked.documents.add(revision.documentId);
      parked.paths.add(revision.path);
      const state = await this.journal.getDocument(revision.documentId);
      if (state !== undefined && !state.deleted) parked.paths.add(state.path);
    }
    return parked;
  }

  /**
   * The operations that make the server show the changed files, by content
   * hash against the journal's base: deletes and renames first, then edits,
   * then creates, so a path a change frees is free before a create takes it.
   * Paths the merge path owns, and documents and paths with an operation still
   * pending, are left alone: the pending operation goes first, and the disk
   * keeps the newest content for the push after it.
   */
  private async detectChanges(changes: Changes, parked: Parked): Promise<PendingOperation[]> {
    const pending = await this.journal.listPending();
    const busyDocuments = new Set([...parked.documents, ...pending.map((operation) => operation.documentId)]);
    const busyPaths = new Set([...parked.paths, ...pending.map((operation) => operation.path)]);
    const removals: PendingOperation[] = [];
    const edits: PendingOperation[] = [];
    const creates: PendingOperation[] = [];
    const handled = new Set<string>();

    for (const [to, from] of changes.renames) {
      if (busyPaths.has(from) || busyPaths.has(to)) continue;
      const state = await this.journal.findDocumentByPath(from);
      if (state === undefined || busyDocuments.has(state.documentId)) continue;
      if ((await this.readOrNull(from)) !== null || (await this.journal.findDocumentByPath(to)) !== undefined) continue;
      const content = await this.readOrNull(to);
      if (content === null) continue;
      edits.push(this.operation(state, to, content));
      handled.add(from);
      handled.add(to);
    }

    const paths = new Set(changes.paths);
    const tombstones = new Map<string, DocumentState>();
    const documents = await this.journal.listDocuments();
    for (const state of documents) {
      if (state.deleted) {
        const known = tombstones.get(state.path);
        if (known === undefined || known.seq < state.seq) tombstones.set(state.path, state);
      } else if (changes.all) {
        paths.add(state.path);
      }
    }
    if (changes.all) for (const path of await this.vault.list()) paths.add(path);

    for (const path of [...paths].sort()) {
      if (handled.has(path) || busyPaths.has(path)) continue;
      const state = await this.journal.findDocumentByPath(path);
      if (state !== undefined && busyDocuments.has(state.documentId)) continue;
      const content = await this.readOrNull(path);
      if (state !== undefined) {
        if (content === null) removals.push(this.operation(state, state.path, null));
        else if (sha256Hex(content) !== state.baseHash) edits.push(this.operation(state, path, content));
        continue;
      }
      if (content === null) continue;
      // A file where a deleted document was brings that document back (SPEC.md §8, decision #17).
      const tombstone = tombstones.get(path);
      if (tombstone !== undefined && !busyDocuments.has(tombstone.documentId)) {
        edits.push(this.operation(tombstone, path, content));
        continue;
      }
      creates.push({ revisionId: this.newId(), documentId: this.newId(), baseRevisionId: "", path, contentHash: sha256Hex(content), size: BigInt(content.length), kind: this.classify(path), deleted: false });
    }
    return [...removals, ...edits, ...creates];
  }

  /** A new revision of a known document: `content` at `path`, or a tombstone (null). */
  private operation(state: DocumentState, path: string, content: Uint8Array | null): PendingOperation {
    return {
      revisionId: this.newId(),
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
   * Uploads an operation's content and commits it with its own revision id
   * and identical fields, however often it is retried, so a commit whose
   * response was lost returns the revision already committed (SPEC.md §6.2).
   * The journal records the new base and only then drops the operation.
   */
  private async commitOperation(operation: PendingOperation, summary: PushSummary): Promise<void> {
    const state = await this.journal.getDocument(operation.documentId);
    if (state?.revisionId === operation.revisionId) {
      // Acknowledged before an interruption; only the clean-up is left.
      await this.journal.removePending(operation.revisionId);
      return;
    }
    // A rename or delete keeps the base's content, which the server already holds.
    const keepsContent = state !== undefined && state.revisionId === operation.baseRevisionId && state.baseHash === operation.contentHash;
    const upload = keepsContent
      ? "complete"
      : await uploadContent(this.api, this.vaultId, operation.contentHash, operation.size, () => (operation.deleted ? Promise.resolve(null) : this.readOrNull(operation.path)));
    if (upload === "missing") {
      // The file changed before its content was uploaded, so this revision
      // was never committed (the server commits only complete blobs). The
      // file's current content replaces it.
      await this.journal.removePending(operation.revisionId);
      this.changes.paths.add(operation.path);
      return;
    }
    const request = {
      vaultId: this.vaultId,
      documentId: operation.documentId,
      revisionId: operation.revisionId,
      baseRevId: operation.baseRevisionId,
      kind: kindValue(operation.kind),
      contentRef: { blobId: hexToBytes(operation.contentHash), size: operation.size },
      path: new TextEncoder().encode(operation.path),
      deleted: operation.deleted,
      deviceId: this.deviceId,
    };
    let committed;
    for (let attempt = 1; committed === undefined; attempt++) {
      try {
        committed = await this.api.sync.commitRevision(request);
      } catch (error) {
        // The response may have been lost after the server committed: the
        // identical request returns that revision instead of a conflict.
        if (isTransient(error) && attempt < maxCommitAttempts) continue;
        await this.commitFailed(operation, error, summary);
        return;
      }
    }
    const revision = committed.revision;
    if (revision?.id !== operation.revisionId || revision.documentId !== operation.documentId) {
      throw new RemoteContentError(`CommitRevision for ${operation.revisionId} returned another revision`);
    }
    const remote = toIncoming(revision).remote;
    await this.journal.putDocument({
      documentId: operation.documentId,
      path: operation.path,
      revisionId: revision.id,
      seq: revision.seq,
      baseHash: operation.contentHash,
      size: operation.size,
      kind: operation.kind,
      deleted: operation.deleted,
    });
    await this.journal.removePending(operation.revisionId);
    summary.committed++;
    // Changes made while the operation was pending were left for after it.
    this.changes.paths.add(operation.path);
    this.onAcknowledged(remote);
  }

  /**
   * Handles a refused commit; the operation stays pending unless resolved here.
   * Head moved: pull, which hands the document to the merge hook (it has a
   * pending operation). Path taken by another document (ALREADY_EXISTS): pull,
   * so that document arrives. If its revision lands at the same path, the pull
   * hands it to the merge hook, which keeps the local file as a conflict copy;
   * otherwise (the paths differ only by case or Unicode form, or the hook
   * deferred) see moveToConflictPath. INVALID_ARGUMENT: recorded as rejected.
   * Anything else rejects the push.
   */
  private async commitFailed(operation: PendingOperation, error: unknown, summary: PushSummary): Promise<void> {
    if (!(error instanceof ConnectError)) throw error;
    if (error.code === Code.FailedPrecondition && error.findDetails(DocumentSchema).length > 0) {
      summary.conflicts++;
      await this.pullOnce();
      return;
    }
    if (error.code === Code.AlreadyExists) {
      summary.conflicts++;
      await this.pullOnce();
      await this.moveToConflictPath(operation, error, summary);
      return;
    }
    if (error.code === Code.InvalidArgument) {
      summary.rejected.push({ operation, error });
      return;
    }
    throw error;
  }

  /**
   * Resolves a commit refused because another document holds its path
   * (SPEC.md §6.3): if the operation is still pending after the pull and the
   * merge path does not own it, the local document moves to
   * `<name> (conflict <device> <date>).<ext>` and is committed there, under
   * its own document id. Logged in the conflict log before the file moves, so
   * an interrupted move resumes under the same name; the replacement
   * operation is added before the refused one is removed. If no name fits the
   * path limits, nothing moves and the operation is reported as rejected.
   */
  private async moveToConflictPath(operation: PendingOperation, error: ConnectError, summary: PushSummary): Promise<void> {
    const pending = await this.journal.listPending();
    if (operation.deleted || !pending.some((candidate) => candidate.revisionId === operation.revisionId)) return;
    const parked = await this.parked();
    if (parked.documents.has(operation.documentId) || parked.paths.has(operation.path)) return;
    const logged = (await this.journal.listConflicts()).filter(
      (record) => record.reason === "path-taken" && record.documentId === operation.documentId && record.path === operation.path && record.copyHash === operation.contentHash,
    );
    let record = logged.find((candidate) => candidate.copyPath !== null);
    const atPath = await this.readOrNull(operation.path);
    if (record === undefined) {
      // Nothing to move: the file is gone, and the next push sees that.
      if (atPath === null) return;
      const copyPath = await this.freeConflictPath(operation.path);
      if (copyPath === null) {
        if (logged.length === 0) await this.journal.putConflict(this.conflictRecord(operation.documentId, operation.path, "path-taken", null, operation.contentHash, ""));
        summary.rejected.push({ operation, error });
        return;
      }
      record = this.conflictRecord(operation.documentId, operation.path, "path-taken", copyPath, operation.contentHash, "");
      await this.journal.putConflict(record);
    }
    const copyPath = record.copyPath;
    if (copyPath === null) return;
    // Already moved before an interruption, if the copy's path holds a file;
    // a file at the old path is then a new one, which the next round pushes.
    if (atPath !== null && (await this.vault.stat(copyPath)) === null) {
      await this.echoed(this.echoes.expectRename(operation.path, copyPath), () => this.vault.rename(operation.path, copyPath));
    }
    const content = await this.readOrNull(copyPath);
    if (content === null) return;
    const replacement = pending.find((candidate) => candidate.documentId === operation.documentId && candidate.path === copyPath) ?? {
      ...operation,
      revisionId: this.newId(),
      path: copyPath,
      contentHash: sha256Hex(content),
      size: BigInt(content.length),
    };
    if (!pending.includes(replacement)) await this.journal.addPending(replacement);
    await this.journal.removePending(operation.revisionId);
    this.changes.paths.add(operation.path);
    await this.commitOperation(replacement, summary);
  }

  private restoreChanges(changes: Changes): void {
    this.changes.all ||= changes.all;
    for (const path of changes.paths) this.changes.paths.add(path);
    for (const [to, from] of changes.renames) if (!this.changes.renames.has(to)) this.changes.renames.set(to, from);
  }

  private recordChange(event: VaultEvent): void {
    this.changes.paths.add(event.path);
    if (event.type === "rename") {
      this.changes.paths.add(event.oldPath);
      // a -> b -> c is one rename of the document synced at a.
      const origin = this.changes.renames.get(event.oldPath) ?? event.oldPath;
      this.changes.renames.delete(event.oldPath);
      if (origin !== event.path) this.changes.renames.set(event.path, origin);
    }
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushDebounceMs === null || this.disposed) return;
    this.cancelScheduledPush();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push().catch((error: unknown) => {
        this.onPushError(error);
      });
    }, this.pushDebounceMs);
  }

  private cancelScheduledPush(): void {
    if (this.pushTimer === undefined) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  private async handleEvent(event: VaultEvent): Promise<void> {
    let echo = false;
    try {
      echo = await this.echoes.isEcho(event, async (path) => {
        const content = await this.readOrNull(path);
        return content === null ? null : sha256Hex(content);
      });
    } catch {
      // In doubt, report the change: a duplicate report is harmless, a missed edit is not.
    }
    if (echo) return;
    this.recordChange(event);
    try {
      this.onLocalChange(event);
    } catch (error) {
      // Keep classifying later events; surface the listener's error without swallowing it.
      setTimeout(() => {
        throw error;
      });
    }
  }

  private async readOrNull(path: string): Promise<Uint8Array | null> {
    try {
      return await this.vault.read(path);
    } catch (error) {
      if (isVaultError(error, "not-found")) return null;
      throw error;
    }
  }
}

function syncedState(remote: RemoteRevision): DocumentState {
  return {
    documentId: remote.documentId,
    path: remote.path,
    revisionId: remote.revisionId,
    seq: remote.seq,
    baseHash: remote.contentHash,
    size: remote.size,
    kind: remote.kind,
    deleted: remote.deleted,
  };
}

/** A failure after which the identical call may succeed. */
function isTransient(error: unknown): boolean {
  return error instanceof ConnectError && (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded);
}

function sameContent(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && sha256Hex(left) === sha256Hex(right);
}
