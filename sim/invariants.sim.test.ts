// The engine-level user invariants of #22 against the real server: engines
// whose users make random changes keep every invariant, also under Windows
// rules among other platforms; a seed replays identically; and each new
// check catches the bug it exists for, injected as a mutation (an engine
// that loses a user's write, one that drops a file, one that reports its own
// write as the user's on a case-insensitive platform, one that skips a
// remote delete and pushes the file back, #276). Runs from
// `make test-sim` (sim/simulation_test.go).

import { describe, expect, it } from "vitest";

import type { MergeHook } from "../plugin/src/core/engine/merge";
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

/** The contents of concurrentEdits: the note `e1` creates, `e1`'s edit of it and `e2`'s. */
interface ConcurrentContents {
  base: string;
  first: string;
  second: string;
}

/**
 * Two POSIX engines whose users edit `notes/a.md` concurrently (#301): `e1`
 * creates it, `e2` syncs it, `e1`'s user adds a line and pushes, `e2`'s user
 * adds another, `e2` gets `merge` as its merge hook and pulls, so the hook
 * merges the two edits, and pushes.
 */
async function concurrentEdits(
  endpoints: SimEndpoints,
  merge: MergeHook | undefined,
  contents: ConcurrentContents = { base: "a\n", first: "a\nfrom the first engine's user\n", second: "from the second engine's user\na\n" },
): Promise<{ result: RunResult; run: SimRun }> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const drain = async () => {
    await settle();
    await run.drain();
  };
  run.context.log(await first.edit("notes/a.md", encoder.encode(contents.base)));
  run.context.log(first.startPush());
  await drain();
  run.context.log(second.startPull());
  await drain();
  run.context.log(await first.edit("notes/a.md", encoder.encode(contents.first)));
  run.context.log(first.startPush());
  await drain();
  run.context.log(await second.edit("notes/a.md", encoder.encode(contents.second)));
  second.merge = merge;
  run.context.log(second.startPull());
  await drain();
  run.context.log(second.startPush());
  await drain();
  return { result: await run.finish(), run };
}

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

