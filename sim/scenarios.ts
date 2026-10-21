// Scripted scenarios: hand-written interleavings that random schedules hit
// only rarely, driven step by step against the real server.

import { Code, ConnectError } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind } from "../plugin/src/gen/vaultsync/v1/types_pb";
import { serverHeads } from "./engine-observer";
import { settle } from "./network";
import { seededCommitRetryBackoff, SimRun, type RunResult, type SimEndpoints } from "./runner";

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
  /**
   * Crashes the second engine once its merge is on disk, before it uploads the result: at the
   * upload's first call, the look-up of whether the server holds the blob (a 1-byte DownloadBlob
   * at the blob's end; a download asks for length 0). The conflict copy's content is the second
   * engine's own edit, which its refused push already uploaded, so no BeginBlob follows (#439).
   */
  const crashBeforeUpload = async () => {
    for (let delivery = 0; !/^DownloadBlob\(\S+ @\d+ length=1\)$/.test(run.context.network.pendingDescription(second.index) ?? ""); delivery++) {
      if (delivery > 400) throw new Error(`e${String(second.index)} never looked its upload up`);
      await run.step({ kind: "deliver-request", client: second.index });
      await run.step({ kind: "deliver-response", client: second.index });
    }
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

export interface SaveBeforeEngineWriteResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** Whether every armed save landed (inside the engine's apply, as intended). */
  savesLanded: boolean;
}

/**
 * A local save that lands after the engine checked the disk against its base
 * and before its write or delete reaches the vault (#163, SPEC.md §8), as
 * Obsidian's autosave can. Two engines over the real server; the second
 * one's user saves at that moment:
 *
 * 1. Before the write of the first engine's edit of the note: both edits must
 *    be merged, never the remote one written over the save.
 * 2. Before the delete of a note the first engine deleted: the edit wins over
 *    the delete.
 * 3. Before the write of a merge result (the second engine already had an
 *    unpushed edit, merged with the first engine's): the newer save must be
 *    merged too.
 * 4. Before the second engine, which follows Windows' path rules, removes the
 *    unchanged file of a note the first engine renamed to a name Windows
 *    cannot hold (releasing it, SPEC.md §8): the file must stay as a local
 *    edit, merged once a later rename gives the note a legal name.
 */
export async function saveBeforeEngineWrite(endpoints: SimEndpoints): Promise<SaveBeforeEngineWriteResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "windows"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };
  const lines = (...values: string[]) => encoder.encode(values.map((value) => `${value}\n`).join(""));
  let savesLanded = true;
  const pull = async () => {
    log(second.startPull());
    await drain(second.index);
    if (second.savePending) savesLanded = false;
  };

  // 1. A remote edit.
  log(await first.edit("notes/edit.md", lines("one", "two", "three")));
  // 2. A remote delete.
  log(await first.edit("notes/gone.md", lines("keep", "me")));
  // 3. A merge result.
  log(await first.edit("notes/merge.md", lines("alpha", "beta", "gamma", "delta")));
  // 4. A release of an unmaterializable note's file.
  log(await first.edit("notes/release.md", lines("left", "as", "synced")));
  log(first.startPush());
  await drain(first.index);
  log(second.startPull());
  await drain(second.index);

  log(await first.edit("notes/edit.md", lines("ONE", "two", "three")));
  log(await first.remove("notes/gone.md"));
  log(await first.edit("notes/merge.md", lines("ALPHA", "beta", "gamma", "delta")));
  log(await first.move("notes/release.md", "notes/release?.md"));
  log(first.startPush());
  await drain(first.index);

  log(await second.edit("notes/merge.md", lines("alpha", "beta", "GAMMA", "delta")));
  log(second.saveBeforeNextEngineChange("notes/edit.md", lines("one", "two", "THREE")));
  log(second.saveBeforeNextEngineChange("notes/gone.md", lines("keep", "me", "edited")));
  log(second.saveBeforeNextEngineChange("notes/merge.md", lines("alpha", "beta", "GAMMA", "DELTA")));
  log(second.saveBeforeNextEngineChange("notes/release.md", lines("left", "as", "synced", "then", "saved")));
  await pull();
  log(second.startPush());
  await drain(second.index);
  log(first.startPull());
  await drain(first.index);

  // The note gets a legal name again, and the second engine merges the kept save into it.
  log(await first.move("notes/release?.md", "notes/released.md"));
  log(first.startPush());
  await drain(first.index);
  await pull();
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
  return { ...result, vaults, savesLanded };
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

export interface FreedPathResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents before the renames and after the run: path to document label. */
  before: Map<string, string>;
  documents: Map<string, string>;
}

/**
 * A path freed by an unmaterializable rename is reused (review of #217,
 * SPEC.md §8). The POSIX engine renames three notes the Windows engine has
 * synced, unchanged, to names Windows cannot hold, so the Windows engine
 * removes their files. Then the POSIX engine creates a different note at one
 * freed path and an empty note, of the same content as the empty original,
 * at another, while the Windows user creates a new note at the third and the
 * Windows engine crashes. Once the POSIX engine renames the originals to
 * legal names, every one of the six notes must be live on the server, with
 * its own content, and in both vaults: none merged into another, deleted,
 * or left unpushed.
 */
export async function freedPathReused(endpoints: SimEndpoints): Promise<FreedPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 2, platforms: ["posix", "windows"] });
  const [posix, windows] = run.observers;
  if (posix === undefined || windows === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof posix) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof posix) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };
  const moveAll = async (moves: [string, string][]) => {
    for (const [from, to] of moves) log(await posix.move(from, to));
    await push(posix);
  };

  log(await posix.edit("plan.md", encoder.encode(textLines("one", "two"))));
  log(await posix.edit("empty.md", new Uint8Array()));
  log(await posix.edit("draft.md", encoder.encode(textLines("draft"))));
  await push(posix);
  await pull(windows);
  const before = await liveDocuments(run);

  await moveAll([
    ["plan.md", "plan?.md"],
    ["empty.md", "empty?.md"],
    ["draft.md", "draft?.md"],
  ]);
  await pull(windows);

  // Another note at one freed path, an empty one at another, and a new local note at the third.
  log(await posix.edit("plan.md", encoder.encode(textLines("another note"))));
  log(await posix.edit("empty.md", new Uint8Array()));
  await push(posix);
  log(await windows.edit("draft.md", encoder.encode(textLines("brand new"))));
  await pull(windows);
  log(windows.crash());
  await push(windows);
  await pull(windows);

  await moveAll([
    ["plan?.md", "plan 2.md"],
    ["empty?.md", "empty 2.md"],
    ["draft?.md", "draft 2.md"],
  ]);
  await pull(windows);
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
  return { ...result, vaults, before, documents: await liveDocuments(run) };
}

export interface ConfigSyncResult extends RunResult {
  /** The server's live paths after the first engine pushed its config folder. */
  liveAfterPush: string[];
  /** The second engine's config folder while its config sync was off, and after it was turned on. */
  configWhileOff: string[];
  configAfterOn: string[];
  /** CommitRevision calls of the first engine that the server applied after its layout change, through turning config sync off. */
  commitsWhileOff: number;
  /** The server's live paths at the end. */
  liveAtEnd: string[];
}

const allConfigCategories = { themes: true, snippets: true, hotkeys: true, appSettings: true, pluginList: true, corePluginSettings: true, plugins: true };

/**
 * Config folder sync between two real engines (#28, SPEC.md §8). The first
 * syncs its config folder with every category; the second has config sync
 * off, as every device starts.
 *
 * 1. The first pushes its config folder and a note. Only the selected config
 *    files reach the server: never workspace*.json, graph.json, sync.json or
 *    vault-sync's own folder.
 * 2. The second pulls, losing one response on the way: it gets the note and
 *    writes nothing into its config folder.
 * 3. The first changes its layout (as a pane switch does) and pushes: nothing
 *    is committed. It turns config sync off, edits and deletes synced config
 *    files, and pushes again: still nothing, so the server keeps them.
 * 4. The second turns config sync on: what arrived while it was off is
 *    applied, after a crash interrupts its first push.
 */
export async function configFolderSync(endpoints: SimEndpoints): Promise<ConfigSyncResult> {
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
  const commits = (from: number) => run.trace.slice(from).filter((line) => line.includes(`c${String(first.index)} CommitRevision(`) && line.includes("-> ok")).length;

  log(await first.setConfigSync({ enabled: true, categories: allConfigCategories }));
  log(await second.setConfigSync({ enabled: false, categories: allConfigCategories }));
  const config: [string, string][] = [
    ["hotkeys.json", '{"editor:toggle-bold":[]}'],
    ["community-plugins.json", '["dataview"]'],
    ["plugins/dataview/main.js", "module.exports = {};\n"],
    ["snippets/wide.css", ".wide {}\n"],
    ["workspace.json", '{"active":"a"}'],
    ["workspace-mobile.json", '{"active":"a"}'],
    ["graph.json", '{"scale":1}'],
    ["plugins/vault-sync/data.json", '{"refreshToken":"secret"}'],
    ["app.json", '{"vimMode":true}'],
    ["daily-notes.json", '{"folder":"Daily"}'],
    ["sync.json", "{}"],
  ];
  for (const [relative, content] of config) log(await first.editConfig(relative, encoder.encode(content)));
  log(await first.edit("note.md", encoder.encode("a note\n")));
  log(first.startPush());
  await drain(first.index);
  const liveAfterPush = await liveFiles(run);

  log(second.startPull());
  await run.step({ kind: "deliver-request", client: second.index });
  await run.step({ kind: "drop-response", pick: 0 });
  await drain(second.index);
  log(second.startPush());
  await drain(second.index);
  const configWhileOff = await second.configFiles();

  const beforeLayout = run.trace.length;
  log(await first.editConfig("workspace.json", encoder.encode('{"active":"b"}')));
  log(await first.editConfig("graph.json", encoder.encode('{"scale":2}')));
  log(first.startPush());
  await drain(first.index);
  log(await first.setConfigSync({ enabled: false, categories: allConfigCategories }));
  log(await first.editConfig("hotkeys.json", encoder.encode('{"edited":"while off"}')));
  log(await first.removeConfig("snippets/wide.css"));
  log(first.startPush());
  await drain(first.index);
  const commitsWhileOff = commits(beforeLayout);

  log(await second.setConfigSync({ enabled: true, categories: allConfigCategories }));
  log(second.startPush());
  await run.step({ kind: "deliver-request", client: second.index });
  await run.step({ kind: "deliver-response", client: second.index });
  log(second.crash());
  log(second.startPush());
  await drain(second.index);
  const configAfterOn = await second.configFiles();

  const result = await run.finish();
  return { ...result, liveAfterPush, configWhileOff, configAfterOn, commitsWhileOff, liveAtEnd: await liveFiles(run) };
}

