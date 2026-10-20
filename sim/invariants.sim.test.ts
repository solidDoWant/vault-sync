// The engine-level user invariants of #22 against the real server: engines
// whose users make random changes keep every invariant, also under Windows
// rules among other platforms; a seed replays identically; and each new
// check catches the bug it exists for, injected as a mutation (an engine
// that loses a user's write, one that drops a file, one that reports its own
// write as the user's on a case-insensitive platform, one that skips a
// remote delete and pushes the file back, #276). Runs from
// `make test-sim` (sim/simulation_test.go).

import { describe, expect, it } from "vitest";

import { simEnvironment } from "./environment";
import { serverFeed } from "./invariants";
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

/**
 * Two POSIX engines (#276): `e1` creates `notes/a.md` and `notes/b.md`, `e2`
 * syncs both, `before` runs, `e1`'s user deletes `notes/b.md` and pushes,
 * `e2` pulls the delete, `after` runs, and `e2` crashes, so its next push is
 * a full scan, and pushes.
 */
async function deleteOnFirstEngine(endpoints: SimEndpoints, before: (run: SimRun) => Promise<string>, after: (run: SimRun) => Promise<string>): Promise<{ result: RunResult; run: SimRun }> {
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
  run.context.log(await before(run));
  run.context.log(await first.remove("notes/b.md"));
  run.context.log(first.startPush());
  await drain();
  run.context.log(second.startPull());
  await drain();
  run.context.log(await after(run));
  run.context.log(second.crash());
  run.context.log(second.startPush());
  await drain();
  return { result: await run.finish(), run };
}

const nothing = () => Promise.resolve("nothing");

/** The paths at which the feed has a live revision right after a tombstone of the same document. */
async function broughtBack(run: SimRun): Promise<string[]> {
  const feed = await serverFeed(run.direct, run.context.vaultId);
  const deleted = new Map<string, boolean>();
  const paths: string[] = [];
  for (const revision of feed) {
    if (!revision.deleted && deleted.get(revision.documentId) === true) paths.push(revision.path);
    deleted.set(revision.documentId, revision.deleted);
  }
  return paths;
}

describe.runIf(suites.has("scenarios"))("resurrected deletes (#276)", () => {
  it("passes the resurrection scenario without a mutation: the delete stays applied everywhere", async () => {
    const { result, run } = await deleteOnFirstEngine(environment, nothing, nothing);
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    expect(await run.observers[0]?.list(), trace).toEqual(["notes/a.md"]);
    expect(await run.observers[1]?.list(), trace).toEqual(["notes/a.md"]);
    expect(await broughtBack(run), trace).toEqual([]);
  });

  it("catches an engine that skips applying a remote delete to its disk and pushes the file back (resurrected-delete)", async () => {
    const { result, run } = await deleteOnFirstEngine(environment, (run) => Promise.resolve(run.observers[1]?.keepFileOnNextDelete("notes/b.md") ?? ""), nothing);
    const trace = tail(result.trace);
    // Every vault converged on the resurrected note: only the new check sees the bug.
    expect(invariants(result), trace).toEqual(["resurrected-delete"]);
    expect(result.violations[0]?.detail, trace).toMatch(/^e2 brought back .* at notes\/b\.md .* after its delete at notes\/b\.md .* although its user changed no file of it since$/);
    expect(await run.observers[0]?.list(), trace).toEqual(["notes/a.md", "notes/b.md"]);
    expect(await broughtBack(run), trace).toEqual(["notes/b.md"]);
  });

  it("accepts a delete undone by the other engine's user's concurrent edit, which wins (SPEC.md §4)", async () => {
    const { result, run } = await deleteOnFirstEngine(environment, async (run) => (await run.observers[1]?.edit("notes/b.md", encoder.encode("b\nedited while deleted elsewhere\n"))) ?? "", nothing);
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    // The edit brought the note back on the engine that deleted it.
    expect(new TextDecoder().decode(await run.observers[0]?.read("notes/b.md")), trace).toBe("b\nedited while deleted elsewhere\n");
    expect(await broughtBack(run), trace).toEqual(["notes/b.md"]);
  });

  it("accepts a deleted note the other engine's user creates again at its path (SPEC.md §8)", async () => {
    const { result, run } = await deleteOnFirstEngine(environment, nothing, async (run) => (await run.observers[1]?.edit("notes/b.md", encoder.encode("b, written again\n"))) ?? "");
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    expect(new TextDecoder().decode(await run.observers[0]?.read("notes/b.md")), trace).toBe("b, written again\n");
    expect(await broughtBack(run), trace).toEqual(["notes/b.md"]);
  });
});

