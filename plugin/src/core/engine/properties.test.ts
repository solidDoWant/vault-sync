// Model-based property suite of docs/design/engine-path-ownership.md §9.3:
// fast-check commands drive device A's engine, a scripted remote device, the
// server's history operations and crashes at the Nth journal write, over the
// in-memory server, vault and journal (PropertyWorld in ./testing.ts). The
// harness's oracle (inodes, content origins, bindings) is independent of the
// engine's journal.
//
// Each property that the engine violates today is `it.fails` with the issue
// that tracks its class. Flipping one to `it` is the refactor's progress
// measure (§9.2): an `it.fails` whose property starts to hold fails the suite.
//
// Runs are deterministic: a fixed seed and bounded runs (§9.3's 2,000 cases
// per PR, up to 40 commands each), no wall clock. To explore, change `seed`
// or `runs` locally; fast-check prints the counterexample and its replay
// path.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PathPlatform } from "../vaultpath/platform";
import { PropertyWorld, type PropertyId, type RenameMode, type WorldCommand } from "./testing";

const runs = 2000;
const seed = 563;
const maxCommands = 40;

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

/** The alphabet of §9.3 without crashes (P4 places its own crash). */
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
  fc.constant({ type: "push" }),
  restore,
  index.map((revision) => ({ type: "purge", revision })),
];

const allCommands: fc.Arbitrary<WorldCommand>[] = [...steadyCommands, fc.integer({ min: 1, max: 12 }).map((write) => ({ type: "crash", write }))];

/**
 * P6's alphabet: no database restore. A document the restored server lost
 * stays on the device unpushed until it changes (SPEC.md §8, divergence,
 * #156), which INV-9 does not yet account for.
 */
const convergingCommands = allCommands.filter((command) => command !== restore);

const platform = fc.constantFrom<PathPlatform>("posix", "windows", "macos");

function commands(alphabet: fc.Arbitrary<WorldCommand>[]) {
  return fc.commands(
    alphabet.map((command) => command.map((data) => new Step(data))),
    { maxCommands, size: "max" },
  );
}

/** Runs the commands on a fresh world and brings it to quiescence. */
async function play(on: PathPlatform, steps: Iterable<fc.AsyncCommand<object, PropertyWorld>>): Promise<{ world: PropertyWorld; quiet: boolean }> {
  const world = new PropertyWorld(on);
  await fc.asyncModelRun(() => ({ model: {}, real: world }), steps);
  const quiet = await world.quiesce();
  return { world, quiet };
}

function violations(world: PropertyWorld, property: PropertyId): string[] {
  return world.violations.filter((violation) => violation.property === property).map((violation) => `step ${String(violation.step)}: ${violation.message}`);
}

/** Asserts that `check` finds nothing after every run of `alphabet` (by default the full one, crashes included). */
async function holds(check: (world: PropertyWorld, quiet: boolean) => Promise<string[]> | string[], alphabet = allCommands): Promise<void> {
  await fc.assert(
    fc.asyncProperty(platform, commands(alphabet), async (on, steps) => {
      const { world, quiet } = await play(on, steps);
      expect(await check(world, quiet)).toEqual([]);
    }),
    { seed, numRuns: runs, endOnFailure: false },
  );
}

describe("engine properties (design §9.3)", { timeout: 300_000 }, () => {
  // P1 identity: INV-3 and PO-1. A document's committed content always comes from the inode bound to it.
  // Fails today (#545, flips in R5 #569): a note renamed or edited after a remote delete of it was committed comes back as a new document, not as the original.
  it.fails("P1: a document's committed content comes from its own file", async () => {
    await holds((world) => violations(world, "P1"));
  });

  // P2 provenance: INV-5 and INV-6 (PO-6/7) on inodes.
  // Fails today (the crash-lost-rename class of #531 and #550; flips in R5 #569): a rename held only in memory is lost to a crash, so it is committed as a delete of the document plus a new one.
  it.fails("P2: tombstones come from user deletes, resurrections from user changes", async () => {
    await holds((world) => violations(world, "P2"));
  });

  // P3 exclusivity: INV-1 and INV-2 after every command.
  // Fails today (flips in R7 #571): after a database restore the journal keeps a document the server lost live at a path key another document then claims.
  it.fails("P3: no two live documents or live outboxes claim one path key", async () => {
    await holds((world) => violations(world, "P3"));
  });

  // P4 crash equivalence: INV-7. Crashing at journal write N and restarting reaches the same quiescent state, modulo copy names.
  // Fails today (flips in R8 #572; its minimal case today is the crash-lost rename of P2, R5 #569): a crash in a pull leaves another quiescent vault and server than the run without it.
  it.fails("P4: a crash at any journal write reaches the state a run without it reaches", async () => {
    await fc.assert(
      fc.asyncProperty(platform, fc.array(fc.oneof(...steadyCommands), { maxLength: maxCommands, size: "max" }), fc.integer({ min: 1, max: 40 }), async (on, list, write) => {
        const baseline = new PropertyWorld(on);
        for (const command of list) await baseline.apply(command);
        await baseline.quiesce();
        const crashed = new PropertyWorld(on);
        crashed.armCrash(write);
        for (const command of list) await crashed.apply(command);
        await crashed.quiesce();
        expect(await crashed.outcome()).toEqual(await baseline.outcome());
      }),
      { seed, numRuns: runs, endOnFailure: false },
    );
  });

  // P5 no lost write: INV-4 plus principle 1, against server history.
  it("P5: every user write is in the vault or was accepted by the server", async () => {
    await holds((world) => world.lostWrites());
  });

  // P6 convergence and progress: INV-8 and INV-9 after quiescence, with bounded push rounds.
  // Fails today (flips in R7 #571, PO-11): the engine's own file of a remote note holds the folder that note's next path needs, and the revision stays deferred (path-conflict) for good.
  it.fails("P6: the device converges with the server within bounded rounds", async () => {
    await holds(async (world, quiet) => [...(quiet ? [] : ["no quiescence within the round bound"]), ...world.errors.map((error) => `error: ${String(error)}`), ...(await world.convergence())], convergingCommands);
  });
});
