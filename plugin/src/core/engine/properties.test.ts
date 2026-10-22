// Model-based property suite of docs/design/engine-path-ownership.md §9.3:
// fast-check commands drive device A's engine, a scripted remote device, the
// server's history operations and crashes at the Nth journal write, over the
// in-memory server, vault and journal (PropertyWorld in ./testing.ts). The
// harness's oracle (inodes, content origins, bindings) is independent of the
// engine's journal.
//
// Every property `holds`; each counterexample a fixed issue was found by runs
// first, at any seed, as a fixed example. (A property the engine violated was
// a known failure pinned to its counterexample until #719 flipped the last
// one, P1; see git history to pin one again.) A run that throws anything
// but a PropertyViolation (a TypeError, a broken harness invariant) is a
// harness bug and fails every property, so a broken harness cannot pass for
// an engine violation (#587).
//
// Runs are deterministic: a fixed seed and bounded runs (§9.3's 2,000 cases
// per PR, up to 40 commands each), no wall clock. VAULT_SYNC_PROPERTY_RUNS and
// VAULT_SYNC_PROPERTY_SEED, read by vitest.config.ts, change both (`make
// test-properties`: 100,000 cases a night); fast-check prints the
// counterexample and its replay path.

import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import { hexToBytes } from "@noble/hashes/utils.js";

import { sha256Hex } from "../hash";
import { createProtocolClient } from "../protocol/client";
import type { PathPlatform } from "../vaultpath/platform";
import { kindValue } from "./remote";
import { PropertyWorld, testDeviceId, withoutCopyNames, type PropertyId, type RenameMode, type WorldCommand } from "./testing";
import { uploadContent } from "./upload";

declare module "vitest" {
  export interface ProvidedContext {
    /** The suite's size, from vitest.config.ts. */
    properties: { runs: number; seed: number };
  }
}

const prCases = 2000;
const { runs, seed } = inject("properties");
const maxCommands = 40;
/** Five minutes per 2,000 cases. */
const timeout = 300_000 * Math.max(1, runs / prCases);

class Step implements fc.AsyncCommand<object, PropertyWorld> {
  constructor(readonly command: WorldCommand) {}
  check(): boolean {
    return true;
  }
  async run(_model: object, world: PropertyWorld): Promise<void> {
    await world.apply(this.command);
  }
  toString(): string {
    return JSON.stringify(this.command);
  }
}

const index = fc.nat({ max: 15 });
const renameMode = fc.constantFrom<RenameMode>("pool", "case", "respell", "folder");

/** A database restore to a fraction of the server's head seq. */
const restore: fc.Arbitrary<WorldCommand> = fc.double({ min: 0, max: 1, noNaN: true }).map((fraction) => ({ type: "restore", fraction }));

/**
 * A known document's file the user moves onto the path of a revision with
 * its bytes while the pull reads it (#757, design §4.5 step 3, INV-3, PO-4(a)).
 */
const moveOntoIncoming: fc.Arbitrary<WorldCommand> = fc.tuple(index, index).map(([file, path]) => ({ type: "move-onto-incoming", file, path }));

/** The alphabet of §9.3 without crashes (P4 places its own crash), with `move-onto-incoming` since #769. */
const steadyCommands: fc.Arbitrary<WorldCommand>[] = [
  index.map((path) => ({ type: "user-create", path })),
  index.map((file) => ({ type: "user-edit", file })),
  fc.tuple(index, renameMode, index).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  index.map((file) => ({ type: "user-delete", file })),
  index.map((path) => ({ type: "remote-create", path })),
  index.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(index, index).map(([document, path]) => ({ type: "remote-rename", document, path })),
  index.map((document) => ({ type: "remote-delete", document })),
  fc.constant({ type: "pull" }),
  index.map((file) => ({ type: "edit-during-pull", file })),
  fc.constant({ type: "push" }),
  restore,
  index.map((revision) => ({ type: "purge", revision })),
  moveOntoIncoming,
];

const allCommands: fc.Arbitrary<WorldCommand>[] = [...steadyCommands, fc.integer({ min: 1, max: 12 }).map((write) => ({ type: "crash", write }))];

/**
 * P6's alphabet: no database restore. Since R7b (#700) the push re-creates
 * a document the restored server lost (SPEC.md §8, divergence), but INV-9
 * after a restore is not proven yet: with restores, P6 still finds a run
 * that does not converge (a remote delete, edits during pulls, a restore).
 */
const convergingCommands = allCommands.filter((command) => command !== restore);

/**
 * The one-spelling-folder alphabet (#737): paths whose folders differ only in
 * case, on a faithful filesystem where a folder has one spelling, so a remote
 * document at `Notes/b.md` lands in the `notes/` folder already on disk.
 */
const folderPaths: readonly string[] = ["notes/a.md", "Notes/b.md", "NOTES/a.md", "notes/b.md", "c.md"];
const folderCommands: fc.Arbitrary<WorldCommand>[] = [
  index.map((path) => ({ type: "user-create", path })),
  index.map((file) => ({ type: "user-edit", file })),
  fc.tuple(index, fc.constantFrom<RenameMode>("pool", "case"), index).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  index.map((file) => ({ type: "user-delete", file })),
  index.map((path) => ({ type: "remote-create", path })),
  index.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(index, index).map(([document, path]) => ({ type: "remote-rename", document, path })),
  index.map((document) => ({ type: "remote-delete", document })),
  fc.constant({ type: "pull" }),
  fc.constant({ type: "push" }),
];

/** P1's restore alphabet: few paths and documents, so restores roll the same documents back along their history, and purges remove bases a restore may have kept or lost (#719). */
const few = fc.nat({ max: 3 });
const rollbackCommands: fc.Arbitrary<WorldCommand>[] = [
  few.map((path) => ({ type: "remote-create", path })),
  few.map((document) => ({ type: "remote-edit", document })),
  few.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(few, few).map(([document, path]) => ({ type: "remote-rename", document, path })),
  few.map((file) => ({ type: "user-edit", file })),
  fc.tuple(few, renameMode, few).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  few.map((file) => ({ type: "edit-during-pull", file })),
  fc.constant({ type: "pull" }),
  fc.constant({ type: "push" }),
  restore,
  few.map((revision) => ({ type: "purge", revision })),
];