/** `e2`'s user edits `notes/b.md` to `content` and `e2` pushes it; `e1` pulls the edit (so its delete is of that revision). */
const committedEdit = (content: string) => async (run: SimRun) => {
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const entries = [await second.edit("notes/b.md", encoder.encode(content)), second.startPush()];
  await settle();
  await run.drain();
  entries.push(first.startPull());
  await settle();
  await run.drain();
  return entries.join("; ");
};

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

  // #422 item 5: the edit was committed before the delete, so it explains nothing (explained(), "already carried").
  it("catches an engine that brings back a deleted note whose edit its user had already committed before the delete (resurrected-delete)", async () => {
    const edited = committedEdit("b\nedited and committed before the delete\n");
    const { result, run } = await deleteOnFirstEngine(
      environment,
      async (run) => [await edited(run), run.observers[1]?.keepFileOnNextDelete("notes/b.md")].join("; "),
      nothing,
    );
    const trace = tail(result.trace);
    expect(invariants(result), trace).toEqual(["resurrected-delete"]);
    expect(result.violations[0]?.detail, trace).toMatch(/^e2 brought back .* at notes\/b\.md .* although its user changed no file of it since$/);
    expect(await broughtBack(run), trace).toEqual(["notes/b.md"]);
  });

  // #422 item 5: only the server seq recorded with each change tells this re-creation from the earlier, already committed edit of the same content.
  it("accepts a re-creation of a deleted note with the content its engine had committed before the delete", async () => {
    const content = "b\nwritten before and after the delete\n";
    const { result, run } = await deleteOnFirstEngine(environment, committedEdit(content), async (run) => (await run.observers[1]?.edit("notes/b.md", encoder.encode(content))) ?? "");
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    expect(new TextDecoder().decode(await run.observers[0]?.read("notes/b.md")), trace).toBe(content);
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
    // The engine also reported its own overwrite as a local change, which engine-echo catches (#422: no longer excused by the user's earlier edit there); the lost edit is lost-write's.
    expect(invariants(result), tail(result.trace)).toEqual(["engine-echo", "lost-write"]);
    const lost = result.violations.find((violation) => violation.invariant === "lost-write");
    expect(lost?.detail).toContain("e2's user wrote");
    expect(lost?.detail).toContain("to notes/a.md");
  });

  // #422 item 1: an echo is excused only by the user operation it fired in, not by the path.
  it("catches an engine echo at a path its user changed earlier in the run (engine-echo)", async () => {
    // The content the user wrote, so no write is lost: only the unsuppressed engine write is wrong.
    const result = await twoEngines(environment, async (run) => run.observers[1]?.overwriteBehindUser("notes/a.md", encoder.encode("a\nedited by the second engine's user\n")) ?? "");
    expect(invariants(result), tail(result.trace)).toEqual(["engine-echo"]);
    expect(result.violations.map((violation) => violation.detail)).toEqual(["e2 reported its own modify of notes/a.md as a local change"]);
  });

  it("passes concurrent edits that the merge hook merges (#301)", async () => {
    const { result, run } = await concurrentEdits(environment, undefined);
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    // Both users' lines are in the note on both engines.
    for (const engine of run.observers) {
      const merged = new TextDecoder().decode(await engine.read("notes/a.md"));
      expect(merged, trace).toContain("from the first engine's user\n");
      expect(merged, trace).toContain("from the second engine's user\n");
    }
  });

  // #422 item 4: lost-write checks what the merge result holds, not the hook's record of having merged.
  it("catches a merge that drops the local edit but reports it as merged (lost-write)", async () => {
    const dropLocal: MergeHook = async (request) => ({ status: "merged", content: await request.readRemoteContent() });
    const { result } = await concurrentEdits(environment, dropLocal);
    const trace = tail(result.trace);
    expect(invariants(result), trace).toEqual(["lost-write"]);
    expect(result.violations[0]?.detail, trace).toContain("e2's user wrote");
  });

  it("catches a merge that drops a one-word local addition the remote content holds within a line, but reports it as merged (#717)", async () => {
    const dropLocal: MergeHook = async (request) => ({ status: "merged", content: await request.readRemoteContent() });
    const { result } = await concurrentEdits(environment, dropLocal, { base: "a\n", first: "a\nfrom the first engine's user\n", second: "a\nfirst\n" });
    const trace = tail(result.trace);
    expect(invariants(result), trace).toEqual(["lost-write"]);
    expect(result.violations[0]?.detail, trace).toContain("e2's user wrote");
  });

  it("passes a correct merge, by a hook that never reads the base, of a remote delete of a line the local edit kept (#717)", async () => {
    // The line merge of the two edits, which this hook knows without reading the base.
    const known: MergeHook = () => Promise.resolve({ status: "merged", content: encoder.encode("a\nlocal\n") });
    const { result, run } = await concurrentEdits(environment, known, { base: "a\nb\n", first: "a\n", second: "a\nb\nlocal\n" });
    const trace = tail(result.trace);
    expect(result.violations, trace).toEqual([]);
    for (const engine of run.observers) expect(new TextDecoder().decode(await engine.read("notes/a.md")), trace).toBe("a\nlocal\n");
  });

  // #422 item 7: on a server that was never restored or purged, a pull that resyncs is a bug.
  it("catches an engine whose pulls resync on a server that was neither restored nor purged (engine-resync)", async () => {
    const result = await twoEngines(environment, async (run) => {
      const second = run.observers[1];
      if (second === undefined) throw new Error("the run has two engines");
      // The pull stores a corrupted anchor; the pulls of finish() then send it.
      const entries = [second.mangleCursorAnchors(), second.startPull()];
      await settle();
      await run.drain();
      return entries.join("; ");
    });
    const trace = tail(result.trace);
    expect(invariants(result), trace).toEqual(["engine-resync"]);
    expect(result.violations[0]?.detail, trace).toMatch(/^e2's pull at step \d+ resynced, although the server was neither restored nor purged$/);
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
