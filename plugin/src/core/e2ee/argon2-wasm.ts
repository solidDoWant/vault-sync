/**
 * hash-wasm's WebAssembly Argon2id and its known-answer self-test: the code
 * the Argon2id worker (./argon2-worker-entry) runs. It has no state of its own
 * and runs anywhere WebAssembly does; ./argon2 runs it in a Web Worker so that
 * the derivation never holds the UI thread.
 */
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

/** What the worker answers to an {@link Argon2idInput}. */
export type Argon2WorkerResponse = { kind: "output"; output: Uint8Array } | { kind: "fallback"; reason: string };

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

/** hash-wasm's Argon2id of `input`, without the self-test. */
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

/**
 * Runs the self-test, then derives `input`, both with hash-wasm. Answers a
 * fallback with the reason when hash-wasm does not run or gives a wrong known
 * answer: the engine's WebAssembly is then not to be trusted.
 */
export async function answerArgon2Request(input: Argon2idInput): Promise<Argon2WorkerResponse> {
  try {
    if (bytesToHex(await argon2idWebAssembly(SELF_TEST)) !== SELF_TEST_ANSWER) {
      return { kind: "fallback", reason: "the WebAssembly Argon2id gave a wrong known answer" };
    }
    return { kind: "output", output: await argon2idWebAssembly(input) };
  } catch (error) {
    return { kind: "fallback", reason: `the WebAssembly Argon2id did not run: ${describe(error)}` };
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