export interface ConfigConflictCopyResult extends RunResult {
  /** The server's live paths at the end. */
  live: string[];
  /** Each engine's config folder at the end. */
  configs: string[][];
}

/**
 * Config conflict copies stay on the device (#365, SPEC.md §8). Both engines
 * sync their config folders with every category and write the same snippet
 * and plugin data file. The first pushes; the second's push keeps its own
 * versions as conflict copies inside snippets/ and plugins/dataview/, which
 * are synced folders. The copies are never committed, so the first engine
 * never receives them.
 */
export async function configConflictCopies(endpoints: SimEndpoints): Promise<ConfigConflictCopyResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drain = async (engine: number) => {
    await settle();
    await run.drain(engine);
  };

  for (const engine of [first, second]) log(await engine.setConfigSync({ enabled: true, categories: allConfigCategories }));
  for (const [engine, name] of [[first, "first"], [second, "second"]] as const) {
    log(await engine.editConfig("snippets/wide.css", encoder.encode(`.${name} {}\n`)));
    log(await engine.editConfig("plugins/dataview/data.json", encoder.encode(`{"by":"${name}"}`)));
  }
  log(first.startPush());
  await drain(first.index);
  log(second.startPush());
  await drain(second.index);
  log(second.startPush());
  await drain(second.index);
  log(first.startPull());
  await drain(first.index);

  const result = await run.finish();
  return { ...result, live: await liveFiles(run), configs: [await first.configFiles(), await second.configFiles()] };
}

export interface PurgedMergeBaseResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** Each engine's conflict log: reason, path and copy path of every entry. */
  conflicts: { reason: string; path: string; copyPath: string | null }[][];
  /** Labels of the revisions retention purged. */
  purged: string[];
  /** Label of the second engine's merge base. */
  base: string;
}

/**
 * A merge base that retention purged (review of #219, SPEC.md §8, §11). Both
 * engines sync a note; the second edits it and does not push, while the
 * first edits it too and pushes. Then both revisions age past the retention
 * policy, and the server's own purge removes the older one: the second
 * engine's merge base. Another note is written after the purge. The second
 * engine's pull must not stall on the missing base: it keeps the first
 * engine's version in place and its own as a logged conflict copy, applies
 * the later note, and both engines converge with nothing lost.
 */
export async function purgedMergeBase(endpoints: SimEndpoints): Promise<PurgedMergeBaseResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  const note = "notes/plan.md";
  log(await first.edit(note, encoder.encode(textLines("one", "two", "three"))));
  await push(first);
  await pull(second);

  log(await second.edit(note, encoder.encode(textLines("one", "two (second engine, offline)", "three"))));
  log(await first.edit(note, encoder.encode(textLines("one (first engine)", "two", "three"))));
  await push(first);

  const revisions = (await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: 0n })).revisions;
  const [base, head] = revisions;
  if (base === undefined || head === undefined || base.documentId !== head.documentId) throw new Error("expected the note's two revisions");
  const purged = (await run.purge([base.id, head.id])).map((id) => run.context.ids.label(id));

  log(await first.edit("notes/later.md", encoder.encode(textLines("written after the purge"))));
  await push(first);
  await pull(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = await Promise.all([first, second].map(async (engine) => (await engine.conflicts()).map(({ reason, path, copyPath }) => ({ reason, path, copyPath }))));
  return { ...result, vaults, conflicts, purged, base: run.context.ids.label(base.id) };
}

/**
 * A merge base that retention purged while its engine was offline (#229,
 * SPEC.md §8, §11). Both engines sync a note. The second engine loses the
 * network, its user edits the note and it starts a push, which waits on the
 * network with the soon-purged base. The first engine edits the note too and
 * pushes, then both revisions age past the retention policy and the purge
 * removes the second engine's base. On reconnect the push goes on: it pulls
 * first, finds the head moved and no base to merge against (GetRevision is
 * NOT_FOUND), and the edit must survive as a `base-purged` conflict copy
 * while the first engine's version stays in place.
 */
export async function purgedMergeBaseWhileOffline(endpoints: SimEndpoints): Promise<PurgedMergeBaseResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  const note = "notes/plan.md";
  log(await first.edit(note, encoder.encode(textLines("one", "two", "three"))));
  await push(first);
  await pull(second);

  log(run.context.network.partition(second.index, 1_000_000));
  log(await second.edit(note, encoder.encode(textLines("one", "two (second engine, offline)", "three"))));
  log(second.startPush());
  await settle();
  log(await first.edit(note, encoder.encode(textLines("one (first engine)", "two", "three"))));
  await push(first);

  const revisions = (await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: 0n })).revisions;
  const [base, head] = revisions;
  if (base === undefined || head === undefined || base.documentId !== head.documentId) throw new Error("expected the note's two revisions");
  const purged = (await run.purge([base.id, head.id])).map((id) => run.context.ids.label(id));

  // Reconnect: the push started offline goes on, with the purged base.
  run.context.network.heal();
  log("second engine back online");
  await run.drain(second.index);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = await Promise.all([first, second].map(async (engine) => (await engine.conflicts()).map(({ reason, path, copyPath }) => ({ reason, path, copyPath }))));
  return { ...result, vaults, conflicts, purged, base: run.context.ids.label(base.id) };
}

export interface HeldPathResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents after the first sync and after the run: path to document label. */
  before: Map<string, string>;
  documents: Map<string, string>;
  /** Labels of the documents that got a tombstone during the run, sorted. */
  tombstoned: string[];
}

/**
 * A pull brings a new document to a path the journal still has for a known
 * document (#264). The second engine's user edits a synced note and creates
 * a folder at the path the first engine then renames the note to, so the
 * second engine's merge of the rename is deferred. The first engine then
 * creates another note, with the edit's content, at the note's old path.
 * The second engine's pull must not take the edited file for the new note:
 * once the user removes the folder, the note moves with its edit, the new
 * note is written at the old path, and neither is ever tombstoned.
 */
export async function newDocumentAtHeldPath(endpoints: SimEndpoints): Promise<HeldPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("d.md", encoder.encode("base\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.edit("d.md", encoder.encode("same\n")));
  log(await second.edit("moved.md/x.md", encoder.encode("in the way\n")));
  log(await first.move("d.md", "moved.md"));
  await push(first);
  log(await first.edit("d.md", encoder.encode("same\n")));
  await push(first);

  await pull(second);
  log(await second.remove("moved.md/x.md"));
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run) };
}

/** Labels of the documents with a tombstone anywhere in the vault's change feed, sorted. */
async function tombstonedDocuments(run: SimRun): Promise<string[]> {
  const tombstoned = new Set<string>();
  let since = 0n;
  for (;;) {
    const response = await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: since, pageSize: 1000 });
    for (const revision of response.revisions) {
      if (revision.deleted) tombstoned.add(run.context.ids.label(revision.documentId));
      since = revision.seq;
    }
    if (!response.hasMore) break;
  }
  return [...tombstoned].sort();
}

export interface KnownHeldPathResult extends HeldPathResult {
  /** The second engine's conflict log after the run. */
  conflicts: { reason: string; path: string; copyPath: string | null; document: string }[];
}

/**
 * A pull brings a known document's own revision to a path a pending rename
 * of another document holds, with that document's content (#267). The second
 * engine renames note `a` away to `z.md` and pushes, then renames note `b` to
 * `a.md`, but that commit is lost before the server sees it and the app is
 * killed before it retries, so it stays
 * pending. Its user deletes `z.md`, while the first engine moves `a` back to
 * `a.md` with `b`'s content. The second engine's pull must not take `b`'s
 * file for `a`: `b` moves on to a `path-taken` conflict copy under its own
 * id, `a` comes back at `a.md` (its remote edit wins over the local delete),
 * and neither is ever tombstoned.
 *
 * In the `renamed-away-unpushed` variant the second engine pushes neither
 * rename, so its journal still has `a` at `a.md` when the first engine's
 * edit of `a` there (with `b`'s content) arrives; the outcome must be the same.
 *
 * In the `swapped-unpushed` variant (review of #278) the second engine's user
 * only swaps the names, keeping `z.md`, and pushes neither rename, while the
 * first engine edits `a` at `a.md`. A local rename wins over a remote edit
 * (SPEC.md §7): `a` must end at `z.md` with the edit, `b` must keep `a.md`,
 * and no conflict may be logged.
 */
