// Scripted scenarios: hand-written interleavings that random schedules hit
// only rarely, driven step by step against the real server.

import { hexToBytes } from "@noble/hashes/utils.js";

import { serverHeads } from "./engine-observer";
import { settle } from "./network";
import { SimRun, type RunResult, type SimEndpoints } from "./runner";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface LostResponseResult extends RunResult {
  /** Label of the revision whose first response was lost. */
  retried: string;
  /** Labels of the revisions acknowledged to each client, in order. */
  acknowledgedBy: string[][];
}

/**
 * The lost-response interleaving from #12 (SPEC.md §6.2): the server applies
 * c0's commit A but the response is lost; c1 pulls and commits on top of A,
 * moving the head; c0 then retries A with the same revision id. The retry must
 * return A itself, not FAILED_PRECONDITION.
 */
export async function lostResponseAfterHeadMoved(endpoints: SimEndpoints): Promise<LostResponseResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 2 });
  const operation = async (client: number, kind: "create" | "edit" | "pull", arg = 1) => {
    await run.step({ kind: "operation", client, operation: kind, arg });
    await run.drain(client);
  };

  await operation(0, "pull");
  await operation(0, "create");
  await operation(1, "pull");

  // c0 edits the document: deliver its blob upload, then its commit.
  await run.step({ kind: "operation", client: 0, operation: "edit", arg: 2 });
  for (let delivery = 0; run.context.network.pendingRequest(0) !== "CommitRevision"; delivery++) {
    if (delivery > 100) throw new Error("c0 never sent CommitRevision");
    await run.step({ kind: "deliver-request", client: 0 });
    await run.step({ kind: "deliver-response", client: 0 });
  }
  await run.step({ kind: "deliver-request", client: 0 });
  const retried = lastCommitRevisionLabel(run);
  // The server has applied it; the response is lost, and c0 queues a retry
  // with the same revision id.
  await run.step({ kind: "drop-response", pick: 0 });

  // c1 learns about c0's revision and commits on top of it.
  await operation(1, "pull");
  await operation(1, "edit", 3);

  // Only now does c0's retry reach the server.
  await run.drain(0);

  const result = await run.finish();
  const acknowledgedBy = [0, 1].map((client) =>
    result.acknowledged.filter((acknowledgement) => acknowledgement.client === client).map((acknowledgement) => run.context.ids.label(acknowledgement.revisionId)),
  );
  return { ...result, retried, acknowledgedBy };
}

