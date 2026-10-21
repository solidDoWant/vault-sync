// The networked simulation suite (SPEC.md §13). It needs a running server and
// the driver's control endpoint, so it runs only from `make test-sim`, through
// sim/simulation_test.go and plugin/vitest.sim.config.ts; `make test` excludes
// it.

import { describe, expect, it } from "vitest";

import { Control } from "./control";
import { simEnvironment } from "./environment";
import { runSeed, runSteps, seededCommitRetryBackoff, seededPlatforms, type RunResult } from "./runner";
import { configFolderSync, engineBacksOffWhenThrottled, enginePushUnderFaults, enginesEditConcurrently, lostResponseAfterHeadMoved, remoteRenameOntoUnsyncedFile, saveBeforeEngineWrite, structuralOperations, unmaterializableOnWindows, freedPathReused, purgedMergeBase, purgedMergeBaseWhileOffline, newDocumentAtHeldPath, knownDocumentAtHeldPath, renameLostToCrash, backslashPathsRefused, changeAtBusyPathKept, drivePrefixPathsRefused, serverRefusedPathsSurfaced, normalizedTooLongPath, commitRetryAfterSchedule, stalledEngineReported, fileAtVacatedPath, type VacatedPathResult, scriptedChangesOfBinary, remoteRenameOntoSpellingOfUnpushedFile, caseOnlyRename, remoteRenameOntoLocalFolder, remoteEditOfVacatedPath, remoteRenameIntoDeletedNotesFolder, restoredServer, newFileAtRenamedAwayPath, localRenameIntoRemoteRenamesFolder, remoteRenameOntoFolderName, respelledNoteRenamed, respelledFileAfterRestart } from "./scenarios";
import { localRenameOverRemoteRenameIntoRespelledFolder } from "./scenarios";
import { renameOntoDeletedNotePath } from "./scenarios";
import { bothRenameOntoVacatedPath } from "./scenarios";
import { renameOntoRemoteCreate } from "./scenarios";
import { renameOfRecreatedNote } from "./scenarios";
import { configConflictCopies } from "./scenarios";
import { interruptedConflictMove } from "./scenarios";
import { parkedEditAtReusedPath } from "./scenarios";
import { recreatedNoteMergeCrash } from "./scenarios";
import { purgedCursor } from "./scenarios";
import { historyRestores } from "./history-scenarios";
import { restoreWindow } from "./restore-scenarios";
import { uploadLimitReached, uploadSessionCallsRefused } from "./upload-scenarios";
import { mergedDuringPush } from "./scenarios";
import { stalledAtFinish } from "./scenarios";
import { StallError } from "./network";
import { recordedCase, replayRegression } from "./regression";
import { generateSchedule, type Step } from "./schedule";
import { shrink, type ShrinkProgress } from "./shrink";
import { summarize } from "./summary";

const environment = simEnvironment();
const suites = new Set(environment.suites);
/**
 * Marks a seed's case recorded with the faithful filesystem, so it does not
 * overwrite the folded case of the same seed. The case itself records the
 * setting (RegressionCase.faithfulFilesystem), and the regressions suite
 * replays it with it.
 */
const faithfulSuffix = environment.faithfulFilesystem ? "-faithful-fs" : "";

/** The last lines of a trace, enough to see how a failure came about. */
function tail(trace: readonly string[], lines = 80): string {
  return trace.slice(-lines).join("\n");
}

/**
 * Prints a run's binding-shadow divergences (refactor step R4,
 * docs/design/engine-path-ownership.md §9.2), report only: the nightly
 * report lists them for triage.
 */
function reportShadow(run: string, trace: readonly string[]): void {
  for (const line of trace.filter((entry) => entry.includes("SHADOW binding-shadow: "))) console.log(`${run}: ${line}`);
}

/**
 * Prints a line after every candidate run of a shrink, so a long shrink of a
 * failing seed never looks hung (#381): one line per re-run of the seed's
 * schedule, which takes no longer than the seed's own run.
 */
function shrinkProgress(run: string): (state: ShrinkProgress) => void {
  return (state) => {
    console.log(`${run} shrinking: run ${String(state.runs)}/${String(state.maxRuns)}, candidate ${state.removed ? "still fails" : "passes"}, ${String(state.length)} steps left`);
  };
}

function describeViolations(result: RunResult): string {
  return result.violations.map((violation) => `  ${violation.invariant}: ${violation.detail}`).join("\n");
}

describe.runIf(suites.has("seeds"))("seeded schedules", () => {
  it.each(environment.seeds)("seed %i keeps every invariant", async (seed) => {
    // Without engine users (SIM_ENGINES=0) `engines` stays unset: one engine
    // only pulls, and a recorded case replays the same way.
    const engines = environment.engines === 0 ? undefined : environment.engines;
    const options = { seed, clients: environment.clients, engines, platforms: seededPlatforms(seed, engines ?? 1), commitRetryBackoff: seededCommitRetryBackoff, faithfulFilesystem: environment.faithfulFilesystem, notificationPulls: true };
    const result = await runSeed(environment, { ...options, steps: environment.steps });
    console.log(`seed ${String(seed)} (${options.platforms.join(", ")} path rules): ${summarize(result.trace)}`);
    reportShadow(`seed ${String(seed)}`, result.trace);
    if (result.violations.length === 0) return;

    // Minimize: keep removing steps while a violation of the same kind remains.
    const invariants = new Set(result.violations.map((violation) => violation.invariant));
    const stillFails = async (steps: Step[]) => (await runSteps(environment, options, steps)).violations.some((violation) => invariants.has(violation.invariant));
    console.log(`seed ${String(seed)} failed; shrinking its ${String(result.steps.length)} steps in up to ${String(environment.shrinkRuns)} runs`);
    const minimized = await shrink(result.steps, stillFails, environment.shrinkRuns, shrinkProgress(`seed ${String(seed)}`));
    const replay = await runSteps(environment, options, minimized.items);
    const [steps, final] = replay.violations.length > 0 ? [minimized.items, replay] : [result.steps, result];
    const written = await new Control(environment.controlUrl).report(recordedCase(`seed-${String(seed)}${faithfulSuffix}`, options, final.violations, steps));

    expect.fail(
      [
        `SIM FAILURE: seed ${String(seed)} violated invariants (${String(environment.steps)} steps, ${String(options.clients)} clients):`,
        describeViolations(result),
        `Minimized to ${String(steps.length)} steps in ${String(minimized.runs)} runs, which violate:`,
        describeViolations(final),
        `Regression case written to ${written}.`,
        `Replay with: make test-sim SIM_SEED=${String(seed)} SIM_STEPS=${String(environment.steps)} SIM_CLIENTS=${String(options.clients)} SIM_ENGINES=${String(environment.engines)}${environment.faithfulFilesystem ? " SIM_FAITHFUL_FS=1" : ""}`,
        "Trace of the minimized schedule (last lines):",
        tail(final.trace),
      ].join("\n"),
    );
  });
});