export async function knownDocumentAtHeldPath(endpoints: SimEndpoints, variant: "renamed-away-pushed" | "renamed-away-unpushed" | "swapped-unpushed"): Promise<KnownHeldPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("a.md", encoder.encode("a\n")));
  log(await first.edit("b.md", encoder.encode("b\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("a.md", "z.md"));
  if (variant === "renamed-away-pushed") {
    await push(second);
    await pull(first);

    // The rename's commit request is lost before the server sees it, and the
    // app is killed before it retries, so the commit stays pending.
    log(await second.move("b.md", "a.md"));
    log(second.startPush());
    await settle();
    for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
      if (delivery > 100) throw new Error("the second engine never sent CommitRevision");
      await run.step({ kind: "deliver-request", client: second.index });
      await run.step({ kind: "deliver-response", client: second.index });
    }
    log(second.crash());
    await run.step({ kind: "drop-request", pick: 0 });
    await run.drain(second.index);

    log(await second.remove("z.md"));
    log(await first.move("z.md", "a.md"));
  } else {
    log(await second.move("b.md", "a.md"));
    if (variant === "renamed-away-unpushed") log(await second.remove("z.md"));
  }
  log(await first.edit("a.md", encoder.encode(variant === "swapped-unpushed" ? "a remote\n" : "b\n")));
  await push(first);

  await pull(second);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await second.conflicts()).map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts };
}

export interface LostRenameResult extends KnownHeldPathResult {
  /** The edited note's content, as the first engine's user wrote it. */
  edited: string;
}

/**
 * A rename lost to a crash, against a concurrent edit (#280, #167 item 2).
 * Both engines sync `note.md`. The second engine's user renames it to
 * `moved.md`, and the app is killed before the engine records the rename, so
 * its next push (a full scan) sees a missing file and a new one: a delete of
 * the note plus a new document at `moved.md`. Meanwhile the first engine's
 * user edits the note and pushes, before (`editor-first`) or after
 * (`renamer-first`) that delete reaches the server. The edit must never be
 * lost to the delete (SPEC.md §2 principle 1, §7: an edit wins over a
 * concurrent delete): the note stays live at `note.md` with the edit in both
 * vaults, and `moved.md` holds the renamed content.
 *
 * With `deleted-note-path`, both engines also sync a second note at
 * `moved.md`, and the second engine's user deletes that file just before the
 * rename, so the crash loses the delete too. The restarted engine's full scan
 * then sees `moved.md` changed, and takes the renamed content for an edit of
 * the deleted note (#254 after a crash): the lost rename lands on the deleted
 * note's id, and the renamed-away note gets the delete. The first engine's
 * edit of the renamed-away note must survive that delete just the same.
 */
export async function renameLostToCrash(endpoints: SimEndpoints, order: "editor-first" | "renamer-first", variant: "free-path" | "deleted-note-path" = "free-path"): Promise<LostRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  const edited = "one\ntwo (edited)\n";
  log(await first.edit("note.md", encoder.encode("one\ntwo\n")));
  if (variant === "deleted-note-path") log(await first.edit("moved.md", encoder.encode("other\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  if (variant === "deleted-note-path") log(await second.remove("moved.md"));
  log(await second.move("note.md", "moved.md"));
  log(second.crash());
  log(await first.edit("note.md", encoder.encode(edited)));
  if (order === "editor-first") {
    await push(first);
    await push(second);
  } else {
    await push(second);
    await push(first);
  }
  await push(second);
  await pull(first);
  await push(first);
  await pull(second);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, edited };
}

/** The ways #254's user vacates a synced path and puts another file there before the next push. */
export type VacatedPathVariant = "deleted-then-created" | "deleted-then-renamed-onto" | "deleted-then-case-variant-renamed-onto" | "case-variant-swap" | "renamed-away-while-created" | "remote-created-at-vacated-path";

export interface VacatedPathResult extends HeldPathResult {
  /** The second engine's conflict log after the run. */
  conflicts: { reason: string; path: string; copyPath: string | null; document: string }[];
}

/**
 * A new file at a path the user just vacated (#254). Both engines sync
 * notes, and before the second engine pushes, its user vacates a synced path
 * and puts another file there. The push must keep the user's intent: the
 * old document is deleted or renamed under its own id, and the file now at
 * the path is a new document, or the other document renamed under its own
 * id. It is never committed as the old document's edit.
 *
 * - `deleted-then-created` (POSIX): the user deletes `h.md` and creates a new
 *   `h.md`.
 * - `deleted-then-renamed-onto` (POSIX): the user deletes `h.md` and renames
 *   `d.md` onto it.
 * - `deleted-then-case-variant-renamed-onto` (Windows, seed 24): the user
 *   deletes `A.md` and renames `NOTES` to `a.md`.
 * - `case-variant-swap` (macOS, #254's review of #278): the user renames
 *   `a.md` to `z.md`, then `b.md` to `A.md`.
 * - `renamed-away-while-created` (macOS, seed 22): the user creates
 *   `STRASSE.md` and, while its create is being committed, renames it to
 *   `b.md` and creates `straße.md`, which has the same path key.
 * - `remote-created-at-vacated-path` (POSIX, #303): nothing is synced. The
 *   user creates `e.md`, renames it to `notes/f.md`, creates `x.md` and
 *   renames it to `e.md`. Before the second engine pushes, the first engine
 *   creates `e.md` and pushes. The remote document must never be taken for
 *   the user's rename.
 */
export async function fileAtVacatedPath(endpoints: SimEndpoints, variant: VacatedPathVariant): Promise<VacatedPathResult> {
  const platform = variant === "deleted-then-case-variant-renamed-onto" ? "windows" : variant === "case-variant-swap" || variant === "renamed-away-while-created" ? "macos" : "posix";
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  const synced: Record<VacatedPathVariant, [string, string][]> = {
    "deleted-then-created": [["h.md", "h\n"]],
    "deleted-then-renamed-onto": [
      ["h.md", "h\n"],
      ["d.md", "d\n"],
    ],
    "deleted-then-case-variant-renamed-onto": [
      ["A.md", "a\n"],
      ["NOTES", "notes\n"],
    ],
    "case-variant-swap": [
      ["a.md", "a\n"],
      ["b.md", "b\n"],
    ],
    "renamed-away-while-created": [],
    "remote-created-at-vacated-path": [],
  };
  for (const [path, content] of synced[variant]) log(await first.edit(path, encoder.encode(content)));
  await push(first);
  await pull(second);
  let before = await liveDocuments(run);

  switch (variant) {
    case "deleted-then-created":
      log(await second.remove("h.md"));
      log(await second.edit("h.md", encoder.encode("new\n")));
      break;
    case "deleted-then-renamed-onto":
      log(await second.remove("h.md"));
      log(await second.move("d.md", "h.md"));
      break;
    case "deleted-then-case-variant-renamed-onto":
      log(await second.remove("A.md"));
      log(await second.move("NOTES", "a.md"));
      break;
    case "case-variant-swap":
      log(await second.move("a.md", "z.md"));
      log(await second.move("b.md", "A.md"));
      break;
    case "renamed-away-while-created": {
      log(await second.edit("STRASSE.md", encoder.encode("first\n")));
      log(second.startPush());
      await settle();
      for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
        if (delivery > 100) throw new Error("the second engine never sent CommitRevision");
        await run.step({ kind: "deliver-request", client: second.index });
        await run.step({ kind: "deliver-response", client: second.index });
      }
      // The server commits the create; before its response arrives, the user moves the file away and creates another.
      await run.step({ kind: "deliver-request", client: second.index });
      log(await second.move("STRASSE.md", "b.md", { whileBusy: true }));
      log(await second.edit("straße.md", encoder.encode("second\n"), { whileBusy: true }));
      await run.drain(second.index);
      break;
    }
    case "remote-created-at-vacated-path":
      log(await second.edit("e.md", encoder.encode("second's first note\n")));
      log(await second.move("e.md", "notes/f.md"));
      log(await second.edit("x.md", encoder.encode("second's second note\n")));
      log(await second.move("x.md", "e.md"));
      log(await first.edit("e.md", encoder.encode("first's note\n")));
      await push(first);
      before = await liveDocuments(run);
      break;
  }
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await second.conflicts()).map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts };
}

export interface ThrottledEngineResult extends RunResult {
  /** The methods the server's per-user limit refused, in order. */
  refused: string[];
  /** The delay, in milliseconds, of each backoff the engine started, in order. */
  delays: number[];
  /** Labels of the revisions in the engine's CommitRevision requests, in order: refused ones included. */
  commitLabels: string[];
  /** Labels of the engine's acknowledged revisions, in order. */
  engineAcknowledged: string[];
  /** The edited file's head content on the server, and the engine's copy, after the run. */
  serverContent: string;
  engineContent: string;
}

/**
 * The engine under the server's per-user limit on concurrent requests (#146,
 * SPEC.md §12). The limit refuses the engine's calls with RESOURCE_EXHAUSTED
 * four times in a row (a CommitRevision, a ListChanges, the upload's look-up
 * of its blob (a DownloadBlob) and the CommitRevision again), each time in
 * the engine's next push; the user's
 * edit then lands. A later edit's first push is refused once more. The
 * network checks that the engine sends nothing while backing off; the result
 * shows each delay, and that the edit was committed once, with the revision
 * id it was first sent with.
 */
