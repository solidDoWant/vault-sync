// The networked simulation suite (SPEC.md §13). It needs a running server and
// the driver's control endpoint, so it runs only from `make test-sim`, through
// sim/simulation_test.go and plugin/vitest.sim.config.ts; `make test` excludes
// it.

import { describe, expect, it } from "vitest";

import { Control } from "./control";
import { simEnvironment } from "./environment";
import { runSeed, runSteps, seededCommitRetryBackoff, seededPlatforms, type RunResult } from "./runner";
import { configFolderSync, engineBacksOffWhenThrottled, enginePushUnderFaults, enginesEditConcurrently, lostResponseAfterHeadMoved, remoteRenameOntoUnsyncedFile, saveBeforeEngineWrite, structuralOperations, unmaterializableOnWindows, freedPathReused, purgedMergeBase, newDocumentAtHeldPath, knownDocumentAtHeldPath, renameLostToCrash, backslashPathsRefused, drivePrefixPathsRefused, serverRefusedPathsSurfaced, normalizedTooLongPath, commitRetryAfterSchedule, stalledEngineReported, fileAtVacatedPath, type VacatedPathResult, scriptedChangesOfBinary } from "./scenarios";
import { StallError } from "./network";
import { generateSchedule, type Step } from "./schedule";
import { shrink } from "./shrink";

const environment = simEnvironment();
const suites = new Set(environment.suites);

/** The last lines of a trace, enough to see how a failure came about. */
function tail(trace: readonly string[], lines = 80): string {
  return trace.slice(-lines).join("\n");
}

/** How often notable events occurred in a run, to show what a schedule exercised. */
function summarize(trace: readonly string[]): string {
  const events: [string, string][] = [
    ["acknowledged", " acknowledged "],
    ["head moved", "head moved"],
    ["path taken", "path taken"],
    ["retried after network failure", "retries "],
    ["requests lost", "request lost"],
    ["responses lost", "response lost after"],
    ["delayed", " held for "],
    ["reordered", "out of order"],
    ["partitions", " partitioned for "],
    ["crashes", " crashed and restarted"],
    ["engine pulls completed", " deferred"],
    ["engine pulls interrupted", "engine pull interrupted"],
    ["engine crashes", "restarted with its vault and journal"],
    ["tracked as unmaterializable", " as unmaterializable ("],
    // Steps that did nothing: an operation for a busy client, a delivery with nothing to deliver.
    ["operations skipped (busy)", " skipped"],
    ["idle deliveries", ": no deliverable"],
    ["engine user changes", " user "],
    ["engine pushes completed", " pushed: "],
  ];
  return events.map(([name, needle]) => `${name} ${String(trace.filter((line) => line.includes(needle)).length)}`).join(", ");
}

function describeViolations(result: RunResult): string {
  return result.violations.map((violation) => `  ${violation.invariant}: ${violation.detail}`).join("\n");
}

describe.runIf(suites.has("seeds"))("seeded schedules", () => {
  it.each(environment.seeds)("seed %i keeps every invariant", async (seed) => {
    // Without engine users (SIM_ENGINES=0) `engines` stays unset: one engine
    // only pulls, and a recorded case replays the same way.
    const engines = environment.engines === 0 ? undefined : environment.engines;
    const options = { seed, clients: environment.clients, engines, platforms: seededPlatforms(seed, engines ?? 1), commitRetryBackoff: seededCommitRetryBackoff };
    const result = await runSeed(environment, { ...options, steps: environment.steps });
    console.log(`seed ${String(seed)} (${options.platforms.join(", ")} path rules): ${summarize(result.trace)}`);
    if (result.violations.length === 0) return;

    // Minimize: keep removing steps while a violation of the same kind remains.
    const invariants = new Set(result.violations.map((violation) => violation.invariant));
    const stillFails = async (steps: Step[]) => (await runSteps(environment, options, steps)).violations.some((violation) => invariants.has(violation.invariant));
    const minimized = await shrink(result.steps, stillFails, environment.shrinkRuns);
    const replay = await runSteps(environment, options, minimized.items);
    const [steps, final] = replay.violations.length > 0 ? [minimized.items, replay] : [result.steps, result];
    const written = await new Control(environment.controlUrl).report({ name: `seed-${String(seed)}`, seed, clients: options.clients, engines: options.engines, commitRetryBackoff: options.commitRetryBackoff, violations: final.violations, steps });

    expect.fail(
      [
        `SIM FAILURE: seed ${String(seed)} violated invariants (${String(environment.steps)} steps, ${String(options.clients)} clients):`,
        describeViolations(result),
        `Minimized to ${String(steps.length)} steps in ${String(minimized.runs)} runs, which violate:`,
        describeViolations(final),
        `Regression case written to ${written}.`,
        `Replay with: make test-sim SIM_SEED=${String(seed)} SIM_STEPS=${String(environment.steps)} SIM_CLIENTS=${String(options.clients)} SIM_ENGINES=${String(environment.engines)}`,
        "Trace of the minimized schedule (last lines):",
        tail(final.trace),
      ].join("\n"),
    );
  });
});

