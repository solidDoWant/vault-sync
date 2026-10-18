// Runs one simulation: a fresh vault on the real server, scripted clients
// behind the simulated network, a schedule of steps, then quiescence and the
// invariant checks (SPEC.md §13).

import { Code, ConnectError, type Transport } from "@connectrpc/connect";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { createHttpTransport, createProtocolClient } from "../plugin/src/core/protocol/client";
import { VaultEncryption } from "../plugin/src/gen/vaultsync/v1/types_pb";
import { ScriptedClient, type Acknowledgement, type RunContext, type Violation } from "./client";
import { Control } from "./control";
import { Ids } from "./ids";
import { settle, SimNetwork, type Outcome } from "./network";
import { generateSchedule, type Step } from "./schedule";

/** Where the server and the driver's control endpoint are. */
export interface SimEndpoints {
  serverUrl: string;
  controlUrl: string;
}

export interface RunOptions {
  /** Names the vault; also recorded with regression cases. */
  seed: number;
  clients: number;
}

export interface RunResult {
  vaultId: string;
  /** What happened, step by step, with symbolic ids: identical whenever the same steps are replayed. */
  trace: string[];
  acknowledged: Acknowledgement[];
  violations: Violation[];
}

/** Bound on deliveries while draining, far above what any schedule needs. */
const maxDrainDeliveries = 100_000;

export class SimRun {
  private stepNumber = 0;
  direct: ReturnType<typeof createProtocolClient> | undefined;

  private constructor(
    readonly context: RunContext,
    readonly clients: ScriptedClient[],
    private readonly control: Control,
    readonly trace: string[],
  ) {}

  /** Creates a vault for a new user and registers one device per client. */
  static async start(endpoints: SimEndpoints, options: RunOptions): Promise<SimRun> {
    const control = new Control(endpoints.controlUrl);
    const token = await control.token();
    const http = createHttpTransport(endpoints.serverUrl);
    const setup = createProtocolClient({ transport: http, token: () => token });
    const vault = (await setup.vaults.createVault({ name: `sim seed ${String(options.seed)}`, encryption: VaultEncryption.NONE })).vault;
    if (vault === undefined) throw new Error("CreateVault returned no vault");

    const ids = new Ids();
    const trace: string[] = [];
    const network = new SimNetwork({ describeRequest: (method, input) => describeRequest(ids, method, input), describeOutcome: (method, outcome) => describeOutcome(ids, method, outcome) });
    const run: { stepNumber: () => number } = { stepNumber: () => 0 };
    const context: RunContext = {
      vaultId: vault.id,
      ids,
      network,
      acknowledged: [],
      violations: [],
      rejected: [],
      log: (entry) => trace.push(`${String(run.stepNumber())}: ${entry}`),
    };
    const clients: ScriptedClient[] = [];
    for (let index = 0; index < options.clients; index++) {
      const device = (await setup.devices.registerDevice({ name: `sim client ${String(index)}` })).device;
      if (device === undefined) throw new Error("RegisterDevice returned no device");
      const transport: Transport = network.transport(index, http);
      clients.push(new ScriptedClient(index, createProtocolClient({ transport, token: () => token }), device.id, context));
    }
    const simRun = new SimRun(context, clients, control, trace);
    simRun.direct = setup;
    run.stepNumber = () => simRun.stepNumber;
    return simRun;
  }

  /** Executes one schedule step and lets the clients react to it. */
  async step(step: Step): Promise<void> {
    this.context.network.now = this.stepNumber;
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
    const clients = client === undefined ? this.clients : this.clients.filter((candidate) => candidate.index === client);
    for (let delivery = 0; delivery < maxDrainDeliveries; delivery++) {
      this.context.network.now = this.stepNumber;
      const entry = this.context.network.deliverResponse(client) ?? (await this.context.network.deliverRequest(client));
      if (entry === undefined) {
        if (clients.every((candidate) => candidate.idle) && !this.context.network.hasMessages(client)) return;
        break;
      }
      this.context.log(`drain: ${entry}`);
      await settle();
    }
    this.context.violations.push({ invariant: "liveness", detail: `clients did not become idle while draining${client === undefined ? "" : ` c${String(client)}`}` });
  }