/**
 * P8's alphabet: few paths, and a push whose commits never reach the
 * server, so an outbox outlives the push into the user's later renames and
 * edits and the pulls after them, and remote documents take its paths
 * (#775). Restores make the push re-create documents the server lost,
 * which rule W may move too.
 */
const outboxCommands: fc.Arbitrary<WorldCommand>[] = [
  few.map((path) => ({ type: "user-create", path })),
  few.map((file) => ({ type: "user-edit", file })),
  fc.tuple(few, renameMode, few).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  few.map((file) => ({ type: "user-delete", file })),
  few.map((path) => ({ type: "remote-create", path })),
  few.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(few, few).map(([document, path]) => ({ type: "remote-rename", document, path })),
  few.map((file) => ({ type: "edit-during-pull", file })),
  fc.constant({ type: "pull" }),
  fc.constant({ type: "push" }),
  fc.constant({ type: "offline-push" }),
  fc.constant({ type: "offline-push" }),
  restore,
  fc.integer({ min: 1, max: 12 }).map((write) => ({ type: "crash", write })),
];

const platform = fc.constantFrom<PathPlatform>("posix", "windows", "macos");

/**
 * The alphabet of #757's class: `move-onto-incoming` among the steady
 * commands without restores and purges, so that it comes more often.
 */
const movedOntoIncomingCommands: fc.Arbitrary<WorldCommand>[] = [...steadyCommands.filter((command) => command !== restore).slice(0, 11), moveOntoIncoming];

/**
 * The alphabet of #790's class (INV-3, PO-1, design §4.5 step 4): a document
 * whose file the user moved, deleted on the server before the move is
 * pushed, then brought back by another device (`remote-recreate`) and moved
 * there, all meeting the file the document is bound to. Few paths and
 * documents, so the move, the delete and the re-create meet.
 */
const recreateCommands: fc.Arbitrary<WorldCommand>[] = [
  few.map((path) => ({ type: "user-create", path })),
  few.map((file) => ({ type: "user-edit", file })),
  fc.tuple(few, fc.constantFrom<RenameMode>("pool", "case"), few).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  few.map((path) => ({ type: "remote-create", path })),
  few.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(few, few).map(([document, path]) => ({ type: "remote-rename", document, path })),
  few.map((document) => ({ type: "remote-delete", document })),
  fc.tuple(few, few).map(([document, path]) => ({ type: "remote-recreate", document, path })),
  fc.constant({ type: "pull" }),
  fc.constant({ type: "push" }),
];

/**
 * The alphabet of #768's class (INV-2, PO-12): a document's revision deferred
 * because this device cannot hold it (a path Windows refuses, an `F`-alias of
 * another file on macOS), a restore that loses it, and a later revision of
 * another document at that path. Few paths and documents, so the deferral,
 * the restore and the collision meet.
 */
const ghostPaths: readonly string[] = ["a.md", "no:te.md", "ı.md", "I.md", "b.md"];
const ghost = fc.nat({ max: 4 });
const ghostCommands: fc.Arbitrary<WorldCommand>[] = [
  ghost.map((path) => ({ type: "user-create", path })),
  fc.tuple(ghost, ghost).map(([file, target]) => ({ type: "user-rename", file, mode: "pool", target })),
  ghost.map((path) => ({ type: "remote-create", path })),
  ghost.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(ghost, ghost).map(([document, path]) => ({ type: "remote-rename", document, path })),
  fc.constant({ type: "pull" }),
  ghost.map((file) => ({ type: "edit-during-pull", file })),
  fc.constant({ type: "push" }),
  restore,
];

function commands(alphabet: fc.Arbitrary<WorldCommand>[]) {
  return fc.commands(
    alphabet.map((command) => command.map((data) => new Step(data))),
    { maxCommands, size: "max" },
  );
}

/** Runs the commands on a fresh world and brings it to quiescence. */
async function play(on: PathPlatform, steps: Iterable<fc.AsyncCommand<object, PropertyWorld>>, paths?: readonly string[]): Promise<{ world: PropertyWorld; quiet: boolean }> {
  const world = new PropertyWorld(on, paths);
  await fc.asyncModelRun(() => ({ model: {}, real: world }), steps);
  const quiet = await world.quiesce();
  return { world, quiet };
}

function violations(world: PropertyWorld, property: PropertyId): string[] {
  return world.violations.filter((violation) => violation.property === property).map((violation) => `step ${String(violation.step)}: ${violation.message}`);
}

type Property = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8";

/** The only error a property run may fail with: the property found what it checks for. */
class PropertyViolation extends Error {
  constructor(
    readonly property: Property,
    readonly found: readonly string[],
  ) {
    super(`${property} violated:\n${found.join("\n")}`);
    this.name = "PropertyViolation";
  }
}

/** One property: the arbitrary its cases come from and the check that returns what it finds wrong in a case. */
interface Definition<T> {
  property: Property;
  cases: fc.Arbitrary<T>;
  check: (input: T) => Promise<string[]>;
}

/** A property over `alphabet` (by default the full one, crashes included) whose `check` looks at the quiescent world. */
function overWorld(property: Property, check: (world: PropertyWorld, quiet: boolean) => Promise<string[]> | string[], alphabet = allCommands): Definition<[PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>]> {
  return {
    property,
    cases: fc.tuple(platform, commands(alphabet)),
    check: async ([on, steps]) => {
      const { world, quiet } = await play(on, steps);
      return await check(world, quiet);
    },
  };
}