export async function engineBacksOffWhenThrottled(endpoints: SimEndpoints): Promise<ThrottledEngineResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1 });
  const { observer } = run;
  const engine = observer.index;
  const network = run.context.network;
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const refused: string[] = [];
  /** Steps until the engine's next request is `method` (delivering the calls before it); the limit then refuses it. */
  const refuse = async (method: string) => {
    for (let step = 0; network.pendingRequest(engine) !== method; step++) {
      if (step > 200) throw new Error(`the engine never sent ${method}`);
      // A step without a request to deliver delivers the engine's reply, if any, or only moves time on:
      // while the engine backs off there is nothing to deliver. A timer due at a step fires before it.
      await run.step({ kind: network.pendingRequest(engine) === undefined ? "deliver-response" : "deliver-request", client: engine });
    }
    const entry = network.throttle(engine);
    if (entry === undefined) throw new Error(`no ${method} from the engine to refuse`);
    log(entry);
    refused.push(method);
    await run.step({ kind: "deliver-response", client: engine });
    if (!observer.idle) throw new Error("the refused push is still running");
  };

  const path = "busy.md";
  log(await observer.edit(path, encoder.encode("written while the server is busy\n")));
  log(observer.startPush());
  await refuse("CommitRevision");
  // Each next push starts at once, as the plugin's timer or the user's next edit may start one; the engine waits.
  log(observer.startPush());
  await refuse("ListChanges");
  // The first push uploaded the blob before its commit was refused, so this push's upload is only
  // its look-up of the blob, a DownloadBlob: the limit refuses that (#439).
  log(observer.startPush());
  await refuse("DownloadBlob");
  log(observer.startPush());
  await refuse("CommitRevision");
  log(observer.startPush());
  await settle();
  await run.drain(engine);

  log(await observer.edit(path, encoder.encode("written while the server is busy\nand again\n")));
  log(observer.startPush());
  await refuse("ListChanges");
  log(observer.startPush());
  await settle();
  await run.drain(engine);

  const result = await run.finish();
  const commitPattern = new RegExp(`c${String(engine)} CommitRevision\\(\\S+ (\\S+) .* (?:->|refused)`);
  const commitLabels = run.trace.flatMap((line) => {
    const label = commitPattern.exec(line)?.[1];
    return label === undefined ? [] : [label];
  });
  const heads = await serverHeads(run.direct, run.context.vaultId);
  const headHash = heads.files.get(path);
  const engineCopy = await observer.read(path);
  return {
    ...result,
    refused,
    delays: network.timerDelays.filter((timer) => timer.client === engine).map((timer) => timer.ms),
    commitLabels,
    engineAcknowledged: result.acknowledged.filter((acknowledgement) => acknowledgement.client === engine).map((acknowledgement) => run.context.ids.label(acknowledgement.revisionId)),
    serverContent: headHash === undefined ? "" : decoder.decode(await downloadBlob(run, headHash)),
    engineContent: engineCopy === undefined ? "" : decoder.decode(engineCopy),
  };
}

export interface BusyPathResult extends RunResult {
  /** The server's live documents while the rename was refused: path to document label. */
  whileRefused: Map<string, string>;
  /** The server's live documents after the run: path to document label. */
  documents: Map<string, string>;
  /** The engine's vault after the run: path to content. */
  vault: Map<string, string>;
}

/**
 * A change at a path a pending operation holds (#167 item 3). One POSIX
 * engine syncs `note.md`, and its user renames it to `moved.md`. The server
 * refuses the rename's CommitRevision with INVALID_ARGUMENT, so it stays
 * pending, and the user creates a new note at `note.md`, which the journal
 * still has as the renamed document's path. The next push is refused the same
 * way. Then the server takes the rename. The push that commits it must also
 * push the new note, without another local change or a restart: both notes
 * must be live on the server, the renamed one under its own id.
 */
export async function changeAtBusyPathKept(endpoints: SimEndpoints): Promise<BusyPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 1, platforms: ["posix"] });
  const [observer] = run.observers;
  if (observer === undefined) throw new Error("the run has an engine");
  const engine = observer.index;
  const network = run.context.network;
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async () => {
    log(observer.startPush());
    await settle();
    await run.drain(engine);
  };
  /** Pushes, and has the server refuse the push's CommitRevision as invalid. */
  const refusedPush = async () => {
    log(observer.startPush());
    for (let step = 0; network.pendingRequest(engine) !== "CommitRevision"; step++) {
      if (step > 200) throw new Error("the engine never sent CommitRevision");
      await run.step({ kind: network.pendingRequest(engine) === undefined ? "deliver-response" : "deliver-request", client: engine });
    }
    const entry = network.refuse(engine, new ConnectError("simulated refusal", Code.InvalidArgument));
    if (entry === undefined) throw new Error("no CommitRevision from the engine to refuse");
    log(entry);
    await settle();
    await run.drain(engine);
  };

  log(await observer.edit("note.md", encoder.encode("the note\n")));
  await push();
  log(await observer.move("note.md", "moved.md"));
  await refusedPush();
  log(await observer.edit("note.md", encoder.encode("a new note\n")));
  await refusedPush();
  const whileRefused = await liveDocuments(run);
  await push();

  const result = await run.finish();
  const vault = new Map<string, string>();
  for (const path of await observer.list()) vault.set(path, decoder.decode((await observer.read(path)) ?? new Uint8Array()));
  return { ...result, whileRefused, documents: await liveDocuments(run), vault };
}

export interface BackslashPathResult extends RunResult {
  /** The server's live documents after the refused files were pushed: path to document label. */
  afterRefusal: Map<string, string>;
  /** The second engine's vault then: path to content. */
  secondAfterRefusal: Map<string, string>;
  /** The paths the second engine's last push before the renames reported as rejected. */
  rejected: string[];
  /** Why, per rejected path (#100). */
  reasons: Map<string, string>;
  /** Uploads and commits the second engine sent while its files were refused (before the renames). */
  refusalRequests: string[];
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents after the run: path to document label. */
  documents: Map<string, string>;
}

/**
 * New paths containing "\" (#191, SPEC.md §6.2). Two POSIX engines. The first
 * syncs a note `a/b` and a file `notes`. The second engine's user creates
 * `a\b` and `notes\c.md`, which name `a/b` and a file under `notes` on
 * Windows, and the engine pushes, crashes and pushes again. Neither may
 * reach the server, and both files must stay on the second engine's disk,
 * reported as rejected. Then the user renames them to `a/c` and
 * `notes-c.md`: both must sync, and the vaults must converge.
 */
export async function backslashPathsRefused(endpoints: SimEndpoints): Promise<BackslashPathResult> {
  return newPathsRefused(endpoints, {
    synced: [
      ["a/b", "slash\n"],
      ["notes", "a file\n"],
    ],
    refused: [
      ["a\\b", "backslash twin\n", "a/c"],
      ["notes\\c.md", "under the file\n", "notes-c.md"],
    ],
  });
}

/**
 * New paths starting with one character and a colon (#148, SPEC.md §6.2),
 * which Win32 reads as a drive (`1:` can be created with subst). Two POSIX
 * engines. The first syncs a note `1-x.md`. The second engine's user creates
 * `1:x.md`, `é:y.md` and `😀:z.md`, and the engine pushes, crashes and
 * pushes again. None may reach the server, and all must stay on the second
 * engine's disk, reported as rejected. Then the user renames them to
 * `1/x.md`, `e-y.md` and `z.md`: all must sync, and the vaults must
 * converge.
 */
export async function drivePrefixPathsRefused(endpoints: SimEndpoints): Promise<BackslashPathResult> {
  return newPathsRefused(endpoints, {
    synced: [["1-x.md", "synced\n"]],
    refused: [
      ["1:x.md", "digit drive\n", "1/x.md"],
      ["é:y.md", "letter drive\n", "e-y.md"],
      ["😀:z.md", "emoji drive\n", "z.md"],
    ],
  });
}

/**
 * Local files whose paths the server refuses under any rule (#100, SPEC.md
 * §6.2). Two POSIX engines. The first syncs a note `notes/a.md`. The second
 * engine's user creates `notes/line⏎break.md` (a control character),
 * `notes/.../dots.md` (a segment of dots) and a path of 11 folders and a
 * name that grows past 8192 bytes once normalized, though the path itself is
 * 2,830 bytes. The engine pushes, crashes and pushes again. None may reach
 * the server, the engine may send no upload or commit for them, and all must
 * stay on its disk, reported as rejected with the rule each breaks. Then the
 * user renames them to valid paths: all must sync, and the vaults must
 * converge.
 */
export async function serverRefusedPathsSurfaced(endpoints: SimEndpoints): Promise<BackslashPathResult> {
  return newPathsRefused(endpoints, {
    synced: [["notes/a.md", "synced\n"]],
    refused: [
      ["notes/line\nbreak.md", "control character\n", "notes/line break.md"],
      ["notes/.../dots.md", "dots\n", "notes/dots.md"],
      [normalizedTooLongPath, "grows when normalized\n", "notes/long.md"],
    ],
  });
}

/** 11 folders of 63 U+1D160 (each 252 bytes, a legal name) and a short name: 2,830 bytes, 8,462 once normalized (testdata/paths/key.json). */
export const normalizedTooLongPath = `${Array.from({ length: 11 }, () => "\u{1d160}".repeat(63)).join("/")}/${"\u{1d160}".repeat(11)}.md`;

/**
 * The shape of backslashPathsRefused and drivePrefixPathsRefused: the first
 * engine syncs `synced`, the second creates each `refused` file at a path a
 * commit may not give a document, pushes, crashes and pushes again, then
 * renames each to its valid path and pushes.
 */