  /**
   * Ends the run: lifts every fault, lets in-flight work finish, has every
   * client pull, and checks the invariants against the server's database.
   */
  async finish(): Promise<RunResult> {
    this.context.network.heal();
    this.context.log("quiesce");
    await this.drain();
    for (const client of this.clients) this.context.log(client.start("pull", 0));
    await settle();
    await this.drain();
    for (const rejection of this.context.rejected) {
      try {
        const got = await this.direct!.sync.getRevision({ vaultId: this.context.vaultId, revisionId: rejection.revisionId });
        const detail = `revision ${this.context.ids.label(rejection.revisionId)} of c${String(rejection.client)} was rejected with ${rejection.code} but is stored (seq ${String(got.revision?.seq)})`;
        this.context.violations.push({ invariant: "rejected-but-stored", detail });
        this.context.log(`VIOLATION rejected-but-stored: ${detail}`);
      } catch (error) {
        if (ConnectError.from(error).code !== Code.NotFound) throw error;
      }
    }
    this.context.log(`checked ${String(this.context.rejected.length)} rejected revision ids`);
    const seenBlobs = new Set<string>();
    for (const ack of this.context.acknowledged) {
      if (seenBlobs.has(ack.blobId)) continue;
      seenBlobs.add(ack.blobId);
      const blobId = hexToBytes(ack.blobId);
      const chunks: Uint8Array[] = [];
      let offset = 0n;
      let total = -1n;
      try {
        while (total < 0n || offset < total) {
          const response = await this.direct!.blobs.downloadBlob({ vaultId: this.context.vaultId, blobId, offset, length: 0 });
          total = response.size;
          if (response.data.length === 0 && offset < total) throw new Error("empty range");
          chunks.push(response.data);
          offset += BigInt(response.data.length);
        }
      } catch (error) {
        this.context.violations.push({ invariant: "blob-readable", detail: `blob ${ack.blobId} of ${this.context.ids.label(ack.revisionId)} unreadable: ${String(error)}` });
        continue;
      }
      const all = new Uint8Array(Number(offset));
      let at = 0;
      for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
      if (bytesToHex(sha256(all)) !== ack.blobId || String(total) !== ack.size) {
        this.context.violations.push({ invariant: "blob-readable", detail: `blob ${ack.blobId} of ${this.context.ids.label(ack.revisionId)} has wrong content or size ${String(total)}` });
      }
    }
    this.context.log(`checked ${String(seenBlobs.size)} acknowledged blobs`);
    const snapshots = this.clients.map((client) => client.snapshot());
    for (const [index, snapshot] of snapshots.entries()) {
      if (snapshot !== snapshots[0]) {
        this.context.violations.push({ invariant: "convergence", detail: `c${String(index)} (cursor ${String(this.clients[index]?.cursorSeq)}) disagrees with c0 (cursor ${String(this.clients[0]?.cursorSeq)})` });
      }
    }
    const violations = await this.control.check(this.context.vaultId, this.context.acknowledged);
    for (const violation of violations) {
      this.context.violations.push({ invariant: violation.invariant, detail: this.context.ids.relabel(violation.detail) });
      this.context.log(`VIOLATION ${violation.invariant}: ${this.context.ids.relabel(violation.detail)}`);
    }
    return { vaultId: this.context.vaultId, trace: this.trace, acknowledged: this.context.acknowledged, violations: this.context.violations };
  }

  private async execute(step: Step): Promise<string> {
    const network = this.context.network;
    const nothing = (what: string) => (entry: string | undefined) => entry ?? `${step.kind}: no ${what}`;
    switch (step.kind) {
      case "operation":
        return this.client(step.client).start(step.operation, step.arg);
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
      case "crash":
        this.client(step.client).crash();
        return `c${String(step.client)} crashed and restarted with empty memory`;
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

/** Runs the schedule generated from `seed`. */
export async function runSeed(endpoints: SimEndpoints, options: RunOptions & { steps: number }): Promise<RunResult & { steps: Step[] }> {
  const steps = generateSchedule({ seed: options.seed, steps: options.steps, clients: options.clients });
  return { ...(await runSteps(endpoints, options, steps)), steps };
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
    default:
      return method;
  }
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
      return `ok ${String(Array.isArray(message.revisions) ? message.revisions.length : "?")} revisions head=${String(message.headSeq)}${message.hasMore === true ? " more" : ""}`;
    default:
      return "ok";
  }
}
