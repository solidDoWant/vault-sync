import { sha256Hex } from "../hash";
import type { DeferReason, DocumentState, Journal, RemoteRevision } from "../journal/journal";
import { isVaultError, type VaultAdapter, type VaultEvent } from "../vault/adapter";
import { EchoSuppressor } from "./echo";
import { deferMerge, type MergeHook } from "./merge";
import { downloadContent, RemoteContentError, revisionContent, toIncoming, type IncomingRevision, type PullApi } from "./remote";

export interface SyncEngineOptions {
  /** The vault to sync. Plaintext vaults only until end-to-end encryption exists (SPEC.md §9.3). */
  vaultId: string;
  api: PullApi;
  vault: VaultAdapter;
  journal: Journal;
  /** Receives remote revisions that would overwrite unsynced local content. Defaults to deferMerge. */
  merge?: MergeHook;
  /**
   * Called, in order, for every vault change that is not an echo of the
   * engine's own writes (SPEC.md §8): the user's edits, to be pushed.
   */
  onLocalChange?: (event: VaultEvent) => void;
  /** ListChanges page size; the server caps it (SPEC.md §6.1). */
  pageSize?: number;
}

export interface PullSummary {
  /** The journal cursor after the pull. */
  cursor: bigint;
  /** Remote revisions written to (or already reflected on) disk. */
  applied: number;
  /** Remote revisions recorded as pending in the journal instead of applied. */
  deferred: number;
  /** Whether the server's history had diverged from the cursor and a resync ran. */
  resynced: boolean;
}

/** What the disk shows for a document, relative to its base and a remote revision. */
type Inspection =
  /** The disk already shows the remote revision (e.g. an apply interrupted after its disk step). */
  | { kind: "applied" }
  /** The disk shows the synced base; `source` is the document's file to move or replace, if any. */
  | { kind: "clean"; source: string | undefined; sourceHash: string | undefined }
  /** Applying would overwrite or lose local content. */
  | { kind: "dirty"; path: string; content: Uint8Array | null };

const defaultPageSize = 500;

/**
 * The platform-independent sync engine (SPEC.md §4): pulls the change feed
 * from the journal's cursor and applies it to the vault without ever
 * overwriting unsynced local edits (§6.1, §8). The push side (#17) builds on
 * onLocalChange and the journal's pending operations.
 *
 * Every step is resumable from the journal: a revision's disk changes are made
 * first, then its journal state, then the cursor, and each disk check compares
 * content hashes (never mtimes), so a revision interrupted at any point is
 * recognized and finished when it is pulled again.
 */
export class SyncEngine {
  private readonly vaultId: string;
  private readonly api: PullApi;
  private readonly vault: VaultAdapter;
  private readonly journal: Journal;
  private readonly merge: MergeHook;
  private readonly onLocalChange: (event: VaultEvent) => void;
  private readonly pageSize: number;
  private readonly echoes = new EchoSuppressor();
  private readonly unsubscribe: () => void;
  private events: Promise<void> = Promise.resolve();
  private pulls: Promise<unknown> = Promise.resolve();

  constructor(options: SyncEngineOptions) {
    this.vaultId = options.vaultId;
    this.api = options.api;
    this.vault = options.vault;
    this.journal = options.journal;
    this.merge = options.merge ?? deferMerge;
    this.onLocalChange = options.onLocalChange ?? (() => undefined);
    this.pageSize = options.pageSize ?? defaultPageSize;
    this.unsubscribe = this.vault.watch((event) => {
      this.events = this.events.then(() => this.handleEvent(event));
    });
  }

  /** Stops watching the vault. */
  dispose(): void {
    this.unsubscribe();
  }

  /** Resolves once every vault event received so far has been classified (and reported if it is a local change). */
  settled(): Promise<void> {
    return this.events;
  }

  /**
   * Pulls and applies every remote change since the cursor. Concurrent calls
   * run one after another. Rejects if a call fails; the cursor then stands at
   * the last revision that was fully applied, and the next pull resumes there.
   */
  pull(): Promise<PullSummary> {
    const run = this.pulls.then(() => this.pullOnce());
    this.pulls = run.catch(() => undefined);
    return run;
  }

  private async pullOnce(): Promise<PullSummary> {
    const summary: PullSummary = { cursor: await this.journal.getCursor(), applied: 0, deferred: 0, resynced: false };
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

  private count(summary: PullSummary, outcome: "applied" | "deferred" | "skipped"): void {
    if (outcome === "applied") summary.applied++;
    if (outcome === "deferred") summary.deferred++;
  }

  /**
   * Applies one remote revision, or defers it. Idempotent: a revision whose
   * apply was interrupted at any step is finished, not repeated.
   */
  private async applyRevision(incoming: IncomingRevision): Promise<"applied" | "deferred" | "skipped"> {
    const { remote } = incoming;
    const state = await this.journal.getDocument(remote.documentId);
    if (state?.revisionId === remote.revisionId) return "skipped";
    const deferred = await this.journal.getDeferred(remote.documentId);
    if (deferred?.reason === "local-changes" || (await this.hasPendingOperation(remote))) {
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

  /**
   * Whether the document has a local operation not yet acknowledged, other
   * than this very revision (this device's own commit coming back). Such a
   * document is owned by the merge path, like one with a deferred revision
   * because of local changes.
   */
  private async hasPendingOperation(remote: RemoteRevision): Promise<boolean> {
    const pending = await this.journal.listPending();
    return pending.some((operation) => operation.documentId === remote.documentId && operation.revisionId !== remote.revisionId);
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

  private async handToMerge(remote: RemoteRevision, state: DocumentState | undefined, local: { path: string; content: Uint8Array | null }): Promise<"deferred"> {
    // The only outcome until the merge algorithm (#18) exists is "deferred".
    await this.merge({
      remote,
      base: state,
      local: { path: local.path, content: local.content },
      readRemoteContent: () => (remote.deleted ? Promise.resolve(null) : downloadContent(this.api, this.vaultId, remote.contentHash, remote.size)),
      readBaseContent: () => (state === undefined ? Promise.resolve(null) : revisionContent(this.api, this.vaultId, state.revisionId)),
    });
    return this.defer(remote, "local-changes");
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
    deleted: remote.deleted,
  };
}