/** fast-check's report of a run, with the error its counterexample failed with. */
function report<T>(details: fc.RunDetails<T>): string {
  const error = details.errorInstance;
  const message = error instanceof Error ? error.message : String(error);
  return `${fc.defaultReportMessage(details) ?? "no counterexample"}${details.failed ? `\nGot ${message}` : ""}`;
}

/**
 * Searches for a counterexample, trying `examples` first. Any error but a
 * PropertyViolation thrown in any run (shrinking included) fails the test
 * here: it is a harness bug, never an engine violation.
 */
async function search<T>(definition: Definition<T>, examples: T[] = []): Promise<fc.RunDetails<[T]>> {
  const harnessErrors: unknown[] = [];
  const details = await fc.check(
    fc.asyncProperty(definition.cases, async (input) => {
      let found: string[];
      try {
        found = await definition.check(input);
      } catch (error) {
        harnessErrors.push(error);
        throw error;
      }
      if (found.length > 0) throw new PropertyViolation(definition.property, found);
    }),
    { seed, numRuns: runs, endOnFailure: false, examples: examples.map((example): [T] => [example]) },
  );
  const [first] = harnessErrors;
  if (first !== undefined) {
    const thrown = first instanceof Error ? (first.stack ?? first.message) : JSON.stringify(first);
    expect.fail(`the harness threw ${String(harnessErrors.length)} time(s) during ${definition.property}, first:\n${thrown}\n\n${report(details)}`);
  }
  return details;
}

/** The property holds: fast-check finds no counterexample, on `examples` (fixed regression cases, run first) or a generated case. */
async function holds<T>(definition: Definition<T>, examples: T[] = []): Promise<void> {
  const details = await search(definition, examples);
  if (details.failed) expect.fail(report(details));
}

/** A world property's case: the platform and the commands, as data. */
function scripted(on: PathPlatform, ...list: WorldCommand[]): [PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>] {
  return [on, list.map((command) => new Step(command))];
}

const p1 = overWorld("P1", (world) => violations(world, "P1"));
const p2 = overWorld("P2", (world) => violations(world, "P2"));
const p3 = overWorld("P3", (world) => violations(world, "P3"));
/** P3 over ghostCommands, on the platforms that defer a revision they cannot hold (#768). */
const p3Ghosts: Definition<[PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>]> = {
  property: "P3",
  cases: fc.tuple(fc.constantFrom<PathPlatform>("windows", "macos"), commands(ghostCommands)),
  check: async ([on, steps]) => violations((await play(on, steps, ghostPaths)).world, "P3"),
};
const p8 = overWorld("P8", (world) => violations(world, "P8"), outboxCommands);
const p1Recreate = overWorld("P1", (world) => violations(world, "P1"), recreateCommands);
/**
 * P4 over `alphabet` on `platforms`: crashing at journal write N and
 * restarting reaches the quiescent state the run without the crash reaches.
 */
function crashEquivalence(platforms: fc.Arbitrary<PathPlatform>, alphabet: fc.Arbitrary<WorldCommand>[], paths?: readonly string[]): Definition<[PathPlatform, WorldCommand[], number]> {
  return {
    property: "P4",
    cases: fc.tuple(platforms, fc.array(fc.oneof(...alphabet), { maxLength: maxCommands, size: "max" }), fc.integer({ min: 1, max: 40 })),
    check: async ([on, list, write]) => {
      const baseline = new PropertyWorld(on, paths);
      for (const command of list) await baseline.apply(command);
      await baseline.quiesce();
      const crashed = new PropertyWorld(on, paths);
      crashed.armCrash(write);
      for (const command of list) await crashed.apply(command);
      await crashed.quiesce();
      const [without, crashing] = [await baseline.outcome(), await crashed.outcome()];
      return without === crashing ? [] : [`a crash at journal write ${String(write)} reaches ${crashing}, the run without it ${without}`];
    },
  };
}
const p4 = crashEquivalence(platform, steadyCommands);
/**
 * #801's commands: after a restore to nothing, the push re-creates `STRASSE.md`'s
 * document, which yields its path to the new `Straße.md` (one path under `K`)
 * and is displaced to a copy name; a remote edit then picks the first live
 * document by path.
 */
const restoredGhostYields: WorldCommand[] = [
  { type: "remote-create", path: 0 },
  { type: "edit-during-pull", file: 0 },
  { type: "user-create", path: 5 },
  { type: "move-onto-incoming", file: 0, path: 7 },
  { type: "move-onto-incoming", file: 0, path: 6 },
  { type: "restore", fraction: 0 },
  { type: "push" },
  { type: "remote-edit", document: 0 },
  { type: "move-onto-incoming", file: 0, path: 0 },
];
/** P4 over ghostCommands (#784): a restore that loses a released document's deferred revision, crashed at any write. */
const p4Ghosts = crashEquivalence(fc.constantFrom<PathPlatform>("windows", "macos"), ghostCommands, ghostPaths);
const p5 = overWorld("P5", (world) => world.lostWrites());
/**
 * P7's alphabet: the steady one over the paths of `worldPaths` whose `K` and
 * `F` disagree (`Café.md` NFC and NFD, `Straße.md`, `STRASSE.md`) and a case
 * pair, so the engine writes, renames and deletes one spelling while the
 * vault holds another (#738). Crashes are left out: a restart's scan reports
 * what changed while the engine was down, which is no echo of a live change.
 */
