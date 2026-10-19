// The engine-level user invariants of #22 against the real server: engines
// whose users make random changes keep every invariant, also under Windows
// rules among other platforms; a seed replays identically; and each new
// check catches the bug it exists for, injected as a mutation (an engine
// that loses a user's write, one that drops a file, one that reports its own
// write as the user's on a case-insensitive platform). Runs from
// `make test-sim` (sim/simulation_test.go).

import { describe, expect, it } from "vitest";

import { simEnvironment } from "./environment";
import { settle } from "./network";
import { runSeed, SimRun, type RunResult, type SimEndpoints } from "./runner";

const environment = simEnvironment();
const suites = new Set(environment.suites);
const encoder = new TextEncoder();

function tail(trace: readonly string[], lines = 120): string {
  return trace.slice(-lines).join("\n");
}

const invariants = (result: RunResult) => [...new Set(result.violations.map((violation) => violation.invariant))].sort();

/** Two POSIX engines that share notes; `mutate` gets them after `e2` has synced both notes and its user edited `notes/a.md`. */
async function twoEngines(endpoints: SimEndpoints, mutate: (run: SimRun) => Promise<string>): Promise<RunResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const drain = async () => {
    await settle();
    await run.drain();
  };
  run.context.log(await first.edit("notes/a.md", encoder.encode("a\n")));
  run.context.log(await first.edit("notes/b.md", encoder.encode("b\n")));
  run.context.log(first.startPush());
  await drain();
  run.context.log(second.startPull());
  await drain();
  run.context.log(await second.edit("notes/a.md", encoder.encode("a\nedited by the second engine's user\n")));
  run.context.log(await mutate(run));
  run.context.log(second.startPush());
  await drain();
  return run.finish();
}

/**
 * A POSIX engine and a macOS one (#247). `e1` creates `straße.md` and
 * `notes/b.md`; `e2` syncs both, then its user writes `STRASSE.md`, which
 * the macOS vault resolves to `straße.md` and reports as a modify of it.
 * `mutate` gets the run after that write; then `e2` pushes and `e1` pulls.
 */
async function macosUserWritesAnotherSpelling(endpoints: SimEndpoints, mutate: (run: SimRun) => Promise<string>): Promise<{ result: RunResult; run: SimRun }> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "macos"] });
  const [posix, macos] = run.observers;
  if (posix === undefined || macos === undefined) throw new Error("the run has two engines");
  const drain = async () => {
    await settle();
    await run.drain();
  };
  run.context.log(await posix.edit("straße.md", encoder.encode("one\n")));
  run.context.log(await posix.edit("notes/b.md", encoder.encode("b\n")));
  run.context.log(posix.startPush());
  await drain();
  run.context.log(macos.startPull());
  await drain();
  run.context.log(await macos.edit("STRASSE.md", encoder.encode("one\nedited on macos\n")));
  run.context.log(await mutate(run));
  run.context.log(macos.startPush());
  await drain();
  run.context.log(posix.startPull());
  await drain();
  return { result: await run.finish(), run };
}

