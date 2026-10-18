// An engine-backed client for the simulation: the real plugin/src/core
// SyncEngine over an in-memory vault and journal, talking to the real server
// through the simulated network and its faults. In seeded runs it only pulls
// (#16): it never edits locally, so after the run its vault must equal the
// server's live heads, it must report no local changes (echo suppression), and
// it must have deferred nothing. Scripted scenarios also edit its vault and
// push (#17), with several engines editing concurrently (#18); random engine
// edits are #22. Its vault and journal survive a
// crash (they are a device's disk), while the engine itself, and everything it
// had in flight, does not.

import { Code } from "@connectrpc/connect";

import { bytesToHex } from "@noble/hashes/utils.js";

import { SyncEngine, type PushSummary } from "../plugin/src/core/engine/engine";
import { threeWayMerge, type MergeHook } from "../plugin/src/core/engine/merge";
import { sha256Hex } from "../plugin/src/core/hash";
import type { ConflictRecord } from "../plugin/src/core/journal/journal";
import { InMemoryJournal } from "../plugin/src/core/journal/memory";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { VaultEvent } from "../plugin/src/core/vault/adapter";
import { InMemoryVault } from "../plugin/src/core/vault/memory";
import type { RunContext, Violation } from "./client";
import { errorCode } from "./network";

/** Revisions per ListChanges page; small, so pulls page. */
const pageSize = 7;
/** The engines' clock, fixed so conflict-copy names (and with them traces) replay identically. */
export const simDate = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

/** What a converged vault holds: path to content hash of every live document, and the last seq. */
export interface ServerHeads {
  files: Map<string, string>;
  lastSeq: bigint;
}

export class EngineObserver {
  private readonly vault = new InMemoryVault({ now: () => 0 });
  private readonly journal = new InMemoryJournal();
  private engine: SyncEngine;
  private busy = false;
  private readonly localChanges: VaultEvent[] = [];
  /** Paths the scenario edited as the user: their events are expected local changes. */
  private readonly userEdited = new Set<string>();
  /** The merge hook of the engine (and of the engines after a crash); the default is the engine's, threeWayMerge. */
  merge: MergeHook | undefined;

  constructor(
    /** The observer's index in the simulated network (after the scripted clients). */
    readonly index: number,
    private readonly api: ProtocolClient,
    private readonly deviceId: string,
    private readonly context: RunContext,
  ) {
    this.engine = this.createEngine();
  }

  get name(): string {
    return `e${String(this.index)}`;
  }

  get idle(): boolean {
    return !this.busy;
  }