const spelling = fc.constantFrom(0, 1, 3, 4, 5, 6);
const echoCommands: fc.Arbitrary<WorldCommand>[] = [
  spelling.map((path) => ({ type: "user-create", path })),
  index.map((file) => ({ type: "user-edit", file })),
  fc.tuple(index, renameMode, spelling).map(([file, mode, target]) => ({ type: "user-rename", file, mode, target })),
  index.map((file) => ({ type: "user-delete", file })),
  spelling.map((path) => ({ type: "remote-create", path })),
  index.map((document) => ({ type: "remote-edit", document })),
  fc.tuple(index, spelling).map(([document, path]) => ({ type: "remote-rename", document, path })),
  index.map((document) => ({ type: "remote-delete", document })),
  fc.constant({ type: "pull" }),
  index.map((file) => ({ type: "edit-during-pull", file })),
  fc.constant({ type: "push" }),
];
/** P7 runs on the faithful filesystem, where `F` decides the file (design §3.1, PO-10). */
const p7: Definition<[PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>]> = {
  property: "P7",
  cases: fc.tuple(platform, commands(echoCommands)),
  check: async ([on, steps]) => (await play(on, steps)).world.ownChangesReported(),
};
/** P6 where a folder has one spelling on disk (#737): INV-9 with folders compared under `F`, and INV-10 (P7's oracle), no own write reported as the user's. */
const p6Folders: Definition<[PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>]> = {
  property: "P6",
  cases: fc.tuple(fc.constantFrom<PathPlatform>("windows", "macos"), commands(folderCommands)),
  check: async ([on, steps]) => {
    const { world, quiet } = await play(on, steps, folderPaths);
    return [...(quiet ? [] : ["no quiescence within the round bound"]), ...world.errors.map((error) => `error: ${String(error)}`), ...(await world.convergence()), ...world.ownChangesReported()];
  },
};
/**
 * #757: P1, P2, P3, P5 and P6 over movedOntoIncomingCommands, with no
 * harness errors (P6 since #769, whose convergence check excuses the kept
 * file of a document deferred as an `F`-alias, §5.5 X-15).
 */
const movedOntoIncoming = overWorld(
  "P1",
  async (world, quiet) => [
    ...violations(world, "P1"),
    ...violations(world, "P2"),
    ...violations(world, "P3"),
    ...(await world.lostWrites()),
    ...world.errors.map((error) => `error: ${String(error)}`),
    ...(quiet ? [] : ["no quiescence within the round bound"]),
    ...(await world.convergence()),
  ],
  movedOntoIncomingCommands,
);
const p6 = overWorld("P6", async (world, quiet) => [...(quiet ? [] : ["no quiescence within the round bound"]), ...world.errors.map((error) => `error: ${String(error)}`), ...(await world.convergence())], convergingCommands);