/** The label of the revision in the newest CommitRevision c0 sent, read from the trace. */
function lastCommitRevisionLabel(run: SimRun): string {
  const entry = [...run.trace].reverse().find((line) => line.includes("c0 CommitRevision("));
  const label = /c0 CommitRevision\(\S+ (\S+) /.exec(entry ?? "")?.[1];
  if (label === undefined) throw new Error("no CommitRevision from c0 in the trace");
  return label;
}

export interface EnginePushResult extends RunResult {
  /** The engine's acknowledged revisions, in order: label and the label of its base. */
  engineAcknowledged: { label: string; base: string }[];
  /** Label of the engine revision whose CommitRevision response was lost. */
  lostCommit: string;
  /** Label of the scripted client's revision that moved the head under the engine's second edit. */
  movedHead: string;
  /** The engine's edited document's head content on the server, and its own copy, after the run. */
  serverContent: string;
  engineContent: string;
  /** Offsets of the large upload's PutBlobChunk calls that reached the server, before and after the crash. */
  chunksBeforeCrash: string[];
  chunksAfterCrash: string[];
}

/** Content of the large file the engine uploads: spans several of the sim server's 64 KiB chunks. */
const largeContentBytes = 150 * 1024;

/**
 * The engine's push side (#17, SPEC.md §6.2) against the real server, through
 * the simulated network. The engine (the observer, which crashes with c0)
 * edits a document c0 created and pushes:
 *
 * 1. Its CommitRevision response is lost after the server applied it; the
 *    engine retries with the same revision id and gets that revision back.
 * 2. Its next edit is committed against a head that c1 moves between the
 *    engine's pull and its commit; the engine pulls, its merge hook keeps both
 *    sides, and it commits the merge on top of c1's revision.
 * 3. A large file's upload loses a chunk; the engine crashes and restarts with
 *    its vault and journal, and resumes the upload where the server's session
 *    stands.
 */
export async function enginePushUnderFaults(endpoints: SimEndpoints): Promise<EnginePushResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 2 });
  const { observer } = run;
  const engine = observer.index;
  const log = (entry: string) => {
    run.context.log(entry);
  };
  observer.merge = async (request) => {
    const remote = decoder.decode((await request.readRemoteContent()) ?? new Uint8Array());
    const local = decoder.decode(request.local.content ?? new Uint8Array());
    return { status: "merged", path: request.remote.path, content: encoder.encode(`${remote}${local}`) };
  };
  const operation = async (client: number, kind: "create" | "edit" | "pull", arg = 1) => {
    await run.step({ kind: "operation", client, operation: kind, arg });
    await run.drain(client);
  };
  const engineDrain = async () => {
    await settle();
    await run.drain(engine);
  };
  /** Delivers the engine's calls until `method` is the next one it sends. */
  const deliverUntil = async (method: string) => {
    for (let delivery = 0; run.context.network.pendingRequest(engine) !== method; delivery++) {
      if (delivery > 200) throw new Error(`the engine never sent ${method}`);
      await run.step({ kind: "deliver-request", client: engine });
      await run.step({ kind: "deliver-response", client: engine });
    }
  };

  await operation(0, "pull");
  await operation(0, "create");
  log(observer.startPull());
  await engineDrain();
  const [path] = await observer.list();
  if (path === undefined) throw new Error("the engine did not pull c0's document");

  // 1. A lost CommitRevision response.
  log(await observer.edit(path, encoder.encode("engine edit 1\n")));
  log(observer.startPush());
  await deliverUntil("CommitRevision");
  await run.step({ kind: "deliver-request", client: engine });
  const lostCommit = lastCommitLabel(run, engine);
  await run.step({ kind: "drop-response", pick: 0 });
  await engineDrain();

  // 2. The head moves between the engine's pull and its commit.
  await operation(1, "pull");
  // A pull step also starts an engine pull; let it finish before the user edits.
  await engineDrain();
  log(await observer.edit(path, encoder.encode("engine edit 2\n")));
  log(observer.startPush());
  await deliverUntil("CommitRevision");
  await operation(1, "edit", 3);
  const movedHead = run.context.ids.label(run.context.acknowledged.filter((acknowledgement) => acknowledgement.client === 1).at(-1)?.revisionId ?? "");
  await engineDrain();

  // 3. An upload interrupted by a lost chunk and a crash.
  const large = new Uint8Array(largeContentBytes).fill(0x61);
  const phaseStart = run.trace.length;
  log(await observer.edit("large.md", large));
  log(observer.startPush());
  await deliverUntil("PutBlobChunk");
  await run.step({ kind: "deliver-request", client: engine });
  await run.step({ kind: "deliver-response", client: engine });
  if (run.context.network.pendingRequest(engine) !== "PutBlobChunk") throw new Error("the large upload took a single chunk");
  await run.step({ kind: "drop-request", pick: 0 });
  await engineDrain();
  const chunksBeforeCrash = chunkOffsets(run.trace.slice(phaseStart), engine);
  log(observer.crash());
  log(observer.startPush());
  await engineDrain();
  const chunksAfterCrash = chunkOffsets(run.trace.slice(phaseStart), engine).slice(chunksBeforeCrash.length);

  const result = await run.finish();
  const engineAcknowledged = result.acknowledged
    .filter((acknowledgement) => acknowledgement.client === engine && acknowledgement.path === path)
    .map((acknowledgement) => ({ label: run.context.ids.label(acknowledgement.revisionId), base: run.context.ids.label(acknowledgement.parentRevisionId) }));
  const heads = await serverHeads(run.direct, run.context.vaultId);
  const headHash = heads.files.get(path);
  const engineCopy = await observer.read(path);
  const serverContent = headHash === undefined ? "" : decoder.decode(await downloadBlob(run, headHash));
  return {
    ...result,
    engineAcknowledged,
    lostCommit,
    movedHead,
    serverContent,
    engineContent: engineCopy === undefined ? "" : decoder.decode(engineCopy),
    chunksBeforeCrash,
    chunksAfterCrash,
  };
}

