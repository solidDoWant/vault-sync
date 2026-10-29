/**
 * Argon2id for the passphrase wrapping: hash-wasm's WebAssembly Argon2id where
 * it loads and gives the right answer, @noble/hashes' pure-JavaScript
 * `argon2idAsync` otherwise. Both are Argon2id version 0x13 (RFC 9106) and
 * produce the same output.
 *
 * Before the first derivation, the WebAssembly implementation runs a
 * known-answer test (a small vector computed with Go's golang.org/x/crypto).
 * If it fails to load or gives another answer, every derivation of this
 * session uses @noble/hashes. That guards against JavaScript engines that
 * compile the module wrongly.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { argon2id as wasmArgon2id } from "hash-wasm";

export interface Argon2idInput {
  password: Uint8Array;
  salt: Uint8Array;
  /** Memory cost in KiB. */
  memory: number;
  /** Passes. */
  iterations: number;
  /** Lanes. */
  parallelism: number;
  /** Output length in bytes. */
  length: number;
}

/** Which implementation derives, and why WebAssembly does not when it does not. */
export type Argon2Implementation = { kind: "webassembly" } | { kind: "javascript"; reason: string };

/**
 * How long (ms) the pure-JavaScript derivation computes before it yields to
 * the event loop.
 */
const JAVASCRIPT_ASYNC_TICK_MS = 10;

const encoder = new TextEncoder();

/** The known answer: Argon2id(t = 2, m = 64 KiB, p = 1, 32 bytes) of the inputs, by golang.org/x/crypto/argon2. */
const SELF_TEST: Readonly<Argon2idInput> = Object.freeze({
  password: encoder.encode("vault-sync argon2id self-test"),
  salt: encoder.encode("self-test salt 16"),
  memory: 64,
  iterations: 2,
  parallelism: 1,
  length: 32,
});
const SELF_TEST_ANSWER = "09795e828b75172af2d0ef2c0d14447a0d7442ee9a69e8522e484399f3576eab";

/** The WebAssembly Argon2id, without the self-test. */
export async function argon2idWebAssembly(input: Argon2idInput): Promise<Uint8Array> {
  return wasmArgon2id({
    password: input.password,
    salt: input.salt,
    iterations: input.iterations,
    memorySize: input.memory,
    parallelism: input.parallelism,
    hashLength: input.length,
    outputType: "binary",
  });
}

/** The pure-JavaScript Argon2id, which yields to the event loop as it runs. */
export async function argon2idJavaScript(input: Argon2idInput): Promise<Uint8Array> {
  return argon2idAsync(input.password, input.salt, {
    m: input.memory,
    t: input.iterations,
    p: input.parallelism,
    dkLen: input.length,
    asyncTick: JAVASCRIPT_ASYNC_TICK_MS,
  });
}

let chosen: Promise<Argon2Implementation> | undefined;

/** The implementation this session derives with; runs the self-test once. */
export function argon2Implementation(): Promise<Argon2Implementation> {
  chosen ??= selfTest();
  return chosen;
}

async function selfTest(): Promise<Argon2Implementation> {
  try {
    const answer = bytesToHex(await argon2idWebAssembly(SELF_TEST));
    if (answer === SELF_TEST_ANSWER) return { kind: "webassembly" };
    return { kind: "javascript", reason: "the WebAssembly Argon2id gave a wrong known answer" };
  } catch (error) {
    return { kind: "javascript", reason: `the WebAssembly Argon2id did not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Argon2id of `input` with the implementation {@link argon2Implementation} chose. The caller validates the parameters. */
export async function argon2id(input: Argon2idInput): Promise<Uint8Array> {
  const implementation = await argon2Implementation();
  return implementation.kind === "webassembly" ? argon2idWebAssembly(input) : argon2idJavaScript(input);
}