describe.runIf(suites.has("retention"))("seeded schedules with retention purges (#229)", () => {
  // The same seeds, with the retention job between steps: revisions age
  // past the policy and the server's own purge removes them (SPEC.md §11).
  const purged: string[] = [];

  it.each(environment.seeds)("seed %i keeps every invariant while retention purges", async (seed) => {
    const engines = environment.engines === 0 ? undefined : environment.engines;
    const options = { seed, clients: environment.clients, engines, platforms: seededPlatforms(seed, engines ?? 1), commitRetryBackoff: seededCommitRetryBackoff, retention: true, faithfulFilesystem: environment.faithfulFilesystem, notificationPulls: true };
    const result = await runSeed(environment, { ...options, steps: environment.steps });
    purged.push(...result.purged);
    console.log(`seed ${String(seed)} with retention (${options.platforms.join(", ")} path rules): ${String(result.purged.length)} revisions purged, ${summarize(result.trace)}`);
    reportShadow(`seed ${String(seed)} with retention`, result.trace);
    if (result.violations.length === 0) return;

    const invariants = new Set(result.violations.map((violation) => violation.invariant));
    const stillFails = async (steps: Step[]) => (await runSteps(environment, options, steps)).violations.some((violation) => invariants.has(violation.invariant));
    console.log(`seed ${String(seed)} with retention failed; shrinking its ${String(result.steps.length)} steps in up to ${String(environment.shrinkRuns)} runs`);
    const minimized = await shrink(result.steps, stillFails, environment.shrinkRuns, shrinkProgress(`seed ${String(seed)} with retention`));
    const replay = await runSteps(environment, options, minimized.items);
    const [steps, final] = replay.violations.length > 0 ? [minimized.items, replay] : [result.steps, result];
    const written = await new Control(environment.controlUrl).report(recordedCase(`seed-${String(seed)}-retention${faithfulSuffix}`, options, final.violations, steps));

    expect.fail(
      [
        `SIM FAILURE: seed ${String(seed)} with retention violated invariants (${String(environment.steps)} steps, ${String(options.clients)} clients):`,
        describeViolations(result),
        `Minimized to ${String(steps.length)} steps in ${String(minimized.runs)} runs, which violate:`,
        describeViolations(final),
        `Regression case written to ${written}.`,
        `Replay with: make test-sim SIM_SEED=${String(seed)} SIM_STEPS=${String(environment.steps)} SIM_CLIENTS=${String(options.clients)} SIM_ENGINES=${String(environment.engines)}${environment.faithfulFilesystem ? " SIM_FAITHFUL_FS=1" : ""}`,
        "Trace of the minimized schedule (last lines):",
        tail(final.trace),
      ].join("\n"),
    );
  });

  it("purged at least one revision", () => {
    expect(purged.length, `no seed's retention steps purged anything; run more steps (SIM_STEPS=${String(environment.steps)})`).toBeGreaterThan(0);
  });
});

