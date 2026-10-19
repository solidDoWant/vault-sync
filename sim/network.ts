// The simulated network between the scripted clients and the real server, and
// its fault injector (SPEC.md §13). Each client talks to the server through a
// Transport from SimNetwork.transport. A call does not go out on its own: it
// waits in the network until a schedule step delivers it to the server, and
// its response waits again until a step delivers it back to the client. Faults
// act on these waiting messages. Time is the step counter, not the clock, and
// only one message is ever in transit to the server at a time, so a schedule
// replays identically.

import { Code, ConnectError, type Transport } from "@connectrpc/connect";

/** How a call ended, as seen on the wire. */
export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

interface Message {
  /** Sequence number in order of sending; trace entries name messages by it. */
  id: number;
  client: number;
  /** The client's incarnation that sent it; replies to an earlier incarnation are never delivered. */
  incarnation: number;
  method: string;
  /** Symbolic description of the request for the trace. */
  description: string;
  /** The revision id of a CommitRevision request. */
  revisionId?: string;
  phase: "request" | "response";
  /** Step number before which the message cannot be delivered. */
  heldUntil: number;
  send: () => Promise<unknown>;
  outcome?: Outcome;
  settle: (outcome: Outcome) => void;
}

export interface NetworkOptions {
  /** Describes a request for the trace, without raw ids (they differ between runs). */
  describeRequest: (method: string, input: unknown) => string;
  /** Describes a server reply for the trace. */
  describeOutcome: (method: string, outcome: Outcome) => string;
  /** Reports a broken protocol guarantee the network observed on the wire. */
  violation: (invariant: string, detail: string) => void;
  /**
   * Steps a CommitRevision retry (a request with a revision id sent before)
   * waits before it can be delivered; 0 or unset delivers retries at once.
   */
  commitRetryBackoff?: number;
}

/** CommitRevision refusals that a retry of a revision the server already applied must never get (SPEC.md §6.2). */
const refusedRetryCodes: readonly Code[] = [Code.FailedPrecondition, Code.AlreadyExists];

/** Thrown to a client whose request or response the network lost. */
export function networkError(reason: string): ConnectError {
  return new ConnectError(`simulated network fault: ${reason}`, Code.Unavailable);
}

/** The status code of a call's failure (UNKNOWN for non-Connect errors). */
export function errorCode(error: unknown): Code {
  return ConnectError.from(error).code;
}


function revisionIdOf(input: unknown): string | undefined {
  const revisionId = (input as { revisionId?: unknown } | undefined)?.revisionId;
  return typeof revisionId === "string" && revisionId !== "" ? revisionId : undefined;
}