describe.runIf(suites.has("scenarios"))("engine users (#22)", () => {
  it("keeps every invariant when engines' users make random changes under faults, with Windows rules among the engines", async () => {
    const result = await runSeed(environment, { seed: 2, clients: environment.clients, steps: Math.min(environment.steps, 800), engines: 2, platforms: ["windows", "posix"] });
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    // The schedule exercised what the invariants are about.
    const count = (needle: RegExp) => result.trace.filter((line) => needle.test(line)).length;
    // The engines are named after the scripted clients (`SIM_CLIENTS` changes how many): the first, with Windows rules, and the second.
    const windows = `e${String(environment.clients)}`;
    const engines = `(?:${windows}|e${String(environment.clients + 1)})`;
    expect(count(new RegExp(`${engines} user (creates|edits|writes)`)), trace).toBeGreaterThan(10);
    expect(count(new RegExp(`${engines} user renames`)), trace).toBeGreaterThan(0);
    expect(count(new RegExp(`${engines} user deletes`)), trace).toBeGreaterThan(0);
    expect(count(new RegExp(`${engines} acknowledged `)), trace).toBeGreaterThan(10);
    expect(count(new RegExp(`${windows} tracks .* as unmaterializable`)), trace).toBeGreaterThan(0);
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

  // #452: the kept edited file used to hold off for good another note the
  // server put under a folder of its name, deferred path-conflict.
  it("frees a Windows engine's kept edited file's name for a note another device creates under a folder of that name, keeping the edit as a conflict copy", async () => {
    const run = await SimRun.start(environment, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "windows"] });
    const [posix, windows] = run.observers;
    if (posix === undefined || windows === undefined) throw new Error("the run has two engines");
    const drain = async () => {
      await settle();
      await run.drain();
    };
    run.context.log(await posix.edit("notes", encoder.encode("one\n")));
    run.context.log(posix.startPush());
    await drain();
    run.context.log(windows.startPull());
    await drain();
    run.context.log(await windows.edit("notes", encoder.encode("one\nedited on windows\n")));
    run.context.log(await posix.move("notes", "plan?.md"));
    run.context.log(posix.startPush());
    await drain();
    run.context.log(windows.startPull());
    await drain();
    run.context.log(await posix.edit("NOTES/d.md", encoder.encode("another note\n")));
    run.context.log(posix.startPush());
    await drain();
    run.context.log(windows.startPull());
    await drain();
    run.context.log(windows.startPush());
    await drain();
    const result = await run.finish();

    expect(result.violations, tail(result.trace)).toEqual([]);
    const listed = await windows.list();
    expect(listed).toContain("NOTES/d.md");
    const copies = listed.filter((path) => path.startsWith("notes (conflict "));
    expect(copies, listed.join(", ")).toHaveLength(1);
    expect(new TextDecoder().decode(await windows.read(copies[0] ?? ""))).toBe("one\nedited on windows\n");
    expect(listed).toHaveLength(2);
    expect(await windows.unmaterializable()).toEqual(new Map([["plan?.md", "forbidden-character"]]));
    expect(await posix.list()).toEqual([...listed, "plan?.md"].sort());
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
