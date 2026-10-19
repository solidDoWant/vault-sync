// An engine-backed client for the simulation: the real plugin/src/core
// SyncEngine over an in-memory vault and journal, talking to the real server
// through the simulated network and its faults. It pulls (#16) and pushes
// (#17), with several engines editing concurrently (#18). In seeded runs its
// user (EngineUser) makes random changes (#22); scripted scenarios make
// theirs. After the run its vault must equal the server's live heads, it must
// report none of its own writes as local changes (echo suppression), and it
// must have deferred nothing. Its vault and journal survive a
// crash (they are a device's disk), while the engine itself, and everything it
// had in flight, does not.
//
// Each engine follows a platform's path rules (posix, windows or macos), with
// an in-memory vault that refuses the names that platform cannot hold and,
// for windows and macos, matches paths ignoring case and Unicode form
// (SPEC.md §8). A live document may then be missing from its vault only if
// the engine reports it as unmaterializable and the harness's own check
// agrees that the platform cannot hold its path.

import { Code } from "@connectrpc/connect";

import { bytesToHex } from "@noble/hashes/utils.js";

import { SyncEngine, type PushSummary } from "../plugin/src/core/engine/engine";
import { threeWayMerge, type MergeHook } from "../plugin/src/core/engine/merge";
import { InterleavingVault } from "../plugin/src/core/engine/testing";
import { sha256Hex } from "../plugin/src/core/hash";
import type { ConflictRecord } from "../plugin/src/core/journal/journal";
import { InMemoryJournal } from "../plugin/src/core/journal/memory";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { DeletePrecondition, VaultEvent } from "../plugin/src/core/vault/adapter";
import { InMemoryVault } from "../plugin/src/core/vault/memory";
import type { PathPlatform } from "../plugin/src/core/vaultpath/platform";
import type { RunContext, Violation } from "./client";
import { EngineUser } from "./engine-user";
import { checkEngineEchoes, UserLedger } from "./invariants";
import { errorCode } from "./network";
import { Random } from "./random";
import type { EngineOperation } from "./schedule";

/** Revisions per ListChanges page; small, so pulls page. */
const pageSize = 7;
/** The engines' clock, fixed so conflict-copy names (and with them traces) replay identically. */
export const simDate = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

/** What a converged vault holds: path to content hash of every live document, and the last seq. */
export interface ServerHeads {
  files: Map<string, string>;
  lastSeq: bigint;
}

/**
 * The harness's own, deliberately simple, check of which paths Windows cannot
 * hold, independent of the engine's rules: Windows's forbidden characters,
 * trailing dots and spaces and reserved names, enough for the paths the sim uses. Other platforms can hold
 * all of them.
 */
