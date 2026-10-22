// Runs one simulation: a fresh vault on the real server, scripted clients
// behind the simulated network, a schedule of steps, then quiescence and the
// invariant checks (SPEC.md §13).

import { Code, ConnectError, type Transport } from "@connectrpc/connect";

import { bytesToHex } from "@noble/hashes/utils.js";

import { downloadContent } from "../plugin/src/core/engine/remote";
import { sha256Hex } from "../plugin/src/core/hash";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "../plugin/src/core/protocol/client";
import type { PathPlatform } from "../plugin/src/core/vaultpath/platform";
import { VaultEncryption } from "../plugin/src/gen/vaultsync/v1/types_pb";
import { faithfulPathPool, pathPool, ScriptedClient, type Acknowledgement, type RunContext, type Violation } from "./client";
import { Control } from "./control";
import { EngineObserver, notificationSeq, serverHeads } from "./engine-observer";
import { Members } from "./members";
import { Ids } from "./ids";
import { checkLostWrites, checkPhantomDeletes, checkResurrections, serverFeed, type FeedRevision } from "./invariants";
import { settle, SimNetwork, StallError, type Outcome } from "./network";
import { generateSchedule, type Step } from "./schedule";

/** Where the server and the driver's control endpoint are. */
export interface SimEndpoints {
  serverUrl: string;
  /**
   * Another replica of the same server (same database and bucket) whose
   * per-vault upload session limit is limitedMaxUploadsPerVault (#490).
   */
  limitedServerUrl: string;
  controlUrl: string;
}

/** The limited replica's VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT (sim/simulation_test.go). */
export const limitedMaxUploadsPerVault = 2;

export interface RunOptions {
  /** Names the vault; also recorded with regression cases. */
  seed: number;
  clients: number;
  /**
   * Engine-driven clients (EngineObserver), after the scripted ones; 1 by
   * default. Seeded schedules use one; scripted scenarios may add more, to
   * make real engines edit concurrently.
   */
  engines?: number;
  /**
   * Each engine's platform path rules (SPEC.md §8). By default every engine
   * gets `platformForSeed(seed)`, so seeded runs cover all three platforms.
   */
  platforms?: PathPlatform[];
  /**
   * Steps a commit retried with the same revision id waits on the network
   * (NetworkOptions.commitRetryBackoff). Seeded schedules use
   * seededCommitRetryBackoff; scripted scenarios, and regression cases
   * recorded before #110, retry at once (0, the default).
   */
  commitRetryBackoff?: number;
  /**
   * Whether a seeded schedule runs the retention job between steps
   * (ScheduleOptions.retention, #229). Only runSeed reads it: a recorded
   * schedule carries its retention steps.
   */
  retention?: boolean;
  /**
   * Whether the clients and users choose from faithfulPathPool rather than
   * pathPool (refactor step R2 of docs/design/engine-path-ownership.md). The
   * engines' vaults always take two spellings for one file as the
   * platform's filesystem does (`F`); the folded vault this once also chose
   * is gone (#797). The seeded suites set it unless SIM_FAITHFUL_FS=0 (the
   * default since step R7); scripted scenarios and regression cases
   * recorded without it leave it unset. It changes which paths a schedule's
   * steps pick, so a run replays only with the same setting.
   */
  faithfulFilesystem?: boolean;
  /**
   * Whether the engines' pulls on a schedule's pull step are sometimes gated
   * on a seq the server announced, as the realtime session's are (#277,
   * EngineObserver.startPull): the step's `arg` chooses a plain pull, a pull
   * if behind the head, or one if behind an earlier head. Seeded suites turn
   * it on; scripted scenarios and regression cases recorded before #277 pull
   * plainly, so they replay unchanged.
   */
  notificationPulls?: boolean;
  /**
   * Users of the vault (#35); 1 by default. User 0 creates and owns the
   * vault and every engine; every other user joins as an editor through an
   * invitation, and scripted client i belongs to user i % users. Membership
   * steps change the other users' roles (Members); with one user they do
   * nothing.
   */
  users?: number;
  /**
   * Whether a seeded schedule changes members' roles between steps
   * (ScheduleOptions.membership, #35). Only runSeed reads it: a recorded
   * schedule carries its membership steps.
   */
  membership?: boolean;
}