async function newPathsRefused(endpoints: SimEndpoints, files: { synced: [path: string, content: string][]; refused: [path: string, content: string, renameTo: string][] }): Promise<BackslashPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };
  const contents = async (engine: typeof first) => {
    const files = new Map<string, string>();
    for (const path of await engine.list()) files.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
    return files;
  };

  for (const [path, content] of files.synced) log(await first.edit(path, encoder.encode(content)));
  await push(first);
  await pull(second);

  for (const [path, content] of files.refused) log(await second.edit(path, encoder.encode(content)));
  const refusalStart = run.trace.length;
  await push(second);
  log(second.crash());
  await push(second);
  // A request's trace entries read `<step>: drain: #<message> c<client> <method>(…`.
  const uploadOrCommit = new RegExp(` #\\d+ c${String(second.index)} (BeginBlob|PutBlobChunk|CommitBlob|CommitRevision)\\(`);
  const refusalRequests = run.trace.slice(refusalStart).filter((entry) => uploadOrCommit.test(entry));
  const rejected = (second.lastPush?.rejected ?? []).map(({ operation }) => operation.path).sort();
  const reasons = new Map((second.lastPush?.rejected ?? []).map(({ operation, reason }) => [operation.path, reason]));
  const afterRefusal = await liveDocuments(run);
  const secondAfterRefusal = await contents(second);

  for (const [path, , renameTo] of files.refused) log(await second.move(path, renameTo));
  await push(second);
  await pull(first);

  const result = await run.finish();
  return { ...result, afterRefusal, secondAfterRefusal, rejected, reasons, refusalRequests, vaults: [await contents(first), await contents(second)], documents: await liveDocuments(run) };
}

export interface RetryAfterScheduleResult extends RunResult {
  /** Label of the revision whose first CommitRevision request was lost. */
  lost: string;
}

/**
 * A commit retry left for the end of the run (#302, seed 21). With the
 * seeded commit retry backoff, the engine's CommitRevision request and the
 * push's own retries of it are lost on the last steps of the schedule, so the
 * push gives up. Its next push, after the faults heal, sends the
 * commit again with the same revision id, which the network holds for the
 * backoff. Draining must let that time pass, so that the retry lands once and
 * the run ends with no violation, instead of waiting for steps that never
 * come.
 */
export async function commitRetryAfterSchedule(endpoints: SimEndpoints): Promise<RetryAfterScheduleResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 1, platforms: ["posix"], commitRetryBackoff: seededCommitRetryBackoff });
  const { observer } = run;
  run.context.log(await observer.edit("note.md", encoder.encode("one\n")));
  await run.step({ kind: "engine-operation", engine: 0, operation: "push", arg: 0 });
  for (let delivery = 0; run.context.network.pendingRequest(observer.index) !== "CommitRevision"; delivery++) {
    if (delivery > 100) throw new Error("the engine never sent CommitRevision");
    await run.step({ kind: "deliver-request", client: observer.index });
    await run.step({ kind: "deliver-response", client: observer.index });
  }
  const lost = /CommitRevision\(\S+ (\S+) /.exec(run.context.network.describePending(observer.index))?.[1] ?? "?";
  // Lose the request and every retry the push makes itself, until the push gives up.
  for (let drop = 0; run.context.network.pendingRequest(observer.index) === "CommitRevision"; drop++) {
    if (drop > 10) throw new Error("the engine never gave up its push");
    await run.step({ kind: "drop-request", pick: 0 });
  }
  return { ...(await run.finish()), lost };
}

export interface StalledEngineResult extends RunResult {
  /** What awaiting the stalled engine threw. */
  error: unknown;
}

/**
 * The harness waits for an engine that waits on the network, which nothing
 * delivers meanwhile (#302): the engine's push has sent its first call, and
 * the scenario then has the user edit another note, which waits for the
 * engine to settle. That wait must fail as a stall naming the step, not hang
 * the run. The run then finishes normally, its drain delivering the push.
 */
export async function stalledEngineReported(endpoints: SimEndpoints): Promise<StalledEngineResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 1, platforms: ["posix"] });
  const { observer } = run;
  run.context.log(await observer.edit("note.md", encoder.encode("one\n")));
  await run.step({ kind: "engine-operation", engine: 0, operation: "push", arg: 0 });
  const error = await observer.edit("other.md", encoder.encode("two\n")).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return { ...(await run.finish()), error };
}

export interface ScriptedChangesOfBinaryResult extends RunResult {
  /** Id of the engine's blob document. */
  documentId: string;
  /** The document's revisions on the server, in order: label, kind and whether it is a tombstone. */
  revisions: { label: string; kind: string; deleted: boolean }[];
}

/**
 * A scripted client changes an engine's blob document (#306). The engine
 * classifies `trailing.`, a path without a text extension, as a blob, and
 * pushes it. The scripted client pulls it, then edits, renames and deletes it.
 * The server never changes a document's kind (SPEC.md §7), so each of those
 * commits must carry the document's own kind, not TEXT, and be accepted.
 */
export async function scriptedChangesOfBinary(endpoints: SimEndpoints): Promise<ScriptedChangesOfBinaryResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 1, engines: 1, platforms: ["posix"] });
  const { observer } = run;
  const drain = async () => {
    await settle();
    await run.drain();
  };
  run.context.log(await observer.edit("trailing.", encoder.encode("engine content\n")));
  run.context.log(observer.startPush());
  await drain();
  for (const operation of ["pull", "edit", "rename", "delete"] as const) {
    await run.step({ kind: "operation", client: 0, operation, arg: 1 });
    await drain();
  }
  const result = await run.finish();

  const revisions: { documentId: string; label: string; kind: string; deleted: boolean }[] = [];
  for (let since = 0n; ; ) {
    const response = await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: since, pageSize: 1000 });
    for (const revision of response.revisions) {
      revisions.push({ documentId: revision.documentId, label: run.context.ids.label(revision.id), kind: DocumentKind[revision.kind], deleted: revision.deleted });
      since = revision.seq;
    }
    if (!response.hasMore) break;
  }
  const documentId = revisions[0]?.documentId ?? "";
  return {
    ...result,
    documentId,
    revisions: revisions.filter((revision) => revision.documentId === documentId).map(({ label, kind, deleted }) => ({ label, kind, deleted })),
  };
}

export interface SpellingRenameResult extends HeldPathResult {
  /** The contents of every acknowledged revision of the note, in order. */
  noteContents: string[];
}

/**
 * A remote rename onto another spelling of an unpushed local file (#305) on
 * a case-insensitive client. Both engines share `notes/f.md`; the second
 * engine's user creates `STRASSE.md` and does not push it. The first engine
 * renames the note to `straße.md` (the same path key) and pushes; the second
 * engine's user renames the note to `Notes/C.md`, and the second engine
 * pushes. The note must keep its id with its own content, and the user's
 * new file must be a document of its own: never committed as the note's
 * next revision.
 */
export async function remoteRenameOntoSpellingOfUnpushedFile(endpoints: SimEndpoints, platform: "windows" | "macos"): Promise<SpellingRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("notes/f.md", encoder.encode("f\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.edit("STRASSE.md", encoder.encode("my own new note\n")));
  log(await first.move("notes/f.md", "straße.md"));
  await push(first);
  log(await second.move("notes/f.md", "Notes/C.md"));
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const noteId = result.acknowledged.find((acknowledgement) => acknowledgement.path === "notes/f.md")?.documentId;
  const noteContents: string[] = [];
  for (const acknowledgement of result.acknowledged) {
    if (acknowledgement.documentId !== noteId || acknowledgement.deleted) continue;
    noteContents.push(decoder.decode(await downloadBlob(run, acknowledgement.blobId)));
  }
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), noteContents };
}

/**
 * A case-only rename on a case-insensitive client (#304). In the `remote-edit`
 * variant both engines share `a.md`; the second engine's user renames it to
 * `A.md`, and the first engine edits `a.md` and pushes before the second
 * engine pushes. In the `first-push` variant the second engine's user
 * creates `Notes/C.md` and renames it to `notes/c.md` before the first push.
 * The user's spelling must reach the server and stay in the vault.
 */
export async function caseOnlyRename(endpoints: SimEndpoints, platform: "windows" | "macos", variant: "remote-edit" | "first-push"): Promise<HeldPathResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  let before = new Map<string, string>();
  if (variant === "remote-edit") {
    log(await first.edit("a.md", encoder.encode("a\n")));
    await push(first);
    await pull(second);
    before = await liveDocuments(run);
    log(await second.move("a.md", "A.md"));
    log(await first.edit("a.md", encoder.encode("a\nremote edit\n")));
    await push(first);
    await push(second);
    await pull(first);
  } else {
    log(await second.edit("Notes/C.md", encoder.encode("new\n")));
    log(await second.move("Notes/C.md", "notes/c.md"));
    await push(second);
    await pull(first);
  }

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run) };
}

export interface RespelledRenameResult extends HeldPathResult {
  /** The case-insensitive engine's push summaries, in order. */
  pushes: string[];
}

/**
 * A live rename of a note whose file the vault holds under another spelling
 * than the note's synced path (#374). Both engines sync `Foo.md` (and, in the
 * `vacated-path` variant, `b.md`). The second engine follows Windows or macOS
 * rules; its user renames `Foo.md` to `foo.md` by case only, and the app is
 * killed before the engine records it, so the restarted engine's journal
 * still has the note at `Foo.md` (no push runs before the next rename: a
 * push's scan alone would commit the vault's spelling, #481). The user then
 * renames `foo.md` to `b.md`, in the
 * `vacated-path` variant after renaming the other note away from `b.md` to
 * `c.md`. Each rename must be committed as a rename of its note: no
 * tombstone, no new document, both vaults equal to the server, and the last
 * push commits nothing (SPEC.md §2 principle 1).
 */