describe.runIf(suites.has("regressions") && environment.regressions.length > 0)("committed regression cases", () => {
  it.each(environment.regressions.map((regression) => [regression.name, regression] as const))("%s keeps every invariant", async (_name, regression) => {
    const engines = regression.engines ?? 1;
    const result = await runSteps(environment, { seed: regression.seed, clients: regression.clients, engines, platforms: seededPlatforms(regression.seed, engines), commitRetryBackoff: regression.commitRetryBackoff }, regression.steps);
    expect(result.violations, tail(result.trace)).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted scenarios", () => {
  it("returns the committed revision when a commit whose response was lost is retried after the head moved", async () => {
    const result = await lostResponseAfterHeadMoved(environment);
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    // c0's retry got its own revision back, and c1's commit landed on top of it.
    expect(result.acknowledgedBy[0], trace).toContain(result.retried);
    expect(result.trace.filter((line) => line.includes(`${result.retried} -> FailedPrecondition`)), trace).toEqual([]);
    const seqOf = (label: string) => result.trace.find((line) => line.includes(`acknowledged ${label} `))?.match(/seq=(\d+)/)?.[1];
    const retriedSeq = Number(seqOf(result.retried));
    const otherSeq = Number(seqOf(result.acknowledgedBy[1]?.at(-1) ?? ""));
    expect(retriedSeq, trace).toBeLessThan(otherSeq);
    // The retry really did happen after c1's commit moved the head.
    const retryAt = result.trace.findIndex((line) => line.includes(`acknowledged ${result.retried} `));
    const otherAt = result.trace.findIndex((line) => line.includes(`acknowledged ${result.acknowledgedBy[1]?.at(-1) ?? "?"} `));
    expect(otherAt, trace).toBeLessThan(retryAt);
  });

  it("pushes the engine's edits through a lost commit response, a moved head and an interrupted upload", async () => {
    const result = await enginePushUnderFaults(environment);
    const trace = tail(result.trace, 160);

    expect(result.violations, trace).toEqual([]);
    // The lost commit was retried with its revision id: acknowledged once, never a conflict.
    expect(result.engineAcknowledged.filter((revision) => revision.label === result.lostCommit), trace).toHaveLength(1);
    expect(result.trace.filter((line) => line.includes(`${result.lostCommit} -> FailedPrecondition`)), trace).toEqual([]);
    // The second edit met the moved head, was merged and committed on top of it.
    expect(result.engineAcknowledged.map((revision) => revision.base), trace).toContain(result.movedHead);
    expect(result.engineAcknowledged, trace).toHaveLength(2);
    expect(result.serverContent, trace).toBe(result.engineContent);
    expect(result.serverContent.endsWith("engine edit 2\n"), trace).toBe(true);
    expect(result.serverContent.length, trace).toBeGreaterThan("engine edit 2\n".length);
    // The restarted engine resumed the upload where the server's session stood.
    expect(result.chunksBeforeCrash, trace).toEqual(["0"]);
    expect(result.chunksAfterCrash, trace).toEqual(["65536", "131072"]);
  });

  it("backs the engine off, bounded and jittered, when the server's per-user limit refuses its calls, and loses no write", async () => {
    const result = await engineBacksOffWhenThrottled(environment);
    const trace = tail(result.trace, 160);

    // Includes the network's check that the engine sent nothing while it backed off.
    expect(result.violations, trace).toEqual([]);
    expect(result.refused, trace).toEqual(["CommitRevision", "ListChanges", "BeginBlob", "CommitRevision", "ListChanges"]);
    // Half of a ceiling that doubles from 1 s with each consecutive refusal, plus a random part of the other half; a push that succeeded starts it over.
    const bounds = [
      [500, 1000],
      [1000, 2000],
      [2000, 4000],
      [4000, 8000],
      [500, 1000],
    ];
    expect(result.delays, trace).toHaveLength(bounds.length);
    result.delays.forEach((delay, index) => {
      expect(delay, `backoff ${String(index + 1)}\n${trace}`).toBeGreaterThanOrEqual(bounds[index]?.[0] ?? Infinity);
      expect(delay, `backoff ${String(index + 1)}\n${trace}`).toBeLessThanOrEqual(bounds[index]?.[1] ?? -Infinity);
    });
    // The first edit went out three times with one revision id, and was acknowledged once; the second edit once.
    const [first, second] = result.engineAcknowledged;
    expect(result.engineAcknowledged, trace).toHaveLength(2);
    expect(result.commitLabels, trace).toEqual([first, first, first, second]);
    expect(result.serverContent, trace).toBe("written while the server is busy\nand again\n");
    expect(result.engineContent, trace).toBe(result.serverContent);
  });

  it("merges two engines' concurrent edits, keeping overlapping and binary ones as conflict copies", async () => {
    const result = await enginesEditConcurrently(environment);
    const trace = tail(result.trace, 200);

    // Convergence, no lost acknowledged writes, no deferral left, no echo reported (engine-* and server invariants).
    expect(result.violations, trace).toEqual([]);
    // Every phase really raced: the second engine's first commit was refused.
    expect(result.refused, trace).toEqual([
      "non-overlapping edits",
      "overlapping edits",
      "binary edits",
      "line endings",
      "creates at one path",
      "creates at case-colliding paths",
    ]);
    const [first, second] = result.vaults;
    expect(second, trace).toEqual(first);
    const copy = (name: string, extension: string) => `${name} (conflict e2 2026-01-02 030405)${extension}`;
    const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
    const note = (overrides: Record<number, string>, eol = "\n") =>
      Array.from({ length: 10 }, (_, index) => `${overrides[index] ?? `line ${String(index + 1)}`}${eol}`).join("");
    expect(first, trace).toEqual(
      new Map([
        // Phases 1, 2 and 4: both non-overlapping edits, the first engine's overlapping one, the CRLF conversion.
        ["notes/plan.md", note({ 0: "line 1 (first engine)", 1: "line 2 (first engine)", 4: "line 5 (first engine)", 8: "line 9 (second engine)" }, "\r\n")],
        // Phase 2: the second engine's overlapping edit, whole and without conflict markers.
        [`notes/${copy("plan", ".md")}`, note({ 1: "line 2 (first engine)", 4: "line 5 (second engine)", 8: "line 9 (second engine)" })],
        // Phase 3.
        ["attachments/image.png", "89504e4702"],
        [`attachments/${copy("image", ".png")}`, "89504e4703"],
        // Phase 5.
        ["inbox/new.md", lines("created by the first engine")],
        [`inbox/${copy("new", ".md")}`, lines("created by the second engine")],
        // Phase 6.
        ["Todo.md", lines("first engine's list")],
        [copy("todo", ".md"), lines("second engine's list")],
      ]),
    );
    expect(result.conflicts[0], trace).toEqual([]);
    expect(result.conflicts[1], trace).toEqual([
      { reason: "overlapping-edits", path: "notes/plan.md", copyPath: `notes/${copy("plan", ".md")}` },
      { reason: "binary", path: "attachments/image.png", copyPath: `attachments/${copy("image", ".png")}` },
      { reason: "concurrent-create", path: "inbox/new.md", copyPath: `inbox/${copy("new", ".md")}` },
      { reason: "path-taken", path: "todo.md", copyPath: copy("todo", ".md") },
    ]);
  });

  it("keeps an unsynced local file whose path a remote rename takes as a conflict copy, never merged into the renamed note", async () => {
    const result = await remoteRenameOntoUnsyncedFile(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const copy = "notes/c (conflict e2 2026-01-02 030405).md";
    const expected = new Map([
      ["notes/c.md", "b line\nappended remotely\n"],
      [copy, "my own new note\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.conflicts[0], trace).toEqual([]);
    expect(result.conflicts[1], trace).toEqual([{ reason: "concurrent-create", path: "notes/c.md", copyPath: copy }]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted scenarios: a local save between the engine's check and its change (#163)", () => {
  it("merges or keeps a save that lands just before the engine's write or delete, never overwriting or deleting it", async () => {
    const result = await saveBeforeEngineWrite(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    expect(result.savesLanded, trace).toBe(true);
    const expected = new Map([
      ["notes/edit.md", "ONE\ntwo\nTHREE\n"],
      ["notes/gone.md", "keep\nme\nedited\n"],
      ["notes/merge.md", "ALPHA\nbeta\nGAMMA\nDELTA\n"],
      ["notes/released.md", "left\nas\nsynced\nthen\nsaved\n"],
    ]);
    // The engines converged on the server's heads (engine-convergence), so these are the server's too.
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.vaults[0], trace).toEqual(expected);
  });
});

describe.runIf(suites.has("scenarios"))("scripted structural scenarios (#19)", () => {
  it("syncs renames, deletes, same-path creates, folder renames and rename chains between two engines without losing or duplicating a document", async () => {
    const result = await structuralOperations(environment);
    const trace = tail(result.trace, 200);

    // Convergence, no lost acknowledged writes, no deferral left, no echo reported (engine-* and server invariants).
    expect(result.violations, trace).toEqual([]);
    // Every raced phase really raced: the second engine's first commit was refused.
    expect(result.refused, trace).toEqual([
      "rename vs edit", "delete vs edit", "edit vs delete", "creates at one path", "folder rename vs edit", "rename chain on one engine",
      "file where the other created a folder",
      "folder where the other created a file",
    ]);
    const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
    const archived = Array.from({ length: 12 }, (_, index) => [`archive/file ${String(index)}.md`, lines(`projects/file ${String(index)}.md`)] as const);
    const stamped = (name: string) => `${name} (conflict e2 2026-01-02 030405)`;
    const copy = `inbox/${stamped("same")}.md`;
    const expected = new Map<string, string>([
      ["notes/renamed.md", lines("one", "two (edited)", "three")],
      ["notes/delete-me.md", lines("kept by the edit", "edited")],
      ["notes/edit-me.md", lines("kept by the edit too", "edited")],
      ["inbox/same.md", lines("created by the first engine")],
      [copy, lines("created by the second engine")],
      ...archived,
      ["moved/inside.md", lines("one", "two (edited)")],
      ["chain/C.md", lines("chained")],
      ["rotate/b.md", lines("note x", "edited")],
      ["rotate/c.md", lines("note y", "edited")],
      ["topics", lines("a file named like the folder")],
      [`${stamped("topics")}/x.md`, lines("x")],
      [`${stamped("topics")}/y.md`, lines("y")],
      ["ideas/a.md", lines("a")],
      [stamped("ideas"), lines("a file named like the folder")],
      ["held/p.md", lines("held", "note (edited)")],
      ["held/z.md", lines("untracked")],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    // Each document kept its identity through its renames, delete and edits: nothing re-created.
    const identity = new Map<string, string>([
      ["notes/renamed.md", "notes/rename-me.md"],
      ["notes/delete-me.md", "notes/delete-me.md"],
      ["notes/edit-me.md", "notes/edit-me.md"],
      ...archived.map(([path]) => [path, path.replace("archive/", "projects/")] as [string, string]),
      ["moved/inside.md", "shared/inside.md"],
      ["chain/C.md", "chain/A.md"],
      ["rotate/b.md", "rotate/a.md"],
      ["rotate/c.md", "rotate/b.md"],
      ["held/p.md", "held/d.md"],
    ]);
    for (const [path, origin] of identity) expect(result.documents.get(path), `${path} is the document that was ${origin}`).toBe(result.before.get(origin));
    expect(result.documents.size, trace).toBe(expected.size);
    // The folder rename moved no content: renames only.
    expect(result.folderRenameTransfers, trace).toEqual({ uploads: 0, downloads: 0 });
    // The file renamed off the held path was pushed while the hook still held the document.
    expect(result.heldPhaseFiles, trace).toContain("held/z.md");
    expect(result.conflicts[0], trace).toEqual([]);
    expect(result.conflicts[1], trace).toEqual([
      { reason: "concurrent-create", path: "inbox/same.md", copyPath: copy },
      { reason: "path-taken", path: "topics/x.md", copyPath: `${stamped("topics")}/x.md` },
      { reason: "path-taken", path: "topics/y.md", copyPath: `${stamped("topics")}/y.md` },
      { reason: "path-taken", path: "ideas", copyPath: stamped("ideas") },
    ]);
  });
});

describe.runIf(suites.has("scenarios"))("platform path rules (#20)", () => {
  it("tracks the notes a Windows engine cannot hold, commits nothing for them, and materializes each once it gets a legal name", async () => {
    const result = await unmaterializableOnWindows(environment);
    const trace = tail(result.trace, 200);

    // Convergence (only what Windows cannot hold may be missing, and exactly that is reported), no lost acknowledged writes, no echo.
    expect(result.violations, trace).toEqual([]);
    const overlong = `${"long".repeat(50)}/${"b".repeat(56)}.md`;
    expect(result.reportedAfterCreate, trace).toEqual(
      new Map([
        ["CON.md", "reserved-name"],
        ["notes/a:b.md", "forbidden-character"],
        ["trailing.", "trailing-dot-or-space"],
        [overlong, "path-too-long"],
      ]),
    );
    expect(result.windowsFilesAfterCreate, trace).toEqual(["ok.md", "plan.md"]);
    // The edited note stays where it was on Windows, with the user's edit, unpushed; the unchanged one is removed.
    expect(result.reportedAfterRename.get("plan?.md"), trace).toBe("forbidden-character");
    expect(result.reportedAfterRename.get("ok*.md"), trace).toBe("forbidden-character");
    expect(result.windowsFilesAfterRename, trace).toEqual(new Map([["plan.md", "one\ntwo (edited on windows)\n"]]));
    // Nothing committed while they could not be materialized: no rename, no drop, not the edit.
    expect(result.windowsCommitsWhileTracked, trace).toEqual([]);
    const expected = new Map([
      ["console.md", "illegal 0\n"],
      ["notes/a-b.md", "illegal 1\n"],
      ["ok 2.md", "fine\n"],
      ["plan 2.md", "one\ntwo (edited on windows)\n"],
      ["short.md", "illegal 3\n"],
      ["trailing.txt", "illegal 2\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.size, trace).toBe(expected.size);
    // The renamed notes are still the same documents.
    expect(result.documents.get("plan 2.md"), trace).toBe(result.before.get("plan.md"));
    expect(result.documents.get("ok 2.md"), trace).toBe(result.before.get("ok.md"));
  });

  it("never takes what is later at a path an unmaterializable rename freed for the renamed note's file", async () => {
    const result = await freedPathReused(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const expected = new Map([
      ["draft 2.md", "draft\n"],
      ["draft.md", "brand new\n"],
      ["empty 2.md", ""],
      ["empty.md", ""],
      ["plan 2.md", "one\ntwo\n"],
      ["plan.md", "another note\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.size, trace).toBe(expected.size);
    // The renamed notes are still the same documents, and the notes at their old paths are others.
    for (const name of ["plan", "empty", "draft"]) {
      expect(result.documents.get(`${name} 2.md`), trace).toBe(result.before.get(`${name}.md`));
      expect(result.documents.get(`${name}.md`), trace).not.toBe(result.before.get(`${name}.md`));
    }
  });

  it("keeps every invariant in a seeded run under Windows rules, tracking the pool's illegal names", async () => {
    const result = await runSeed(environment, { seed: 1, clients: environment.clients, steps: Math.min(environment.steps, 400), platforms: ["windows"] });
    const trace = tail(result.trace, 120);

    expect(result.violations, trace).toEqual([]);
    expect(result.trace.some((line) => line.includes(" as unmaterializable (")), trace).toBe(true);
  });
});

describe.runIf(suites.has("scenarios"))("config folder sync (#28)", () => {
  it("syncs only the selected config files, applies nothing while off, and never deletes on the server when turned off", async () => {
    const result = await configFolderSync(environment);
    const trace = tail(result.trace, 200);

    // Convergence of everything each engine syncs; config files outside its scope are deferred, never written.
    expect(result.violations, trace).toEqual([]);
    const synced = [".obsidian/community-plugins.json", ".obsidian/hotkeys.json", ".obsidian/plugins/dataview/main.js", ".obsidian/snippets/wide.css", "note.md"];
    expect(result.liveAfterPush, trace).toEqual(synced);
    expect(result.configWhileOff, trace).toEqual([]);
    // A layout change, then edits and a delete with config sync off: no commit, nothing deleted on the server.
    expect(result.commitsWhileOff, trace).toBe(0);
    expect(result.liveAtEnd, trace).toEqual(synced);
    expect(result.configAfterOn, trace).toEqual(["community-plugins.json", "hotkeys.json", "plugins/dataview/main.js", "snippets/wide.css"]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted retention scenarios (#26)", () => {
  it("merges past a merge base that retention purged, without stalling the pull or losing either edit", async () => {
    const result = await purgedMergeBase(environment);
    const trace = tail(result.trace, 200);

    // Convergence (the pull did not stall: cursor at the feed's end, nothing deferred), no lost acknowledged write but the purged base.
    expect(result.violations, trace).toEqual([]);
    expect(result.purged, trace).toEqual([result.base]);
    const copy = "notes/plan (conflict e1 2026-01-02 030405).md";
    const expected = new Map([
      [copy, "one\ntwo (second engine, offline)\nthree\n"],
      ["notes/later.md", "written after the purge\n"],
      ["notes/plan.md", "one (first engine)\ntwo\nthree\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.conflicts[1], trace).toEqual([{ reason: "base-purged", path: "notes/plan.md", copyPath: copy }]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted path-holding scenarios (#264)", () => {
  it("never takes a known document's file for a new document at its path, nor tombstones either", async () => {
    const result = await newDocumentAtHeldPath(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const expected = new Map([
      ["d.md", "same\n"],
      ["moved.md", "same\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    // The note moved with its edit under its own id; the new note is another document.
    const note = result.before.get("d.md");
    expect(note, trace).toBeDefined();
    expect(result.documents.get("moved.md"), trace).toBe(note);
    expect(result.documents.get("d.md"), trace).toBeDefined();
    expect(result.documents.get("d.md"), trace).not.toBe(note);
    expect(result.tombstoned, trace).toEqual([]);
  });

  it.each([
    { variant: "renamed-away-pushed", title: "a known document's new path" },
    { variant: "renamed-away-unpushed", title: "the path a known document's unpushed rename left" },
  ] as const)("moves a document a local rename put at $title to a path-taken copy, and tombstones neither (#267)", async ({ variant }) => {
    const result = await knownDocumentAtHeldPath(environment, variant);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const a = result.before.get("a.md");
    const b = result.before.get("b.md");
    expect(a, trace).toBeDefined();
    expect(b, trace).toBeDefined();
    expect(result.conflicts, trace).toMatchObject([{ reason: "path-taken", path: "a.md", document: b }]);
    const copy = result.conflicts[0]?.copyPath;
    expect(copy, trace).toEqual(expect.any(String));
    const expected = new Map([
      ["a.md", "b\n"],
      [copy ?? "", "b\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents, trace).toEqual(
      new Map([
        ["a.md", a],
        [copy ?? "", b],
      ]),
    );
    expect(result.tombstoned, trace).toEqual([]);
  });

  it("keeps a swap of two notes' names by local renames against a concurrent remote edit of the renamed-away note, with no conflict (review of #278)", async () => {
    const result = await knownDocumentAtHeldPath(environment, "swapped-unpushed");
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const a = result.before.get("a.md");
    const b = result.before.get("b.md");
    expect(a, trace).toBeDefined();
    expect(b, trace).toBeDefined();
    expect(result.conflicts, trace).toEqual([]);
    const expected = new Map([
      ["a.md", "b\n"],
      ["z.md", "a remote\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents, trace).toEqual(
      new Map([
        ["a.md", b],
        ["z.md", a],
      ]),
    );
    expect(result.tombstoned, trace).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted lost-rename scenarios (#280)", () => {
  it.each(["editor-first", "renamer-first"] as const)("never loses a concurrent edit to the delete a rename lost to a crash becomes (%s)", async (order) => {
    const result = await renameLostToCrash(environment, order);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("note.md");
    expect(note, trace).toBeDefined();
    // The edit wins over the delete: the note is live where it was, with the edit, under its own id.
    const expected = new Map([
      ["moved.md", "one\ntwo\n"],
      ["note.md", result.edited],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.get("note.md"), trace).toBe(note);
    expect(result.documents.get("moved.md"), trace).toBeDefined();
    expect(result.documents.get("moved.md"), trace).not.toBe(note);
    // Only when the delete reached the server first did it land at all, as a tombstone the edit then overrode.
    expect(result.tombstoned, trace).toEqual(order === "renamer-first" ? [note] : []);
  });

  it.each(["editor-first", "renamer-first"] as const)("never loses a concurrent edit to the delete a rename lost to a crash becomes, when the rename lands on a deleted note's id (%s)", async (order) => {
    const result = await renameLostToCrash(environment, order, "deleted-note-path");
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}\ntombstoned: ${JSON.stringify(result.tombstoned)}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("note.md");
    const other = result.before.get("moved.md");
    expect(note, trace).toBeDefined();
    expect(other, trace).toBeDefined();
    // The edit of the renamed-away note survives the delete: it is live where it was, with the edit, under its own id.
    // The deleted note at moved.md now holds the renamed content, as the restarted engine took it for an edit of that note.
    const expected = new Map([
      ["moved.md", "one\ntwo\n"],
      ["note.md", result.edited],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.get("note.md"), trace).toBe(note);
    expect(result.documents.get("moved.md"), trace).toBe(other);
    expect(result.tombstoned, trace).toEqual(order === "renamer-first" ? [note] : []);
  });
});

describe.runIf(suites.has("scenarios"))("scripted scenarios of a new file at a just-vacated path (#254)", () => {
  /** The run's trace end, with what it ended with. */
  const traceOf = (result: VacatedPathResult) =>
    `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}\ntombstoned: ${JSON.stringify(result.tombstoned)}`;

  it("tombstones the deleted note and creates a new document for the file created at its path", async () => {
    const result = await fileAtVacatedPath(environment, "deleted-then-created");
    const trace = traceOf(result);

    expect(result.violations, trace).toEqual([]);
    const h = result.before.get("h.md");
    expect(h, trace).toBeDefined();
    const expected = new Map([["h.md", "new\n"]]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.get("h.md"), trace).toEqual(expect.any(String));
    expect(result.documents.get("h.md"), trace).not.toBe(h);
    expect(result.tombstoned, trace).toEqual([h]);
    expect(result.conflicts, trace).toEqual([]);
  });

  it.each([
    { variant: "deleted-then-renamed-onto", deleted: "h.md", renamed: "d.md", to: "h.md", content: "d\n" },
    { variant: "deleted-then-case-variant-renamed-onto", deleted: "A.md", renamed: "NOTES", to: "a.md", content: "notes\n" },
  ] as const)("renames the other note onto the path under its own id and tombstones the deleted one ($variant)", async ({ variant, deleted, renamed, to, content }) => {
    const result = await fileAtVacatedPath(environment, variant);
    const trace = traceOf(result);

    expect(result.violations, trace).toEqual([]);
    const gone = result.before.get(deleted);
    const moved = result.before.get(renamed);
    expect(gone, trace).toBeDefined();
    expect(moved, trace).toBeDefined();
    const expected = new Map([[to, content]]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents, trace).toEqual(new Map([[to, moved]]));
    expect(result.tombstoned, trace).toEqual([gone]);
    expect(result.conflicts, trace).toEqual([]);
  });

  it("keeps both notes' ids when one is renamed away and the other onto a case variant of its path (macOS)", async () => {
    const result = await fileAtVacatedPath(environment, "case-variant-swap");
    const trace = traceOf(result);

    expect(result.violations, trace).toEqual([]);
    const a = result.before.get("a.md");
    const b = result.before.get("b.md");
    expect(a, trace).toBeDefined();
    expect(b, trace).toBeDefined();
    const expected = new Map([
      ["A.md", "b\n"],
      ["z.md", "a\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents, trace).toEqual(
      new Map([
        ["z.md", a],
        ["A.md", b],
      ]),
    );
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts, trace).toEqual([]);
  });

  it("renames a new note away and creates another at a case variant of its path while its create is committed (macOS, seed 22)", async () => {
    const result = await fileAtVacatedPath(environment, "renamed-away-while-created");
    const trace = traceOf(result);

    expect(result.violations, trace).toEqual([]);
    const expected = new Map([
      ["b.md", "first\n"],
      ["straße.md", "second\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    const created = result.documents.get("b.md");
    expect(created, trace).toEqual(expect.any(String));
    expect(result.documents.get("straße.md"), trace).toEqual(expect.any(String));
    expect(result.documents.get("straße.md"), trace).not.toBe(created);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts, trace).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted backslash-path scenarios (#191)", () => {
  it("refuses new paths containing a backslash, keeps their files, and syncs them once renamed", async () => {
    const result = await backslashPathsRefused(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    // Neither backslash file reached the server, and both stayed on the second engine's disk.
    expect([...result.afterRefusal.keys()].sort(), trace).toEqual(["a/b", "notes"]);
    expect(result.rejected, trace).toEqual(["a\\b", "notes\\c.md"]);
    expect(result.secondAfterRefusal, trace).toEqual(
      new Map([
        ["a/b", "slash\n"],
        ["a\\b", "backslash twin\n"],
        ["notes", "a file\n"],
        ["notes\\c.md", "under the file\n"],
      ]),
    );
    const expected = new Map([
      ["a/b", "slash\n"],
      ["a/c", "backslash twin\n"],
      ["notes", "a file\n"],
      ["notes-c.md", "under the file\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect([...result.documents.keys()].sort(), trace).toEqual([...expected.keys()]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted drive-like path scenarios (#148)", () => {
  it("refuses new paths starting with one character and a colon, keeps their files, and syncs them once renamed", async () => {
    const result = await drivePrefixPathsRefused(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    // No drive-like file reached the server, and all stayed on the second engine's disk.
    expect([...result.afterRefusal.keys()], trace).toEqual(["1-x.md"]);
    expect(result.rejected, trace).toEqual(["1:x.md", "é:y.md", "😀:z.md"].sort());
    expect(result.secondAfterRefusal, trace).toEqual(
      new Map([
        ["1-x.md", "synced\n"],
        ["1:x.md", "digit drive\n"],
        ["é:y.md", "letter drive\n"],
        ["😀:z.md", "emoji drive\n"],
      ]),
    );
    const expected = new Map([
      ["1-x.md", "synced\n"],
      ["1/x.md", "digit drive\n"],
      ["e-y.md", "letter drive\n"],
      ["z.md", "emoji drive\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect([...result.documents.keys()].sort(), trace).toEqual([...expected.keys()].sort());
  });
});

describe.runIf(suites.has("scenarios"))("scripted server-refused path scenarios (#100)", () => {
  it("never sends files whose paths the server refuses, reports each with its reason, and syncs them once renamed", async () => {
    const result = await serverRefusedPathsSurfaced(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    // Nothing of the refused files was uploaded or committed, across a crash.
    expect(result.refusalRequests, trace).toEqual([]);
    expect([...result.afterRefusal.keys()], trace).toEqual(["notes/a.md"]);
    expect(result.reasons, trace).toEqual(
      new Map([
        ["notes/line\nbreak.md", "invalid-character"],
        ["notes/.../dots.md", "not-vault-relative"],
        [normalizedTooLongPath, "too-long-normalized"],
      ]),
    );
    expect(result.secondAfterRefusal, trace).toEqual(
      new Map([
        ["notes/a.md", "synced\n"],
        ["notes/line\nbreak.md", "control character\n"],
        ["notes/.../dots.md", "dots\n"],
        [normalizedTooLongPath, "grows when normalized\n"],
      ]),
    );
    const expected = new Map([
      ["notes/a.md", "synced\n"],
      ["notes/line break.md", "control character\n"],
      ["notes/dots.md", "dots\n"],
      ["notes/long.md", "grows when normalized\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect([...result.documents.keys()].sort(), trace).toEqual([...expected.keys()].sort());
  });
});

describe.runIf(suites.has("scenarios"))("scripted liveness scenarios (#302)", () => {
  it("lets a commit retry sent after the schedule wait out its backoff while draining, so it lands once", async () => {
    const result = await commitRetryAfterSchedule(environment);
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    expect(result.lost, trace).not.toBe("?");
    // The retry reused the lost request's revision id, and the drain ended its backoff rather than the schedule.
    expect(result.trace.some((line) => line.includes(` ${result.lost} base=- "note.md" `) && line.endsWith("retry backoff elapsed")), trace).toBe(true);
    expect(result.trace.filter((line) => line.includes(`acknowledged ${result.lost} `)), trace).toHaveLength(1);
    expect(result.acknowledged, trace).toHaveLength(1);
  });

  it("reports an engine the harness waits for while nothing delivers its calls as a stall naming the step, instead of hanging", async () => {
    const result = await stalledEngineReported(environment);
    const trace = tail(result.trace);

    expect(result.error, trace).toBeInstanceOf(StallError);
    const message = result.error instanceof Error ? result.error.message : "";
    expect(message, trace).toMatch(/^run stalled at step 1: e1's engine work never finished/);
    expect(message, trace).toContain("c1 ListChanges(since=0) (request)");
    expect(message, trace).toContain("Trace (last lines):\n");
    expect(result.trace.some((line) => line.startsWith("1: STALLED: run stalled at step 1")), trace).toBe(true);
    // Once something delivers the engine's calls again, the run goes on and ends cleanly.
    expect(result.violations, trace).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted document-kind scenarios (#306)", () => {
  it("lets a scripted client edit, rename and delete an engine's binary document, each commit keeping the document's kind", async () => {
    const result = await scriptedChangesOfBinary(environment);
    const trace = tail(result.trace);

    expect(result.violations, trace).toEqual([]);
    const scripted = result.acknowledged.filter((acknowledgement) => acknowledgement.client === 0 && acknowledgement.documentId === result.documentId);
    expect(
      scripted.map(({ path, deleted }) => ({ path, deleted })),
      trace,
    ).toEqual([
      { path: "trailing.", deleted: false },
      { path: expect.not.stringMatching(/^trailing\.$/) as unknown, deleted: false },
      { path: expect.any(String) as unknown, deleted: true },
    ]);
    expect(result.revisions.map(({ kind }) => kind), trace).toEqual(["BLOB", "BLOB", "BLOB", "BLOB"]);
    expect(result.revisions.map(({ deleted }) => deleted), trace).toEqual([false, false, false, true]);
  });
});

describe.runIf(suites.has("determinism"))("determinism", () => {
  const seed = environment.seeds[0] ?? 1;
  const steps = Math.min(environment.steps, 150);

  it("generates the identical schedule from the same seed", () => {
    const options = { seed, steps, clients: environment.clients };
    expect(generateSchedule(options)).toEqual(generateSchedule(options));
  });

  it("replays the identical client-side operations, faults and outcomes when a seed is re-run", async () => {
    const options = { seed, clients: environment.clients, steps };
    const first = await runSeed(environment, options);
    const second = await runSeed(environment, options);

    expect(second.vaultId).not.toBe(first.vaultId);
    expect(second.steps).toEqual(first.steps);
    expect(second.trace).toEqual(first.trace);
    // The schedule exercised faults, so the comparison covers them.
    expect(first.trace.some((line) => line.includes("lost"))).toBe(true);
  });
});
