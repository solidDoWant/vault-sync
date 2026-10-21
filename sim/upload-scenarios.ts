// Scripted upload-session scenarios (#490, SPEC.md §6.2, §12): upload-session
// calls refused with RESOURCE_EXHAUSTED for content new to the server, and a
// vault at its upload session limit on the real server, with idle sessions
// reclaimed.

import { hexToBytes } from "@noble/hashes/utils.js";

import type { EngineObserver } from "./engine-observer";
import { serverHeads } from "./engine-observer";
import { settle } from "./network";
import { limitedMaxUploadsPerVault, SimRun, type RunResult, type SimEndpoints } from "./runner";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Spans three chunks at the sim server's 64 KiB maximum chunk size. */
const largeContentBytes = 150 * 1024;

/** Content of `largeContentBytes` bytes no other file of a run has: `byte` repeated. */
function large(byte: string): Uint8Array {
  return encoder.encode(byte.repeat(largeContentBytes));
}

/** Steps `engine`'s calls (delivering those before it) until its next request is `method`. */
async function deliverUntil(run: SimRun, engine: number, method: string): Promise<void> {
  const network = run.context.network;
  for (let step = 0; network.pendingRequest(engine) !== method; step++) {
    if (step > 200) throw new Error(`c${String(engine)} never sent ${method}`);
    // A step without a request to deliver delivers the engine's reply, if any, or only moves time on:
    // while the engine backs off there is nothing to deliver. A timer due at a step fires before it.
    await run.step({ kind: network.pendingRequest(engine) === undefined ? "deliver-response" : "deliver-request", client: engine });
  }
}

/** Delivers `engine`'s pending request and its reply. */
async function deliverOne(run: SimRun, engine: number): Promise<void> {
  await run.step({ kind: "deliver-request", client: engine });
  await run.step({ kind: "deliver-response", client: engine });
}

/** What the server answered `client`'s `method` calls, in order, from the trace: `ok` or an error code. */
function outcomes(trace: readonly string[], client: number, method: string): string[] {
  const pattern = new RegExp(`^\\d+: (?:drain: )?#\\d+ c${String(client)} ${method}\\(.*?\\) -> (\\S+)`);
  return trace.flatMap((line) => {
    const outcome = pattern.exec(line)?.[1];
    return outcome === undefined ? [] : [outcome];
  });
}

/** Offsets of the PutBlobChunk calls of `client` that the server accepted, in order, from `trace`. */
function chunkOffsets(trace: readonly string[], client: number): string[] {
  const pattern = new RegExp(`c${String(client)} PutBlobChunk\\(\\S+ @(\\d+)\\) -> ok`);
  return trace.flatMap((line) => {
    const offset = pattern.exec(line)?.[1];
    return offset === undefined ? [] : [offset];
  });
}

/** The server's head content of every live file: path to content. */
async function serverFiles(run: SimRun): Promise<Map<string, string>> {
  const heads = await serverHeads(run.direct, run.context.vaultId);
  const files = new Map<string, string>();
  for (const [path, hash] of heads.files) {
    // A download returns at most one chunk's worth of bytes at a time.
    const parts: Uint8Array[] = [];
    for (let offset = 0n, size = 1n; offset < size; ) {
      const response = await run.direct.blobs.downloadBlob({ vaultId: run.context.vaultId, blobId: hexToBytes(hash), offset, length: 0 });
      if (response.data.length === 0 && response.size > offset) throw new Error(`DownloadBlob returned no bytes at ${String(offset)}`);
      parts.push(response.data);
      offset += BigInt(response.data.length);
      size = response.size;
    }
    files.set(path, parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode());
  }
  return files;
}

/** Labels of `engine`'s acknowledged revisions, by path. */
function acknowledgedPaths(result: RunResult, engine: number): string[] {
  return result.acknowledged.filter((acknowledgement) => acknowledgement.client === engine).map((acknowledgement) => acknowledgement.path);
}

export interface RefusedUploadResult extends RunResult {
  /** The upload-session calls the network refused, in order. */
  refused: string[];
  /** The delay, in milliseconds, of each backoff the engine started, in order. */
  delays: number[];
  /** Offsets of the engine's chunks the server accepted, in order. */
  chunks: string[];
  /** Paths of the engine's acknowledged revisions, in order. */
  engineAcknowledged: string[];
  /** The engine's CommitRevision calls, refused ones included. */
  commits: number;
  /** The server's live files after the run: path to content; and the engine's. */
  server: Map<string, string>;
  engine: Map<string, string>;
  /** What was written. */
  written: string;
}