/**
 * The commit retry backoff of seeded schedules (#110): long enough that
 * another client's commit often moves the head before a retry lands, the
 * interleaving of #12, which a retry delivered at once almost never meets.
 */
export const seededCommitRetryBackoff = 30;

/** The engines' platforms in a seeded run with `engines` engines: engine i follows `platformForSeed(seed + i)`, so most seeds mix platforms. */
export function seededPlatforms(seed: number, engines: number): PathPlatform[] {
  return Array.from({ length: engines }, (_, engine) => platformForSeed(seed + engine));
}

const platforms: readonly PathPlatform[] = ["posix", "windows", "macos"];

/** The platform the engines of a seeded run follow: seeds rotate through POSIX, Windows and macOS rules. */
export function platformForSeed(seed: number): PathPlatform {
  return platforms[seed % platforms.length] ?? "posix";
}

export interface RunResult {
  vaultId: string;
  /** What happened, step by step, with symbolic ids: identical whenever the same steps are replayed. */
  trace: string[];
  acknowledged: Acknowledgement[];
  violations: Violation[];
  /** Labels of the revisions retention purged during the run. */
  purged: string[];
  /** The role changes membership steps made (#35), by kind. */
  membershipChanges: Members["changes"];
}

/** Bound on deliveries while draining, far above what any schedule needs. */
const maxDrainDeliveries = 100_000;
/** Bound on the rounds of pushes after the schedule; each round lets every engine push what the previous ones merged. */
const maxPushRounds = 8;

export class SimRun {
  private stepNumber = 0;
  /** The revisions retention purged during the run (SimRun.purge), by id. */
  readonly purged = new Map<string, FeedRevision>();
  /** Whether the run had retention purge (SimRun.purge) or restored a backup (SimRun.restore). */
  private purgedOrRestored = { purged: false, restored: false };

  private constructor(
    readonly context: RunContext,
    readonly clients: ScriptedClient[],
    /** The real engines, behind the same faulty network. */
    readonly observers: EngineObserver[],
    private readonly control: Control,
    /** Fault-free access for the harness's own checks. */
    readonly direct: ProtocolClient,
    readonly trace: string[],
    private readonly purges: { seqs: Set<bigint>; revisions: Set<string> },
    /** RunOptions.notificationPulls. */
    private readonly notificationPulls: boolean,
    /** The vault's users and their roles (RunOptions.users). */
    readonly members: Members,
  ) {}