describe("engine properties (design §9.3)", () => {
  // P1 identity: INV-3 and PO-1. A document's committed content always comes from the inode bound to it.
  // Flipped in #719. Fixed cases (#700, design §4.6): a restore that rolled a document back along this device's own
  // history, to a revision it synced as its base, and to its base's parent; #690's 20k-case counterexample (a blocked
  // document keeps its moved file, never a new document's); and #719's pin, a base retention purged under an unchanged
  // (renamed) file, which merges the pulled edit with the rename instead of keeping a conflict copy; and #770's (seed 719, 20k
  // cases), an unmaterializable document's edited kept file that a remote create's path needs, detached as a new document's
  // (PO-4(b), §5.5 X-20).
  it("P1: a document's committed content comes from its own file", { timeout }, async () => {
    const fixed = [
      scripted("posix", { type: "remote-create", path: 0 }, { type: "remote-create", path: 3 }, { type: "remote-edit", document: 7 }, { type: "remote-rename", document: 0, path: 2 }, { type: "pull" }, { type: "restore", fraction: 0.25 }, { type: "pull" }),
      scripted("posix", { type: "remote-create", path: 0 }, { type: "pull" }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "remote-edit", document: 0 }, { type: "push" }, { type: "remote-create", path: 2 }, { type: "restore", fraction: 0.25 }, { type: "pull" }),
      scripted("windows", { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 2 }, { type: "pull" }, { type: "user-rename", file: 0, mode: "pool", target: 0 }, { type: "remote-rename", document: 0, path: 11 }, { type: "purge", revision: 0 }),
      scripted("posix", { type: "remote-create", path: 0 }, { type: "push" }, { type: "user-rename", file: 0, mode: "pool", target: 1 }, { type: "remote-edit", document: 0 }, { type: "purge", revision: 0 }),
      // #770 (seed 719): a known document's file edited during a pull, then a create at its old path.
      scripted("windows", { type: "remote-create", path: 0 }, { type: "push" }, { type: "remote-rename", document: 0, path: 11 }, { type: "edit-during-pull", file: 0 }, { type: "remote-create", path: 0 }, { type: "user-create", path: 0 }),
      // #769: a document re-created after a restore with bytes the remote device committed to it, and to another document first.
      scripted("posix", { type: "remote-create", path: 0 }, { type: "move-onto-incoming", file: 0, path: 0 }, { type: "move-onto-incoming", file: 0, path: 2 }, { type: "restore", fraction: 0 }, { type: "user-rename", file: 0, mode: "pool", target: 0 }),
      // #769: a remote rename of a document moved locally onto the path where the user's unpushed rename put another document's file with the same bytes.
      scripted("posix", { type: "remote-create", path: 0 }, { type: "push" }, { type: "move-onto-incoming", file: 0, path: 10 }, { type: "push" }, { type: "user-delete", file: 0 }, { type: "move-onto-incoming", file: 0, path: 0 }, { type: "user-rename", file: 15, mode: "pool", target: 7 }, { type: "remote-rename", document: 8, path: 7 }, { type: "user-rename", file: 0, mode: "pool", target: 0 }),
    ];
    for (const example of fixed) expect(await p1.check(example)).toEqual([]);
    await holds(p1, fixed);
  });

  // P1 over restores that roll documents back along this device's own history (design §4.6): remote edits the device
  // pulls, local edits and renames, restores and the pulls and pushes after them, and retention purges (#719).
  // Fixed case: a document the restored server lost, renamed locally, whose re-create a later remote create's path
  // takes: it is displaced under its own id, not kept as a new document's copy; and one whose respelled file another
  // document the server has holds under the server's key (20k cases), re-created at a copy name under its own id,
  // whether a later revision of that document comes or not; and a re-create kept in place whose create a remote
  // rename's path refuses (#722), moved to a copy name under its own id; and one displaced, edited and renamed onto a later
  // remote create's path (#770, seed 719), displaced again under its own id with its edited content's size.
  it("P1: a restore along this device's own history commits the lost revision under its own id", { timeout }, async () => {
    await holds(overWorld("P1", (world) => violations(world, "P1"), rollbackCommands), [
      scripted("posix", { type: "remote-create", path: 3 }, { type: "edit-during-pull", file: 0 }, { type: "user-rename", file: 0, mode: "respell", target: 0 }, { type: "remote-rename", document: 0, path: 0 }, { type: "edit-during-pull", file: 0 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 3 }, { type: "remote-create", path: 0 }, { type: "remote-edit", document: 0 }),
      scripted("posix", { type: "remote-create", path: 3 }, { type: "edit-during-pull", file: 0 }, { type: "user-rename", file: 0, mode: "respell", target: 0 }, { type: "remote-rename", document: 0, path: 0 }, { type: "edit-during-pull", file: 0 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 3 }, { type: "remote-create", path: 0 }),
      scripted("posix", { type: "remote-create", path: 0 }, { type: "push" }, { type: "user-rename", file: 0, mode: "pool", target: 2 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "remote-create", path: 2 }, { type: "push" }, { type: "edit-during-pull", file: 0 }),
      // #722: the re-create, kept in place, is refused because a remote rename took its path meanwhile.
      scripted("posix", { type: "remote-create", path: 0 }, { type: "push" }, { type: "user-rename", file: 0, mode: "pool", target: 2 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "pull" }, { type: "remote-rename", document: 0, path: 2 }, { type: "user-rename", file: 0, mode: "pool", target: 3 }),
      // #770 (seed 719): a document's file edited during a pull, renamed, then a create at its new path and an edit.
      scripted("posix", { type: "remote-create", path: 0 }, { type: "edit-during-pull", file: 0 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "pull" }, { type: "edit-during-pull", file: 0 }, { type: "user-rename", file: 0, mode: "pool", target: 2 }, { type: "remote-create", path: 2 }, { type: "remote-edit", document: 0 }),
    ]);
  });

  // P2 provenance: INV-5 and INV-6 (PO-6/7) on inodes.
  it("P2: tombstones come from user deletes, resurrections from user changes", { timeout }, async () => {
    await holds(p2);
  });

  // P3 exclusivity: INV-1 and INV-2 after every command. Flipped in R7b (#700). Fixed cases: R7a's pin (a document the
  // restored server lost at a path key a pulled document then claims), and a document the restored server lost, then a
  // colliding local create, with its file kept and with it deleted (design §4.6: the push re-creates it, yielding the path).
  it("P3: no two live documents or live outboxes claim one path key", { timeout }, async () => {
    await holds(p3, [
      scripted("posix", { type: "remote-create", path: 5 }, { type: "push" }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 6 }),
      scripted("posix", { type: "user-create", path: 1 }, { type: "remote-create", path: 0 }, { type: "pull" }, { type: "restore", fraction: 0 }),
      scripted("posix", { type: "remote-create", path: 5 }, { type: "edit-during-pull", file: 0 }, { type: "user-delete", file: 0 }, { type: "restore", fraction: 0 }, { type: "user-create", path: 5 }),
    ]);
  });

  // #768 (INV-2, PO-12): a restore re-derives the server view, so a deferred revision the restored server lost claims
  // no path any more. Fixed cases: #768's counterexamples, a rename deferred as unmaterializable on Windows and one
  // deferred as an `F`-alias on macOS, each lost by a restore before another document takes its path.
  it("P3: a deferred revision a restore lost claims no path", { timeout }, async () => {
    await holds(p3Ghosts, [
      scripted("windows", { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 1 }, { type: "edit-during-pull", file: 0 }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 2 }, { type: "pull" }, { type: "remote-rename", document: 0, path: 1 }, { type: "pull" }, { type: "restore", fraction: 0 }),
      scripted("macos", { type: "remote-create", path: 2 }, { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 3 }, { type: "push" }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 3 }, { type: "user-rename", file: 0, mode: "pool", target: 0 }),
    ]);
    expect(await p3.check(scripted("macos", { type: "remote-create", path: 13 }, { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 14 }, { type: "push" }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 14 }, { type: "user-rename", file: 0, mode: "pool", target: 0 }))).toEqual([]);
  });

  // P4 crash equivalence: INV-7. Crashing at journal write N and restarting reaches the same quiescent state, modulo copy names.
  // Flipped in R7b (#700), which re-creates a document the restored server lost (design §4.6). Fixed case: the pin before it.
  it("P4: a crash at any journal write reaches the state a run without it reaches", { timeout }, async () => {
    await holds<[PathPlatform, WorldCommand[], number]>(p4, [
      [
        "posix",
        [
          { type: "remote-create", path: 1 },
          { type: "remote-rename", document: 0, path: 0 },
          { type: "edit-during-pull", file: 0 },
          { type: "restore", fraction: 0 },
          { type: "user-delete", file: 0 },
          { type: "remote-create", path: 1 },
          { type: "push" },
          { type: "remote-rename", document: 0, path: 0 },
          { type: "remote-delete", document: 0 },
          { type: "pull" },
        ],
        12,
      ],
      // #769's, found with `move-onto-incoming` before it was limited to free target paths.
      [
        "posix",
        [
          { type: "remote-create", path: 0 },
          { type: "remote-rename", document: 0, path: 2 },
          { type: "remote-create", path: 0 },
          { type: "remote-delete", document: 0 },
          { type: "edit-during-pull", file: 0 },
          { type: "remote-edit", document: 0 },
          { type: "move-onto-incoming", file: 0, path: 0 },
        ],
        13,
      ],
      // #801's: a crash at the displace intent that re-creates a ghost at a copy name after a restore.
      ["posix", restoredGhostYields, 17],
    ]);
  });

  // #801 (INV-7, PO-8): a push that displaces a ghost the restore lost to a copy name commits its re-create in the
  // same push, as the push a crash restarts does when it recovers the intent and resumes the outbox. Otherwise a
  // remote edit in between reaches a different copy. Fixed cases: on every platform, crashed at
  // each journal write of that push.
  it("P4: a push that re-creates a ghost at a copy name reaches the state a crash in it reaches", { timeout }, async () => {
    for (const on of ["posix", "macos", "windows"] as const) {
      for (let write = 13; write <= 24; write++) expect(await p4.check([on, restoredGhostYields, write]), `${on}, crash at write ${String(write)}`).toEqual([]);
    }
    const world = new PropertyWorld("posix");
    for (const command of restoredGhostYields.slice(0, 7)) await world.apply(command);
    expect(await world.journal.listPending()).toEqual([]);
    expect([...world.server.liveFiles()].map(([path]) => path).sort()).toEqual(["STRASSE (conflict laptop 2026-10-18 040506 2).md", "STRASSE (conflict laptop 2026-10-18 040506).md", "Straße.md", "x (conflict laptop 2026-10-18 040506)"]);
  });

  // #784 (INV-7, INV-9, PO-12): a resync that drops a released document's deferral the restore lost forgets the
  // document in the same journal write, so a crash cannot leave it released at its restored base with nothing to
  // re-derive it. Fixed cases: a rename deferred as unmaterializable on Windows, lost by a restore that keeps its base,
  // crashed at each journal write of the resync.
  it("P4: a crash during a restore that lost a released document's deferral reaches the state a run without it reaches", { timeout }, async () => {
    const lost: WorldCommand[] = [{ type: "remote-create", path: 0 }, { type: "pull" }, { type: "remote-rename", document: 0, path: 1 }, { type: "pull" }, { type: "restore", fraction: 0.5 }, { type: "pull" }];
    await holds(
      p4Ghosts,
      Array.from({ length: 12 }, (_, write): [PathPlatform, WorldCommand[], number] => ["windows", lost, write + 1]),
    );
  });

  // P5 no lost write: INV-4 plus principle 1, against server history.
  it("P5: every user write is in the vault or was accepted by the server", { timeout }, async () => {
    await holds(p5);
  });

  // #757 (INV-3, PO-1, PO-4(a)): a pull never adopts or merges a known document's file that the user moved onto the
  // path of a revision while the pull ran. Rule W displaces it under its own id, and the revision materializes.
  // Fixed case (#769, 20k cases): an unpushed case-only rename back to a spelling the document had wins over a later
  // remote delete (§4 R5b).
  it("P1–P3, P5, P6: a known document's file moved onto an incoming revision's path stays the document's", { timeout }, async () => {
    const fixed = [
      scripted("posix", { type: "user-create", path: 0 }, { type: "push" }, { type: "move-onto-incoming", file: 0, path: 8 }, { type: "user-rename", file: 3, mode: "case", target: 0 }, { type: "push" }, { type: "user-rename", file: 0, mode: "case", target: 0 }, { type: "remote-rename", document: 0, path: 0 }, { type: "remote-delete", document: 0 }, { type: "user-edit", file: 0 }),
    ];
    for (const example of fixed) expect(await movedOntoIncoming.check(example)).toEqual([]);
    await holds(movedOntoIncoming, [scripted("posix", { type: "remote-create", path: 0 }, { type: "pull" }, { type: "move-onto-incoming", file: 0, path: 2 }), ...fixed]);
  });

  // #790 (INV-3, PO-1, design §4.5 step 4): a document bound on its tombstone (the user's move, not pushed yet, won
  // over a remote delete) meets a revision that brings it back elsewhere as a local change: the merge path takes its
  // bound file, which stays the document's. Fixed case: the move, the delete, the re-create and a remote move in one
  // pull, then an edit of the moved file (seed 100101).
  it("P1: a document's file moved before a remote delete stays the document's when another device brings it back", { timeout }, async () => {
    await holds(p1Recreate, [
      scripted("macos", { type: "remote-create", path: 3 }, { type: "pull" }, { type: "user-rename", file: 0, mode: "pool", target: 1 }, { type: "remote-delete", document: 0 }, { type: "remote-recreate", document: 0, path: 3 }, { type: "remote-rename", document: 0, path: 8 }, { type: "pull" }, { type: "user-edit", file: 0 }, { type: "push" }),
    ]);
  });

  // P6 convergence and progress: INV-8 and INV-9 after quiescence, with bounded push rounds.
  // Flipped in R7b (#700; #583, PO-11). Fixed case: the pin before it (the engine's own file of a remote note held the
  // folder that note's next path needs); #769's, an `F`-alias deferral's kept file with the user's edit (decision #52),
  // and a remote rename onto another document's file with equal bytes that an unpushed rename put there.
  it("P6: the device converges with the server within bounded rounds", { timeout }, async () => {
    const fixed = [
      scripted("posix", { type: "user-create", path: 8 }, { type: "remote-create", path: 8 }, { type: "remote-rename", document: 0, path: 7 }, { type: "user-edit", file: 0 }),
      scripted("macos", { type: "remote-create", path: 0 }, { type: "remote-create", path: 14 }, { type: "edit-during-pull", file: 0 }, { type: "remote-rename", document: 1, path: 13 }, { type: "edit-during-pull", file: 15 }, { type: "pull" }),
      scripted("posix", { type: "remote-create", path: 0 }, { type: "push" }, { type: "move-onto-incoming", file: 0, path: 10 }, { type: "push" }, { type: "user-delete", file: 0 }, { type: "move-onto-incoming", file: 0, path: 0 }, { type: "user-rename", file: 15, mode: "pool", target: 7 }, { type: "remote-rename", document: 8, path: 7 }, { type: "user-rename", file: 0, mode: "pool", target: 0 }),
    ];
    for (const example of fixed) expect(await p6.check(example)).toEqual([]);
    await holds(p6, fixed);
  });

  it("P6: a device whose folder has one spelling on disk converges without taking its own writes for the user's", { timeout }, async () => {
    // notes/ is on disk; the remote document Notes/b.md lands in it as notes/b.md (#737).
    await holds(p6Folders, [scripted("windows", { type: "user-create", path: 0 }, { type: "push" }, { type: "remote-create", path: 1 }, { type: "pull" })]);
  });
});