  /** Starts a pull unless one is running; returns the trace entry. */
  startPull(): string {
    if (this.busy) return `${this.name} busy, pull skipped`;
    this.busy = true;
    const incarnation = this.context.network.incarnation(this.index);
    void this.engine
      .pull()
      .then(
        (summary) => {
          this.context.log(`${this.name} pulled up to seq ${String(summary.cursor)}: ${String(summary.applied)} applied, ${String(summary.deferred)} deferred`);
        },
        (error: unknown) => {
          if (errorCode(error) === Code.Unavailable) {
            this.context.log(`${this.name} engine pull interrupted: Unavailable`);
          } else {
            this.violation("engine", `${this.name} pull failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      )
      .finally(() => {
        if (this.context.network.incarnation(this.index) === incarnation) this.busy = false;
      });
    return `${this.name} starts pull`;
  }

  /** Writes `content` to the observer's vault as its user would; the engine pushes it on the next push. */
  async edit(path: string, content: Uint8Array): Promise<string> {
    this.userEdited.add(path);
    await this.vault.write(path, content);
    await this.engine.settled();
    return `${this.name} user writes ${path} (${String(content.length)} B)`;
  }

  /** Deletes `path` from the observer's vault as its user would. */
  async remove(path: string): Promise<string> {
    this.userEdited.add(path);
    await this.vault.delete(path);
    await this.engine.settled();
    return `${this.name} user deletes ${path}`;
  }

  /** The engine's conflict log. */
  conflicts(): Promise<ConflictRecord[]> {
    return this.journal.listConflicts();
  }

  /** The paths in the observer's vault, sorted. */
  async list(): Promise<string[]> {
    return (await this.vault.list()).sort();
  }

  /** The vault's content at `path`, or undefined. */
  async read(path: string): Promise<Uint8Array | undefined> {
    return (await this.vault.list()).includes(path) ? this.vault.read(path) : undefined;
  }

  /** Starts a push unless the engine is busy; returns the trace entry. */
  startPush(): string {
    if (this.busy) return `${this.name} busy, push skipped`;
    this.busy = true;
    const incarnation = this.context.network.incarnation(this.index);
    void this.engine
      .push()
      .then(
        (summary: PushSummary) => {
          this.context.log(`${this.name} pushed: ${String(summary.committed)} committed, ${String(summary.conflicts)} conflicts, ${String(summary.pending)} pending`);
        },
        (error: unknown) => {
          if (errorCode(error) === Code.Unavailable) {
            this.context.log(`${this.name} engine push interrupted: Unavailable`);
          } else {
            this.violation("engine", `${this.name} push failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      )
      .finally(() => {
        if (this.context.network.incarnation(this.index) === incarnation) this.busy = false;
      });
    return `${this.name} starts push`;
  }

  /** The app is killed: the engine and its in-flight calls are gone; the vault and journal remain. */
  crash(): string {
    this.context.network.crash(this.index);
    this.engine.dispose();
    this.engine = this.createEngine();
    this.busy = false;
    return `${this.name} crashed and restarted with its vault and journal`;
  }

  /** The engine-level invariants, checked once the run has quiesced. */
  async check(heads: ServerHeads): Promise<Violation[]> {
    await this.engine.settled();
    const violations: Violation[] = [];
    const files = new Map<string, string>();
    for (const path of await this.vault.list()) files.set(path, sha256Hex(await this.vault.read(path)));
    for (const [path, hash] of heads.files) {
      const local = files.get(path);
      if (local === undefined) violations.push({ invariant: "engine-convergence", detail: `${this.name} is missing ${path}` });
      else if (local !== hash) violations.push({ invariant: "engine-convergence", detail: `${this.name} holds other content at ${path}` });
    }
    for (const path of files.keys()) {
      if (!heads.files.has(path)) violations.push({ invariant: "engine-convergence", detail: `${this.name} holds ${path}, which is not a live document` });
    }
    const cursor = await this.journal.getCursor();
    if (cursor !== heads.lastSeq) violations.push({ invariant: "engine-convergence", detail: `${this.name} cursor is ${String(cursor)}, the feed ends at ${String(heads.lastSeq)}` });
    for (const deferred of await this.journal.listDeferred()) {
      violations.push({ invariant: "engine-deferred", detail: `${this.name} deferred ${this.context.ids.label(deferred.revision.revisionId)} (${deferred.reason}) without local changes` });
    }
    for (const event of this.localChanges) {
      if (this.userEdited.has(event.path)) continue;
      violations.push({ invariant: "engine-echo", detail: `${this.name} reported its own ${event.type} of ${event.path} as a local change` });
    }
    for (const violation of violations) this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    return violations;
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vaultId: this.context.vaultId,
      deviceId: this.deviceId,
      api: this.api,
      vault: this.vault,
      journal: this.journal,
      onLocalChange: (event) => this.localChanges.push(event),
      onAcknowledged: (revision) => {
        this.context.acknowledged.push({
          client: this.index,
          revisionId: revision.revisionId,
          documentId: revision.documentId,
          seq: String(revision.seq),
          parentRevisionId: revision.parentRevisionId,
          path: revision.path,
          deleted: revision.deleted,
          blobId: revision.contentHash,
          size: String(revision.size),
        });
        this.context.log(`${this.name} acknowledged ${this.context.ids.label(revision.revisionId)} seq=${String(revision.seq)} base=${this.context.ids.label(revision.parentRevisionId)}`);
      },
      merge: (request) => (this.merge ?? threeWayMerge)(request),
      deviceName: this.name,
      now: () => simDate,
      // The simulation decides when the engine pushes.
      pushDebounceMs: null,
      newId: () => this.context.ids.generate(`${this.name}.x`),
      pageSize,
    });
  }

  private violation(invariant: string, detail: string): void {
    this.context.violations.push({ invariant, detail });
    this.context.log(`VIOLATION ${invariant}: ${detail}`);
  }
}

/** The server's live heads, read without faults straight from the change feed: the harness's own fold, independent of the engine. */
export async function serverHeads(api: ProtocolClient, vaultId: string): Promise<ServerHeads> {
  const heads = new Map<string, { path: string; hash: string; deleted: boolean }>();
  let lastSeq = 0n;
  for (;;) {
    const response = await api.sync.listChanges({ vaultId, sinceSeq: lastSeq, pageSize: 1000 });
    for (const revision of response.revisions) {
      heads.set(revision.documentId, {
        path: new TextDecoder().decode(revision.path),
        hash: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
        deleted: revision.deleted,
      });
      lastSeq = revision.seq;
    }
    if (!response.hasMore) break;
  }
  const files = new Map<string, string>();
  for (const head of heads.values()) if (!head.deleted) files.set(head.path, head.hash);
  return { files, lastSeq };
}