  /** Creates a vault for a new user and registers one device per client. */
  static async start(endpoints: SimEndpoints, options: RunOptions): Promise<SimRun> {
    const control = new Control(endpoints.controlUrl);
    const users = options.users ?? 1;
    if (!Number.isInteger(users) || users < 1) throw new RangeError("users must be a positive integer");
    const tokens: string[] = [];
    for (let user = 0; user < users; user++) tokens.push(await control.token());
    const [token = ""] = tokens;
    const http = createHttpTransport(endpoints.serverUrl);
    const setup = createProtocolClient({ transport: http, token: () => token });
    const vault = (await setup.vaults.createVault({ name: `sim seed ${String(options.seed)}`, encryption: VaultEncryption.NONE })).vault;
    if (vault === undefined) throw new Error("CreateVault returned no vault");

    const ids = new Ids();
    const trace: string[] = [];
    let serverSeq = 0n;
    const run: { stepNumber: () => number } = { stepNumber: () => 0 };
    const log = (entry: string) => trace.push(`${String(run.stepNumber())}: ${entry}`);
    const violations: Violation[] = [];
    const purges = { seqs: new Set<bigint>(), revisions: new Set<string>() };
    const access: { members?: Members } = {};
    const network = new SimNetwork({
      describeRequest: (method, input) => describeRequest(ids, method, input),
      describeOutcome: (method, outcome) => describeOutcome(ids, method, outcome),
      commitRetryBackoff: options.commitRetryBackoff,
      violation: (invariant, detail) => {
        violations.push({ invariant, detail });
        log(`VIOLATION ${invariant}: ${detail}`);
      },
      observeOutcome: (method, outcome, client) => {
        const seq = replySeq(method, outcome);
        if (seq !== undefined && seq > serverSeq) serverSeq = seq;
        // Each call against the role its user had while the server ran it (#35).
        for (const violation of access.members?.check(client, method, outcome) ?? []) {
          violations.push(violation);
          log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
        }
      },
    });
    const context: RunContext = {
      vaultId: vault.id,
      ids,
      network,
      acknowledged: [],
      violations,
      log,
      trace,
      stepNumber: () => run.stepNumber(),
      serverSeq: () => serverSeq,
      purgedSeqs: purges.seqs,
      purgedRevisions: purges.revisions,
      pathPool: options.faithfulFilesystem === true ? faithfulPathPool : pathPool,
      mayLoseAccess: (client) => access.members?.mayLoseAccess(client) === true,
    };
    const members = await Members.join(http, vault.id, tokens, options.clients);
    access.members = members;
    const clients: ScriptedClient[] = [];
    for (let index = 0; index < options.clients; index++) {
      const userToken = tokens[members.userOf(index)] ?? token;
      const userSetup = createProtocolClient({ transport: http, token: () => userToken });
      const device = (await userSetup.devices.registerDevice({ name: `sim client ${String(index)}` })).device;
      if (device === undefined) throw new Error("RegisterDevice returned no device");
      const transport: Transport = network.transport(index, http);
      clients.push(new ScriptedClient(index, createProtocolClient({ transport, token: () => userToken }), device.id, context));
    }
    const observers: EngineObserver[] = [];
    for (let engine = 0; engine < (options.engines ?? 1); engine++) {
      const observerIndex = options.clients + engine;
      const observerDevice = (await setup.devices.registerDevice({ name: `sim engine ${String(engine)}` })).device;
      if (observerDevice === undefined) throw new Error("RegisterDevice returned no device");
      const platform = options.platforms?.[engine] ?? platformForSeed(options.seed);
      observers.push(new EngineObserver(observerIndex, createProtocolClient({ transport: network.transport(observerIndex, http), token: () => token }), observerDevice.id, context, platform));
    }
    const simRun = new SimRun(context, clients, observers, control, setup, trace, purges, options.notificationPulls === true, members);
    run.stepNumber = () => simRun.stepNumber;
    return simRun;
  }

  /** The first engine: the one seeded schedules drive, which crashes with client 0. */
  get observer(): EngineObserver {
    const observer = this.observers[0];
    if (observer === undefined) throw new Error("the run has no engine");
    return observer;
  }

  /** Executes one schedule step and lets the clients react to it. */
  async step(step: Step): Promise<void> {
    this.context.network.now = this.stepNumber;
    await this.fireDueTimers();
    const entry = await this.execute(step);
    this.context.log(entry);
    await settle();
    this.stepNumber++;
  }

  /**
   * Delivers messages (of `client`, if given) in order, without faults, until
   * those clients are idle and have nothing in flight. Partitions and delays
   * still apply; call heal first to lift them.
   */
  async drain(client?: number): Promise<void> {
    const everyone: { index: number; idle: boolean }[] = [...this.clients, ...this.observers];
    const clients = client === undefined ? everyone : everyone.filter((candidate) => candidate.index === client);
    for (let delivery = 0; delivery < maxDrainDeliveries; delivery++) {
      this.context.network.now = this.stepNumber;
      // Once nothing can be delivered, time moves on to the next backoff timer or the end of a commit retry's backoff.
      const entry = this.context.network.deliverResponse(client) ?? (await this.context.network.deliverRequest(client)) ?? this.context.network.passTime(client);
      if (entry === undefined) {
        if (clients.every((candidate) => candidate.idle) && !this.context.network.hasMessages(client)) return;
        break;
      }
      this.context.log(`drain: ${entry}`);
      await settle();
    }
    const busy = clients.filter((candidate) => !candidate.idle).map((candidate) => `c${String(candidate.index)}`);
    const detail = `clients did not become idle while draining${client === undefined ? "" : ` c${String(client)}`} at step ${String(this.stepNumber)} (busy: ${busy.join(", ") || "none"}; in the network: ${this.context.network.describePending(client)})`;
    this.context.violations.push({ invariant: "liveness", detail });
    this.context.log(`VIOLATION liveness: ${detail}`);
  }