/** Commits `content` live on `documentId`'s head as device A would, behind the engine's back: a resurrection the oracle must judge. */
async function commitAsDevice(world: PropertyWorld, documentId: string, path: string, content: string): Promise<void> {
  const api = createProtocolClient({ transport: world.server.transport });
  const bytes = new TextEncoder().encode(content);
  const hash = sha256Hex(bytes);
  await uploadContent(api, world.server.vaultId, hash, BigInt(bytes.length), () => Promise.resolve(bytes));
  await api.sync.commitRevision({
    vaultId: world.server.vaultId,
    documentId,
    revisionId: `forged-${documentId}`,
    baseRevId: world.server.head(documentId)?.id ?? "",
    kind: kindValue("text"),
    contentRef: { blobId: hexToBytes(hash), size: BigInt(bytes.length) },
    path: new TextEncoder().encode(path),
    deleted: false,
    deviceId: testDeviceId,
  });
}

// The P2 oracle credits a resurrection to an edit that wins over a delete
// only for a user write into an inode bound to the document whose content no
// server revision of the document carried (PO-7). These pin that it still
// flags a resurrection without such a write.
describe("content reference property (design §9.3, INV-8)", () => {
  // P8 content references: INV-8 with PO-8. No outbox operation, and no blob request the engine sends, names a content
  // hash at another content's size, which the server refuses on every push (#775). Fixed case: an unpushed create the user
  // renames onto a path and edits to a content of another size before a remote document takes that path, whose displace
  // intent rewrote the outbox with the moved content's hash and the create's old size.
  it("P8: the engine names every content at its own size", { timeout }, async () => {
    const pad = Array.from({ length: 8 }, (): WorldCommand => ({ type: "pull" }));
    await holds(p8, [
      scripted("posix", { type: "user-create", path: 2 }, { type: "offline-push" }, { type: "user-rename", file: 0, mode: "pool", target: 0 }, ...pad, { type: "user-edit", file: 0 }, { type: "remote-create", path: 0 }, { type: "pull" }),
    ]);
  });
});