export function harnessUnmaterializable(path: string, platform: PathPlatform): boolean {
  if (platform !== "windows") return false;
  return path.split("/").some((segment) => /[<>:"|?*]/.test(segment) || segment.endsWith(".") || segment.endsWith(" ") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(segment));
}

export class EngineObserver {
  private readonly vault: InMemoryVault;
  /** What the engine sees: the vault, with a scenario's saves landing just before an engine write (#163). */
  private readonly engineVault: MutableVault;
  private readonly journal = new InMemoryJournal();
  private engine: SyncEngine;
  private busy = false;
  private readonly localChanges: VaultEvent[] = [];
  /** Paths the scenario edited as the user: their events are expected local changes. */
  private readonly userEdited = new Set<string>();
  /** What the user did, for the lost-write and phantom-delete checks (sim/invariants.ts). */
  readonly ledger = new UserLedger();
  private readonly user: EngineUser;
  /** The last push that completed. */
  lastPush: PushSummary | undefined;
  /** The merge hook of the engine (and of the engines after a crash); the default is the engine's, threeWayMerge. */
  merge: MergeHook | undefined;

  constructor(
    /** The observer's index in the simulated network (after the scripted clients). */
    readonly index: number,
    private readonly api: ProtocolClient,
    readonly deviceId: string,
    private readonly context: RunContext,
    /** The platform whose path rules the engine and its vault follow. */
    readonly platform: PathPlatform = "posix",
  ) {
    this.vault = new InMemoryVault({ now: () => 0, pathRules: { platform } });
    this.engineVault = new MutableVault(this.vault);
    this.engine = this.createEngine();
    this.user = new EngineUser({
      name: this.name,
      vault: this.vault,
      journal: this.journal,
      ledger: this.ledger,
      now: () => `step ${String(context.stepNumber())}`,
      touched: (path) => this.userEdited.add(path),
      serverSeq: () => context.serverSeq(),
    });
  }

  /** The user changes the vault (seeded with `arg`), or the engine starts a push; returns the trace entry. Never waits for the engine. */
  async userOperation(operation: EngineOperation, arg: number): Promise<string> {
    return operation === "push" ? this.startPush() : this.user.perform(operation, new Random(arg));
  }

  get name(): string {
    return `e${String(this.index)}`;
  }

  /** The documents the engine reports as unmaterializable: server path to reason. */
  async unmaterializable(): Promise<Map<string, string>> {
    return new Map((await this.engine.unmaterializable()).map((document) => [document.path, document.reason]));
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
    const entry = await this.user.write(path, content);
    await this.engine.settled();
    return entry;
  }

  /**
   * Arms a save of `content` to `path` by the user that lands just before the
   * engine's next write or delete of `path`, after the engine checked the
   * disk: what Obsidian's autosave can do (#163).
   */
  saveBeforeNextEngineChange(path: string, content: Uint8Array): string {
    this.userEdited.add(path);
    this.engineVault.beforeNextChange(path, async () => {
      this.context.log(`${this.name} user saves ${path} (${String(content.length)} B) just before the engine changes it`);
      // As the user: the ledger records the save, which replaces what the user had written there.
      await this.user.write(path, content);
    });
    return `${this.name} user will save ${path} just before the engine's next change of it`;
  }

  /** Whether a save armed by saveBeforeNextEngineChange has not landed yet. */
  get savePending(): boolean {
    return this.engineVault.pending;
  }

  /** Renames `from` to `to` in the observer's vault as its user would. */
  async move(from: string, to: string): Promise<string> {
    const entry = await this.user.rename(from, to);
    await this.engine.settled();
    return entry;
  }

  /** Renames the folder `from` to `to` as its user would; reported as a rename of every file in it, as Obsidian reports it. */
  async moveFolder(from: string, to: string): Promise<string> {
    const moves: [string, string][] = [];
    for (const path of await this.vault.list()) {
      if (!path.startsWith(`${from}/`)) continue;
      const moved = `${to}/${path.slice(from.length + 1)}`;
      this.userEdited.add(path);
      this.userEdited.add(moved);
      moves.push([path, moved]);
    }
    await this.vault.renameFolder(from, to);
    const serverSeq = this.context.serverSeq();
    const at = `step ${String(this.context.stepNumber())}`;
    for (const [path, moved] of moves) this.ledger.changed({ paths: [path, moved], result: { path: moved, hash: sha256Hex(await this.vault.read(moved)) }, serverSeq, at });
    await this.engine.settled();
    return `${this.name} user renames folder ${from} to ${to}`;
  }

  /** Deletes `path` from the observer's vault as its user would. */
  async remove(path: string): Promise<string> {
    const entry = await this.user.remove(path);
    await this.engine.settled();
    return entry;
  }

  /**
   * Mutation for the harness's own tests (sim/invariants.sim.test.ts):
   * overwrites `path` behind the user's back, as an engine that loses a user
   * write would. The user never sees it, so it replaces nothing in the ledger.
   */
  async overwriteBehindUser(path: string, content: Uint8Array): Promise<string> {
    await this.vault.write(path, content);
    await this.engine.settled();
    return `${this.name} MUTATION: ${path} overwritten behind the user's back`;
  }

  /** Mutation for the harness's own tests: deletes `path` behind the user's back, as an engine that drops a file would. */
  async deleteBehindUser(path: string): Promise<string> {
    await this.vault.delete(path);
    await this.engine.settled();
    return `${this.name} MUTATION: ${path} deleted behind the user's back`;
  }

  /**
   * Mutation for the harness's own tests: the engine's next delete of `path`
   * leaves the file where it is, as an engine that skips applying a remote
   * tombstone to its disk would; the engine believes it deleted the file.
   */
  keepFileOnNextDelete(path: string): string {
    this.engineVault.keepOnNextDelete(path);
    return `${this.name} MUTATION: the engine's next delete of ${path} will leave the file`;
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
          this.lastPush = summary;
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
    const unmaterializable = await this.unmaterializable();
    // Where the engine keeps an unmaterializable document's edited file (SPEC.md §8): not a live path, and not to be removed.
    const kept = new Set((await this.engine.unmaterializable()).flatMap((document) => (document.localPath === undefined ? [] : [document.localPath])));
    for (const [path, hash] of heads.files) {
      const local = files.get(path);
      const expectedMissing = harnessUnmaterializable(path, this.platform);
      if (expectedMissing && !unmaterializable.has(path)) {
        violations.push({ invariant: "engine-unmaterializable", detail: `${this.name} (${this.platform}) does not report ${path}, which the platform cannot hold` });
      } else if (!expectedMissing && unmaterializable.has(path)) {
        violations.push({ invariant: "engine-unmaterializable", detail: `${this.name} (${this.platform}) reports ${path} as unmaterializable (${String(unmaterializable.get(path))})` });
      }
      if (expectedMissing) continue;
      if (local === undefined) violations.push({ invariant: "engine-convergence", detail: `${this.name} is missing ${path}` });
      else if (local !== hash) violations.push({ invariant: "engine-convergence", detail: `${this.name} holds other content at ${path}` });
    }
    for (const path of unmaterializable.keys()) {
      if (!heads.files.has(path)) violations.push({ invariant: "engine-unmaterializable", detail: `${this.name} reports ${path}, which is not a live document's path` });
    }
    for (const path of files.keys()) {
      if (!heads.files.has(path) && !kept.has(path)) violations.push({ invariant: "engine-convergence", detail: `${this.name} holds ${path}, which is not a live document` });
    }
    const cursor = await this.journal.getCursor();
    if (cursor !== heads.lastSeq) violations.push({ invariant: "engine-convergence", detail: `${this.name} cursor is ${String(cursor)}, the feed ends at ${String(heads.lastSeq)}` });
    for (const deferred of await this.journal.listDeferred()) {
      // Checked above: tracked exactly for the live documents the platform cannot hold.
      if (deferred.reason === "unmaterializable") continue;
      violations.push({ invariant: "engine-deferred", detail: `${this.name} deferred ${this.context.ids.label(deferred.revision.revisionId)} (${deferred.reason}) without local changes` });
    }
    violations.push(...checkEngineEchoes(this.name, this.localChanges, this.userEdited, this.platform));
    for (const violation of violations) this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    return violations;
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vaultId: this.context.vaultId,
      deviceId: this.deviceId,
      api: this.api,
      vault: this.engineVault,
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
      merge: async (request) => {
        const outcome = await (this.merge ?? threeWayMerge)(request);
        // What the merge path made of the local content: it survives there (sim/invariants.ts).
        if (outcome.status === "merged" && request.local.content !== null) {
          const local = sha256Hex(request.local.content);
          if (outcome.content !== null) this.ledger.merged(local, sha256Hex(outcome.content));
          if (outcome.conflict !== undefined) this.ledger.merged(local, sha256Hex(outcome.conflict.content));
        }
        return outcome;
      },
      deviceName: this.name,
      now: () => simDate,
      // The simulation decides when the engine pushes.
      pushDebounceMs: null,
      newId: () => this.context.ids.generate(`${this.name}.x`),
      pageSize,
      pathRules: { platform: this.platform },
      onUnmaterializable: (document) => {
        this.context.log(`${this.name} tracks ${document.path} as unmaterializable (${document.reason})`);
      },
    });
  }

  private violation(invariant: string, detail: string): void {
    this.context.violations.push({ invariant, detail });
    this.context.log(`VIOLATION ${invariant}: ${detail}`);
  }
}

/** The engine's view of the vault: an InterleavingVault whose deletes a mutation test can make no-ops. */
class MutableVault extends InterleavingVault {
  private readonly keep = new Set<string>();

  keepOnNextDelete(path: string): void {
    this.keep.add(path);
  }

  override async delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    if (this.keep.delete(path)) return;
    await super.delete(path, precondition);
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
