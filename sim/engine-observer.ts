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
// harness's inode tap (§5.4) records who made each change; the engine never
// sees that record. The engine-echo check uses it: an event the engine
// reports as a local change must be one that a change of the user's emitted.
//
// A scenario may turn on config folder sync (#28, SPEC.md §8): the engine then
// syncs a ConfigSyncVault over the vault and a config folder of its own, and
// live documents outside what its settings sync are expected to be missing,
// deferred as out-of-scope.

import { Code } from "@connectrpc/connect";

import { bytesToHex } from "@noble/hashes/utils.js";

import { configPrefix, ConfigSyncVault } from "../plugin/src/core/config/config-vault";
import type { ConfigSyncSettings } from "../plugin/src/core/config/policy";
import { EngineDisposedError, SyncEngine, type PullSummary, type PushSummary } from "../plugin/src/core/engine/engine";
import { RestoreError } from "../plugin/src/core/engine/history";
import { threeWayMerge, type MergeHook } from "../plugin/src/core/engine/merge";
import { InterleavingVault } from "../plugin/src/core/engine/testing";
import { sha256Hex } from "../plugin/src/core/hash";
import type { ConflictRecord, JournalChanges, PendingOperation } from "../plugin/src/core/journal/journal";
import { InMemoryJournal } from "../plugin/src/core/journal/memory";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { DeletePrecondition, VaultAdapter, VaultEvent, VaultListener, WritePrecondition } from "../plugin/src/core/vault/adapter";
import { InMemoryVault, type InodeEvent } from "../plugin/src/core/vault/memory";
import { filesystemKey, type PathPlatform } from "../plugin/src/core/vaultpath/platform";
import { pathKey } from "../plugin/src/core/pathkey/pathkey";
import type { RunContext, Violation } from "./client";
import { EngineUser } from "./engine-user";
import { carriesLocalEdit, checkEngineEchoes, KnownContents, UserLedger } from "./invariants";
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

/**
 * The harness's own check of `F`-aliases (design §3.1, decision #52): the
 * live paths in `live` other than `path` that the platform's filesystem
 * takes for one file with `path`, or for a folder of it, although the
 * server's path key keeps them apart (`ı.md` and `I.md` on Windows and
 * macOS). The device holds one of such a group; the others are
 * unmaterializable there (`alias`, X-15).
 */
export function harnessAliases(path: string, live: Iterable<string>, platform: PathPlatform): string[] {
  if (platform === "posix") return [];
  const file = (candidate: string) => pathKey(filesystemKey(candidate, platform));
  const collide = (key: (candidate: string) => string, a: string, b: string) => {
    const [left, right] = [key(a), key(b)];
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  };
  return [...live].filter((other) => other !== path && collide(file, other, path) && !collide(pathKey, other, path));
}

/**
 * The seq a schedule's pull step with `arg` gates the engines' pulls on, as a
 * realtime notification would (#277), when the server's head is `head`:
 * undefined for a plain pull, the head itself (a `vault_changed` for the
 * latest commit), or an earlier head (a stale or coalesced notification,
 * which the engine's cursor may already be past).
 */