describe("engine echo property (design §9.3, INV-10)", () => {
  // P7 echo independence: INV-10 with PO-10. The engine never reports its own vault change as the user's, on the faithful
  // filesystem, where two files can share a file key (#738). Fixed cases: the engine's create of a remote `Straße.md` beside
  // the user's `STRASSE.md`, and of NFC `Café.md` beside the user's NFD `Café.md` on Windows, and the reverse of each.
  it("P7: the engine never reports its own change as a local one", { timeout }, async () => {
    await holds(p7, [
      scripted("windows", { type: "user-create", path: 6 }, { type: "remote-create", path: 5 }, { type: "pull" }),
      scripted("macos", { type: "user-create", path: 5 }, { type: "remote-create", path: 6 }, { type: "pull" }),
      scripted("windows", { type: "user-create", path: 4 }, { type: "remote-create", path: 3 }, { type: "pull" }),
      scripted("windows", { type: "user-create", path: 3 }, { type: "remote-create", path: 4 }, { type: "pull" }),
    ]);
  });
});

describe("P2 oracle (design §5.4)", () => {
  it("flags a resurrection of synced content without a user change", async () => {
    const world = new PropertyWorld("posix");
    await world.apply({ type: "user-create", path: 0 });
    await world.apply({ type: "push" });
    const [[, documentId] = ["", ""]] = [...world.server.liveDocuments()];
    await world.apply({ type: "remote-delete", document: 0 });
    await commitAsDevice(world, documentId, "a.md", "user 1");
    await world.apply({ type: "pull" });
    expect(violations(world, "P2")).toEqual([expect.stringMatching(/live revision of .* on its tombstone without a user change/)]);
  });

  it("flags a resurrection carrying an unsynced write into another document's file", async () => {
    const world = new PropertyWorld("posix");
    await world.apply({ type: "user-create", path: 0 });
    await world.apply({ type: "user-create", path: 2 });
    await world.apply({ type: "push" });
    const documentId = world.server.liveDocuments().get("a.md") ?? "";
    // Step 4: the user's unsynced edit of b.md, whose inode is bound to the other document.
    await world.apply({ type: "user-edit", file: 1 });
    await world.apply({ type: "remote-edit", document: 0 });
    await world.apply({ type: "remote-delete", document: 0 });
    await commitAsDevice(world, documentId, "a.md", "user 4");
    await world.apply({ type: "pull" });
    expect(violations(world, "P2")).toEqual([expect.stringMatching(/live revision of .* on its tombstone without a user change/)]);
  });

  it("flags a resurrection carrying an untracked file's content from another path", async () => {
    const world = new PropertyWorld("posix");
    await world.apply({ type: "user-create", path: 0 });
    await world.apply({ type: "push" });
    const documentId = world.server.liveDocuments().get("a.md") ?? "";
    await world.apply({ type: "remote-delete", document: 0 });
    await world.apply({ type: "pull" });
    // Step 5: an untracked file at b.md, not the tombstone's path.
    await world.apply({ type: "user-create", path: 2 });
    await commitAsDevice(world, documentId, "a.md", "user 5");
    await world.apply({ type: "pull" });
    expect(violations(world, "P2")).toEqual([expect.stringMatching(/live revision of .* on its tombstone without a user change/)]);
  });

  it("credits an unsynced write into the document's own file made before the other device's last live revision", async () => {
    const world = new PropertyWorld("posix");
    await world.apply({ type: "user-create", path: 0 });
    await world.apply({ type: "push" });
    const documentId = world.server.liveDocuments().get("a.md") ?? "";
    // Step 3: the user's unsynced edit of a.md, the document's own file.
    await world.apply({ type: "user-edit", file: 0 });
    await world.apply({ type: "remote-rename", document: 0, path: 2 });
    await world.apply({ type: "remote-delete", document: 0 });
    await commitAsDevice(world, documentId, "a.md", "user 3");
    await world.apply({ type: "pull" });
    expect(violations(world, "P2")).toEqual([]);
  });
});

