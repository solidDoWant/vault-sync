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
// (SPEC.md §8): by default by the engine's file key, or, with the faithful
// filesystem (SIM_FAITHFUL_FS=1), as NTFS and APFS match them
// (docs/design/engine-path-ownership.md §3.1). A live document may then be
// missing from its vault only if the engine reports it as unmaterializable
// and the harness's own check agrees that the platform cannot hold its path.
//
// The user and the engine change the vault through their own handles, so the
// harness's inode tap (§5.4) records who made each change; nothing checks
// that record yet, and the engine never sees it.
//
// A scenario may turn on config folder sync (#28, SPEC.md §8): the engine then
// syncs a ConfigSyncVault over the vault and a config folder of its own, and
// live documents outside what its settings sync are expected to be missing,
// deferred as out-of-scope.

import { Code } from "@connectrpc/connect";

import { bytesToHex } from "@noble/hashes/utils.js";

import { ConfigSyncVault } from "../plugin/src/core/config/config-vault";
import type { ConfigSyncSettings } from "../plugin/src/core/config/policy";
import { EngineDisposedError, SyncEngine, type PullSummary, type PushSummary } from "../plugin/src/core/engine/engine";
import { threeWayMerge, type MergeHook } from "../plugin/src/core/engine/merge";
import { InterleavingVault } from "../plugin/src/core/engine/testing";
import { sha256Hex } from "../plugin/src/core/hash";
import type { ConflictRecord, JournalChanges, PendingOperation } from "../plugin/src/core/journal/journal";
import { InMemoryJournal } from "../plugin/src/core/journal/memory";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { DeletePrecondition, VaultAdapter, VaultEvent } from "../plugin/src/core/vault/adapter";
import { InMemoryVault, type InodeEvent } from "../plugin/src/core/vault/memory";
import type { PathPlatform } from "../plugin/src/core/vaultpath/platform";
import type { RunContext, Violation } from "./client";
import { EngineUser } from "./engine-user";
import { checkEngineEchoes, UserLedger } from "./invariants";
import { errorCode, settle, StallError } from "./network";
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
  /** The config folder, with paths relative to it; synced only after setConfigSync. */
  private readonly config: InMemoryVault;
  /** What the engine syncs: the vault, or after setConfigSync the vault plus the config folder. */
  private synced: VaultAdapter;
  private readonly journal = new HaltingJournal();
  private engine: SyncEngine;
  private busy = false;
  private readonly localChanges: VaultEvent[] = [];
  /** Paths the scenario edited as the user: their events are expected local changes. */
  private readonly userEdited = new Set<string>();
  /** What the user did, for the lost-write and phantom-delete checks (sim/invariants.ts). */
  readonly ledger: UserLedger;
  private readonly user: EngineUser;
  /** The last push that completed. */
  lastPush: PushSummary | undefined;
  /** The last pull that completed. */
  lastPull: PullSummary | undefined;
  /** The merge hook of the engine (and of the engines after a crash); the default is the engine's, threeWayMerge. */
  merge: MergeHook | undefined;
  /** The jitter of the engines' backoff, the same in every replay. */
  private readonly backoffJitter: Random;

  constructor(
    /** The observer's index in the simulated network (after the scripted clients). */
    readonly index: number,
    private readonly api: ProtocolClient,
    readonly deviceId: string,
    private readonly context: RunContext,
    /** The platform whose path rules the engine and its vault follow. */
    readonly platform: PathPlatform = "posix",
    /** Which spellings the vault takes for one file (InMemoryVaultOptions.filesystem). */
    filesystem: "folded" | "faithful" = "folded",
  ) {
    this.backoffJitter = Random.derive(index, "backoff");
    this.vault = new InMemoryVault({ now: () => 0, pathRules: { platform }, filesystem });
    this.vault.tapInodes((event) => this.inodeEvents.push({ ...event, step: context.stepNumber() }));
    this.engineVault = new MutableVault(this.vault.handle("engine"), (from, to, rename) => this.user.engineRenamed(from, to, rename));
    this.config = new InMemoryVault({ now: () => 0, pathRules: { platform }, filesystem });
    this.synced = this.engineVault;
    this.engine = this.createEngine();
    this.ledger = new UserLedger(platform);
    this.user = new EngineUser({
      name: this.name,
      vault: this.vault.handle("user"),
      journal: this.journal,
      ledger: this.ledger,
      now: () => `step ${String(context.stepNumber())}`,
      touched: (path) => this.userEdited.add(path),
      serverSeq: () => context.serverSeq(),
      pathPool: context.pathPool,
    });
  }

  /**
   * Every change to the vault, with its harness inode, who made it (the
   * user, or the engine through its own handle) and the step
   * (docs/design/engine-path-ownership.md §5.4). The harness's record, which
   * the engine never sees; it survives crashes, as the disk does.
   */
  readonly inodeEvents: (InodeEvent & { step: number })[] = [];

  /** The harness inode of the file at `path` in the vault, or undefined. */
  inodeOf(path: string): number | undefined {
    return this.vault.inodeOf(path);
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
          this.lastPull = summary;
          this.context.log(`${this.name} pulled up to seq ${String(summary.cursor)}: ${String(summary.applied)} applied, ${String(summary.deferred)} deferred${summary.resynced ? ", resynced" : ""}`);
        },
        (error: unknown) => {
          if (interrupted(error)) {
            this.context.log(`${this.name} engine pull interrupted: ${interruption(error)}`);
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

  /**
   * Writes `content` to the observer's vault as its user would; the engine
   * pushes it on the next push. Waits for the engine's work to finish,
   * unless `whileBusy` (a change made while the engine waits on the
   * network): then only until the engine has seen the change.
   */
  async edit(path: string, content: Uint8Array, options: { whileBusy?: boolean } = {}): Promise<string> {
    const entry = await this.user.write(path, content);
    await this.afterChange(options);
    return entry;
  }

  private async afterChange(options: { whileBusy?: boolean }): Promise<void> {
    if (options.whileBusy === true) await settle();
    else await this.settled();
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

  /**
   * Makes the engine's next write, delete or rename of `path` never finish, as
   * a disk that stops answering would. Engine work the harness waits for after
   * that never finishes either, with nothing on the network: a stall (#310).
   */
  hangBeforeNextEngineChange(path: string): string {
    this.engineVault.beforeNextChange(path, () => new Promise<void>(() => undefined));
    return `${this.name}'s next change of ${path} will never finish`;
  }

  /** Whether a save armed by saveBeforeNextEngineChange has not landed yet. */
  get savePending(): boolean {
    return this.engineVault.pending;
  }

  /** Renames `from` to `to` in the observer's vault as its user would; `whileBusy` as for edit. */
  async move(from: string, to: string, options: { whileBusy?: boolean } = {}): Promise<string> {
    const entry = await this.user.rename(from, to);
    await this.afterChange(options);
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
    await this.settled();
    return `${this.name} user renames folder ${from} to ${to}`;
  }

  /** Deletes `path` from the observer's vault as its user would. */
  async remove(path: string): Promise<string> {
    const entry = await this.user.remove(path);
    await this.settled();
    return entry;
  }

  /**
   * Mutation for the harness's own tests (sim/invariants.sim.test.ts):
   * overwrites `path` behind the user's back, as an engine that loses a user
   * write would. The user never sees it, so it replaces nothing in the ledger.
   */
  async overwriteBehindUser(path: string, content: Uint8Array): Promise<string> {
    await this.vault.handle("engine").write(path, content);
    await this.settled();
    return `${this.name} MUTATION: ${path} overwritten behind the user's back`;
  }

  /** Mutation for the harness's own tests: deletes `path` behind the user's back, as an engine that drops a file would. */
  async deleteBehindUser(path: string): Promise<string> {
    await this.vault.handle("engine").delete(path);
    await this.settled();
    return `${this.name} MUTATION: ${path} deleted behind the user's back`;
  }

  /**
   * Waits until the engine has handled every vault event and finished its
   * pull or push. Nothing delivers messages meanwhile, so an engine still
   * waiting on the network never gets there: that throws a StallError naming
   * the step and the end of the trace, instead of hanging the run (#302).
   */
  private async settled(): Promise<void> {
    const stallTraceLines = 80;
    try {
      await this.context.network.untilSettled(this.engine.settled(), () => `run stalled at step ${String(this.context.stepNumber())}: ${this.name}'s engine work never finished, and nothing delivers its calls while the harness waits for it`);
    } catch (error) {
      if (!(error instanceof StallError)) throw error;
      this.context.log(`STALLED: ${error.message}`);
      throw new StallError(`${error.message}\nTrace (last lines):\n${this.context.trace.slice(-stallTraceLines).join("\n")}`);
    }
  }

  /**
   * Changes the config sync settings and restarts the engine over the same
   * vault and journal, as the plugin restarts its session; call while idle.
   */
  async setConfigSync(settings: ConfigSyncSettings): Promise<string> {
    await this.settled();
    this.engine.dispose();
    this.synced = new ConfigSyncVault({ notes: this.engineVault, config: this.config, settings, ownFolders: ["plugins/vault-sync"] });
    this.engine = this.createEngine();
    return `${this.name} config sync ${settings.enabled ? `on (${Object.entries(settings.categories).filter(([, on]) => on).map(([category]) => category).join(", ")})` : "off"}, engine restarted`;
  }

  /** Writes `content` to the config folder (`relative` to it) as Obsidian would. */
  async editConfig(relative: string, content: Uint8Array): Promise<string> {
    this.userEdited.add(`.obsidian/${relative}`);
    await this.config.write(relative, content);
    await this.settled();
    return `${this.name} Obsidian writes config ${relative} (${String(content.length)} B)`;
  }

  /** Deletes `relative` from the config folder as Obsidian would. */
  async removeConfig(relative: string): Promise<string> {
    this.userEdited.add(`.obsidian/${relative}`);
    await this.config.delete(relative);
    await this.settled();
    return `${this.name} Obsidian deletes config ${relative}`;
  }

  /** The config folder's files, sorted (whether or not they sync). */
  async configFiles(): Promise<string[]> {
    return (await this.config.list()).sort();
  }

  /** The config folder's content at `relative`, or undefined. */
  async readConfig(relative: string): Promise<Uint8Array | undefined> {
    return (await this.config.stat(relative)) === null ? undefined : this.config.read(relative);
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
          if (interrupted(error)) {
            this.context.log(`${this.name} engine push interrupted: ${interruption(error)}`);
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

  /**
   * Kills the app at the next pending operation the journal records that
   * `matches`: just `before` the write or just `after` it. The engine's work
   * stops there (reported as interrupted); crash() then restarts it.
   */
  haltOnPending(when: "before" | "after", matches: (operation: PendingOperation) => boolean): void {
    this.journal.halt = { when, matches };
  }

  /**
   * Kills the app just before the journal next removes a deferred revision:
   * after a merge has rebased the document onto it, say (#453). crash() then
   * restarts it. Returns a check of whether the kill happened.
   */
  haltOnDeferralRemoval(): () => boolean {
    this.journal.haltOnDeferralRemoval = true;
    return () => !this.journal.haltOnDeferralRemoval;
  }

  /** The app is killed: the engine and its in-flight calls are gone; the vault and journal remain. */
  crash(): string {
    this.context.network.crash(this.index);
    this.ledger.crashed(this.context.serverSeq());
    this.engine.dispose();
    this.engine = this.createEngine();
    this.busy = false;
    return `${this.name} crashed and restarted with its vault and journal`;
  }

  /** The engine-level invariants, checked once the run has quiesced. */
  async check(heads: ServerHeads): Promise<Violation[]> {
    await this.settled();
    const violations: Violation[] = [];
    const files = new Map<string, string>();
    for (const path of await this.synced.list()) files.set(path, sha256Hex(await this.synced.read(path)));
    const unmaterializable = await this.unmaterializable();
    const outOfScope = new Set<string>();
    // Where the engine keeps an unmaterializable document's edited file (SPEC.md §8): not a live path, and not to be removed.
    const kept = new Set((await this.engine.unmaterializable()).flatMap((document) => (document.localPath === undefined ? [] : [document.localPath])));
    for (const [path, hash] of heads.files) {
      // Not this device's to sync (config sync off, or its category): deferred, never written.
      if (this.synced.isSynced?.(path) === false) {
        outOfScope.add(path);
        continue;
      }
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
      // Waiting for config sync to cover it again: fine for a live document out of scope, and for a tombstone.
      if (deferred.reason === "out-of-scope" && (outOfScope.has(deferred.revision.path) || deferred.revision.deleted)) continue;
      violations.push({ invariant: "engine-deferred", detail: `${this.name} deferred ${this.context.ids.label(deferred.revision.revisionId)} (${deferred.reason}) without local changes` });
    }
    violations.push(...checkEngineEchoes(this.name, this.localChanges, this.userEdited, this.platform));
    for (const violation of violations) this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    await this.shadowCheck();
    return violations;
  }

  /**
   * The `binding-shadow` differential check of refactor step R4
   * (docs/design/engine-path-ownership.md §9.2): where the engine's
   * bindings disagree with the ownership it derives. Report only, never a
   * violation: each line is triaged as an old-code bug or a model bug.
   */
  private async shadowCheck(): Promise<void> {
    for (const divergence of await this.engine.bindingShadow()) {
      const binding = divergence.binding === undefined ? "no recorded binding" : divergence.binding === null ? `no file (${String(divergence.absence)})` : divergence.binding;
      this.context.log(`SHADOW binding-shadow: ${this.name} (${this.platform}) ${this.context.ids.label(divergence.documentId)} bound to ${binding}, derived ${divergence.derived ?? "no file"}`);
    }
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vaultId: this.context.vaultId,
      deviceId: this.deviceId,
      api: this.api,
      vault: this.synced,
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
      // The RESOURCE_EXHAUSTED backoff (#146) runs on the network's step clock, with a jitter that replays.
      timers: this.context.network.timers(this.index),
      random: this.backoffJitter.float.bind(this.backoffJitter),
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

/** Thrown where haltOnPending kills the app. */
class AppKilled extends Error {
  override readonly name = "AppKilled";
}

/**
 * The device's journal: an InMemoryJournal that can kill the app at one
 * chosen recording of a pending operation (haltOnPending), or at the next
 * removal of a deferral (haltOnDeferralRemoval), whether the engine makes it
 * on its own (addPending, removeDeferred) or within a `transact`, which then
 * either commits whole before the kill ("after") or not at all ("before").
 */
class HaltingJournal extends InMemoryJournal {
  halt: { when: "before" | "after"; matches: (operation: PendingOperation) => boolean } | undefined;

  override async addPending(operation: PendingOperation): Promise<void> {
    const halt = this.takePendingHalt([operation]);
    if (halt?.when === "before") throw new AppKilled(`app killed before recording ${halt.path}`);
    await super.addPending(operation);
    if (halt?.when === "after") throw new AppKilled(`app killed after recording ${halt.path}`);
  }

  /** Set by haltOnDeferralRemoval; cleared when it kills the app. */
  haltOnDeferralRemoval = false;

  override async removeDeferred(documentId: string): Promise<void> {
    await this.haltBeforeDeferralRemoval([documentId]);
    await super.removeDeferred(documentId);
  }

  override async transact(changes: JournalChanges): Promise<void> {
    await this.haltBeforeDeferralRemoval(changes.removeDeferred ?? []);
    const halt = this.takePendingHalt(changes.addPending ?? []);
    if (halt?.when === "before") throw new AppKilled(`app killed before recording ${halt.path}`);
    await super.transact(changes);
    if (halt?.when === "after") throw new AppKilled(`app killed after recording ${halt.path}`);
  }

  /** The armed pending halt, disarmed, if one of `operations` matches it. */
  private takePendingHalt(operations: readonly PendingOperation[]): { when: "before" | "after"; path: string } | undefined {
    const halt = this.halt;
    const operation = halt === undefined ? undefined : operations.find((candidate) => halt.matches(candidate));
    if (halt === undefined || operation === undefined) return undefined;
    this.halt = undefined;
    return { when: halt.when, path: operation.path };
  }

  private async haltBeforeDeferralRemoval(documentIds: readonly string[]): Promise<void> {
    if (!this.haltOnDeferralRemoval) return;
    for (const documentId of documentIds) {
      if ((await this.getDeferred(documentId)) !== undefined) {
        this.haltOnDeferralRemoval = false;
        throw new AppKilled("app killed before removing a deferred revision");
      }
    }
  }
}

/** The engine's view of the vault: an InterleavingVault whose deletes a mutation test can make no-ops, and whose renames the user's ledger follows (#509). */
class MutableVault extends InterleavingVault {
  private readonly keep = new Set<string>();

  constructor(
    inner: VaultAdapter,
    private readonly renamed: (from: string, to: string, rename: () => Promise<void>) => Promise<void>,
  ) {
    super(inner);
  }

  override rename(from: string, to: string): Promise<void> {
    return this.renamed(from, to, () => super.rename(from, to));
  }

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

/**
 * A pull or push failure the engine expects and recovers from by itself: a
 * call lost on the network, one the server's per-user limit refused (the
 * engine backs off, #146), or a wait for that backoff cut short by a crash.
 */
function interrupted(error: unknown): boolean {
  return error instanceof EngineDisposedError || error instanceof AppKilled || errorCode(error) === Code.Unavailable || errorCode(error) === Code.ResourceExhausted;
}

function interruption(error: unknown): string {
  if (error instanceof AppKilled) return error.message;
  return error instanceof EngineDisposedError ? "engine disposed" : Code[errorCode(error)];
}
