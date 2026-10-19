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
  | { kind: "crash"; client: number };

export type StepKind = Step["kind"];

export interface ScheduleOptions {
  seed: number;
  steps: number;
  clients: number;
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
  const random = Random.derive(options.seed, "schedule");
  const steps: Step[] = [];
  for (let index = 0; index < options.steps; index++) {
    steps.push(generateStep(random, options.clients));
  }
  return steps;
}

function generateStep(random: Random, clients: number): Step {
  const kind = random.weighted(stepWeights);
  switch (kind) {
    case "operation":
      return { kind, client: random.int(clients), operation: random.weighted(operationWeights), arg: random.uint32() };
    case "deliver-request":
    case "deliver-response":
      return { kind };
    case "reorder":
    case "drop-request":
    case "drop-response":
      return { kind, pick: random.uint32() };
    case "delay":
      return { kind, pick: random.uint32(), steps: 1 + random.int(maxFaultSteps) };
    case "partition":
      return { kind, client: random.int(clients), steps: 1 + random.int(maxFaultSteps) };
    case "crash":
      return { kind, client: random.int(clients) };
  }
}