  /** Fires the clients' backoff timers that are due (SimNetwork.timers) and lets the clients react. */
  private async fireDueTimers(): Promise<void> {
    const fired = this.context.network.fireDueTimers();
    for (const entry of fired) this.context.log(entry);
    if (fired.length > 0) await settle();
  }

  /**
   * Has retention purge revisions of the run's vault, as if they were old
   * enough (Control.purge); returns the purged ids. The invariant checks then
   * expect exactly these to be gone.
   */
  async purge(revisionIds: readonly string[]): Promise<string[]> {
    this.purgedOrRestored.purged = true;
    const before = await serverFeed(this.direct, this.context.vaultId);
    const feed = new Map(before.map((revision) => [revision.revisionId, revision]));
    // Each document's head (live or tombstone) before the purge: the last of its revisions in the feed.
    const heads = new Set(new Map(before.map((revision) => [revision.documentId, revision.revisionId])).values());
    const purged = await this.control.purge(this.context.vaultId, revisionIds);
    for (const id of purged) {
      const revision = feed.get(id);
      if (revision === undefined) throw new Error(`retention purged ${id}, which was not in the change feed`);
      if (heads.has(id)) {
        // Retention never purges a head, not even a tombstone (SPEC.md §11).
        // Such a revision is not excused: the checks it would break must fire.
        const violation = { invariant: "retention-head", detail: `retention purged ${this.context.ids.label(id)}, the head of its document` };
        this.context.violations.push(violation);
        this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
        continue;
      }
      this.purged.set(id, revision);
      this.purges.seqs.add(revision.seq);
      this.purges.revisions.add(id);
    }
    this.context.log(`retention purged ${purged.map((id) => this.context.ids.label(id)).join(", ") || "nothing"}`);
    return purged;
  }

  /** Has retention prune the run's vault's purge markers, as if past their horizon (Control.pruneMarkers). */
  async pruneMarkers(): Promise<number> {
    const pruned = await this.control.pruneMarkers(this.context.vaultId);
    this.context.log(`retention pruned ${String(pruned)} purge markers`);
    return pruned;
  }

  /** Ages the run's vault's upload sessions in progress past the reclaim idle (Control.ageUploads); returns how many. */
  async ageUploads(): Promise<number> {
    const aged = await this.control.ageUploads(this.context.vaultId);
    this.context.log(`aged ${String(aged)} upload sessions past the reclaim idle`);
    return aged;
  }

  /** Backs up the run's vault in the database (Control.snapshot). */
  async snapshot(): Promise<bigint> {
    const headSeq = await this.control.snapshot(this.context.vaultId);
    this.context.log(`database snapshot at seq ${String(headSeq)}`);
    return headSeq;
  }

  /**
   * Restores the snapshot (Control.restore). The invariants of finish()
   * assume the server keeps every acknowledged write, so a run that
   * restores checks its own outcome instead.
   */
  async restore(): Promise<bigint> {
    this.purgedOrRestored.restored = true;
    const headSeq = await this.control.restore(this.context.vaultId);
    this.context.log(`database restored to seq ${String(headSeq)}`);
    return headSeq;
  }

