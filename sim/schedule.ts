// The client-side schedule of a simulation run: which client starts which
// operation, which message the network delivers next, and which fault it
// injects, step by step. It is a pure function of the seed (SPEC.md §13), so a
// failing seed always replays the same schedule, and it is plain JSON, so a
// minimized schedule can be committed as a regression case (sim/regressions/).
//
// Steps never name messages or documents directly: `pick` and `arg` are
// unsigned 32-bit numbers that select among whatever is pending or known when
// the step runs. A step therefore stays meaningful when the shrinker removes
// steps before it.

import { Random } from "./random";

export const operations = ["create", "edit", "rename", "delete", "pull"] as const;
export type Operation = (typeof operations)[number];

/** What an engine's user does to its vault, or a push of the engine (#22). */
export const engineOperations = ["create", "edit", "rename", "delete", "push"] as const;
export type EngineOperation = (typeof engineOperations)[number];

export type Step =
  /** `client` starts `operation` (if it is idle); `arg` seeds its choices (document, path, content). */
  | { kind: "operation"; client: number; operation: Operation; arg: number }
  /** The oldest deliverable request (of `client`, if given) reaches the server. */
  | { kind: "deliver-request"; client?: number }
  /** The oldest deliverable response (to `client`, if given) reaches its client. */
  | { kind: "deliver-response"; client?: number }
  /** A deliverable request other than the oldest reaches the server: requests arrive out of order. */
  | { kind: "reorder"; pick: number }
  /** A deliverable request is held back for `steps` steps. */
  | { kind: "delay"; pick: number; steps: number }
  /** A request is lost before it reaches the server; its client sees UNAVAILABLE. */
  | { kind: "drop-request"; pick: number }
  /** A response is lost after the server applied the request; its client sees UNAVAILABLE. */
  | { kind: "drop-response"; pick: number }
  /** `client` loses the network for `steps` steps; its in-flight messages are lost. */
  | { kind: "partition"; client: number; steps: number }
  /** `client` crashes and restarts, losing all in-memory state. */
  | { kind: "crash"; client: number }
  /**
   * Engine `engine`'s user changes its vault, or the engine starts a push;
   * `arg` seeds the user's choices. Generated only for runs with engines, so
   * a schedule without them, and every regression case recorded before #22,
   * is unchanged.
   */
  | { kind: "engine-operation"; engine: number; operation: EngineOperation; arg: number }
  /**
   * The retention job runs (SPEC.md §11), as if the revisions with the
   * lowest seqs of the feed had aged past the policy: `pick` selects how
   * many of them (at least one). Generated only for schedules with
   * retention (#229), so every other schedule, and every regression case
   * recorded before it, is unchanged.
   */
  | { kind: "retention"; pick: number }
  /**
   * The vault's owner changes a member's role (#35): `pick` selects the
   * member and the change (Members.change): demote to viewer, promote back
   * to editor, remove, or invite again. Generated only for schedules with
   * membership changes, so every other schedule, and every regression case
   * recorded before it, is unchanged.
   */
  | { kind: "membership"; pick: number };

export type StepKind = Step["kind"];

export interface ScheduleOptions {
  seed: number;
  steps: number;
  clients: number;
  /** Engines whose users make random changes; with 0 (the default) no engine-operation step is generated. */
  engines?: number;
  /** Whether the retention job runs between steps (#229); without it (the default) no retention step is generated. */
  retention?: boolean;
  /** Whether the owner changes members' roles between steps (#35); without it (the default) no membership step is generated. */
  membership?: boolean;
}

/** Relative frequency of each step kind in a generated schedule. */
export const stepWeights: Readonly<Record<StepKind, number>> = {
  // An operation takes several round trips (a blob upload, then the
  // commit), so deliveries dominate; faults are frequent enough that most
  // operations of a long schedule meet one, rare enough that most finish.
  // Tuned for commits and conflicts per seed (#110). A client has one call in
  // flight at a time, and a delivery step finds nothing of its kind about a
  // third of the time, so delivery steps bound the yield and the weights move
  // it only a little. A delay stalls a whole operation, so it is rarer than
  // the other faults.
  operation: 28,
  "deliver-request": 34,
  "deliver-response": 34,
  reorder: 3,
  delay: 1.5,
  "drop-request": 2,
  "drop-response": 3,
  partition: 0.75,
  crash: 0.75,
  // Never drawn: withRetention inserts retention steps into a schedule
  // (#229). With weight 0 it never changes another kind's draw.
  retention: 0,
  // Never drawn either: withMembership inserts membership steps (#35).
  membership: 0,
  // Last, and drawn only when the run has engines: with weight 0 every other
  // kind's draws, and so every engine-less schedule, are exactly as before #22.
  "engine-operation": 10,
};