/**
 * Upload-session calls refused with RESOURCE_EXHAUSTED (#483, SPEC.md §12).
 * The engine's user writes content new to the server, three chunks long. The
 * server's per-user limit refuses, each in the engine's next push, its
 * BeginBlob, then its second PutBlobChunk, then its CommitBlob; the push
 * after that lands. The network checks that the engine sends nothing while
 * backing off; the result shows each delay, that the upload resumed where
 * the server's session stood, and that the edit was committed once.
 */
export async function uploadSessionCallsRefused(endpoints: SimEndpoints): Promise<RefusedUploadResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 1, platforms: ["posix"] });
  const { observer } = run;
  const engine = observer.index;
  const network = run.context.network;
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const refused: string[] = [];
  /** Delivers the engine's calls until its `skip`+1-th `method` is next; the limit then refuses that one. */
  const refuse = async (method: string, skip = 0) => {
    for (let skipped = 0; skipped < skip; skipped++) {
      await deliverUntil(run, engine, method);
      await deliverOne(run, engine);
    }
    await deliverUntil(run, engine, method);
    const entry = network.throttle(engine);
    if (entry === undefined) throw new Error(`no ${method} from the engine to refuse`);
    log(entry);
    refused.push(method);
    await run.step({ kind: "deliver-response", client: engine });
    if (!observer.idle) throw new Error("the refused push is still running");
  };

  const path = "attachment.md";
  const written = large("u");
  log(await observer.edit(path, written));
  log(observer.startPush());
  await refuse("BeginBlob");
  // Each next push starts at once, as the plugin's timer or the user's next edit may start one; the engine waits.
  log(observer.startPush());
  await refuse("PutBlobChunk", 1);
  log(observer.startPush());
  await refuse("CommitBlob");
  log(observer.startPush());
  await settle();
  await run.drain(engine);

  const result = await run.finish();
  const engineFiles = new Map<string, string>();
  for (const file of await observer.list()) engineFiles.set(file, decoder.decode((await observer.read(file)) ?? new Uint8Array()));
  return {
    ...result,
    refused,
    delays: network.timerDelays.filter((timer) => timer.client === engine).map((timer) => timer.ms),
    chunks: chunkOffsets(run.trace, engine),
    engineAcknowledged: acknowledgedPaths(result, engine),
    commits: run.trace.filter((line) => line.includes(`c${String(engine)} CommitRevision(`) && /-> |refused/.test(line)).length,
    server: await serverFiles(run),
    engine: engineFiles,
    written: decoder.decode(written),
  };
}

export interface UploadLimitResult extends RunResult {
  /** The server's answers to the tested engine's BeginBlob calls, in order: `ok` or an error code. */
  begins: string[];
  /** The server's answers to the tested engine's PutBlobChunk calls, in order. */
  chunkOutcomes: string[];
  /** Offsets of the tested engine's chunks the server accepted after its session was reclaimed. */
  chunksAfterReclaim: string[];
  /** How many sessions each ageing made idle. */
  aged: number[];
  /** Paths of the tested engine's acknowledged revisions, in order. */
  engineAcknowledged: string[];
  /** The server's live files after the run: path to content. */
  server: Map<string, string>;
  /** What each file was written with: path to content. */
  written: Map<string, string>;
  /** The delay, in milliseconds, of each backoff the tested engine started. */
  delays: number[];
}

/**
 * A vault at its upload session limit on the real server (#386 item 3,
 * SPEC.md §6.2), against the replica whose limit is
 * limitedMaxUploadsPerVault (2). Three engines of one user:
 *
 * 1. Two engines each begin uploading a large new file, send a chunk, and
 *    crash while sending the next, abandoning their sessions: the vault is
 *    at its limit.
 * 2. The tested engine's user writes a new note. The server refuses its
 *    BeginBlob with RESOURCE_EXHAUSTED, and again on the next push after the
 *    backoff: no session is idle long enough to be reclaimed.
 * 3. The two sessions are aged past the reclaim idle (Control.ageUploads).
 *    The next push reclaims them and lands the note.
 * 4. The tested engine begins uploading a large new file and sends one
 *    chunk. Its session is aged; the restarted engines begin their uploads
 *    again, and the second of them, at the limit, reclaims the tested
 *    engine's session. Its next chunk is refused, its upload starts over
 *    from BeginBlob and is refused at the limit. Once the others finish, its
 *    next push uploads the file from the start and lands it.
 *
 * Every write, the abandoned ones included, must reach the server
 * (`lost-write` and the other invariants of finish()).
 */