describe.runIf(suites.has("scenarios"))("engine users (#22)", () => {
  it("keeps every invariant when engines' users make random changes under faults, with Windows rules among the engines", async () => {
    const result = await runSeed(environment, { seed: 2, clients: environment.clients, steps: Math.min(environment.steps, 800), engines: 2, platforms: ["windows", "posix"] });
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    // The schedule exercised what the invariants are about.
    const count = (needle: RegExp) => result.trace.filter((line) => needle.test(line)).length;
    expect(count(/e[34] user (creates|edits|writes)/), trace).toBeGreaterThan(10);
    expect(count(/e[34] user renames/), trace).toBeGreaterThan(0);
    expect(count(/e[34] user deletes/), trace).toBeGreaterThan(0);
    expect(count(/e[34] acknowledged /), trace).toBeGreaterThan(10);
    expect(count(/e3 tracks .* as unmaterializable/), trace).toBeGreaterThan(0);
    expect(count(/restarted with its vault and journal/), trace).toBeGreaterThan(0);
    expect(count(/lost/), trace).toBeGreaterThan(0);
  });

  it("replays the identical trace when a seed with engine users is re-run", async () => {
    const options = { seed: environment.seeds[0] ?? 1, clients: environment.clients, steps: Math.min(environment.steps, 200), engines: 2, platforms: ["macos", "windows"] as const };
    const first = await runSeed(environment, { ...options, platforms: [...options.platforms] });
    const second = await runSeed(environment, { ...options, platforms: [...options.platforms] });

    expect(second.trace).toEqual(first.trace);
    expect(first.trace.some((line) => / user (creates|edits|writes) /.test(line))).toBe(true);
  });

  it("holds the invariants modulo the unmaterializable set: a Windows engine keeps its user's edit of a note renamed to a name Windows cannot hold", async () => {
    const run = await SimRun.start(environment, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "windows"] });
    const [posix, windows] = run.observers;
    if (posix === undefined || windows === undefined) throw new Error("the run has two engines");
    const drain = async () => {
      await settle();
      await run.drain();
    };
    run.context.log(await posix.edit("plan.md", encoder.encode("one\n")));
    run.context.log(posix.startPush());
    await drain();
    run.context.log(windows.startPull());
    await drain();
    run.context.log(await windows.edit("plan.md", encoder.encode("one\nedited on windows\n")));
    run.context.log(await posix.move("plan.md", "plan?.md"));
    run.context.log(posix.startPush());
    await drain();
    run.context.log(windows.startPull());
    await drain();
    const result = await run.finish();

    // The edit stays on Windows, unpushed, outside the live paths; nothing is lost, deleted or unconverged.
    expect(result.violations, tail(result.trace)).toEqual([]);
    expect(await windows.list()).toEqual(["plan.md"]);
    expect(new TextDecoder().decode(await windows.read("plan.md"))).toBe("one\nedited on windows\n");
    expect(await windows.unmaterializable()).toEqual(new Map([["plan?.md", "forbidden-character"]]));
    expect(await posix.list()).toEqual(["plan?.md"]);
  });

  it("passes the mutation tests' scenario without a mutation", async () => {
    const result = await twoEngines(environment, () => Promise.resolve("no mutation"));
    expect(result.violations, tail(result.trace)).toEqual([]);
  });

  it("catches an engine that loses a user's write (lost-write)", async () => {
    const result = await twoEngines(environment, async (run) => {
      // What the engine wrote over the edit, before pushing it: the content the user had edited.
      return run.observers[1]?.overwriteBehindUser("notes/a.md", encoder.encode("a\n")) ?? "";
    });
    expect(invariants(result), tail(result.trace)).toEqual(["lost-write"]);
    expect(result.violations[0]?.detail).toContain("e2's user wrote");
    expect(result.violations[0]?.detail).toContain("to notes/a.md");
  });

  it("attributes to the user a write the macOS vault reports under the file's own spelling, which the engine pushes as an edit (#247)", async () => {
    const { result, run } = await macosUserWritesAnotherSpelling(environment, () => Promise.resolve("no mutation"));
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    // The write is an edit of the synced note, under the note's own spelling, on both engines.
    expect(await run.observers[1]?.list(), trace).toEqual(["notes/b.md", "straße.md"]);
    expect(await run.observers[0]?.list(), trace).toEqual(["notes/b.md", "straße.md"]);
    expect(new TextDecoder().decode(await run.observers[0]?.read("straße.md")), trace).toBe("one\nedited on macos\n");
  });

  it("still catches an engine that reports its own write as a local change on a case-insensitive platform (engine-echo)", async () => {
    // An engine write of the content the file already has, not suppressed: reported at notes/b.md, which the user never changed under any spelling.
    const { result } = await macosUserWritesAnotherSpelling(environment, async (run) => run.observers[1]?.overwriteBehindUser("NOTES/B.md", encoder.encode("b\n")) ?? "");
    expect(invariants(result), tail(result.trace)).toEqual(["engine-echo"]);
    expect(result.violations.map((violation) => violation.detail)).toEqual(["e2 reported its own modify of notes/b.md as a local change"]);
  });

  it("catches an engine that drops a file its user never deleted (phantom-delete)", async () => {
    const result = await twoEngines(environment, async (run) => run.observers[1]?.deleteBehindUser("notes/b.md") ?? "");
    // The engine also reported its own delete as a local change, which engine-echo catches; the delete it pushed is phantom-delete's.
    expect(invariants(result), tail(result.trace)).toEqual(["engine-echo", "phantom-delete"]);
    const phantom = result.violations.find((violation) => violation.invariant === "phantom-delete");
    expect(phantom?.detail).toContain("e2 deleted");
    expect(phantom?.detail).toContain("at notes/b.md");
  });
});
