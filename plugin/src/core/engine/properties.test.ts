// Model-based property suite of docs/design/engine-path-ownership.md §9.3:
// fast-check commands drive device A's engine, a scripted remote device, the
// server's history operations and crashes at the Nth journal write, over the
// in-memory server, vault and journal (PropertyWorld in ./testing.ts). The
// harness's oracle (inodes, content origins, bindings) is independent of the
// engine's journal.
//
// Each property that the engine violates today is a `knownFailure` with the
// issue that tracks its class, pinned to a minimal counterexample and the
// violation it fails with; the pinned case runs first, at any seed. Flipping
// one to `holds` is the refactor's progress measure (§9.2): a known failure
// whose property starts to hold fails the suite. A run that throws anything
// but a PropertyViolation (a TypeError, a broken harness invariant) is a
// harness bug and fails every property, known failures included, so a broken
// harness cannot pass for an engine violation (#587).
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
import { PropertyWorld, testDeviceId, type PropertyId, type RenameMode, type WorldCommand } from "./testing";
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
  index.map((file) => ({ type: "edit-during-pull", file })),
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

type Property = "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

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
 * here: it is a harness bug, and would otherwise let a known failure pass
 * without an engine violation.
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

/** The property holds: fast-check finds no counterexample. */
async function holds<T>(definition: Definition<T>): Promise<void> {
  const details = await search(definition);
  if (details.failed) expect.fail(report(details));
}

/** A known failure's pinned minimal counterexample and the violation it fails with. */
interface Pin<T> {
  example: T;
  violation: RegExp;
}

/**
 * The engine violates the property today. Its pinned counterexample runs
 * first, whatever the seed, and must fail with a violation of this property
 * that matches the pin. A known failure whose property holds, on the pinned
 * case and every generated one, fails, so that it is flipped to `holds`.
 */
async function knownFailure<T>(definition: Definition<T>, pin: Pin<T>): Promise<void> {
  const details = await search(definition, [pin.example]);
  if (!details.failed) expect.fail(`${definition.property} holds now: make it \`holds\` (${String(details.numRuns)} cases, seed ${String(seed)})`);
  const error = details.errorInstance;
  if (!(error instanceof PropertyViolation) || error.property !== definition.property) expect.fail(`${definition.property} failed with something other than its own violation:\n${report(details)}`);
  if (!error.found.some((found) => pin.violation.test(found))) expect.fail(`${definition.property}'s pinned counterexample no longer fails with ${String(pin.violation)}; re-pin it to the counterexample below:\n${report(details)}`);
}

/** A world property's case: the platform and the commands, as data. */
function scripted(on: PathPlatform, ...list: WorldCommand[]): [PathPlatform, Iterable<fc.AsyncCommand<object, PropertyWorld>>] {
  return [on, list.map((command) => new Step(command))];
}

const p1 = overWorld("P1", (world) => violations(world, "P1"));
const p2 = overWorld("P2", (world) => violations(world, "P2"));
const p3 = overWorld("P3", (world) => violations(world, "P3"));
const p4: Definition<[PathPlatform, WorldCommand[], number]> = {
  property: "P4",
  cases: fc.tuple(platform, fc.array(fc.oneof(...steadyCommands), { maxLength: maxCommands, size: "max" }), fc.integer({ min: 1, max: 40 })),
  check: async ([on, list, write]) => {
    const baseline = new PropertyWorld(on);
    for (const command of list) await baseline.apply(command);
    await baseline.quiesce();
    const crashed = new PropertyWorld(on);
    crashed.armCrash(write);
    for (const command of list) await crashed.apply(command);
    await crashed.quiesce();
    const [without, crashing] = [await baseline.outcome(), await crashed.outcome()];
    return without === crashing ? [] : [`a crash at journal write ${String(write)} reaches ${crashing}, the run without it ${without}`];
  },
};
const p5 = overWorld("P5", (world) => world.lostWrites());
const p6 = overWorld("P6", async (world, quiet) => [...(quiet ? [] : ["no quiescence within the round bound"]), ...world.errors.map((error) => `error: ${String(error)}`), ...(await world.convergence())], convergingCommands);

describe("engine properties (design §9.3)", () => {
  // P1 identity: INV-3 and PO-1. A document's committed content always comes from the inode bound to it.
  it("P1: a document's committed content comes from its own file", { timeout }, async () => {
    await holds(p1);
  });

  // P2 provenance: INV-5 and INV-6 (PO-6/7) on inodes.
  it("P2: tombstones come from user deletes, resurrections from user changes", { timeout }, async () => {
    await holds(p2);
  });

  // P3 exclusivity: INV-1 and INV-2 after every command.
  // Fails today (flips in R7 #571): after a database restore the journal keeps a document the server lost live at a path key another document then claims.
  it("P3: no two live documents or live outboxes claim one path key (known failure)", { timeout }, async () => {
    await knownFailure(p3, {
      example: scripted("posix", { type: "remote-create", path: 5 }, { type: "push" }, { type: "restore", fraction: 0 }, { type: "remote-create", path: 0 }, { type: "remote-rename", document: 0, path: 6 }),
      violation: /^step \d+: live documents r-1@"Straße\.md" and r-4@"STRASSE\.md" collide under K$/,
    });
  });

  // P4 crash equivalence: INV-7. Crashing at journal write N and restarting reaches the same quiescent state, modulo copy names.
  // Fails today (flips in R8 #572; re-pinned in R5a #622, which fixed the crash-lost rename that was pinned before; this counterexample fails on master too): after a database restore, a crash at a journal write leaves a remote file in the vault that the run without the crash does not keep.
  it("P4: a crash at any journal write reaches the state a run without it reaches (known failure)", { timeout }, async () => {
    await knownFailure(p4, {
      example: [
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
      violation: /^a crash at journal write 12 reaches \{"vault":\["a\.md=remote 6"\],"server":\[\]\}, the run without it \{"vault":\[\],"server":\[\]\}$/,
    });
  });

  // P5 no lost write: INV-4 plus principle 1, against server history.
  it("P5: every user write is in the vault or was accepted by the server", { timeout }, async () => {
    await holds(p5);
  });

  // P6 convergence and progress: INV-8 and INV-9 after quiescence, with bounded push rounds.
  // Fails today (#583, blocked by R7 #571; PO-11): the engine's own file of a remote note holds the folder that note's next path needs, and the revision stays deferred (path-conflict) for good.
  it("P6: the device converges with the server within bounded rounds (known failure)", { timeout }, async () => {
    await knownFailure(p6, {
      example: scripted("posix", { type: "user-create", path: 8 }, { type: "remote-create", path: 8 }, { type: "remote-rename", document: 0, path: 7 }, { type: "user-edit", file: 0 }),
      violation: /^deferred revisions left: r-2 \(path-conflict\)$/,
    });
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