  /**
   * Ends the run: lifts every fault, lets in-flight work finish, has every
   * client pull, and checks the invariants against the server's database.
   */
  async finish(): Promise<RunResult> {
    this.context.network.heal();
    this.context.log("quiesce");
    await this.drain();
    await this.pushEverything();
    for (const client of this.clients) this.context.log(client.start("pull", 0));
    await settle();
    await this.drain();
    // Every commit has landed, so one more fault-free pull must converge.
    for (const observer of this.observers) this.context.log(observer.startPull());
    await settle();
    await this.drain();
    const heads = await serverHeads(this.direct, this.context.vaultId);
    for (const violation of this.checkHarnessSeq(heads.lastSeq)) {
      this.context.violations.push(violation);
      this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    }
    for (const observer of this.observers) {
      try {
        this.context.violations.push(...(await observer.check(heads)));
      } catch (error) {
        // An engine that never settles cannot be checked; the run reports the stall (with the trace, which holds it) instead of hanging (#302).
        if (!(error instanceof StallError)) throw error;
        this.context.violations.push({ invariant: "liveness", detail: error.message.split("\n")[0] ?? error.message });
      }
    }
    // After their last pull every scripted client must know every document's
    // current head: the feed skips purged revisions, never a head (§11).
    // Except a removed member's: it can no longer pull (#35).
    const clientHeads = this.clients.filter((client) => this.members.roleOf(client.index) !== "removed").map((client) => ({ client: client.index, heads: client.knownHeads() }));
    for (const violation of await this.checkUsers()) {
      this.context.violations.push(violation);
      this.context.log(`VIOLATION ${violation.invariant}: ${violation.detail}`);
    }
    const violations = await this.control.check(this.context.vaultId, this.context.acknowledged, clientHeads);
    for (const violation of violations) {
      this.context.violations.push({ invariant: violation.invariant, detail: this.context.ids.relabel(violation.detail) });
      this.context.log(`VIOLATION ${violation.invariant}: ${this.context.ids.relabel(violation.detail)}`);
    }
    return {
      vaultId: this.context.vaultId,
      trace: this.trace,
      acknowledged: this.context.acknowledged,
      violations: this.context.violations,
      purged: [...this.purged.keys()].map((id) => this.context.ids.label(id)),
      membershipChanges: { ...this.members.changes },
    };
  }

  /**
   * Has every engine push until a round commits nothing, so every local
   * change has reached the server (or is held for a reason the engine
   * reports, as for unmaterializable documents).
   */
  private async pushEverything(): Promise<void> {
    for (let round = 0; round < maxPushRounds; round++) {
      for (const observer of this.observers) observer.lastPush = undefined;
      for (const observer of this.observers) this.context.log(observer.startPush());
      await settle();
      await this.drain();
      if (this.observers.every((observer) => observer.lastPush?.committed === 0 && observer.lastPush.conflicts === 0)) return;
    }
    this.context.violations.push({ invariant: "liveness", detail: `the engines still committed after ${String(maxPushRounds)} rounds of pushes` });
  }

  /**
   * `server-seq`: after the last pulls, the harness's serverSeq (a lower
   * bound, taken from replies) is the feed head, unless a restore lowered the
   * head. `engine-resync`: in a run that neither restores nor purges, no
   * engine pull resynced; the server never diverged from any cursor (#155).
   */
  private checkHarnessSeq(lastSeq: bigint): Violation[] {
    const violations: Violation[] = [];
    const { purged, restored } = this.purgedOrRestored;
    if (!restored && this.context.serverSeq() !== lastSeq) violations.push({ invariant: "server-seq", detail: `the harness's server seq is ${String(this.context.serverSeq())}, the feed ends at ${String(lastSeq)}` });
    if (purged || restored) return violations;
    for (const observer of this.observers) {
      for (const at of observer.resyncs) violations.push({ invariant: "engine-resync", detail: `${observer.name}'s pull at ${at} resynced, although the server was neither restored nor purged` });
    }
    return violations;
  }

