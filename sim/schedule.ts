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

/**
 * What an engine's device does to its config sync (#422 item 8): turn it on
 * or off, flip one category (both restart the engine, as the plugin does),
 * or Obsidian writes or deletes a file in the config folder.
 */
export const configActions = ["toggle", "category", "edit", "delete"] as const;
export type ConfigAction = (typeof configActions)[number];

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
   * Engine `engine`'s device changes its config sync or its config folder
   * (ConfigAction); `arg` seeds the choices. Inserted only into schedules
   * with config sync (ScheduleOptions.configSync, #422), so every other
   * schedule, and every regression case recorded before it, is unchanged.
   */
  | { kind: "engine-config"; engine: number; action: ConfigAction; arg: number };

export type StepKind = Step["kind"];

export interface ScheduleOptions {
  seed: number;
  steps: number;
  clients: number;
  /** Engines whose users make random changes; with 0 (the default) no engine-operation step is generated. */
  engines?: number;
  /** Whether the retention job runs between steps (#229); without it (the default) no retention step is generated. */
  retention?: boolean;
  /** Whether the engines' devices change their config sync between steps (#422); needs engines. Without it (the default) no engine-config step is generated. */
  configSync?: boolean;
  /**
   * Whether deliveries of the engines' own calls are added between steps
   * (#422); needs engines. Without it (the default) none is added.
   */
  engineDeliveries?: boolean;
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
  // Never drawn either: withConfigSync inserts them (#422).
  "engine-config": 0,
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
  const delivered = options.engineDeliveries === true && engines > 0 ? withEngineDeliveries(options.seed, steps, options.clients, engines) : steps;
  const configured = options.configSync === true && engines > 0 ? withConfigSync(options.seed, delivered, engines) : delivered;
  return options.retention === true ? withRetention(options.seed, configured) : configured;
}

/**
 * On average, a schedule with engine deliveries delivers one of an engine's
 * calls (a request or a response) after this many steps (#422).
 */
export const engineDeliveryInterval = 2;

/**
 * `steps` with deliveries of the engines' own calls between them (#422),
 * from the seed's own stream, as withRetention inserts its steps. A push or
 * pull of an engine takes many round trips (page after page, blob after
 * blob), and the plain schedule's deliveries are shared with every scripted
 * client, so without these an engine seldom finishes a push before the
 * faults heal. The engines are the network's clients after the scripted
 * ones. Faults still reach their calls as before.
 */
function withEngineDeliveries(seed: number, steps: readonly Step[], clients: number, engines: number): Step[] {
  const random = Random.derive(seed, "engine-deliveries");
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (random.int(engineDeliveryInterval) !== 0) continue;
    const client = clients + random.int(engines);
    result.push(random.chance(0.5) ? { kind: "deliver-request", client } : { kind: "deliver-response", client });
  }
  return result;
}

/** On average, a schedule with config sync changes an engine's config once in this many steps (#422). */
export const configSyncInterval = 40;

/** Relative frequency of each config action. */
export const configActionWeights: Readonly<Record<ConfigAction, number>> = {
  toggle: 20,
  category: 20,
  edit: 45,
  delete: 15,
};

/**
 * `steps` with config sync changes between them (#422), as withRetention
 * inserts its steps: from the seed's own stream, so every other step is the
 * seed's plain schedule, in its order.
 */
function withConfigSync(seed: number, steps: readonly Step[], engines: number): Step[] {
  const random = Random.derive(seed, "config-sync");
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (random.int(configSyncInterval) === 0) result.push({ kind: "engine-config", engine: random.int(engines), action: random.weighted(configActionWeights), arg: random.uint32() });
  }
  return result;
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
  const random = Random.derive(seed, "retention");
  const result: Step[] = [];
  for (const step of steps) {
    result.push(step);
    if (random.int(retentionInterval) === 0) result.push({ kind: "retention", pick: random.uint32() });
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
      return { kind, pick: random.uint32() };
    case "delay":
      return { kind, pick: random.uint32(), steps: 1 + random.int(maxFaultSteps) };
    case "partition":
      return { kind, client: random.int(clients), steps: 1 + random.int(maxFaultSteps) };
    case "crash":
      return { kind, client: random.int(clients) };
    case "engine-operation":
      return { kind, engine: random.int(engines), operation: random.weighted(engineOperationWeights), arg: random.uint32() };
    case "engine-config":
      return { kind, engine: random.int(engines), action: random.weighted(configActionWeights), arg: random.uint32() };
  }
}