/** Lets clients run until they block on their next call or finish. */
export async function settle(): Promise<void> {
  // Client code between calls is synchronous work and promise chains, which
  // all run before the next macrotask.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class SimNetwork {
  /** The current step; delays and partitions are measured in steps. */
  now = 0;
  private nextId = 0;
  private messages: Message[] = [];
  private readonly incarnations = new Map<number, number>();
  private readonly partitionedUntil = new Map<number, number>();
  /**
   * Revision ids of CommitRevision calls the server answered successfully,
   * whether or not the answer then reached the client. A retry of one must
   * get the revision back, however far the head moved since (§6.2).
   */
  private readonly appliedRevisions = new Set<string>();
  /** Revision ids of every CommitRevision request sent so far (for the retry backoff). */
  private readonly sentRevisions = new Set<string>();

  constructor(private readonly options: NetworkOptions) {}

  /** A Transport for `client` that routes every unary call through this network. */
  transport(client: number, inner: Transport): Transport {
    return {
      unary: (method, _signal, _timeoutMs, header, input, contextValues) =>
        this.enqueue(client, method.name, input, () => inner.unary(method, undefined, undefined, header, input, contextValues)),
      stream: () => Promise.reject(new ConnectError("streaming calls are not simulated", Code.Unimplemented)),
    };
  }

  /** The current incarnation of `client` (it changes when the client crashes). */
  incarnation(client: number): number {
    return this.incarnations.get(client) ?? 0;
  }

  isPartitioned(client: number): boolean {
    return (this.partitionedUntil.get(client) ?? 0) > this.now;
  }

  /** Whether any message (of `client`, if given) is still in the network. */
  hasMessages(client?: number): boolean {
    return this.messages.some((message) => client === undefined || message.client === client);
  }

  /** The method of the oldest request `client` has waiting, if any. */
  pendingRequest(client: number): string | undefined {
    return this.messages.find((message) => message.client === client && message.phase === "request")?.method;
  }

  /** Delivers the oldest deliverable request (of `client`, if given) to the server. */
  async deliverRequest(client?: number): Promise<string | undefined> {
    const message = this.deliverableRequests().find((candidate) => client === undefined || candidate.client === client);
    if (message === undefined) return undefined;
    return this.send(message);
  }

  /** Delivers a deliverable request other than the oldest: the network reorders. */
  async reorder(pick: number): Promise<string | undefined> {
    const candidates = this.deliverableRequests();
    if (candidates.length < 2) return undefined;
    const message = candidates[1 + (pick % (candidates.length - 1))];
    if (message === undefined) throw new Error("unreachable: reorder pick out of range");
    return `out of order: ${await this.send(message)}`;
  }

  /** Delivers the oldest deliverable response (to `client`, if given). */
  deliverResponse(client?: number): string | undefined {
    const message = this.messages.find(
      (candidate) => candidate.phase === "response" && !this.isPartitioned(candidate.client) && (client === undefined || candidate.client === client),
    );
    if (message === undefined) return undefined;
    this.remove(message);
    const outcome = message.outcome;
    if (outcome === undefined) throw new Error("unreachable: response without an outcome");
    const live = message.incarnation === this.incarnation(message.client);
    if (live) message.settle(outcome);
    return `${this.label(message)} reply delivered${live ? "" : " to a crashed incarnation, discarded"}`;
  }

  /** Holds a deliverable request back for `steps` steps. */
  delay(pick: number, steps: number): string | undefined {
    const candidates = this.deliverableRequests();
    const message = candidates[pick % Math.max(1, candidates.length)];
    if (message === undefined) return undefined;
    message.heldUntil = this.now + steps;
    return `${this.label(message)} held for ${String(steps)} steps`;
  }

  /** Loses a request before the server sees it. */
  dropRequest(pick: number): string | undefined {
    const candidates = this.messages.filter((message) => message.phase === "request");
    const message = candidates[pick % Math.max(1, candidates.length)];
    if (message === undefined) return undefined;
    this.fail(message, "request lost");
    return `${this.label(message)} request lost`;
  }

  /** Loses a response after the server applied the request. */
  dropResponse(pick: number): string | undefined {
    const candidates = this.messages.filter((message) => message.phase === "response");
    const message = candidates[pick % Math.max(1, candidates.length)];
    if (message === undefined) return undefined;
    this.fail(message, "response lost");
    return `${this.label(message)} response lost after the server handled it`;
  }

  /** Cuts `client` off for `steps` steps; everything it has in flight is lost. */
  partition(client: number, steps: number): string {
    this.partitionedUntil.set(client, Math.max(this.partitionedUntil.get(client) ?? 0, this.now + steps));
    const lost = this.messages.filter((message) => message.client === client);
    for (const message of lost) this.fail(message, "partitioned");
    return `c${String(client)} partitioned for ${String(steps)} steps, ${String(lost.length)} message(s) lost`;
  }

  /**
   * Crashes `client`: its current incarnation never hears back again.
   * Requests it already sent stay in the network and may still reach the
   * server, like packets on the wire.
   */
  crash(client: number): void {
    this.incarnations.set(client, this.incarnation(client) + 1);
  }

  /** Ends every partition and delay (used to quiesce at the end of a run). */
  heal(): void {
    this.partitionedUntil.clear();
    for (const message of this.messages) message.heldUntil = 0;
  }

  private enqueue<T>(client: number, method: string, input: unknown, send: () => Promise<T>): Promise<T> {
    const revisionId = method === "CommitRevision" ? revisionIdOf(input) : undefined;
    return new Promise<T>((resolve, reject) => {
      this.messages.push({
        id: this.nextId++,
        client,
        incarnation: this.incarnation(client),
        method,
        description: this.options.describeRequest(method, input),
        revisionId,
        phase: "request",
        heldUntil: this.backoff(revisionId),
        send,
        settle: (outcome) => {
          if (outcome.ok) resolve(outcome.value as T);
          else reject(outcome.error as Error);
        },
      });
    });
  }

  /**
   * The step before which a CommitRevision request cannot be delivered: a
   * retry of a revision id already sent waits out the backoff, as a real
   * client's retry would, so other clients' commits can move the head
   * meanwhile (#110). A first attempt is not held.
   */
  private backoff(revisionId: string | undefined): number {
    const steps = this.options.commitRetryBackoff ?? 0;
    if (revisionId === undefined || steps === 0) return 0;
    if (!this.sentRevisions.has(revisionId)) {
      this.sentRevisions.add(revisionId);
      return 0;
    }
    return this.now + steps;
  }

  private deliverableRequests(): Message[] {
    return this.messages.filter((message) => message.phase === "request" && message.heldUntil <= this.now && !this.isPartitioned(message.client));
  }

  private async send(message: Message): Promise<string> {
    message.outcome = await message.send().then(
      (value): Outcome => ({ ok: true, value }),
      (error: unknown): Outcome => ({ ok: false, error }),
    );
    message.phase = "response";
    this.checkRetry(message, message.outcome);
    return `${this.label(message)} -> ${this.options.describeOutcome(message.method, message.outcome)}`;
  }

  /**
   * Catches a client-side duplicate the server-side invariants cannot see
   * (#12, #110): the server applied a commit, its response was lost, and the
   * retry with the same revision id was refused as stale or as a path
   * collision. The client would then rebase or move the change and commit it
   * again as a second revision.
   */
  private checkRetry(message: Message, outcome: Outcome): void {
    if (message.method !== "CommitRevision" || message.revisionId === undefined) return;
    if (outcome.ok) {
      this.appliedRevisions.add(message.revisionId);
      return;
    }
    const code = errorCode(outcome.error);
    if (refusedRetryCodes.includes(code) && this.appliedRevisions.has(message.revisionId)) {
      this.options.violation(
        "protocol",
        `${this.label(message)} was refused with ${Code[code]}, although the server already applied this revision id (a retry must get the revision back)`,
      );
    }
  }

  private fail(message: Message, reason: string): void {
    this.remove(message);
    if (message.incarnation === this.incarnation(message.client)) message.settle({ ok: false, error: networkError(reason) });
  }

  private remove(message: Message): void {
    this.messages = this.messages.filter((candidate) => candidate !== message);
  }

  private label(message: Message): string {
    return `#${String(message.id)} c${String(message.client)} ${message.description}`;
  }
}