/** Relative frequency of each engine operation. */
export const engineOperationWeights: Readonly<Record<EngineOperation, number>> = {
  create: 20,
  edit: 35,
  rename: 10,
  delete: 8,
  push: 27,
};

/** Relative frequency of each operation. */
export const operationWeights: Readonly<Record<Operation, number>> = {
  create: 25,
  // Edits of known documents race other clients' commits (FAILED_PRECONDITION).
  edit: 45,
  rename: 12,
  delete: 8,
  pull: 15,
};

/** Longest delay or partition a generated step asks for, in steps. */
export const maxFaultSteps = 12;

/** The schedule for `options`: the same options always give the same steps. */
export function generateSchedule(options: ScheduleOptions): Step[] {
  if (!Number.isInteger(options.clients) || options.clients < 1) throw new RangeError("clients must be a positive integer");
  if (!Number.isInteger(options.steps) || options.steps < 0) throw new RangeError("steps must be a non-negative integer");
  const engines = options.engines ?? 0;
  if (!Number.isInteger(engines) || engines < 0) throw new RangeError("engines must be a non-negative integer");
  const weights = engines === 0 ? { ...stepWeights, "engine-operation": 0 } : stepWeights;
  const random = Random.derive(options.seed, "schedule");
  const steps: Step[] = [];
  for (let index = 0; index < options.steps; index++) {
    steps.push(generateStep(random, weights, options.clients, engines));
  }
  const retained = options.retention === true ? withRetention(options.seed, steps) : steps;
  return options.membership === true ? withMembership(options.seed, retained) : retained;
}

/** On average, a schedule with retention runs the retention job once in this many steps (#229). */
export const retentionInterval = 200;

/**
 * `steps` with the retention job run between them (#229): after each step,
 * with probability 1/retentionInterval, a `retention` step drawn from the
 * seed's own stream. Every other step is the seed's plain schedule, in its
 * order, so a schedule with retention that fails where the plain one passes
 * fails because of what the purges did.
 */
function withRetention(seed: number, steps: readonly Step[]): Step[] {
  return withInserted(Random.derive(seed, "retention"), retentionInterval, steps, (random) => ({ kind: "retention", pick: random.uint32() }));
}

/** On average, a schedule with membership changes changes a member's role once in this many steps (#35). */
export const membershipInterval = 100;

/**
 * `steps` with the owner changing members' roles between them (#35), as
 * withRetention inserts the retention job: after each step, with probability
 * 1/membershipInterval, a `membership` step from the seed's own stream.
 */
function withMembership(seed: number, steps: readonly Step[]): Step[] {
  return withInserted(Random.derive(seed, "membership"), membershipInterval, steps, (random) => ({ kind: "membership", pick: random.uint32() }));
}

/** `steps` with a step from `make` after each one with probability 1/interval, drawn from `random` alone. */
function withInserted(random: Random, interval: number, steps: readonly Step[], make: (random: Random) => Step): Step[] {
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (random.int(interval) === 0) result.push(make(random));
  }
  return result;
}

function generateStep(random: Random, weights: Readonly<Record<StepKind, number>>, clients: number, engines: number): Step {
  const kind = random.weighted(weights);
  switch (kind) {
    case "operation":
      return { kind, client: random.int(clients), operation: random.weighted(operationWeights), arg: random.uint32() };
    case "deliver-request":
    case "deliver-response":
      return { kind };
    case "reorder":
    case "drop-request":
    case "drop-response":
    case "retention":
    case "membership":
      return { kind, pick: random.uint32() };
    case "delay":
      return { kind, pick: random.uint32(), steps: 1 + random.int(maxFaultSteps) };
    case "partition":
      return { kind, client: random.int(clients), steps: 1 + random.int(maxFaultSteps) };
    case "crash":
      return { kind, client: random.int(clients) };
    case "engine-operation":
      return { kind, engine: random.int(engines), operation: random.weighted(engineOperationWeights), arg: random.uint32() };
  }
}