describe.runIf(suites.has("regressions") && environment.regressions.length > 0)("committed regression cases", () => {
  it.each(environment.regressions.map((regression) => [regression.name, regression] as const))("%s keeps every invariant", async (_name, regression) => {
    const result = await replayRegression(environment, regression);
    expect(result.violations, tail(result.trace)).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted scenarios", () => {
  it("gates the engines' pulls on an announced seq only with notificationPulls, one gated pull per engine (#661)", async () => {
    // Pull steps whose arg chooses each kind (notificationSeq): plain, if behind the head, if behind an earlier head.
    const pulls: Step[] = [0, 1, 2].map((arg) => ({ kind: "operation", client: 0, operation: "pull", arg }));
    const steps: Step[] = pulls.flatMap((pull) => [pull, ...Array.from({ length: 12 }, (): Step => ({ kind: "deliver-request" })), ...Array.from({ length: 12 }, (): Step => ({ kind: "deliver-response" }))]);
    const options = { seed: 661, clients: 1, engines: 2, platforms: seededPlatforms(661, 2) };
    const gated = " starts pull if behind seq ";

    const on = await runSteps(environment, { ...options, notificationPulls: true }, steps);
    expect(on.violations, tail(on.trace)).toEqual([]);
    const gatedLines = on.trace.filter((line) => line.includes(gated));
    const gatedPulls = gatedLines.reduce((count, line) => count + line.split(gated).length - 1, 0);
    // Two of the three pull steps gate both engines' pulls, and the summary counts each engine's.
    expect(gatedLines, tail(on.trace)).toHaveLength(2);
    expect(gatedPulls, tail(on.trace)).toBe(4);
    expect(summarize(on.trace), tail(on.trace)).toContain("notification-gated pulls 4,");

    const off = await runSteps(environment, { ...options, notificationPulls: false }, steps);
    expect(off.violations, tail(off.trace)).toEqual([]);
    expect(off.trace.filter((line) => line.includes(gated)), tail(off.trace)).toEqual([]);
    expect(summarize(off.trace), tail(off.trace)).toContain("notification-gated pulls 0,");
  });

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
    expect(result.refused, trace).toEqual(["CommitRevision", "ListChanges", "DownloadBlob", "CommitRevision", "ListChanges"]);
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
    const synced = [
      ".obsidian/app.json",
      ".obsidian/community-plugins.json",
      ".obsidian/daily-notes.json",
      ".obsidian/hotkeys.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/wide.css",
      "note.md",
    ];
    expect(result.liveAfterPush, trace).toEqual(synced);
    expect(result.configWhileOff, trace).toEqual([]);
    // A layout change, then edits and a delete with config sync off: no commit, nothing deleted on the server.
    expect(result.commitsWhileOff, trace).toBe(0);
    expect(result.liveAtEnd, trace).toEqual(synced);
    expect(result.configAfterOn, trace).toEqual(["app.json", "community-plugins.json", "daily-notes.json", "hotkeys.json", "plugins/dataview/main.js", "snippets/wide.css"]);
  });

  it("keeps a conflict copy of a config file inside a synced folder on the device that made it (#365)", async () => {
    const result = await configConflictCopies(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    const synced = ["plugins/dataview/data.json", "snippets/wide.css"];
    expect(result.live, trace).toEqual(synced.map((path) => `.obsidian/${path}`));
    expect(result.configs[0], trace).toEqual(synced);
    expect(result.configs[1], trace).toEqual(["plugins/dataview/data (conflict e1 2026-01-02 030405).json", "plugins/dataview/data.json", "snippets/wide (conflict e1 2026-01-02 030405).css", "snippets/wide.css"]);
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

  it("keeps an edit made offline whose merge base retention purged before the engine reconnected, as a conflict copy (#229)", async () => {
    const result = await purgedMergeBaseWhileOffline(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    expect(result.purged, trace).toEqual([result.base]);
    // The push started offline pulls first on reconnect and finds its merge base gone.
    expect(
      result.trace.some((line) => line.includes("GetRevision -> NotFound")),
      trace,
    ).toBe(true);
    const copy = "notes/plan (conflict e1 2026-01-02 030405).md";
    const expected = new Map([
      [copy, "one\ntwo (second engine, offline)\nthree\n"],
      ["notes/plan.md", "one (first engine)\ntwo\nthree\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.conflicts[1], trace).toEqual([{ reason: "base-purged", path: "notes/plan.md", copyPath: copy }]);
  });

  it("applies another device's delete of an unchanged note after retention purged the cursor's revision, and never commits it back (#480)", async () => {
    const result = await purgedCursor(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    expect(result.purged, trace).toHaveLength(2);
    // The purge marker of the cursor's revision matches its anchor: no resync (#488).
    expect(result.resynced, trace).toBe(false);
    const expected = new Map([["notes/kept.md", "two\n"]]);
    expect(result.live, trace).toEqual(["notes/kept.md"]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
  });

  it("resyncs a device whose cursor's purge marker retention pruned past the horizon, and keeps every file (#514)", async () => {
    const result = await purgedCursor(environment, { pruneMarkers: true });
    const trace = tail(result.trace, 200);

    expect(result.purged, trace).toHaveLength(2);
    expect(result.prunedMarkers, trace).toBe(2);
    // Neither the cursor's revision nor its marker is left: a false-positive divergence.
    expect(result.resynced, trace).toBe(true);
    // The resync merges every note the device holds (SPEC.md §8): its
    // unchanged copy of the note the first engine deleted wins over the
    // delete, so the next push brings it back (the only invariant the
    // resync breaks, as documented), and the other note, whose merge base
    // was purged, keeps the device's version as a conflict copy next to the
    // first engine's edit. Nothing is lost.
    expect(
      result.violations.map((violation) => violation.invariant),
      trace,
    ).toEqual(["resurrected-delete"]);
    const copy = "notes/kept (conflict e1 2026-01-02 030405).md";
    const expected = new Map([
      ["notes/gone.md", "deleted by the first engine\n"],
      [copy, "one\n"],
      ["notes/kept.md", "two\n"],
    ]);
    expect(result.live, trace).toEqual(["notes/gone.md", copy, "notes/kept.md"]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
  });

  it("keeps an unpushed local edit of a device whose cursor's purge marker retention pruned past the horizon (#519)", async () => {
    const result = await purgedCursor(environment, { pruneMarkers: true, localEdit: true });
    const trace = tail(result.trace, 200);

    expect(result.prunedMarkers, trace).toBe(2);
    expect(result.resynced, trace).toBe(true);
    // As without the edit, the resync brings back the deleted note; the
    // only invariant it breaks, as documented (SPEC.md §11).
    expect(
      result.violations.map((violation) => violation.invariant),
      trace,
    ).toEqual(["resurrected-delete"]);
    // The edit's merge base was purged: the first engine's version stays in
    // place, and the device's edit is kept next to it as a conflict copy on
    // both devices and the server (principle 1).
    const copy = "notes/kept (conflict e1 2026-01-02 030405).md";
    const expected = new Map([
      ["notes/gone.md", "deleted by the first engine\n"],
      [copy, "one\nedited offline\n"],
      ["notes/kept.md", "two\n"],
    ]);
    expect(result.live, trace).toEqual(["notes/gone.md", copy, "notes/kept.md"]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
  });
});

describe.runIf(suites.has("scenarios"))("scripted server restore scenarios (#155)", () => {
  it("resyncs a device whose cursor the restored server passed again, and keeps every post-restore note and every local one", async () => {
    const result = await restoredServer(environment);
    const trace = tail(result.trace, 200);

    expect(result.resynced, trace).toBe(true);
    expect(result.serverFiles, trace).toEqual(["notes/after-1.md", "notes/after-2.md", "notes/after-3.md", "notes/kept.md"]);
    // Every post-restore revision reached the device.
    for (const index of [1, 2, 3]) expect(result.vault.get(`notes/after-${String(index)}.md`), trace).toBe(`written after the restore ${String(index)}\n`);
    // Nothing the device held was overwritten or deleted: the note the
    // server lost, and the edit of the restored note, stay.
    expect(result.vault.get("notes/lost.md"), trace).toBe("only before the restore\n");
    expect([...result.vault.values()].join(""), trace).toContain("edited before the restore");
  });
});

describe.runIf(suites.has("scenarios"))("scripted history restore scenarios (#651)", () => {
  it("restores older and deleted versions, in place and at another path, keeping every document's id and every invariant", async () => {
    const result = await historyRestores(environment);
    const trace = tail(result.trace, 200);

    expect(result.violations, trace).toEqual([]);
    // The restore at a path another document took was refused, with nothing committed, before the one at another path.
    expect(result.trace.some((line) => line.includes("e0 user restore of notes/c.md refused: path-taken notes/c.md")), trace).toBe(true);
    const expected = new Map([
      ["archive/a.md", "title\ntwo\n"],
      ["notes/b.md", "bee\n"],
      ["notes/c (restored).md", "old sea\n"],
      ["notes/c.md", "dee\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    // Each restore is a revision of the document it restores: a, b and c keep their ids, and d, renamed onto c's path, keeps its own.
    const [a, b, c, d] = ["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md"].map((path) => result.before.get(path));
    expect(new Set([a, b, c, d]).size === 4 && [a, b, c, d].every((label) => label !== undefined), trace).toBe(true);
    expect(result.documents.get("archive/a.md"), trace).toBe(a);
    expect(result.documents.get("notes/b.md"), trace).toBe(b);
    expect(result.documents.get("notes/c (restored).md"), trace).toBe(c);
    expect(result.documents.get("notes/c.md"), trace).toBe(d);
    expect(result.documents.size, trace).toBe(4);
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

  it("never takes the user's rename of a new note for a remote document created at the path it vacated (#303)", async () => {
    const result = await fileAtVacatedPath(environment, "remote-created-at-vacated-path");
    const trace = traceOf(result);

    expect(result.violations, trace).toEqual([]);
    const remote = result.before.get("e.md");
    expect(remote, trace).toBeDefined();
    // The other device's note stays at e.md under its own id, with its own content, on both devices.
    expect(result.documents.get("e.md"), trace).toBe(remote);
    expect(result.vaults[0]?.get("e.md"), trace).toBe("first's note\n");
    expect(result.vaults[1]?.get("e.md"), trace).toBe("first's note\n");
    // The user's first note is a new document at the path it was renamed to.
    expect(result.vaults[1]?.get("notes/f.md"), trace).toBe("second's first note\n");
    const renamed = result.documents.get("notes/f.md");
    expect(renamed, trace).toEqual(expect.any(String));
    expect(renamed, trace).not.toBe(remote);
    // The user's second note, which lost e.md to the remote note, is a conflict copy of its own.
    const copies = [...result.documents.keys()].filter((path) => path !== "e.md" && path !== "notes/f.md");
    expect(copies, trace).toEqual([expect.stringMatching(/^e \(conflict .*\)\.md$/)]);
    const copy = copies[0] ?? "";
    expect(result.vaults[1]?.get(copy), trace).toBe("second's second note\n");
    expect(new Set([remote, renamed, result.documents.get(copy)]).size, trace).toBe(3);
    expect(result.vaults[0], trace).toEqual(result.vaults[1]);
    expect(result.vaults[1]?.size, trace).toBe(3);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts.map(({ path, copyPath }) => ({ path, copyPath })), trace).toEqual([{ path: "e.md", copyPath: copy }]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted remote renames onto another spelling of an unpushed file (#305)", () => {
  it.each(["macos", "windows"] as const)("keeps the note's id and content and makes the user's new file a document of its own (%s)", async (platform) => {
    const result = await remoteRenameOntoSpellingOfUnpushedFile(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}\nnote contents: ${JSON.stringify(result.noteContents)}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("notes/f.md");
    expect(note, trace).toBeDefined();
    const notePaths = [...result.documents].filter(([, document]) => document === note).map(([path]) => path);
    expect(notePaths, trace).toHaveLength(1);
    const [notePath = ""] = notePaths;
    const ownPaths = [...result.documents].filter(([, document]) => document !== note).map(([path]) => path);
    expect(ownPaths, trace).toHaveLength(1);
    const [ownPath = ""] = ownPaths;
    for (const vault of result.vaults) {
      expect(vault, trace).toEqual(
        new Map([
          [notePath, "f\n"],
          [ownPath, "my own new note\n"],
        ]),
      );
    }
    expect(result.noteContents, trace).not.toHaveLength(0);
    expect(result.noteContents, trace).not.toContain("my own new note\n");
    expect(result.tombstoned, trace).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted case-only renames on a case-insensitive client (#304)", () => {
  it.each(["macos", "windows"] as const)("keeps the user's spelling when a remote edit arrives before the rename is pushed (%s)", async (platform) => {
    const result = await caseOnlyRename(environment, platform, "remote-edit");
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("a.md");
    expect(note, trace).toBeDefined();
    expect(result.documents, trace).toEqual(new Map([["A.md", note]]));
    for (const vault of result.vaults) expect(vault, trace).toEqual(new Map([["A.md", "a\nremote edit\n"]]));
    expect(result.tombstoned, trace).toEqual([]);
  });

  it.each(["macos", "windows"] as const)("creates one document, at the new spelling, for a note renamed by case before its first push (%s)", async (platform) => {
    const result = await caseOnlyRename(environment, platform, "first-push");
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    expect([...result.documents.keys()], trace).toEqual(["notes/c.md"]);
    expect(new Set(result.acknowledged.map((acknowledgement) => acknowledgement.documentId)).size, trace).toBe(1);
    for (const vault of result.vaults) expect(vault, trace).toEqual(new Map([["notes/c.md", "new\n"]]));
    expect(result.tombstoned, trace).toEqual([]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted renames of a note respelled before a restart (#374)", () => {
  it.each([
    ["macos", "free-path"],
    ["windows", "free-path"],
    ["macos", "vacated-path"],
    ["windows", "vacated-path"],
  ] as const)("commits the rename as the note's own, with no tombstone (%s, %s)", async (platform, variant) => {
    const result = await respelledNoteRenamed(environment, platform, variant);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("Foo.md");
    expect(note, trace).toBeDefined();
    const expected = variant === "free-path" ? new Map([["b.md", note]]) : new Map([["b.md", note], ["c.md", result.before.get("b.md")]]);
    expect(result.documents, trace).toEqual(expected);
    const files = variant === "free-path" ? new Map([["b.md", "x\n"]]) : new Map([["b.md", "x\n"], ["c.md", "p\n"]]);
    for (const vault of result.vaults) expect(vault, trace).toEqual(files);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted note respelled behind the engine's back before a restart (#481)", () => {
  it.each([
    ["macos", "respelled"],
    ["windows", "respelled"],
    ["macos", "vacated-path"],
    ["windows", "vacated-path"],
  ] as const)("names every file as the vault does, with no tombstone of the note (%s, %s)", async (platform, variant) => {
    const result = await respelledFileAfterRestart(environment, platform, variant);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("STRASSE.md");
    expect(note, trace).toBeDefined();
    const files = variant === "respelled" ? new Map([["d.md", "p\n"], ["straße.md", "x\nedited\n"]]) : new Map([["d.md", "x\n"], ["straße.md", "new\n"]]);
    for (const vault of result.vaults) expect(vault, trace).toEqual(files);
    expect(new Set(result.documents.keys()), trace).toEqual(new Set(files.keys()));
    expect(result.tombstoned, trace).not.toContain(note);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted local rename over a remote rename into a respelled folder (#375)", () => {
  it.each([
    ["posix", "free-path"],
    ["macos", "free-path"],
    ["windows", "free-path"],
    ["posix", "vacated-path"],
    ["macos", "vacated-path"],
    ["windows", "vacated-path"],
  ] as const)("commits the local rename, with no stray copy (%s, %s)", async (platform, variant) => {
    const result = await localRenameOverRemoteRenameIntoRespelledFolder(environment, platform, variant);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const moved = result.before.get("notes/C.md");
    const note = result.before.get("notes/b.md");
    expect(moved, trace).toBeDefined();
    expect(note, trace).toBeDefined();
    const expected = variant === "free-path" ? new Map([["notes/C.md", moved], ["z.md", note]]) : new Map([["moved/C.md", moved], ["notes/C.md", note]]);
    expect(result.documents, trace).toEqual(expected);
    const files = variant === "free-path" ? new Map([["notes/C.md", "a\n"], ["z.md", "b\n"]]) : new Map([["moved/C.md", "a\n"], ["notes/C.md", "b\n"]]);
    for (const vault of result.vaults) expect(vault, trace).toEqual(files);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted rename onto a just-deleted note's path (#451)", () => {
  it.each(["posix", "macos", "windows"] as const)("commits the delete and the rename over a remote edit of the renamed note (%s)", async (platform) => {
    const result = await renameOntoDeletedNotePath(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const renamed = result.before.get("x.md");
    const deleted = result.before.get("c.md");
    expect(renamed, trace).toBeDefined();
    expect(deleted, trace).toBeDefined();
    expect(result.documents, trace).toEqual(new Map([["c.md", renamed]]));
    for (const vault of result.vaults) expect(vault, trace).toEqual(new Map([["c.md", "x\nremote\n"]]));
    expect(result.tombstoned, trace).toEqual([deleted]);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted renames of one note onto a vacated path on both devices (#462)", () => {
  it.each(["posix", "macos", "windows"] as const)("keeps the local edit of the renamed note (%s)", async (platform) => {
    const result = await bothRenameOntoVacatedPath(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    for (const vault of result.vaults) {
      const contents = [...vault.values()];
      expect(contents, trace).toContain("x\nlocal\n");
      expect(contents, trace).toContain("x\nremote\n");
      expect(contents, trace).toContain("c\nremote\n");
    }
    expect(result.vaults[1], trace).toEqual(result.vaults[0]);
    expect(result.documents.size, trace).toBe(result.vaults[0]?.size);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted unpushed rename onto a remote create's path (#479)", () => {
  it.each(["posix", "macos", "windows"] as const)("never tombstones the other device's note (%s)", async (platform) => {
    const result = await renameOntoRemoteCreate(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const renamed = result.before.get("b.md");
    expect(renamed, trace).toBeDefined();
    // Only the note the other device deleted is tombstoned.
    expect(result.tombstoned, trace).toEqual([renamed]);
    expect(result.documents.get("x.md"), trace).toBeDefined();
    for (const vault of result.vaults) {
      expect(vault.get("x.md"), trace).toBe("theirs\n");
      expect([...vault.values()], trace).toContain("b\nmine\n");
    }
    expect(result.vaults[1], trace).toEqual(result.vaults[0]);
    expect(result.documents.size, trace).toBe(result.vaults[0]?.size);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted unpushed rename of a note deleted and recreated at its path (#486)", () => {
  it.each(["posix", "macos", "windows"] as const)("never renames the recreated note (%s)", async (platform) => {
    const result = await renameOfRecreatedNote(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const renamed = result.before.get("b.md");
    expect(renamed, trace).toBeDefined();
    expect(result.recreated, trace).toBeDefined();
    expect(result.recreated, trace).not.toBe(renamed);
    // Only the note the other device deleted is tombstoned, and the
    // recreated note keeps its path.
    expect(result.tombstoned, trace).toEqual([renamed]);
    expect(result.documents.get("b.md"), trace).toBe(result.recreated);
    expect(result.documents.get("x.md"), trace).toBeDefined();
    for (const vault of result.vaults) {
      expect(vault.get("b.md"), trace).toBe("theirs\n");
      expect(vault.get("x.md"), trace).toBe("b\nmine\n");
    }
    expect(result.vaults[1], trace).toEqual(result.vaults[0]);
    expect(result.documents.size, trace).toBe(result.vaults[0]?.size);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted merge of a later operation's document during a push (#482)", () => {
  it.each(["posix", "macos", "windows"] as const)("commits the edit on top of the remote delete and quiesces (%s)", async (platform) => {
    const result = await mergedDuringPush(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    expect([...result.documents.keys()].sort(), trace).toEqual(["a.md", "b.md"]);
    for (const vault of result.vaults) {
      expect(vault, trace).toEqual(
        new Map([
          ["a.md", "theirs\na\nmine\n"],
          ["b.md", "b\nmine\n"],
        ]),
      );
    }
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted busy-path scenario (#167)", () => {
  it("pushes a change made at a path a refused operation held once the operation commits, without a restart", async () => {
    const result = await changeAtBusyPathKept(environment);
    const trace = tail(result.trace, 120);

    expect(result.violations, trace).toEqual([]);
    expect([...result.whileRefused.keys()], trace).toEqual(["note.md"]);
    expect(result.vault, trace).toEqual(
      new Map([
        ["moved.md", "the note\n"],
        ["note.md", "a new note\n"],
      ]),
    );
    expect([...result.documents.keys()].sort(), trace).toEqual(["moved.md", "note.md"]);
    // The rename kept the original note's id; the new note is a document of its own.
    expect(result.documents.get("moved.md"), trace).toBe(result.whileRefused.get("note.md"));
    expect(result.documents.get("note.md"), trace).not.toBe(result.whileRefused.get("note.md"));
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

  it("reports an engine still stalled when the run ends as a liveness violation, and returns (#310)", async () => {
    const result = await stalledAtFinish(environment);
    const trace = tail(result.trace);

    // The final check's stall, recorded by SimRun.finish: it names the step and the engine.
    const stalls = result.violations.filter((violation) => violation.invariant === "liveness" && violation.detail.includes("engine work never finished"));
    expect(stalls.map((violation) => violation.detail), trace).toEqual([expect.stringMatching(/^run stalled at step \d+: e1's engine work never finished/)]);
    expect(result.trace.some((line) => line.includes("STALLED: run stalled at step")), trace).toBe(true);
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

describe.runIf(suites.has("scenarios"))("scripted file/folder rule scenarios (#307)", () => {
  it.each(["windows", "macos"] as const)("keeps a local edit and a local note whose folder a remote rename's name takes, and stops pushing, under %s rules", async (platform) => {
    const result = await remoteRenameOntoLocalFolder(environment, platform);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const a = result.before.get("a.md");
    expect(a, trace).toBeDefined();
    // Both vaults hold the same files as the server's live documents.
    const [posix, other] = result.vaults;
    expect(other, trace).toEqual(posix);
    expect([...(posix?.keys() ?? [])].sort(), trace).toEqual([...result.documents.keys()].sort());
    // The edit of a.md is live under a's id (the rename kept, the edit merged in) ...
    const aPath = [...result.documents].find(([, document]) => document === a)?.[0];
    expect(aPath, trace).toBeDefined();
    expect(posix?.get(aPath ?? ""), trace).toBe("a\nlocal edit\n");
    // ... and the new note's content is live, as another document.
    const notes = [...(posix ?? new Map<string, string>())].filter(([, content]) => content === "new note\n");
    expect(notes, trace).toHaveLength(1);
    expect(result.documents.get(notes[0]?.[0] ?? ""), trace).not.toBe(a);
    expect(result.tombstoned, trace).toEqual([]);
    // The case-insensitive engine never sent the same refused commit push after push.
    expect(result.pushes.filter((line) => line.endsWith("0 committed, 1 conflicts, 1 pending")).length, trace).toBeLessThanOrEqual(1);
  });
});

describe.runIf(suites.has("scenarios"))("scripted remote edit of a vacated path (#253)", () => {
  it.each([
    { platform: "macos", timing: "before-push" },
    { platform: "macos", timing: "while-pushing" },
    { platform: "windows", timing: "before-push" },
    { platform: "windows", timing: "while-pushing" },
  ] as const)("keeps the remote edit of a.md and the id of the note renamed onto A.md, with nothing left pending, under $platform rules ($timing)", async ({ platform, timing }) => {
    const result = await remoteEditOfVacatedPath(environment, platform, timing);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const h = result.before.get("a.md");
    const d = result.before.get("d.md");
    expect(h, trace).toBeDefined();
    expect(d, trace).toBeDefined();
    // The edit wins over the delete: H stays live at a.md with the remote edit.
    expect(result.documents.get("a.md"), trace).toBe(h);
    // D keeps its id and content, at a conflict-copy path of the name it was renamed to.
    const dPaths = [...result.documents].filter(([, document]) => document === d).map(([path]) => path);
    expect(dPaths, trace).toEqual([expect.stringMatching(/^A \(conflict .*\)\.md$/)]);
    const dPath = dPaths[0] ?? "";
    const expected = new Map([
      ["a.md", "h\nremote edit\n"],
      [dPath, "d\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.documents.size, trace).toBe(2);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts, trace).toEqual([{ reason: "path-taken", path: "A.md", copyPath: dPath, document: d }]);
    // Nothing stays pending: the case-insensitive engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted remote rename into a folder named like a deleted note's path (#299)", () => {
  it.each(["macos", "windows"] as const)("keeps the remote edit at notes/f.md and the user's notes/f.md as a conflict copy, with nothing deferred, under %s rules", async (platform) => {
    const result = await remoteRenameIntoDeletedNotesFolder(environment, platform);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("NOTES");
    expect(note, trace).toBeDefined();
    // The edit wins over the delete: the note is live at its new path with the remote edit.
    expect(result.documents.get("notes/f.md"), trace).toBe(note);
    // The user's own notes/f.md is kept, as a new document at a conflict-copy path in notes/.
    const copyPaths = [...result.documents.keys()].filter((path) => path !== "notes/f.md");
    expect(copyPaths, trace).toEqual([expect.stringMatching(/^notes\/f \(conflict .*\)\.md$/)]);
    const copyPath = copyPaths[0] ?? "";
    const expected = new Map([
      ["notes/f.md", "theirs, edited\n"],
      [copyPath, "mine\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    // Nothing stays pending: the case-insensitive engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted new file at a renamed-away note's synced path (#352)", () => {
  it("keeps the local rename with the remote edit, the local edit as a conflict copy and the new file NOTES as a path-taken copy, with nothing deferred", async () => {
    const result = await newFileAtRenamedAwayPath(environment);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("NOTES");
    expect(note, trace).toBeDefined();
    // The local rename wins: the note is live at notes/f.md with the remote edit.
    expect(result.documents.get("notes/f.md"), trace).toBe(note);
    const others = [...result.documents.keys()].filter((path) => path !== "notes/f.md").sort();
    // The local edit is a conflict copy in notes/, and the new file NOTES,
    // which the server takes for the folder notes/, a path-taken copy.
    expect(others, trace).toEqual([expect.stringMatching(/^NOTES \(conflict .*\)$/), expect.stringMatching(/^notes\/f \(conflict .*\)\.md$/)]);
    const [otherPath = "", minePath = ""] = others;
    const expected = new Map([
      ["notes/f.md", "theirs\n"],
      [minePath, "mine\n"],
      [otherPath, "other\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    // Nothing stays deferred or pending: the user's engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted local rename into a folder named like a remote rename's path (#344)", () => {
  it.each(["posix", "macos", "windows"] as const)("keeps the local rename to Notes/C.md and the local edit as a conflict copy in Notes/, with nothing deferred, under %s rules", async (platform) => {
    const result = await localRenameIntoRemoteRenamesFolder(environment, platform);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("a.md");
    expect(note, trace).toBeDefined();
    // The local rename wins over the remote one: the note is live at Notes/C.md with the remote content.
    expect(result.documents.get("Notes/C.md"), trace).toBe(note);
    // The overlapping local edit is kept, as a new document at a conflict-copy path in Notes/.
    const copyPaths = [...result.documents.keys()].filter((path) => path !== "Notes/C.md");
    expect(copyPaths, trace).toEqual([expect.stringMatching(/^Notes\/C \(conflict .*\)\.md$/)]);
    const copyPath = copyPaths[0] ?? "";
    const expected = new Map([
      ["Notes/C.md", "theirs\n"],
      [copyPath, "mine\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts.map(({ reason, copyPath: copy }) => [reason, copy]), trace).toEqual([["overlapping-edits", copyPath]]);
    // Nothing stays pending: the second engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted remote rename onto a file named like the local file's folder (#359)", () => {
  it.each(["posix", "macos", "windows"] as const)("keeps the remote edit at NOTES and the local edit under a conflict-named folder, with nothing deferred, under %s rules", async (platform) => {
    const result = await remoteRenameOntoFolderName(environment, platform);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("Notes/C.md");
    expect(note, trace).toBeDefined();
    // The remote rename wins: the note is live at NOTES with the remote edit.
    expect(result.documents.get("NOTES"), trace).toBe(note);
    // The local edit is one copy, under a conflict-named folder Notes/: no duplicates.
    const others = [...result.documents.keys()].filter((path) => path !== "NOTES");
    expect(others, trace).toEqual([expect.stringMatching(/^Notes \(conflict .*\)\/C\.md$/)]);
    const [copyPath = ""] = others;
    const expected = new Map([
      ["NOTES", "theirs\n"],
      [copyPath, "mine\n"],
    ]);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.conflicts.map(({ reason, path, copyPath: copy }) => [reason, path, copy]), trace).toEqual([["overlapping-edits", "NOTES", copyPath]]);
    // Nothing stays deferred or pending: the user's engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted crash while a refused create moves to its conflict copy (#371, #372)", () => {
  const cases = [
    ...(["posix", "macos", "windows"] as const).map((platform) => [platform, "after", "holder-leaves"] as const),
    ["posix", "before", "holder-leaves"],
    ["posix", "before", "delete-copy"],
    ["posix", "before", "move-copy"],
    ["windows", "after", "delete-copy"],
  ] as const;
  it.each(cases)("converges with nothing pending under %s rules, killed %s recording the copy, when %s", async (platform, when, then) => {
    const result = await interruptedConflictMove(environment, platform, when, then);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    expect(result.copy, trace).toMatch(/^notes \(conflict .*\)$/);
    // The other device's note, and the user's note once (none if the user deleted it), where it ended up.
    const others = [...result.documents.keys()].filter((path) => path !== (then === "holder-leaves" ? "A.md" : "NOTES/d.md"));
    expect(result.documents.size, trace).toBe(others.length + 1);
    if (then === "delete-copy") expect(others, trace).toEqual([]);
    else expect(others, trace).toEqual([then === "move-copy" ? "kept.md" : expect.stringMatching(/^notes( \(conflict .*\))?$/)]);
    for (const path of others) expect(result.vaults[1]?.get(path), trace).toBe("mine\n");
    expect(result.vaults[0], trace).toEqual(result.vaults[1]);
    // Nothing stays pending: the second engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted parked note's edit against another note at its old path (#391, #398)", () => {
  it.each(["kept-file", "deleted-file"] as const)("keeps the other note at plan.md and brings the parked note back at draft.md under its own id (%s)", async (variant) => {
    const result = await parkedEditAtReusedPath(environment, variant);
    const trace = `${tail(result.trace, 200)}\nconflicts: ${JSON.stringify(result.conflicts)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("plan.md");
    expect(note, trace).toBeDefined();
    // The parked note is back at its new name under its own id, and the other note keeps plan.md under another.
    expect(result.documents.get("draft.md"), trace).toBe(note);
    expect(result.documents.get("plan.md"), trace).toBeDefined();
    expect(result.documents.get("plan.md"), trace).not.toBe(note);
    const expected = new Map([
      ["draft.md", "one\ntwo\n"],
      ["plan.md", "another note\n"],
    ]);
    if (variant === "kept-file") {
      // The edit the user kept is live as a conflict copy.
      const copyPaths = [...result.documents.keys()].filter((path) => !expected.has(path));
      expect(copyPaths, trace).toEqual([expect.stringMatching(/^plan \(conflict .*\)\.md$/)]);
      expected.set(copyPaths[0] ?? "", "one\ntwo (edited)\n");
    }
    expect(result.documents.size, trace).toBe(expected.size);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    // Nothing stays pending: the Windows engine's last push had nothing left to do.
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
  });
});

describe.runIf(suites.has("scenarios"))("scripted crash in a pull that brings a deleted and recreated note (#453)", () => {
  it.each(["posix", "windows"] as const)("converges with the edit kept and nothing deferred under %s rules", async (platform) => {
    const result = await recreatedNoteMergeCrash(environment, platform);
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}`;

    expect(result.killed, trace).toBe(true);
    // engine-deferred among them: a deferral left behind is reported.
    expect(result.violations, trace).toEqual([]);
    const contents = result.vaults[1] ?? new Map<string, string>();
    expect([...contents.keys()].sort(), trace).toEqual([...result.documents.keys()].sort());
    expect(contents.get("Notes/C.md"), trace).toBe("w3\n");
    // The user's edit of the deleted note is kept, once.
    expect([...contents.values()].filter((content) => content === "w2\n"), trace).toHaveLength(1);
    expect(result.vaults[0], trace).toEqual(result.vaults[1]);
  });
});

describe.runIf(suites.has("scenarios"))("scripted parked note's file renamed, then a restart, against another note at its old path (#459)", () => {
  it("keeps the other note at plan.md, the renamed file as a new note, and brings the parked note back at draft.md", async () => {
    const result = await parkedEditAtReusedPath(environment, "renamed-file");
    const trace = `${tail(result.trace, 200)}\nvaults: ${JSON.stringify(result.vaults.map((vault) => [...vault]))}\ndocuments: ${JSON.stringify([...result.documents])}\ntombstoned: ${JSON.stringify(result.tombstoned)}`;

    expect(result.violations, trace).toEqual([]);
    const note = result.before.get("plan.md");
    expect(note, trace).toBeDefined();
    expect(result.documents.get("draft.md"), trace).toBe(note);
    // Before #459 the parked note took the other note's file for its own after the restart, and the server tombstoned the other note.
    expect(result.documents.get("plan.md"), trace).toBeDefined();
    expect(result.documents.get("plan.md"), trace).not.toBe(note);
    expect(result.documents.get("notes.md"), trace).toBeDefined();
    expect(result.documents.get("notes.md"), trace).not.toBe(note);
    expect(result.documents.get("notes.md"), trace).not.toBe(result.documents.get("plan.md"));
    const expected = new Map([
      ["draft.md", "one\ntwo\n"],
      ["notes.md", "one\ntwo (edited)\n"],
      ["plan.md", "another note\n"],
    ]);
    expect(result.documents.size, trace).toBe(expected.size);
    expect(result.vaults[0], trace).toEqual(expected);
    expect(result.vaults[1], trace).toEqual(expected);
    expect(result.tombstoned, trace).toEqual([]);
    expect(result.pushes.at(-1), trace).toMatch(/: 0 committed, 0 conflicts, 0 pending$/);
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

describe.runIf(suites.has("scenarios"))("scripted restore-and-purge scenarios (#488, #494)", () => {
  const keepsTheEdit = async (shape: Parameters<typeof restoreWindow>[1]) => {
    const result = await restoreWindow(environment, shape);
    const trace = tail(result.trace, 200);

    expect([...result.device.values()].join(""), trace).toContain("acknowledged edit");
    expect([...result.server.values()].join(""), trace).toContain("acknowledged edit");
  };

  // The restored server's purge markers name the revisions it purged, not
  // the device's, and the device sends the anchor of its own commit above
  // its cursor: each restore is reported as divergence (#488, #494).
  it.each(["untouched-after-restore", "deleted-after-restore", "own-commit-above-cursor"] as const)(
    "keeps a device's acknowledged edit the restored server lost, and pushes it again (%s)",
    async (shape) => {
      await keepsTheEdit(shape);
    },
  );
});

describe.runIf(suites.has("scenarios"))("scripted upload-session scenarios (#490)", () => {
  it("backs the engine off when the server refuses its BeginBlob, PutBlobChunk and CommitBlob for new content, and loses no write", async () => {
    const result = await uploadSessionCallsRefused(environment);
    const trace = tail(result.trace, 160);

    // Includes the network's check that the engine sent nothing while it backed off.
    expect(result.violations, trace).toEqual([]);
    expect(result.refused, trace).toEqual(["BeginBlob", "PutBlobChunk", "CommitBlob"]);
    // Half of a ceiling that doubles from 1 s with each consecutive refusal, plus a random part of the other half.
    const bounds = [
      [500, 1000],
      [1000, 2000],
      [2000, 4000],
    ];
    expect(result.delays, trace).toHaveLength(bounds.length);
    result.delays.forEach((delay, index) => {
      expect(delay, `backoff ${String(index + 1)}\n${trace}`).toBeGreaterThanOrEqual(bounds[index]?.[0] ?? Infinity);
      expect(delay, `backoff ${String(index + 1)}\n${trace}`).toBeLessThanOrEqual(bounds[index]?.[1] ?? -Infinity);
    });
    // The refused second chunk was sent again, and the upload resumed where the server's session stood: each chunk accepted once.
    expect(result.chunks, trace).toEqual(["0", "65536", "131072"]);
    // Nothing was committed before the blob was: one CommitRevision, acknowledged once.
    expect(result.commits, trace).toBe(1);
    expect(result.engineAcknowledged, trace).toEqual(["attachment.md"]);
    expect(result.server.get("attachment.md") === result.written, trace).toBe(true);
    expect(result.engine.get("attachment.md") === result.written, trace).toBe(true);
  });

  it("keeps every write when the vault is at its upload session limit, and reclaims idle sessions, the engine's own mid-upload included", async () => {
    const result = await uploadLimitReached(environment);
    const trace = tail(result.trace, 200);

    // No lost write, convergence, no backoff violation (the engine waited after each RESOURCE_EXHAUSTED).
    expect(result.violations, trace).toEqual([]);
    // Two abandoned sessions aged, then the engine's own.
    expect(result.aged, trace).toEqual([2, 1]);
    // Refused at the limit twice; the aged sessions reclaimed; refused once more after its own session was reclaimed; then its upload got a session.
    expect(result.begins, trace).toEqual(["ResourceExhausted", "ResourceExhausted", "ok", "ok", "ResourceExhausted", "ok"]);
    // The chunk after the reclaim found no session.
    expect(result.chunkOutcomes, trace).toContain("FailedPrecondition");
    // The reclaimed session's chunks are gone: the upload started over from the first byte.
    expect(result.chunksAfterReclaim, trace).toEqual(["0", "65536", "131072"]);
    expect(result.delays.length, trace).toBeGreaterThanOrEqual(3);
    expect(result.engineAcknowledged, trace).toEqual(["note.md", "large.md"]);
    expect([...result.server.keys()].sort(), trace).toEqual(["first.md", "large.md", "note.md", "second.md"]);
    for (const [path, content] of result.written) expect(result.server.get(path) === content, `${path}\n${trace}`).toBe(true);
  });
});