// The P1 oracle unbinds an inode the engine detached (design §4.5 W(b),
// PO-4(b), §5.5 X-20): a blocked document's file at its synced path, moved to
// a copy name because a server claim needs the path, is a new document's.
// These pin that it credits exactly that, and still flags a displaced
// document's file (W(a), a local move) committed as a new document.
describe("P1 oracle (design §5.4)", () => {
  it("credits a detached file, kept by an unmaterializable document, pushed as a new document", async () => {
    const world = new PropertyWorld("windows");
    await world.apply({ type: "remote-create", path: 0 });
    await world.apply({ type: "pull" });
    await world.apply({ type: "user-edit", file: 0 });
    // Step 4: the server moves the document to `no:te.md`, which Windows cannot hold; the device keeps the edited a.md.
    await world.apply({ type: "remote-rename", document: 0, path: 11 });
    await world.apply({ type: "pull" });
    // Step 6: another document takes a.md, so the kept file is detached to a copy name.
    await world.apply({ type: "remote-create", path: 0 });
    await world.apply({ type: "pull" });
    await world.apply({ type: "push" });
    const copies = [...world.server.liveFiles()].filter(([path]) => withoutCopyNames(path) !== path);
    expect(copies).toEqual([[expect.stringMatching(/^a \(conflict .*\)\.md$/), "user 3"]]);
    expect(violations(world, "P1")).toEqual([]);
  });

  it("flags a file a document that could follow its head was moved off, committed as a new document", async () => {
    const world = new PropertyWorld("windows");
    await world.apply({ type: "remote-create", path: 0 });
    await world.apply({ type: "pull" });
    await world.apply({ type: "user-edit", file: 0 });
    // Steps 4-6, one page of the feed: the server moves the document to
    // `no:te.md`, which Windows cannot hold, another document takes a.md,
    // and the document moves on to b.md, which this device can hold.
    await world.apply({ type: "remote-rename", document: 0, path: 11 });
    await world.apply({ type: "remote-create", path: 0 });
    // Live documents by path: a.md (the new one), then no:te.md.
    await world.apply({ type: "remote-rename", document: 1, path: 2 });
    // The engine moves the kept a.md aside on the page's second revision,
    // while the server's head of its document is already at b.md: that
    // document is not blocked, so the file stays its own.
    await world.apply({ type: "pull" });
    const copy = (await world.vault.list()).find((path) => withoutCopyNames(path) !== path) ?? "";
    expect(copy).toMatch(/^a \(conflict .*\)\.md$/);
    await commitAsDevice(world, "forged-new", copy, "user 3");
    await world.apply({ type: "restore", fraction: 1 });
    expect(violations(world, "P1")).toContainEqual(expect.stringMatching(/create of forged-new at .* from inode 1, bound to /));
  });

  it("flags a file moved to a copy name from its document's head path, committed as a new document", async () => {
    const world = new PropertyWorld("windows");
    await world.apply({ type: "remote-create", path: 14 });
    await world.apply({ type: "pull" });
    await world.apply({ type: "user-edit", file: 0 });
    // Steps 4-6, one page of the feed: the server moves the document to
    // `no:te.md`, which Windows cannot hold, another document takes `ı.md`,
    // one file with I.md here, and the document moves back to I.md, the
    // other document's F-alias, so this device holds only one of the two.
    await world.apply({ type: "remote-rename", document: 0, path: 11 });
    await world.apply({ type: "remote-create", path: 13 });
    await world.apply({ type: "remote-rename", document: 0, path: 14 });
    // The engine moves the kept I.md aside on the page's second revision,
    // while the server's head of its document is already back at I.md: its
    // head claims no other path, so the move is no detach.
    await world.apply({ type: "pull" });
    const copy = (await world.vault.list()).find((path) => withoutCopyNames(path) !== path) ?? "";
    expect(copy).toMatch(/^I \(conflict .*\)\.md$/);
    await commitAsDevice(world, "forged-new", copy, "user 3");
    await world.apply({ type: "restore", fraction: 1 });
    expect(violations(world, "P1")).toContainEqual(expect.stringMatching(/create of forged-new at .* from inode 1, bound to /));
  });

  it("flags a displaced document's file committed as a new document", async () => {
    const world = new PropertyWorld("posix");
    await world.apply({ type: "user-create", path: 0 });
    await world.apply({ type: "push" });
    // Step 3: a local move of the document to Café.md, which a remote create then takes: the file is displaced under its own id.
    await world.apply({ type: "user-rename", file: 0, mode: "pool", target: 3 });
    await world.apply({ type: "remote-create", path: 3 });
    await world.apply({ type: "pull" });
    const copy = (await world.vault.list()).find((path) => withoutCopyNames(path) !== path) ?? "";
    expect(copy).toMatch(/^Café \(conflict .*\)\.md$/);
    await commitAsDevice(world, "forged-new", copy, "user 1");
    // A restore to the head changes nothing; the world records the forged create while the copy is still inode 1.
    await world.apply({ type: "restore", fraction: 1 });
    expect(violations(world, "P1")).toEqual([expect.stringMatching(/create of forged-new at .* from inode 1, bound to /)]);
  });
});