export async function respelledNoteRenamed(endpoints: SimEndpoints, platform: "windows" | "macos", variant: "free-path" | "vacated-path"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("Foo.md", encoder.encode("x\n")));
  if (variant === "vacated-path") log(await first.edit("b.md", encoder.encode("p\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("Foo.md", "foo.md"));
  log(second.crash());
  if (variant === "vacated-path") log(await second.move("b.md", "c.md"));
  log(await second.move("foo.md", "b.md"));
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * A note whose file the case-insensitive vault holds under another spelling
 * than its synced path, with no rename event to say so (#481, seed 100083 and
 * retention seed 100056). Both engines sync `STRASSE.md` and `d.md`; the
 * second follows Windows or macOS rules. In the `respelled` variant its user
 * renames `STRASSE.md` to `straße.md` and edits it; in the `vacated-path`
 * variant the user deletes `d.md`, moves the note there and saves a new file
 * `straße.md`. The app is killed before the engine records any of it. The
 * restarted engine's push must name each file as the vault does, so both
 * vaults equal the server, with no tombstone of the note, and the last push
 * commits nothing (SPEC.md §2 principle 1).
 */
export async function respelledFileAfterRestart(endpoints: SimEndpoints, platform: "windows" | "macos", variant: "respelled" | "vacated-path"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const sync = async (engine: typeof first, start: () => string) => {
    log(start());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("STRASSE.md", encoder.encode("x\n")));
  log(await first.edit("d.md", encoder.encode("p\n")));
  await sync(first, () => first.startPush());
  await sync(second, () => second.startPull());
  const before = await liveDocuments(run);

  if (variant === "respelled") {
    log(await second.move("STRASSE.md", "straße.md"));
    log(await second.edit("straße.md", encoder.encode("x\nedited\n")));
  } else {
    log(await second.remove("d.md"));
    log(await second.move("STRASSE.md", "d.md"));
    log(await second.edit("straße.md", encoder.encode("new\n")));
  }
  log(second.crash());
  await sync(second, () => second.startPush());
  await sync(second, () => second.startPush());
  await sync(first, () => first.startPull());

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * A local rename against a concurrent remote rename of the same note into a
 * folder of another spelling (#375). Both engines sync `notes/C.md` and
 * `notes/b.md`. The second engine's user moves `notes/C.md` to `moved/C.md`
 * and then `notes/b.md`, by way of `moved/b.md`, into the path the first
 * note just left (`vacated-path`) or to `z.md` (`free-path`), while the first
 * (POSIX) engine renames `notes/b.md` to `NOTES/b.md` and pushes. The local
 * rename must win (SPEC.md §7): the note committed at the user's path under
 * its own id, both vaults equal to the server with no stray copy, and the
 * last push commits nothing.
 */
export async function localRenameOverRemoteRenameIntoRespelledFolder(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos", variant: "free-path" | "vacated-path"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("notes/C.md", encoder.encode("a\n")));
  log(await first.edit("notes/b.md", encoder.encode("b\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  if (variant === "vacated-path") log(await second.move("notes/C.md", "moved/C.md"));
  log(await second.move("notes/b.md", "moved/b.md"));
  log(await second.move("moved/b.md", variant === "vacated-path" ? "notes/C.md" : "z.md"));
  log(await first.move("notes/b.md", "NOTES/b.md"));
  await push(first);
  for (let round = 0; round < 3; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * A local rename onto the path of a note the user just deleted, against a
 * concurrent remote edit of the renamed note (#451). Both engines sync
 * `x.md` and `c.md`. The first (POSIX) engine edits `x.md` and pushes; the
 * second engine's user then deletes `c.md` and renames `x.md` to `c.md`
 * before its next push. The local rename wins (SPEC.md §7): `c.md`'s note is
 * tombstoned, `x.md`'s note is live at `c.md` with the remote edit merged
 * in, both vaults equal the server, and the last push commits nothing
 * (SPEC.md §2 principle 1).
 */
export async function renameOntoDeletedNotePath(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("x.md", encoder.encode("x\n")));
  log(await first.edit("c.md", encoder.encode("c\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await first.edit("x.md", encoder.encode("x\nremote\n")));
  await push(first);
  log(await second.remove("c.md"));
  log(await second.move("x.md", "c.md"));
  for (let round = 0; round < 3; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * Both devices rename a note onto the path of a note they moved away or
 * deleted, and both edit it (#462). The first (POSIX) engine edits the
 * synced note `c.md`, moves it to `d.md`, moves the synced note `x.md` to
 * `c.md`, edits it and pushes. The second engine deletes `c.md`, moves
 * `x.md` to `c.md`, edits it and pushes. The second engine's edit of the
 * moved note must stay live on the server and in both vaults, merged in or
 * as a conflict copy (SPEC.md §2 principle 1, §7).
 */
export async function bothRenameOntoVacatedPath(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("x.md", encoder.encode("x\n")));
  log(await first.edit("c.md", encoder.encode("c\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await first.edit("c.md", encoder.encode("c\nremote\n")));
  log(await first.move("c.md", "d.md"));
  log(await first.move("x.md", "c.md"));
  log(await first.edit("c.md", encoder.encode("x\nremote\n")));
  await push(first);
  log(await second.remove("c.md"));
  log(await second.move("x.md", "c.md"));
  log(await second.edit("c.md", encoder.encode("x\nlocal\n")));
  for (let round = 0; round < 3; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * An unpushed local rename onto the path of a note another device creates
 * there (#479, seed 100073). Both engines sync `b.md`. The second engine's
 * user renames it to `NOTES` and edits it without pushing, while the first
 * (POSIX) engine deletes `b.md`, creates another note at `NOTES` and pushes.
 * The second engine pulls, keeping its user's file apart from the other note,
 * and its user then renames the file at `NOTES` to `x.md`. That rename is the
 * other note's: no push tombstones it, the user's edit stays live, both
 * vaults equal the server, and the last push commits nothing (SPEC.md §2
 * principle 1).
 */
export async function renameOntoRemoteCreate(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<RespelledRenameResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("b.md", encoder.encode("b\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("b.md", "NOTES"));
  log(await second.edit("NOTES", encoder.encode("b\nmine\n")));
  log(await first.remove("b.md"));
  log(await first.edit("NOTES", encoder.encode("theirs\n")));
  await push(first);
  await pull(second);
  log(await second.move("NOTES", "x.md"));
  for (let round = 0; round < 3; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

/**
 * An unpushed local rename of a note another device deletes and then
 * recreates at its old path (#486). Both engines sync `b.md`. The second
 * engine's user renames it to `x.md` and edits it without pushing, while the
 * first (POSIX) engine deletes `b.md` and pushes; the second engine pulls
 * the delete. The first engine then creates a new note at `c.md`, renames
 * it to `b.md` and pushes, and the second engine pulls it before it pushes. The new note
 * keeps its path, content and id (no push renames it to `x.md`), the user's
 * edit stays live, both vaults equal the server, and the last push commits
 * nothing (SPEC.md §2 principle 1).
 */
export async function renameOfRecreatedNote(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<RecreatedNoteResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("b.md", encoder.encode("b\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("b.md", "x.md"));
  log(await second.edit("x.md", encoder.encode("b\nmine\n")));
  log(await first.remove("b.md"));
  await push(first);
  await pull(second);
  // A new note brought to b.md by a rename, so it is never the deleted one resurrected.
  log(await first.edit("c.md", encoder.encode("theirs\n")));
  await push(first);
  log(await first.move("c.md", "b.md"));
  await push(first);
  const recreated = (await liveDocuments(run)).get("b.md");
  await pull(second);
  for (let round = 0; round < 3; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, recreated, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), pushes };
}

export interface RecreatedNoteResult extends RespelledRenameResult {
  /** The note the first engine brought to `b.md` after deleting the synced one. */
  recreated: string | undefined;
}

export interface MergedDuringPushResult extends RunResult {
  /** Path to text content of each engine's vault. */
  vaults: Map<string, string>[];
  /** Live documents by path, read directly from the server. */
  documents: Map<string, string>;
  /** The second engine's push summaries, in order. */
  pushes: string[];
}

/**
 * A pull in the middle of a push that merges a remote revision of a
 * document the push has yet to commit (#482). Both engines sync `a.md` and
 * `b.md`; the second engine's user edits both, and the second engine starts
 * a push. Once the push has pulled and is about to send its first commit,
 * the first engine's user edits `a.md` and deletes `b.md`, and that push
 * lands. The second engine's first commit is refused because the head moved,
 * and the pull after it merges both remote revisions: the edit of `b.md`
 * wins over the delete (SPEC.md §7) and leaves its file as it was. The push
 * detected its operation for `b.md` against the old base, and committing it
 * as it was would be refused for good. The engines must quiesce (no
 * `liveness` violation), with both edits live.
 */
export async function mergedDuringPush(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<MergedDuringPushResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("a.md", encoder.encode("a\n")));
  log(await first.edit("b.md", encoder.encode("b\n")));
  await push(first);
  await pull(second);

  log(await second.edit("a.md", encoder.encode("a\nmine\n")));
  log(await second.edit("b.md", encoder.encode("b\nmine\n")));
  log(second.startPush());
  await settle();
  for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
    if (delivery > 200) throw new Error(`${second.name} never sent CommitRevision`);
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "deliver-response", client: second.index });
  }
  log(await first.edit("a.md", encoder.encode("theirs\na\n")));
  log(await first.remove("b.md"));
  await push(first);
  await run.drain(second.index);
  for (let round = 0; round < 2; round++) await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, documents: await liveDocuments(run), pushes };
}

export interface RenameOntoLocalFolderResult extends KnownHeldPathResult {
  /** The case-insensitive engine's push summaries, in order. */
  pushes: string[];
}

/**
 * A remote rename onto the name of a folder a local, unpushed note created
 * (#307). The second engine follows Windows or macOS rules, where a file
 * `NOTES` cannot sit next to a folder `Notes/`. Its user edits the synced
 * note `a.md` and creates a new note `Notes/C.md`, while the first (POSIX)
 * engine renames `a.md` to `NOTES` and pushes. The second engine's merge of
 * the rename is deferred, and the server refuses its create of `Notes/C.md`
 * by the file/folder rule (SPEC.md §5). The engines must converge in a
 * bounded number of pushes, with the edit of `a.md` and the new note's
 * content both live on the server and in both vaults (SPEC.md §2
 * principle 1), at conflict-copy paths where needed.
 */
export async function remoteRenameOntoLocalFolder(endpoints: SimEndpoints, platform: "windows" | "macos"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await second.edit("a.md", encoder.encode("a\n")));
  await push(second);
  await pull(first);
  const before = await liveDocuments(run);

  log(await second.edit("Notes/C.md", encoder.encode("new note\n")));
  log(await second.edit("a.md", encoder.encode("a\nlocal edit\n")));
  log(await first.move("a.md", "NOTES"));
  await push(first);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

/**
 * A remote edit of a note whose path the user vacated for another note's
 * rename (#253). Both engines sync `a.md` and `d.md`. The second engine
 * follows macOS or Windows rules; its user deletes `a.md` and renames `d.md`
 * to `A.md` (the same path key). The first engine edits `a.md` and pushes,
 * either before the second engine pushes or while that push is committing
 * (`timing`). The edit must survive and the renamed note must keep its id,
 * and no operation may stay pending (SPEC.md §2 principle 1).
 */
export async function remoteEditOfVacatedPath(endpoints: SimEndpoints, platform: "windows" | "macos", timing: "before-push" | "while-pushing"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("a.md", encoder.encode("h\n")));
  log(await first.edit("d.md", encoder.encode("d\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.remove("a.md"));
  log(await second.move("d.md", "A.md"));
  log(await first.edit("a.md", encoder.encode("h\nremote edit\n")));
  if (timing === "before-push") {
    await push(first);
    await push(second);
  } else {
    log(second.startPush());
    await settle();
    for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
      if (delivery > 100) throw new Error("the second engine never sent CommitRevision");
      await run.step({ kind: "deliver-request", client: second.index });
      await run.step({ kind: "deliver-response", client: second.index });
    }
    // The edit commits just before the second engine's first CommitRevision reaches the server.
    await push(first);
    await run.drain(second.index);
  }
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

/**
 * A remote rename into a folder named like the path the user deleted the
 * note from, on a case-insensitive client (#299, retention seed 1 of #229's
 * shape). Both engines sync the note `NOTES`. The second engine follows
 * macOS or Windows rules; its user deletes `NOTES` and creates its own
 * `notes/f.md`. The first (POSIX) engine renames `NOTES` to `notes/f.md`,
 * edits it and pushes. The edit wins over the delete, and the user's
 * `notes/f.md` is in the way, so it must be kept as a conflict copy in
 * `notes/`: the note's synced path `NOTES`, where the merge result does not
 * go, must not leave that folder without a free name. The engines must
 * converge with both versions live and nothing deferred (SPEC.md §2
 * principle 1).
 */
export async function remoteRenameIntoDeletedNotesFolder(endpoints: SimEndpoints, platform: "windows" | "macos"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("NOTES", encoder.encode("theirs\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.remove("NOTES"));
  log(await second.edit("notes/f.md", encoder.encode("mine\n")));
  log(await first.move("NOTES", "notes/f.md"));
  log(await first.edit("notes/f.md", encoder.encode("theirs, edited\n")));
  await push(first);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

export interface RestoredServerResult {
  trace: string[];
  /** Whether the behind engine's pull after the restore resynced. */
  resynced: boolean | undefined;
  /** The behind engine's vault after that pull: path to content. */
  vault: Map<string, string>;
  /** The server's live paths at the end. */
  serverFiles: string[];
}

/**
 * A server restored from a database backup whose head_seq then passes a
 * device's cursor again (#155, SPEC.md §6.1, §8). The first engine writes a
 * note and the database is backed up; it then writes two more revisions,
 * which the second engine pulls (its cursor is 3). The backup is restored
 * (head_seq 1), and a third engine, new to the vault, writes three notes:
 * the restored server numbers them 2 to 4, past the second engine's cursor.
 * The second engine's next pull must detect the divergence and resync: it
 * then holds all three post-restore notes, and keeps the content of the
 * revisions the server lost.
 */
export async function restoredServer(endpoints: SimEndpoints): Promise<RestoredServerResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 3, platforms: ["posix", "posix", "posix"] });
  const [first, second, third] = run.observers;
  if (first === undefined || second === undefined || third === undefined) throw new Error("the run has three engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("notes/kept.md", encoder.encode(textLines("kept"))));
  await push(first);
  if ((await run.snapshot()) !== 1n) throw new Error("expected the backup at seq 1");

  log(await first.edit("notes/kept.md", encoder.encode(textLines("kept", "edited before the restore"))));
  log(await first.edit("notes/lost.md", encoder.encode(textLines("only before the restore"))));
  await push(first);
  await pull(second);
  if (second.lastPull?.cursor !== 3n) throw new Error(`expected the second engine at seq 3, it is at ${String(second.lastPull?.cursor)}`);

  await run.restore();
  await pull(third);
  for (const index of [1, 2, 3]) log(await third.edit(`notes/after-${String(index)}.md`, encoder.encode(textLines(`written after the restore ${String(index)}`))));
  await push(third);

  second.lastPull = undefined;
  await pull(second);

  const vault = new Map<string, string>();
  for (const path of await second.list()) vault.set(path, decoder.decode((await second.read(path)) ?? new Uint8Array()));
  const lastPull = () => second.lastPull;
  return { trace: run.trace, resynced: lastPull()?.resynced, vault, serverFiles: await liveFiles(run) };
}

/**
 * A new file at the synced path a local rename moved a note away from, while
 * another device renamed and edited the note (#352). Both engines follow
 * POSIX rules, where a file `NOTES` and a folder `notes/` can coexist on
 * disk, but the server takes them for one path (SPEC.md §5). Both sync the
 * note `NOTES`. The second engine's user renames it to `notes/f.md`, edits
 * it and creates a new file `NOTES`; the first engine renames it to
 * `notes/c.md`, edits it and pushes. The local rename wins and the two edits
 * conflict, so the local edit must be kept as a copy in `notes/`: the new
 * file `NOTES` must not leave that folder, where the merge result goes,
 * without a free name. The new file is then refused by the server and moved
 * to a `path-taken` copy. The engines must converge with every version live
 * and nothing deferred (SPEC.md §2 principle 1).
 */
export async function newFileAtRenamedAwayPath(endpoints: SimEndpoints): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("NOTES", encoder.encode("base\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("NOTES", "notes/f.md"));
  log(await second.edit("notes/f.md", encoder.encode("mine\n")));
  log(await second.edit("NOTES", encoder.encode("other\n")));
  log(await first.move("NOTES", "notes/c.md"));
  log(await first.edit("notes/c.md", encoder.encode("theirs\n")));
  await push(first);
  await pull(second);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

/**
 * A local rename into a folder named like the path a concurrent remote rename
 * gives the same note (#344, retention seed 5 of #229's shape, with
 * overlapping edits instead of a purged merge base). Both engines sync the
 * note `a.md`. The second engine follows `platform`'s rules; its user renames
 * the note to `Notes/C.md` and edits it. The first (POSIX) engine renames the
 * note to `NOTES`, edits it too and pushes. The local rename wins (SPEC.md
 * §7) and the edits overlap, so the result is the remote content at
 * `Notes/C.md` with the local version as a conflict copy in `Notes/`: the
 * remote revision's own path `NOTES`, where the merge result does not go,
 * must not leave that folder without a free name. The engines must converge
 * with both versions live and nothing deferred (SPEC.md §2 principle 1).
 */
export async function localRenameIntoRemoteRenamesFolder(endpoints: SimEndpoints, platform: "posix" | "windows" | "macos"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("a.md", encoder.encode("synced\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.move("a.md", "Notes/C.md"));
  log(await second.edit("Notes/C.md", encoder.encode("mine\n")));
  log(await first.move("a.md", "NOTES"));
  log(await first.edit("NOTES", encoder.encode("theirs\n")));
  await push(first);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

/**
 * A remote rename of a note onto a file named like the note's local folder
 * by path key, while the user edited the note (#359). Both engines sync the
 * note `Notes/C.md`. The second engine's user edits it; the first engine
 * renames it to `NOTES`, edits it and pushes. There is no local rename, so
 * the remote rename wins and the two edits conflict. Path keys ignore case
 * on every platform, so every name in `Notes/` is under the file `NOTES` the
 * merge result goes to: the local edit's copy must go under a conflict-named
 * folder (`Notes (conflict …)/C.md`, SPEC.md §7). The engines must converge
 * with both versions live, no duplicate copies and nothing deferred (SPEC.md
 * §2 principle 1). Both engines follow `platform`'s rules.
 */
export async function remoteRenameOntoFolderName(endpoints: SimEndpoints, platform: "posix" | "macos" | "windows"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: [platform, platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("Notes/C.md", encoder.encode("base\n")));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.edit("Notes/C.md", encoder.encode("mine\n")));
  log(await first.move("Notes/C.md", "NOTES"));
  log(await first.edit("NOTES", encoder.encode("theirs\n")));
  await push(first);
  await pull(second);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

export interface InterruptedConflictMoveResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents after the run: path to document label. */
  documents: Map<string, string>;
  /** The conflict copy the interrupted move left in the second engine's vault, if any. */
  copy: string | undefined;
  /** The second engine's push summaries, in order. */
  pushes: string[];
}

/**
 * A create refused with ALREADY_EXISTS whose move to its conflict copy the
 * app dies in (#371, #372). The first engine syncs the folder `NOTES/`; the
 * second engine's user creates the file `notes`, which the server refuses
 * (path keys ignore case on every platform), so the push moves it to
 * `notes (conflict …)`. The app is killed `when` the journal records the
 * copy's operation: `before` (the file is already moved) or `after` (the
 * refused operation is not removed yet). Then the first engine renames
 * `NOTES/d.md` to `A.md`, so the path frees up (`holder-leaves`), or the
 * user deletes the copy (`delete-copy`) or moves it to `kept.md`
 * (`move-copy`). The engines must converge with nothing left pending
 * (SPEC.md §7). Both engines follow `platform`'s rules.
 */
export async function interruptedConflictMove(
  endpoints: SimEndpoints,
  platform: "posix" | "macos" | "windows",
  when: "before" | "after",
  then: "holder-leaves" | "delete-copy" | "move-copy",
): Promise<InterruptedConflictMoveResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: [platform, platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("NOTES/d.md", encoder.encode("other\n")));
  await push(first);
  log(await second.edit("notes", encoder.encode("mine\n")));
  await pull(second);

  second.haltOnPending(when, (operation) => operation.path.includes("(conflict "));
  await push(second);
  log(second.crash());
  const copy = (await second.list()).find((path) => path.includes("(conflict "));
  if (then === "holder-leaves") {
    log(await first.move("NOTES/d.md", "A.md"));
    await push(first);
  } else if (copy !== undefined) {
    log(then === "delete-copy" ? await second.remove(copy) : await second.move(copy, "kept.md"));
  }
  await push(second);
  await push(second);
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, documents: await liveDocuments(run), copy, pushes };
}

/**
 * A parked note's edit, still pending at its old path, against another note
 * the server puts there (#391, #398). Both engines sync `plan.md`. The second
 * engine follows Windows rules; its user edits `plan.md`, and while that
 * push is committing the first (POSIX) engine renames the note to
 * `plan?.md`, which Windows cannot hold: the second engine parks the note
 * (unmaterializable, SPEC.md §8) with its edit pending at `plan.md`. With
 * `deleted-file` its user then deletes `plan.md`; with `renamed-file` the
 * user renames it to `notes.md`, and once the second engine has synced the
 * other note below, its app is killed and restarted (#459). The first engine
 * creates another note at `plan.md`, and later renames the parked note to
 * `draft.md`. The other note must stay live at `plan.md` under its own id,
 * the renamed note must come back at `draft.md` under its id, and with
 * `kept-file` the edit must be live as a conflict copy (SPEC.md §2
 * principle 1); nothing may stay pending or deferred.
 */
export async function parkedEditAtReusedPath(endpoints: SimEndpoints, variant: "kept-file" | "deleted-file" | "renamed-file"): Promise<RenameOntoLocalFolderResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "windows"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };
  const sync = async (engine: typeof first) => {
    await pull(engine);
    await push(engine);
    await pull(engine);
    await push(engine);
  };

  log(await first.edit("plan.md", encoder.encode(textLines("one", "two"))));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  log(await second.edit("plan.md", encoder.encode(textLines("one", "two (edited)"))));
  log(second.startPush());
  await settle();
  for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
    if (delivery > 100) throw new Error("the second engine never sent CommitRevision");
    await run.step({ kind: "deliver-request", client: second.index });
    await run.step({ kind: "deliver-response", client: second.index });
  }
  // The rename commits just before the second engine's CommitRevision reaches the server.
  log(await first.move("plan.md", "plan?.md"));
  await push(first);
  await run.drain(second.index);
  if (variant === "deleted-file") log(await second.remove("plan.md"));
  if (variant === "renamed-file") log(await second.move("plan.md", "notes.md"));

  log(await first.edit("plan.md", encoder.encode(textLines("another note"))));
  await push(first);
  await sync(second);
  if (variant === "renamed-file") log(second.crash());

  log(await first.move("plan?.md", "draft.md"));
  await push(first);
  await sync(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  const conflicts = (await Promise.all([first, second].map((engine) => engine.conflicts())))
    .flat()
    .map(({ reason, path, copyPath, documentId }) => ({ reason, path, copyPath, document: run.context.ids.label(documentId) }));
  const pushes = result.trace.filter((line) => line.includes(`${second.name} pushed: `));
  return { ...result, vaults, before, documents: await liveDocuments(run), tombstoned: await tombstonedDocuments(run), conflicts, pushes };
}

export interface RecreatedNoteMergeCrashResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents after the run: path to document label. */
  documents: Map<string, string>;
  /** Whether the app was killed before the merge's deferral was removed. */
  killed: boolean;
}

/**
 * A pull that brings a deleted note's tombstone and a new document at its
 * path, onto a device whose user edited the deleted note, killed after the
 * merge of the tombstone rebased the document and before it removed the
 * deferral (#453). The first engine creates and pushes `Notes/C.md`, then
 * its user deletes it; the second engine pulls the note and its user edits
 * it; the first engine's user writes a new `Notes/C.md`, and its push sends
 * the tombstone and the new document. The second engine's pull is killed
 * there, and it restarts. The engines must converge with the edit kept and
 * nothing deferred (the `engine-deferred` invariant). Both engines follow
 * `platform`'s rules.
 */
export async function recreatedNoteMergeCrash(endpoints: SimEndpoints, platform: "posix" | "windows"): Promise<RecreatedNoteMergeCrashResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: [platform, platform] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("Notes/C.md", encoder.encode("w1\n")));
  await push(first);
  log(await first.remove("Notes/C.md"));
  await pull(second);
  log(await second.edit("Notes/C.md", encoder.encode("w2\n")));
  log(await first.edit("Notes/C.md", encoder.encode("w3\n")));
  await push(first);

  const killed = second.haltOnDeferralRemoval();
  await pull(second);
  log(second.crash());
  for (let round = 0; round < 3; round++) {
    await push(second);
    await push(first);
  }
  await pull(first);
  await pull(second);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return { ...result, vaults, documents: await liveDocuments(run), killed: killed() };
}

export interface PurgedCursorResult extends RunResult {
  /** Each engine's vault after the run: path to content. */
  vaults: Map<string, string>[];
  /** The server's live paths after the run. */
  live: string[];
  /** Labels of the revisions retention purged. */
  purged: string[];
  /** Whether the second engine's pull resynced. */
  resynced: boolean;
  /** How many purge markers retention pruned (with `pruneMarkers`). */
  prunedMarkers: number;
}

/**
 * Retention purged the revision at an engine's cursor (#480, SPEC.md §6.1,
 * §8, §11). Both engines sync two notes; the second engine's cursor sits on
 * the later one's revision. The first engine deletes the other note and edits
 * the later one, and retention purges both notes' older revisions, the
 * second engine's cursor among them. The second engine's pull finds its
 * cursor diverged and resyncs: the server lost nothing, so the delete of a
 * note its user never changed is applied, not merged as a delete against an
 * edit, and its next push never brings the note back.
 *
 * With `pruneMarkers`, the purges' markers then age past the marker horizon
 * and retention prunes them (#514) before the second engine pulls: its
 * anchor check finds neither the revision nor a marker, so it resyncs and
 * merges every note it holds, keeping every file.
 *
 * With `localEdit`, the second engine's user edits the later note before
 * that pull, an edit not yet pushed (#519): it must survive (principle 1).
 */
export async function purgedCursor(
  endpoints: SimEndpoints,
  options: { pruneMarkers?: boolean; localEdit?: boolean } = {},
): Promise<PurgedCursorResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };

  log(await first.edit("notes/gone.md", encoder.encode(textLines("deleted by the first engine"))));
  await push(first);
  log(await first.edit("notes/kept.md", encoder.encode(textLines("one"))));
  await push(first);
  await pull(second);

  log(await first.remove("notes/gone.md"));
  log(await first.edit("notes/kept.md", encoder.encode(textLines("two"))));
  await push(first);

  // Age every revision: retention purges all but the heads, the second engine's cursor among them.
  const revisions = (await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: 0n })).revisions;
  if (revisions.length !== 4) throw new Error(`expected four revisions, got ${String(revisions.length)}`);
  const purged = (await run.purge(revisions.map((revision) => revision.id))).map((id) => run.context.ids.label(id));
  const prunedMarkers = options.pruneMarkers === true ? await run.pruneMarkers() : 0;
  if (options.localEdit === true) log(await second.edit("notes/kept.md", encoder.encode(textLines("one", "edited offline"))));

  second.lastPull = undefined;
  await pull(second);
  const lastPull = () => second.lastPull;
  const resynced = lastPull()?.resynced === true;
  await push(second);
  await pull(first);

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return { ...result, vaults, live: await liveFiles(run), purged, resynced, prunedMarkers };
}