/** Offsets of the PutBlobChunk calls of `client` that the server accepted, in order, from `trace`. */
function chunkOffsets(trace: readonly string[], client: number): string[] {
  const pattern = new RegExp(`c${String(client)} PutBlobChunk\\(\\S+ @(\\d+)\\) -> ok`);
  return trace.flatMap((line) => {
    const offset = pattern.exec(line)?.[1];
    return offset === undefined ? [] : [offset];
  });
}

/** The label of the revision in the newest CommitRevision `client` sent, read from the trace. */
function lastCommitLabel(run: SimRun, client: number): string {
  const needle = `c${String(client)} CommitRevision(`;
  const entry = [...run.trace].reverse().find((line) => line.includes(needle));
  const label = new RegExp(`c${String(client)} CommitRevision\\(\\S+ (\\S+) `).exec(entry ?? "")?.[1];
  if (label === undefined) throw new Error(`no CommitRevision from c${String(client)} in the trace`);
  return label;
}

async function downloadBlob(run: SimRun, hash: string): Promise<Uint8Array> {
  const response = await run.direct.blobs.downloadBlob({ vaultId: run.context.vaultId, blobId: hexToBytes(hash), offset: 0n, length: 0 });
  return response.data;
}

export interface ConcurrentEditsResult extends RunResult {
  /** Each engine's vault after the run: path to content (binary content as hex). */
  vaults: Map<string, string>[];
  /** Each engine's conflict log: reason, path and copy path of every entry. */
  conflicts: { reason: string; path: string; copyPath: string | null }[][];
  /** Phases whose refused commit the second engine retried with a new base, by name. */
  refused: string[];
}

