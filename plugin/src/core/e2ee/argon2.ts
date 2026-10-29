/**
 * Argon2id for the passphrase wrapping. Where the runtime has Web Workers,
 * each derivation runs hash-wasm's WebAssembly Argon2id in a worker of its
 * own, started from a Blob URL of the script the build inlines
 * (`ARGON2_WORKER_SOURCE`, built from ./argon2-worker-entry). The worker first
 * runs a known-answer self-test (./argon2-wasm). Elsewhere, or when the worker
 * does not start, fails, or fails its self-test, every derivation of the
 * session uses @noble/hashes' pure-JavaScript `argon2idAsync` on the main
 * thread instead.
 *
 * Neither path holds the UI thread: the worker runs off it, and
 * `argon2idAsync` yields to the event loop every few milliseconds. Both are
 * Argon2id version 0x13 (RFC 9106) and produce the same output.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";

import { describe, type Argon2idInput, type Argon2WorkerResponse } from "./argon2-wasm";

export type { Argon2idInput } from "./argon2-wasm";

/**
 * The bundled worker script, defined by the build (scripts/argon2-worker.ts);
 * undefined where nothing defines it, as in unit tests.
 */
declare const ARGON2_WORKER_SOURCE: string | undefined;

/** Which implementation derived, and why not WebAssembly when it was not. */
export type Argon2Implementation = { kind: "webassembly" } | { kind: "javascript"; reason: string };

/**
 * How long (ms) the pure-JavaScript derivation computes before it yields to
 * the event loop.
 */
const JAVASCRIPT_ASYNC_TICK_MS = 10;

/**
 * How long a worker may take to answer before the derivation falls back. Far
 * above the slowest derivation the bounds allow on a phone.
 */
const WORKER_TIMEOUT_MS = 5 * 60_000;

/** The reason the session derives in pure JavaScript, once it does. */
let fallbackReason: string | undefined;
let lastImplementation: Argon2Implementation | undefined;

/** @noble/hashes' Argon2id, which yields to the event loop as it runs. */
export async function argon2idJavaScript(input: Argon2idInput): Promise<Uint8Array> {
  return argon2idAsync(input.password, input.salt, {
    m: input.memory,
    t: input.iterations,
    p: input.parallelism,
    dkLen: input.length,
    asyncTick: JAVASCRIPT_ASYNC_TICK_MS,
  });
}

/** The implementation the last derivation of this session used, if any ran. */
export function lastArgon2Implementation(): Argon2Implementation | undefined {
  return lastImplementation;
}

/** Argon2id of `input`, in the worker or, failing that, in pure JavaScript. The caller validates the parameters. */
export async function argon2id(input: Argon2idInput): Promise<Uint8Array> {
  if (fallbackReason === undefined) {
    const response = await deriveInWorker(input);
    if (response.kind === "output") {
      lastImplementation = { kind: "webassembly" };
      return response.output;
    }
    fallbackReason = response.reason;
  }
  lastImplementation = { kind: "javascript", reason: fallbackReason };
  return argon2idJavaScript(input);
}

async function deriveInWorker(input: Argon2idInput): Promise<Argon2WorkerResponse> {
  if (typeof ARGON2_WORKER_SOURCE !== "string") {
    return { kind: "fallback", reason: "the Argon2id worker is not bundled" };
  }
  if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL.createObjectURL !== "function") {
    return { kind: "fallback", reason: "this runtime has no Web Workers" };
  }
  let url: string | undefined;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    url = URL.createObjectURL(new Blob([ARGON2_WORKER_SOURCE], { type: "text/javascript" }));
    const started = new Worker(url);
    worker = started;
    return await new Promise<Argon2WorkerResponse>((resolve) => {
      started.onmessage = (event: MessageEvent<Argon2WorkerResponse>) => {
        resolve(event.data);
      };
      started.onerror = (event: ErrorEvent) => {
        resolve({ kind: "fallback", reason: `the Argon2id worker failed: ${event.message || "no message"}` });
      };
      started.onmessageerror = () => {
        resolve({ kind: "fallback", reason: "the Argon2id worker's answer could not be read" });
      };
      timer = setTimeout(() => {
        resolve({ kind: "fallback", reason: "the Argon2id worker did not answer" });
      }, WORKER_TIMEOUT_MS);
      started.postMessage(input);
    });
  } catch (error) {
    return { kind: "fallback", reason: `the Argon2id worker did not start: ${describe(error)}` };
  } finally {
    clearTimeout(timer);
    worker?.terminate();
    if (url !== undefined) URL.revokeObjectURL(url);
  }
}