  /** The user-visible invariants (sim/invariants.ts): no lost write, no file gone without a delete, no delete undone without a user's change. */
  private async checkUsers(): Promise<Violation[]> {
    const feed = await serverFeed(this.direct, this.context.vaultId);
    const sizes = new Map(feed.map((revision) => [revision.contentHash, revision.size]));
    // Content only a purged revision held is gone by policy (§2 principle
    // 1, §11), not lost; it counts as present, but only if the run purged it.
    const present = new Set<string>([...this.purged.values()].map((revision) => revision.contentHash));
    for (const observer of this.observers) {
      for (const path of await observer.list()) {
        const content = await observer.read(path);
        if (content !== undefined) present.add(sha256Hex(content));
      }
    }
    // A content in history counts once it downloads and matches its hash.
    for (const observer of this.observers) {
      for (const hash of observer.ledger.owed()) {
        const size = sizes.get(hash);
        if (present.has(hash) || size === undefined) continue;
        try {
          await downloadContent(this.direct, this.context.vaultId, hash, size);
          present.add(hash);
        } catch (error) {
          this.context.log(`history content ${hash.slice(0, 8)} did not download: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const violations = this.observers.flatMap((observer) => checkLostWrites(observer.name, observer.ledger, present));
    const scripted = new Set(this.clients.map((client) => client.deviceId));
    const engines = this.observers.map((observer) => ({ name: observer.name, deviceId: observer.deviceId, deletedDocuments: observer.ledger.deletedDocuments, platform: observer.platform, renames: observer.ledger.renames, crashes: observer.ledger.crashes }));
    // The whole history: the feed and the revisions retention purged from it,
    // so a purge never hides a tombstone, nor the revision that brought a
    // deleted document back, from these checks.
    const history = [...feed, ...this.purged.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    violations.push(...checkPhantomDeletes(history, scripted, engines, (id) => this.context.ids.label(id)));
    const changes = this.observers.map((observer) => ({ name: observer.name, deviceId: observer.deviceId, platform: observer.platform, changes: observer.ledger.changes }));
    violations.push(...checkResurrections(history, scripted, changes, (id) => this.context.ids.label(id)));
    return violations;
  }

  private async execute(step: Step): Promise<string> {
    const network = this.context.network;
    const nothing = (what: string) => (entry: string | undefined) => entry ?? `${step.kind}: no ${what}`;
    switch (step.kind) {
      case "operation": {
        const entry = this.client(step.client).start(step.operation, step.arg);
        // The engines pull whenever the schedule asks any client to pull; with
        // notificationPulls, sometimes only if behind a seq the server announced.
        if (step.operation !== "pull") return entry;
        const seq = this.notificationPulls ? notificationSeq(step.arg, this.context.serverSeq()) : undefined;
        return [entry, ...this.observers.map((observer) => observer.startPull(seq))].join("; ");
      }
      case "deliver-request":
        return nothing("deliverable request")(await network.deliverRequest(step.client));
      case "deliver-response":
        return nothing("deliverable response")(network.deliverResponse(step.client));
      case "reorder":
        return nothing("two deliverable requests")(await network.reorder(step.pick));
      case "delay":
        return nothing("deliverable request")(network.delay(step.pick, step.steps));
      case "drop-request":
        return nothing("request in flight")(network.dropRequest(step.pick));
      case "drop-response":
        return nothing("response in flight")(network.dropResponse(step.pick));
      case "partition":
        return network.partition(this.client(step.client).index, step.steps);
      case "crash": {
        const client = this.client(step.client);
        client.crash();
        const entry = `c${String(step.client)} crashed and restarted with empty memory`;
        // Engine i shares its device's fate with client i % clients: with one engine, client 0.
        const crashed = this.observers.filter((_, engine) => engine % this.clients.length === client.index).map((observer) => observer.crash());
        return [entry, ...crashed].join("; ");
      }
      case "retention": {
        // Fault-free, like the job itself: it runs in the server, not through a client's network.
        const feed = await serverFeed(this.direct, this.context.vaultId);
        if (feed.length === 0) return "retention: no revisions";
        const aged = feed.slice(0, 1 + (step.pick % feed.length));
        await this.purge(aged.map((revision) => revision.revisionId));
        return `retention aged the ${String(aged.length)} oldest of ${String(feed.length)} revisions`;
      }
      case "membership":
        // Fault-free, like the owner's own device making the change between two deliveries.
        return this.members.change(step.pick);
      case "engine-operation": {
        const observer = this.observers[step.engine % this.observers.length];
        if (observer === undefined) return "engine-operation: no engine";
        return observer.userOperation(step.operation, step.arg);
      }
    }
  }

  private client(index: number): ScriptedClient {
    const client = this.clients[index % this.clients.length];
    if (client === undefined) throw new Error("a run has at least one client");
    return client;
  }
}

/** Runs `steps` on a fresh vault and checks the invariants. */
export async function runSteps(endpoints: SimEndpoints, options: RunOptions, steps: readonly Step[]): Promise<RunResult> {
  const run = await SimRun.start(endpoints, options);
  for (const step of steps) await run.step(step);
  return run.finish();
}

/** Runs the schedule generated from `seed`, with seededCommitRetryBackoff unless `options` sets another. */
export async function runSeed(endpoints: SimEndpoints, options: RunOptions & { steps: number }): Promise<RunResult & { steps: Step[] }> {
  // Without `engines` the engine has no user, as before #22.
  const steps = generateSchedule({ seed: options.seed, steps: options.steps, clients: options.clients, engines: options.engines ?? 0, retention: options.retention, membership: options.membership });
  return { ...(await runSteps(endpoints, { commitRetryBackoff: seededCommitRetryBackoff, ...options }, steps)), steps };
}

type Fields = Record<string, unknown>;

function hex(value: unknown): string {
  return value instanceof Uint8Array ? bytesToHex(value).slice(0, 8) : "?";
}

function describeRequest(ids: Ids, method: string, input: unknown): string {
  const fields = (input ?? {}) as Fields;
  const id = (name: string) => ids.label(typeof fields[name] === "string" ? fields[name] : "");
  switch (method) {
    case "CommitRevision": {
      const path = fields.path instanceof Uint8Array ? new TextDecoder().decode(fields.path) : "?";
      const content = (fields.contentRef ?? {}) as Fields;
      return `CommitRevision(${id("documentId")} ${id("revisionId")} base=${id("baseRevId")} "${path}"${fields.deleted === true ? " deleted" : ""} blob=${hex(content.blobId)})`;
    }
    case "BeginBlob":
    case "CommitBlob":
      return `${method}(${hex(fields.blobId)})`;
    case "PutBlobChunk":
      return `PutBlobChunk(${hex(fields.blobId)} @${String(fields.offset)})`;
    case "ListChanges":
      return `ListChanges(since=${String(fields.sinceSeq)})`;
    case "DownloadBlob":
      // A look-up before an upload asks for 1 byte at the blob's end; a download asks for length 0 (the server's maximum).
      return `DownloadBlob(${hex(fields.blobId)} @${String(fields.offset)} length=${String(fields.length)})`;
    default:
      return method;
  }
}

/** The server's head seq a reply shows: a committed revision's seq, or the feed's head. */
function replySeq(method: string, outcome: Outcome): bigint | undefined {
  if (!outcome.ok) return undefined;
  const message = ((outcome.value as { message?: unknown }).message ?? {}) as Fields;
  const seq = method === "CommitRevision" ? ((message.revision ?? {}) as Fields).seq : method === "ListChanges" ? message.headSeq : undefined;
  return typeof seq === "bigint" ? seq : undefined;
}

function describeOutcome(ids: Ids, method: string, outcome: Outcome): string {
  if (!outcome.ok) return Code[ConnectError.from(outcome.error).code];
  const message = ((outcome.value as { message?: unknown }).message ?? {}) as Fields;
  switch (method) {
    case "CommitRevision": {
      const revision = (message.revision ?? {}) as Fields;
      return `ok ${ids.label(typeof revision.id === "string" ? revision.id : "")} seq=${String(revision.seq)}`;
    }
    case "BeginBlob":
      return `ok complete=${String(message.complete)} received=${String(message.receivedSize)}`;
    case "PutBlobChunk":
      return `ok received=${String(message.receivedSize)}`;
    case "ListChanges":
      return `ok ${String(Array.isArray(message.revisions) ? message.revisions.length : "?")} revisions head=${String(message.headSeq)}${message.hasMore === true ? " more" : ""}${message.diverged === true ? " diverged" : ""}`;
    default:
      return "ok";
  }
}