export async function uploadLimitReached(endpoints: SimEndpoints): Promise<UploadLimitResult> {
  const run = await SimRun.start({ ...endpoints, serverUrl: endpoints.limitedServerUrl }, { seed: 0, clients: 0, engines: 3, platforms: ["posix", "posix", "posix"] });
  const [tested, first, second] = run.observers;
  if (tested === undefined || first === undefined || second === undefined) throw new Error("the run has three engines");
  // The constant is the literal 2 today; this guards against it changing.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (limitedMaxUploadsPerVault !== 2) throw new Error("the scenario fills a limit of 2 upload sessions");
  const network = run.context.network;
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const written = new Map<string, string>();
  const write = async (observer: EngineObserver, path: string, content: Uint8Array) => {
    written.set(path, decoder.decode(content));
    log(await observer.edit(path, content));
  };
  /** Pushes until the engine's first chunk is accepted; its next chunk is then pending. */
  const firstChunk = async (observer: EngineObserver) => {
    log(observer.startPush());
    await deliverUntil(run, observer.index, "PutBlobChunk");
    await deliverOne(run, observer.index);
    if (network.pendingRequest(observer.index) !== "PutBlobChunk") throw new Error(`${observer.name}'s upload took a single chunk:\n${run.trace.slice(-40).join("\n")}`);
  };
  /** Delivers the tested engine's calls until the server has answered its next BeginBlob, and that answer. */
  const begin = async () => {
    await deliverUntil(run, tested.index, "BeginBlob");
    await deliverOne(run, tested.index);
  };
  const aged: number[] = [];

  // 1. Two abandoned uploads fill the limit.
  await write(first, "first.md", large("f"));
  await write(second, "second.md", large("s"));
  // The crashed incarnation's next chunk is still on its way; it lands, and its reply is discarded.
  for (const observer of [first, second]) {
    await firstChunk(observer);
    log(observer.crash());
    await run.drain(observer.index);
  }

  // 2. The tested engine's new content is refused at the limit, twice.
  await write(tested, "note.md", encoder.encode("written while the vault is at its upload limit\n"));
  log(tested.startPush());
  await begin();
  await settle();
  log(tested.startPush());
  await begin();
  await settle();

  // 3. Aged, the abandoned sessions are reclaimed; the note lands.
  aged.push(await run.ageUploads());
  log(tested.startPush());
  await settle();
  await run.drain(tested.index);

  // 4. The tested engine's own session is reclaimed mid-upload.
  await write(tested, "large.md", large("t"));
  await firstChunk(tested);
  aged.push(await run.ageUploads());
  // The first restarted engine opens a session: one of two.
  await firstChunk(first);
  // The second finds the vault at its limit and reclaims the tested engine's idle session.
  await firstChunk(second);
  const reclaimedAt = run.trace.length;
  // The tested engine's next chunk finds its session gone; it begins again and is refused at the limit.
  await begin();
  await settle();
  // The others finish their uploads and commits; the tested engine's next push lands its file.
  await run.drain(first.index);
  await run.drain(second.index);
  log(tested.startPush());
  await settle();
  await run.drain(tested.index);

  const result = await run.finish();
  return {
    ...result,
    begins: outcomes(run.trace, tested.index, "BeginBlob"),
    chunkOutcomes: outcomes(run.trace, tested.index, "PutBlobChunk"),
    chunksAfterReclaim: chunkOffsets(run.trace.slice(reclaimedAt), tested.index),
    aged,
    engineAcknowledged: acknowledgedPaths(result, tested.index),
    server: await serverFiles(run),
    written,
    delays: network.timerDelays.filter((timer) => timer.client === tested.index).map((timer) => timer.ms),
  };
}