export function notificationSeq(arg: number, head: bigint): bigint | undefined {
  switch (arg % 3) {
    case 0:
      return undefined;
    case 1:
      return head;
    default: {
      const back = BigInt(1 + (Math.floor(arg / 3) % 4));
      return head > back ? head - back : 0n;
    }
  }
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
  /**
   * The events the engine received while a change of the user's was emitted:
   * the only ones it may report as local changes (engine-echo). The vaults
   * emit synchronously within the change, after the inode tap, so each is
   * tied to the user operation it fired in, with no path matching.
   */
  private readonly userEvents = new WeakSet<VaultEvent>();
  /** The actor of the change the vaults are emitting, from their inode taps. */
  private emitting: InodeEvent["actor"] | undefined;
  /** What the user did, for the lost-write and phantom-delete checks (sim/invariants.ts). */
  readonly ledger: UserLedger;
  /** Every content the device's vaults held, whoever wrote it: a merge's base where the hook did not read it (#717). It survives crashes, as the disk does. */
  private readonly contents = new KnownContents();
  private readonly user: EngineUser;
  /** The last push that completed. */
  lastPush: PushSummary | undefined;
  /** The last pull that completed. */
  lastPull: PullSummary | undefined;
  /** Where each of the engine's pulls that resynced (PullSummary.resynced) completed, e.g. `step 120`. */
  readonly resyncs: string[] = [];
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
    this.vault.tapInodes((event) => {
      this.emitting = event.actor;
      this.record(this.vault, event);
      this.inodeEvents.push({ ...event, step: context.stepNumber() });
    });
    this.engineVault = new MutableVault(this.vault.handle("engine"), (from, to, rename) => this.user.engineRenamed(from, to, rename));
    this.config = new InMemoryVault({ now: () => 0, pathRules: { platform }, filesystem });
    this.config.tapInodes((event) => {
      this.emitting = event.actor;
      this.record(this.config, event);
    });
    this.synced = this.engineVault;
    this.engine = this.createEngine();
    this.ledger = new UserLedger(platform, filesystem);
    this.user = new EngineUser({
      name: this.name,
      vault: this.vault.handle("user"),
      journal: this.journal,
      ledger: this.ledger,
      now: () => `step ${String(context.stepNumber())}`,
      serverSeq: () => context.serverSeq(),
      pathPool: context.pathPool,
    });
  }

  /** Records in `contents` what a create or modify left in `vault`: the in-memory vault reads it synchronously, within the change. */
  private record(vault: InMemoryVault, event: InodeEvent): void {
    if (event.type !== "create" && event.type !== "modify") return;
    void vault.read(event.path).then(
      (content) => {
        this.contents.add(content);
      },
      () => undefined,
    );
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

  /**
   * Starts a pull unless one is running; returns the trace entry. With
   * `ifBehind`, the pull is the one a realtime notification announcing that
   * seq starts (SyncEngine.pullIfBehind): the engine skips it when its cursor
   * is already there.
   */
  startPull(ifBehind?: bigint): string {
    if (this.busy) return `${this.name} busy, pull skipped`;
    this.busy = true;
    const incarnation = this.context.network.incarnation(this.index);
    void (ifBehind === undefined ? this.engine.pull() : this.engine.pullIfBehind(ifBehind))
      .then(
        (summary) => {
          if (summary === undefined) {
            this.context.log(`${this.name} pull not needed: cursor at or past seq ${String(ifBehind)}`);
            return;
          }
          this.lastPull = summary;
          if (summary.resynced) this.resyncs.push(`step ${String(this.context.stepNumber())}`);
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
    return ifBehind === undefined ? `${this.name} starts pull` : `${this.name} starts pull if behind seq ${String(ifBehind)}`;
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
    // The engine changes the config folder through its own handle, so the tap tells its changes from Obsidian's.
    this.synced = new ConfigSyncVault({ notes: this.engineVault, config: this.config.handle("engine"), settings, ownFolders: ["plugins/vault-sync"] });
    this.engine = this.createEngine();
    return `${this.name} config sync ${settings.enabled ? `on (${Object.entries(settings.categories).filter(([, on]) => on).map(([category]) => category).join(", ")})` : "off"}, engine restarted`;
  }

  /** Writes `content` to the config folder (`relative` to it) as Obsidian would. */
  async editConfig(relative: string, content: Uint8Array): Promise<string> {
    await this.config.write(relative, content);
    this.recordConfigWrite(relative, content);
    await this.settled();
    return `${this.name} Obsidian writes config ${relative} (${String(content.length)} B)`;
  }

  /** Deletes `relative` from the config folder as Obsidian would. */
  async removeConfig(relative: string): Promise<string> {
    await this.recordConfigDelete(relative);
    await this.config.delete(relative);
    await this.settled();
    return `${this.name} Obsidian deletes config ${relative}`;
  }

  /** Records Obsidian's write of the config file at `relative` as a change on the device, for the resurrected-delete check: it may bring a deleted config document back. */
  private recordConfigWrite(relative: string, content: Uint8Array): void {
    const path = `${configPrefix}/${relative}`;
    this.ledger.changed({ paths: [path], result: { path, hash: sha256Hex(content) }, serverSeq: this.context.serverSeq(), at: `step ${String(this.context.stepNumber())}` });
  }

  /**
   * Records Obsidian's delete of the config file at `relative` as the user's
   * delete of the documents the engine knows there, synced or pending, for
   * the phantom-delete check: deleting a config file is a change on the
   * device, as a note's delete is.
   */
  private async recordConfigDelete(relative: string): Promise<void> {
    const path = `${configPrefix}/${relative}`;
    const synced = await this.journal.findDocumentByPath(path);
    if (synced !== undefined) this.ledger.deletedDocuments.add(synced.documentId);
    for (const operation of await this.journal.listPending()) if (operation.path === path) this.ledger.deletedDocuments.add(operation.documentId);
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

  /**
   * Mutation for the harness's own tests: from now on the anchor the engine
   * stores with its cursor is corrupted, as an anchor mangled between the
   * server and the journal would be, so its next pull finds the history
   * diverged and resyncs although the server was never restored (#422).
   */
  mangleCursorAnchors(): string {
    this.journal.mangleAnchors = true;
    return `${this.name} MUTATION: cursor anchors are corrupted from now on`;
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
   * The user restores a version of the document at `path` from its history
   * (SPEC.md §11), as the history view does: a deleted document (the newest
   * the engine deleted there) or, failing that, the live document there.
   * The version is the newest live revision before the head (the content a
   * deleted document last held, or a live document's previous version), or
   * the one `back` live revisions older still. With `at`, the document comes
   * back at that path instead of its own (#420). Unless the engine is busy,
   * it starts the restore (a push, the commit and a pull, through the
   * network) and returns the trace entry; drain the network to finish it. A
   * restore the engine refuses (RestoreError, say `path-taken`) commits
   * nothing and is logged; the user sees the message.
   *
   * Once committed, the ledger records the restore as the user's change at
   * the document's paths and the target, with the restored content (the
   * resurrected-delete check), and the content as the user's write (lost-write).
   * The paths do not count as the user's for the echo check: the engine
   * writes the restored file itself and must not report it as a local change.
   */
  startRestore(path: string, options: { at?: string; back?: number } = {}): string {
    if (this.busy) return `${this.name} busy, restore of ${path} skipped`;
    this.busy = true;
    const incarnation = this.context.network.incarnation(this.index);
    const engine = this.engine;
    const what = `${path}${options.back === undefined ? "" : ` (${String(options.back)} back)`}${options.at === undefined ? "" : ` at ${options.at}`}`;
    const restore = async (): Promise<string> => {
      const deleted = (await engine.deletedDocuments()).find((state) => state.path === path);
      const document = deleted ?? (await this.journal.findDocumentByPath(path));
      if (document === undefined) return `${this.name} user restore of ${path}: no document there`;
      const page = await engine.history(document.documentId);
      const entry = page.entries.filter((candidate) => !candidate.deleted && candidate.revisionId !== page.headRevisionId)[options.back ?? 0];
      if (entry === undefined) return `${this.name} user restore of ${path}: no such version in its history`;
      const serverSeq = this.context.serverSeq();
      const at = `step ${String(this.context.stepNumber())}`;
      const restored = await engine.restore(entry, undefined, options.at);
      const target = options.at ?? restored.path;
      this.ledger.write({ hash: entry.contentHash, path: target, at });
      this.ledger.changed({ paths: [...new Set([path, entry.path, target])], result: { path: target, hash: entry.contentHash }, serverSeq, at });
      return `${this.name} user restored ${this.context.ids.label(document.documentId)} ${path} to ${this.context.ids.label(entry.revisionId)} (seq ${String(entry.seq)}, ${entry.contentHash.slice(0, 8)}) at ${target}, seq ${String(restored.seq)}`;
    };
    void restore()
      .then(
        (entry) => {
          this.context.log(entry);
        },
        (error: unknown) => {
          if (error instanceof RestoreError) {
            this.context.log(`${this.name} user restore of ${what} refused: ${error.reason} ${error.path}`);
          } else if (interrupted(error)) {
            this.context.log(`${this.name} engine restore interrupted: ${interruption(error)}`);
          } else {
            this.violation("engine", `${this.name} restore of ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      )
      .finally(() => {
        if (this.context.network.incarnation(this.index) === incarnation) this.busy = false;
      });
    return `${this.name} user starts restore of ${what}`;
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
   * Kills the app just before the journal next removes a deferred revision,
   * or finishes an apply or merge intent, which removes the document's
   * deferral with its rebase (#453; design §4.4). crash() then
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

  /**
   * The app is killed, its user renames or deletes files while it is not
   * running (`changes`, with no engine watching, so no event reaches it),
   * and it starts again over the same vault and journal: a change the
   * engine never recorded, which only the start-up scan sees. Logged as a
   * crash after the changes, as for one the app was killed before it
   * recorded.
   */
  async crashWhileChanging(changes: (user: { move: (from: string, to: string) => Promise<string>; remove: (path: string) => Promise<string> }) => Promise<string[]>): Promise<string[]> {
    this.engine.dispose();
    const entries = await changes({ move: (from, to) => this.user.rename(from, to), remove: (path) => this.user.remove(path) });
    return [...entries, this.crash()];
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
      // Of live documents one file here under two path keys, the device holds
      // the one that arrived first; the others are unmaterializable (alias).
      const aliases = harnessAliases(path, heads.files.keys(), this.platform);
      if (aliases.length > 0 && local !== hash && !aliases.some((alias) => files.get(alias) === heads.files.get(alias))) {
        violations.push({ invariant: "engine-convergence", detail: `${this.name} holds none of the live documents ${[path, ...aliases].join(", ")}, which are one file here` });
      }
      const expectedMissing = harnessUnmaterializable(path, this.platform) || (aliases.length > 0 && local !== hash);
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
    violations.push(...checkEngineEchoes(this.name, this.localChanges, this.userEvents));
    for (const violation of violations) this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    return violations;
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vaultId: this.context.vaultId,
      deviceId: this.deviceId,
      api: this.api,
      vault: new AttributedVault(this.synced, (event) => {
        if (this.emitting === "user") this.userEvents.add(event);
      }),
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
        // The base and the remote content as the hook read them, if it did: the harness never reads them again, which would add calls to the run.
        const read: { base?: Uint8Array | null; remote?: Uint8Array | null } = {};
        const outcome = await (this.merge ?? threeWayMerge)({
          ...request,
          readBaseContent: async () => (read.base = await request.readBaseContent()),
          readRemoteContent: async () => (read.remote = await request.readRemoteContent()),
        });
        // What the merge path made of the local content: it survives there
        // (sim/invariants.ts), but only where the harness's own check finds the
        // edit (#301), not because the hook says so. A conflict copy is the
        // local content itself, which then survives by being found.
        if (outcome.status === "merged" && request.local.content !== null && outcome.content !== null) {
          const [local, merged] = [sha256Hex(request.local.content), sha256Hex(outcome.content)];
          // Where the hook did not read the base (or the server purged it), the device's vaults held it (KnownContents).
          const base = request.base === undefined || request.base.deleted ? null : (read.base ?? this.contents.get(request.base.baseHash));
          const remote = read.remote !== undefined ? read.remote : request.remote.deleted ? null : this.contents.get(request.remote.contentHash);
          const carries = carriesLocalEdit(request.local.content, outcome.content, base, remote);
          if (carries) this.ledger.merged(local, merged);
          this.context.log(`${this.name} merge at ${outcome.path}: local ${local.slice(0, 8)} into ${merged.slice(0, 8)}${outcome.conflict === undefined ? "" : `, conflict copy ${sha256Hex(outcome.conflict.content).slice(0, 8)}`}${carries ? "" : ", which does not carry the local edit"}`);
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

  /** Mutation (mangleCursorAnchors): every anchor stored with the cursor is corrupted. */
  mangleAnchors = false;

  override setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return super.setCursor(seq, this.mangled(anchor));
  }

  override resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return super.resetCursor(seq, this.mangled(anchor));
  }

  private mangled(anchor: Uint8Array | undefined): Uint8Array | undefined {
    if (!this.mangleAnchors || anchor === undefined || anchor.length === 0) return anchor;
    const copy = anchor.slice();
    copy[0] = (copy[0] ?? 0) ^ 0xff;
    return copy;
  }

  override async removeDeferred(documentId: string): Promise<void> {
    await this.haltBeforeDeferralRemoval([documentId]);
    await super.removeDeferred(documentId);
  }

  override async transact(changes: JournalChanges): Promise<void> {
    if (changes.cursor !== undefined) changes = { ...changes, cursor: { ...changes.cursor, anchor: this.mangled(changes.cursor.anchor) } };
    await this.haltBeforeDeferralRemoval(changes.removeDeferred ?? [], (changes.removeIntents ?? []).length > 0);
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

  private async haltBeforeDeferralRemoval(documentIds: readonly string[], finishesIntent = false): Promise<void> {
    if (!this.haltOnDeferralRemoval) return;
    for (const documentId of documentIds) {
      // Since R8 a merge's rebase and its deferral's removal are one
      // transaction, the intent's final one, also when no deferral was recorded.
      if (finishesIntent || (await this.getDeferred(documentId)) !== undefined) {
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

/**
 * The engine's vault, passing every event it receives to `received` first,
 * synchronously, while the change that emitted it is still being applied.
 */
class AttributedVault implements VaultAdapter {
  constructor(
    private readonly inner: VaultAdapter,
    private readonly received: (event: VaultEvent) => void,
  ) {}

  list(): Promise<string[]> {
    return this.inner.list();
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    return this.inner.write(path, data, precondition);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    return this.inner.delete(path, precondition);
  }
  stat(path: string): ReturnType<VaultAdapter["stat"]> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    return this.inner.watch((event) => {
      this.received(event);
      listener(event);
    });
  }
  isSynced(path: string): boolean {
    return this.inner.isSynced?.(path) ?? true;
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