const textLines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
const crlfLines = (...values: string[]) => values.map((value) => `${value}\r\n`).join("");
/** The note both engines edit: ten lines, so edits of lines 2 and 9 do not overlap. */
const noteLines = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`);
const withLine = (lines: readonly string[], index: number, value: string) => lines.map((line, at) => (at === index ? value : line));

/**
 * Two real engines edit the same documents concurrently through the
 * simulated network (#18, SPEC.md §7). In every phase both engines change
 * their vaults, the second engine's push gets as far as its CommitRevision,
 * the first engine's push commits, and only then does the second engine's
 * commit reach the server, so it is refused (head moved, or path taken) and
 * the second engine pulls, merges and commits again. Faults: the merged
 * commit's response is lost once, and the second engine crashes once after a
 * conflict was resolved locally, before it pushed the result.
 *
 * 1. Non-overlapping edits of a note: merged, no conflict copy.
 * 2. Overlapping edits: the first engine's version in place, the second's as
 *    a conflict copy, logged.
 * 3. Concurrent edits of a binary file: a conflict copy.
 * 4. One engine only converts the note's line endings to CRLF while the
 *    other edits a line: merged, no conflict copy.
 * 5. Both create a file at the same path: a conflict copy.
 * 6. Both create a file at paths that differ only by case: the second
 *    engine's document moves to a conflict-copy path.
 */
export async function enginesEditConcurrently(endpoints: SimEndpoints): Promise<ConcurrentEditsResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2 });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };
  /** Delivers `engine`'s calls until `method` is the next one it sends. */
  const deliverUntil = async (engine: number, method: string) => {
    for (let delivery = 0; run.context.network.pendingRequest(engine) !== method; delivery++) {
      if (delivery > 400) throw new Error(`e${String(engine)} never sent ${method}`);
      await run.step({ kind: "deliver-request", client: engine });
      await run.step({ kind: "deliver-response", client: engine });
    }
  };
  const refused: string[] = [];
  /**
   * The second engine's commit reaches the server after the first engine's.
   * `fault` runs once the second engine's refused commit has been answered.
   */
  const race = async (phase: string, fault?: () => Promise<void>) => {
    log(`phase: ${phase}`);
    log(second.startPush());
    await deliverUntil(second.index, "CommitRevision");
    log(first.startPush());
    await drain(first.index);
    const traceAt = run.trace.length;
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "deliver-response", client: second.index });
    if (run.trace.slice(traceAt).some((line) => / -> (FailedPrecondition|AlreadyExists)/.test(line))) refused.push(phase);
    if (fault !== undefined) await fault();
    await drain(second.index);
    log(first.startPull());
    await drain(first.index);
    log(second.startPull());
    await drain(second.index);
  };
  /** Loses the response of the second engine's next CommitRevision: its retry must return the same revision. */
  const loseMergedCommitResponse = async () => {
    await deliverUntil(second.index, "CommitRevision");
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "drop-response", pick: 0 });
  };
  /** Crashes the second engine once its merge is on disk, before it uploads the result. */
  const crashBeforeUpload = async () => {
    await deliverUntil(second.index, "BeginBlob");
    log(second.crash());
    log(second.startPush());
  };

  const note = "notes/plan.md";
  log(await first.edit(note, encoder.encode(textLines(...noteLines))));
  log(first.startPush());
  await drain(first.index);
  log(second.startPull());
  await drain(second.index);

  // 1. Non-overlapping edits.
  const firstEdit = withLine(noteLines, 1, "line 2 (first engine)");
  log(await first.edit(note, encoder.encode(textLines(...firstEdit))));
  log(await second.edit(note, encoder.encode(textLines(...withLine(noteLines, 8, "line 9 (second engine)")))));
  await race("non-overlapping edits", loseMergedCommitResponse);
  const merged = withLine(firstEdit, 8, "line 9 (second engine)");

  // 2. Overlapping edits.
  log(await first.edit(note, encoder.encode(textLines(...withLine(merged, 4, "line 5 (first engine)")))));
  log(await second.edit(note, encoder.encode(textLines(...withLine(merged, 4, "line 5 (second engine)")))));
  await race("overlapping edits", crashBeforeUpload);

  // 3. A binary file.
  const image = "attachments/image.png";
  log(await first.edit(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])));
  log(first.startPush());
  await drain(first.index);
  log(second.startPull());
  await drain(second.index);
  log(await first.edit(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2])));
  log(await second.edit(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3])));
  await race("binary edits");

  // 4. Line endings: the second engine only converts the note to CRLF.
  const current = await second.read(note);
  const currentLines = decoder.decode(current ?? new Uint8Array()).split("\n").slice(0, -1);
  log(await first.edit(note, encoder.encode(textLines(...withLine(currentLines, 0, "line 1 (first engine)")))));
  log(await second.edit(note, encoder.encode(crlfLines(...currentLines))));
  await race("line endings");

  // 5. Creates at the same path.
  log(await first.edit("inbox/new.md", encoder.encode("created by the first engine\n")));
  log(await second.edit("inbox/new.md", encoder.encode("created by the second engine\n")));
  await race("creates at one path");

  // 6. Creates at paths that differ only by case.
  log(await first.edit("Todo.md", encoder.encode("first engine's list\n")));
  log(await second.edit("todo.md", encoder.encode("second engine's list\n")));
  await race("creates at case-colliding paths");

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) {
        const content = (await engine.read(path)) ?? new Uint8Array();
        contents.set(path, path.endsWith(".png") ? Array.from(content, (value) => value.toString(16).padStart(2, "0")).join("") : decoder.decode(content));
      }
      return contents;
    }),
  );
  const conflicts = await Promise.all([first, second].map(async (engine) => (await engine.conflicts()).map(({ reason, path, copyPath }) => ({ reason, path, copyPath }))));
  return { ...result, vaults, conflicts, refused };
}

export interface RenameOntoUnsyncedFileResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** Each engine's conflict log: reason, path and copy path of every entry. */
  conflicts: { reason: string; path: string; copyPath: string | null }[][];
}

/**
 * A remote rename onto a path an unsynced local file holds (#173 review): the
 * first engine renames a note and appends to it, while the second engine has
 * created an unrelated note of its own at the new path and not pushed it yet.
 * The second engine's pull must not take its own note for the renamed one:
 * the renamed document lands at the path, and the local note is kept whole as
 * a logged conflict copy. Fault: the second engine crashes after the pull,
 * before it pushes the copy, so the copy is found by the start-up scan.
 */
export async function remoteRenameOntoUnsyncedFile(endpoints: SimEndpoints): Promise<RenameOntoUnsyncedFileResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2 });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };

  log(await first.edit("notes/a.md", encoder.encode("b line\n")));
  log(first.startPush());
  await drain(first.index);
  log(second.startPull());
  await drain(second.index);

  log(await second.edit("notes/c.md", encoder.encode("my own new note\n")));
  log(await first.move("notes/a.md", "notes/c.md"));
  log(await first.edit("notes/c.md", encoder.encode("b line\nappended remotely\n")));
  log(first.startPush());
  await drain(first.index);

  log(second.startPull());
  await drain(second.index);
  log(second.crash());
  log(second.startPush());
  await drain(second.index);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = await Promise.all([first, second].map(async (engine) => (await engine.conflicts()).map(({ reason, path, copyPath }) => ({ reason, path, copyPath }))));
  return { ...result, vaults, conflicts };
}

export interface StructuralOperationsResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** Each engine's conflict log: reason, path and copy path of every entry. */
  conflicts: { reason: string; path: string; copyPath: string | null }[][];
  /** Phases whose refused commit the second engine merged and committed again, by name. */
  refused: string[];
  /** The server's live documents after the run: path to document label. */
  documents: Map<string, string>;
  /** Document labels by path before the structural changes, for the identity checks. */
  before: Map<string, string>;
  /** Content transfers during the folder rename: blob uploads by the renaming engine, downloads by the other. */
  folderRenameTransfers: { uploads: number; downloads: number };
  /** The server's live paths while the second engine's merge hook still held the document of phase 11. */
  heldPhaseFiles: string[];
}

/**
 * Structural operations across two real engines (#19, SPEC.md §6.3), each
 * phase raced as in enginesEditConcurrently: the second engine's push gets as
 * far as its CommitRevision, the first engine's push commits, and only then
 * does the second engine's commit reach the server. Faults: the second engine
 * crashes after one refused commit, before it pushes again, and a merged
 * commit's response is lost once.
 *
 * 1. Rename on one engine, edit on the other: the document has the new name
 *    and the edit.
 * 2. Delete on one engine, edit on the other: the edit wins.
 * 3. Edit on one engine, delete on the other: the edit wins.
 * 4. Both create a file at the same path: both kept, one as a conflict copy.
 * 5. A folder of many files renamed: synced as renames, with no content
 *    uploaded or downloaded.
 * 6. A folder renamed while the other engine edits a file in it: the edit
 *    lands in the renamed folder.
 * 7. A rename chain across engines (A to B on one, then B to C on the other).
 * 8. A rename chain on one engine (b to c, then a to b) while the other edits
 *    both documents: each keeps its identity and its edit.
 * 9. A file on one engine at the path where the other created a folder of
 *    notes (the server refuses file/folder collisions, #134): the notes move
 *    into a conflict-named folder.
 * 10. The reverse: the file gets the conflict name.
 * 11. While the second engine's merge hook holds a document whose remote
 *     rename targets a path an untracked file holds, its user renames that
 *     file away: the file is pushed under its new name right away (review of
 *     #196), and the held document lands once the hook merges it.
 */
export async function structuralOperations(endpoints: SimEndpoints): Promise<StructuralOperationsResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2 });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };
  const deliverUntil = async (engine: number, method: string) => {
    for (let delivery = 0; run.context.network.pendingRequest(engine) !== method; delivery++) {
      if (delivery > 800) throw new Error(`e${String(engine)} never sent ${method}`);
      await run.step({ kind: "deliver-request", client: engine });
      await run.step({ kind: "deliver-response", client: engine });
    }
  };
  const sync = async () => {
    log(first.startPush());
    await drain(first.index);
    log(second.startPull());
    await drain(second.index);
  };
  const refused: string[] = [];
  /** As enginesEditConcurrently's race: the second engine's commit reaches the server after the first engine's. */
  const race = async (phase: string, fault?: () => Promise<void>) => {
    log(`phase: ${phase}`);
    log(second.startPush());
    await deliverUntil(second.index, "CommitRevision");
    log(first.startPush());
    await drain(first.index);
    const traceAt = run.trace.length;
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "deliver-response", client: second.index });
    if (run.trace.slice(traceAt).some((line) => / -> (FailedPrecondition|AlreadyExists)/.test(line))) refused.push(phase);
    if (fault !== undefined) await fault();
    await drain(second.index);
    log(second.startPush());
    await drain(second.index);
    log(first.startPull());
    await drain(first.index);
  };
  const crashAfterRefusal = async () => {
    log(second.crash());
    log(second.startPush());
  };
  const loseMergedCommitResponse = async () => {
    await deliverUntil(second.index, "CommitRevision");
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "drop-response", pick: 0 });
  };

  // Setup: every document both engines start from, synced.
  const files = Array.from({ length: 12 }, (_, index) => `projects/file ${String(index)}.md`);
  const synced: [string, string][] = [
    ["notes/rename-me.md", textLines("one", "two", "three")],
    ["notes/delete-me.md", textLines("kept by the edit")],
    ["notes/edit-me.md", textLines("kept by the edit too")],
    ...files.map((path) => [path, textLines(path)] as [string, string]),
    ["shared/inside.md", textLines("one", "two")],
    ["chain/A.md", textLines("chained")],
    ["rotate/a.md", textLines("note x")],
    ["rotate/b.md", textLines("note y")],
    ["held/d.md", textLines("held", "note")],
  ];
  for (const [path, content] of synced) log(await first.edit(path, encoder.encode(content)));
  await sync();
  const before = await liveDocuments(run);

  // 1. Rename vs edit.
  log(await first.move("notes/rename-me.md", "notes/renamed.md"));
  log(await second.edit("notes/rename-me.md", encoder.encode(textLines("one", "two (edited)", "three"))));
  await race("rename vs edit", loseMergedCommitResponse);

  // 2. Delete vs edit.
  log(await first.remove("notes/delete-me.md"));
  log(await second.edit("notes/delete-me.md", encoder.encode(textLines("kept by the edit", "edited"))));
  await race("delete vs edit", crashAfterRefusal);

  // 3. Edit vs delete.
  log(await first.edit("notes/edit-me.md", encoder.encode(textLines("kept by the edit too", "edited"))));
  log(await second.remove("notes/edit-me.md"));
  await race("edit vs delete");

  // 4. Creates at one path.
  log(await first.edit("inbox/same.md", encoder.encode(textLines("created by the first engine"))));
  log(await second.edit("inbox/same.md", encoder.encode(textLines("created by the second engine"))));
  await race("creates at one path", crashAfterRefusal);

  // 5. A folder rename, nothing else.
  log("phase: folder rename");
  const folderAt = run.trace.length;
  log(await first.moveFolder("projects", "archive"));
  await sync();
  const folderTrace = run.trace.slice(folderAt);
  const count = (engine: number, methods: string) => folderTrace.filter((line) => new RegExp(`c${String(engine)} (${methods})\\(?.* -> `).test(line)).length;
  const folderRenameTransfers = { uploads: count(first.index, "BeginBlob|PutBlobChunk|CommitBlob"), downloads: count(second.index, "DownloadBlob|GetRevision") };

  // 6. A folder rename while the other engine edits a file in it.
  log(await first.moveFolder("shared", "moved"));
  log(await second.edit("shared/inside.md", encoder.encode(textLines("one", "two (edited)"))));
  await race("folder rename vs edit");

  // 7. A rename chain across engines.
  log("phase: rename chain across engines");
  log(await first.move("chain/A.md", "chain/B.md"));
  await sync();
  log(await second.move("chain/B.md", "chain/C.md"));
  log(second.startPush());
  await drain(second.index);
  log(first.startPull());
  await drain(first.index);

  // 8. A rename chain on one engine, while the other edits both documents.
  log(await first.move("rotate/b.md", "rotate/c.md"));
  log(await first.move("rotate/a.md", "rotate/b.md"));
  log(await second.edit("rotate/a.md", encoder.encode(textLines("note x", "edited"))));
  log(await second.edit("rotate/b.md", encoder.encode(textLines("note y", "edited"))));
  await race("rename chain on one engine");

  // 9. A file on one engine where the other created a folder of notes (#134).
  log(await first.edit("topics", encoder.encode(textLines("a file named like the folder"))));
  log(await second.edit("topics/x.md", encoder.encode(textLines("x"))));
  log(await second.edit("topics/y.md", encoder.encode(textLines("y"))));
  await race("file where the other created a folder");

  // 10. A folder of notes on one engine where the other created a file.
  log(await first.edit("ideas/a.md", encoder.encode(textLines("a"))));
  log(await second.edit("ideas", encoder.encode(textLines("a file named like the folder"))));
  await race("folder where the other created a file");

  // 11. An untracked file renamed off a path the merge path holds.
  log("phase: untracked file renamed off a held path");
  log(await first.move("held/d.md", "held/p.md"));
  log(first.startPush());
  await drain(first.index);
  log(await second.edit("held/d.md", encoder.encode(textLines("held", "note (edited)"))));
  log(await second.edit("held/p.md", encoder.encode(textLines("untracked"))));
  second.merge = () => Promise.resolve({ status: "deferred" });
  log(second.startPush());
  await drain(second.index);
  log(await second.move("held/p.md", "held/z.md"));
  log(second.startPush());
  await drain(second.index);
  const heldPhaseFiles = await liveFiles(run);
  second.merge = undefined;
  log(second.startPush());
  await drain(second.index);
  log(first.startPull());
  await drain(first.index);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = await Promise.all([first, second].map(async (engine) => (await engine.conflicts()).map(({ reason, path, copyPath }) => ({ reason, path, copyPath }))));
  return { ...result, vaults, conflicts, refused, documents: await liveDocuments(run), before, folderRenameTransfers, heldPhaseFiles };
}

/** The server's live paths, sorted. */
async function liveFiles(run: SimRun): Promise<string[]> {
  return [...(await liveDocuments(run)).keys()].sort();
}

/** The server's live documents, read without faults from the change feed: path to document label. */
async function liveDocuments(run: SimRun): Promise<Map<string, string>> {
  const heads = new Map<string, { path: string; deleted: boolean }>();
  let since = 0n;
  for (;;) {
    const response = await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: since, pageSize: 1000 });
    for (const revision of response.revisions) {
      heads.set(revision.documentId, { path: decoder.decode(revision.path), deleted: revision.deleted });
      since = revision.seq;
    }
    if (!response.hasMore) break;
  }
  const documents = new Map<string, string>();
  for (const [documentId, head] of heads) if (!head.deleted) documents.set(head.path, run.context.ids.label(documentId));
  return documents;
}

export interface UnmaterializableResult extends RunResult {
  /** What the Windows engine reported as unmaterializable after it first pulled: server path to reason. */
  reportedAfterCreate: Map<string, string>;
  /** The Windows engine's vault then: its paths. */
  windowsFilesAfterCreate: string[];
  /** What it reported once a synced note had been renamed to a name Windows cannot hold, and its vault then. */
  reportedAfterRename: Map<string, string>;
  windowsFilesAfterRename: Map<string, string>;
  /** CommitRevision paths the Windows engine sent while its documents could not be materialized. */
  windowsCommitsWhileTracked: string[];
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents before the illegal names and after the run: path to document label. */
  before: Map<string, string>;
  documents: Map<string, string>;
}

/** Over MAX_PATH (259 UTF-16 code units) with every name under 255. */
const overlongPath = `${"long".repeat(50)}/${"b".repeat(56)}.md`;

/**
 * Platform path rules (#20, SPEC.md §8) between a POSIX engine and a Windows
 * engine (an engine and in-memory vault under Windows rules, which are also
 * case-insensitive). The POSIX engine creates notes Windows cannot hold (a
 * reserved device name, a colon, a trailing dot, a path over MAX_PATH) and
 * renames two synced notes to names with a `?` and a `*`, one of which the
 * Windows engine's user has edited and not pushed. The Windows engine must
 * track each of them as unmaterializable, write none of them, keep the edited
 * note's file where it was with the edit, remove the unchanged one (its
 * content is on the server), and commit nothing for any of them: never a
 * rename or a delete on the server, and not the edit while the note cannot be
 * written. Faults: it crashes after its
 * first pull and pushes after the restart (a full scan). Once the POSIX engine
 * renames them all to legal names, every one materializes on Windows, the
 * edit is merged and committed, and both vaults end identical.
 */
export async function unmaterializableOnWindows(endpoints: SimEndpoints): Promise<UnmaterializableResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "windows"] });
  const [posix, windows] = run.observers;
  if (posix === undefined || windows === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };
  const push = async (engine: typeof posix) => {
    log(engine.startPush());
    await drain(engine.index);
  };
  const pull = async (engine: typeof posix) => {
    log(engine.startPull());
    await drain(engine.index);
  };
  // The network labels an engine's calls by its index, as `c<index>`.
  const windowsCommits = () => [
    ...new Set(run.trace.filter((line) => line.includes(` c${String(windows.index)} CommitRevision(`)).map((line) => /CommitRevision\(\S+ \S+ base=\S+ "([^"]*)"/.exec(line)?.[1] ?? line)),
  ];

  log(await posix.edit("ok.md", encoder.encode(textLines("fine"))));
  log(await posix.edit("plan.md", encoder.encode(textLines("one", "two"))));
  await push(posix);
  await pull(windows);
  const before = await liveDocuments(run);

  const illegal: [string, string][] = [
    ["CON.md", "console.md"],
    ["notes/a:b.md", "notes/a-b.md"],
    ["trailing.", "trailing.txt"],
    [overlongPath, "short.md"],
  ];
  for (const [index, [path]] of illegal.entries()) log(await posix.edit(path, encoder.encode(textLines(`illegal ${String(index)}`))));
  await push(posix);
  await pull(windows);
  const reportedAfterCreate = await windows.unmaterializable();
  const windowsFilesAfterCreate = await windows.list();
  log(windows.crash());
  await push(windows);

  // Two synced notes renamed to names Windows cannot hold: one the Windows
  // user has edited and not pushed yet, one unchanged there.
  log(await windows.edit("plan.md", encoder.encode(textLines("one", "two (edited on windows)"))));
  log(await posix.move("plan.md", "plan?.md"));
  log(await posix.move("ok.md", "ok*.md"));
  await push(posix);
  await pull(windows);
  await push(windows);
  const reportedAfterRename = await windows.unmaterializable();
  const windowsFilesAfterRename = new Map<string, string>();
  for (const path of await windows.list()) windowsFilesAfterRename.set(path, decoder.decode((await windows.read(path)) ?? new Uint8Array()));
  const windowsCommitsWhileTracked = windowsCommits();

  // Every one renamed to a legal name: each materializes on Windows.
  for (const [from, to] of [...illegal, ["plan?.md", "plan 2.md"] as [string, string], ["ok*.md", "ok 2.md"] as [string, string]]) log(await posix.move(from, to));
  await push(posix);
  await push(windows);
  await pull(posix);

  const result = await run.finish();
  const vaults = await Promise.all(
    [posix, windows].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return {
    ...result,
    reportedAfterCreate,
    windowsFilesAfterCreate,
    reportedAfterRename,
    windowsFilesAfterRename,
    windowsCommitsWhileTracked,
    vaults,
    before,
    documents: await liveDocuments(run),
  };
}
