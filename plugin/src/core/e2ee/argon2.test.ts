import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import shared from "../../../../testdata/crypto/vectors.json";
import { nfc } from "../pathkey/normalize";
import { answerArgon2Request, argon2idWebAssembly, type Argon2idInput, type Argon2WorkerResponse } from "./argon2-wasm";

const encoder = new TextEncoder();

function firstPassphraseVector(): (typeof shared.passphrase)[number] {
  const [vector] = shared.passphrase;
  if (vector === undefined) throw new Error("no passphrase vectors");
  return vector;
}

function vectorInput(vector: (typeof shared.passphrase)[number]): Argon2idInput {
  return {
    password: encoder.encode(nfc(vector.passphrase)),
    salt: hexToBytes(vector.salt),
    memory: vector.memory,
    iterations: vector.iterations,
    parallelism: vector.parallelism,
    length: 32,
  };
}

async function deriveFirstVector(e2ee: typeof import("./e2ee")): Promise<{ wrapKey: string; authKey: string }> {
  const vector = firstPassphraseVector();
  const keys = await e2ee.derivePassphraseKeys(
    vector.passphrase,
    { memory: vector.memory, iterations: vector.iterations, parallelism: vector.parallelism },
    hexToBytes(vector.salt),
  );
  return { wrapKey: bytesToHex(keys.wrapKey), authKey: bytesToHex(keys.authKey) };
}

// Argon2id derivations at the vectors' parameters take a few hundred
// milliseconds each; shared CI runners can be several times slower.
describe("Argon2id on hash-wasm's WebAssembly", { timeout: 120_000 }, () => {
  for (const vector of shared.passphrase) {
    it(`derives the same key as the pure-JavaScript implementation: ${vector.name}`, async () => {
      const input = vectorInput(vector);
      const webAssembly = await argon2idWebAssembly(input);
      expect(bytesToHex(webAssembly)).toBe(bytesToHex(await argon2idAsync(input.password, input.salt, { m: input.memory, t: input.iterations, p: input.parallelism, dkLen: 32 })));
      const wrapKey = hkdf(sha256, webAssembly, new Uint8Array(0), encoder.encode("vault-sync/v1/passphrase/wrap"), 32);
      const authKey = hkdf(sha256, webAssembly, new Uint8Array(0), encoder.encode("vault-sync/v1/passphrase/auth"), 32);
      expect([bytesToHex(wrapKey), bytesToHex(authKey)]).toEqual([vector.wrap_key, vector.auth_key]);
    });
  }

  it("derives the same output as the pure-JavaScript implementation for any small parameters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.uint8Array({ minLength: 8, maxLength: 32 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 4, max: 160 }),
        async (password, salt, lanes, passes, extraMemory, length) => {
          const input = { password, salt, memory: 8 * lanes + extraMemory, iterations: passes, parallelism: lanes, length };
          const javascript = await argon2idAsync(password, salt, { m: input.memory, t: passes, p: lanes, dkLen: length });
          expect(bytesToHex(await argon2idWebAssembly(input))).toBe(bytesToHex(javascript));
        },
      ),
      { numRuns: 40 },
    );
  });

  it("passes its self-test and answers the derivation", async () => {
    const vector = firstPassphraseVector();
    const input = vectorInput(vector);
    const response = await answerArgon2Request(input);
    expect(response.kind).toBe("output");
    expect(response.kind === "output" ? bytesToHex(response.output) : response.reason).toBe(bytesToHex(await argon2idWebAssembly(input)));
  });
});

describe("the worker's self-test", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.doUnmock("hash-wasm");
    vi.resetModules();
  });

  it("answers a fallback, without deriving, when hash-wasm gives a wrong known answer", async () => {
    vi.resetModules();
    const memories: number[] = [];
    vi.doMock("hash-wasm", () => ({
      argon2id: (options: { memorySize: number; hashLength: number }) => {
        memories.push(options.memorySize);
        return Promise.resolve(new Uint8Array(options.hashLength).fill(1));
      },
    }));
    const wasm = await import("./argon2-wasm");
    expect(await wasm.answerArgon2Request(vectorInput(firstPassphraseVector()))).toEqual({
      kind: "fallback",
      reason: "the WebAssembly Argon2id gave a wrong known answer",
    });
    expect(memories).toEqual([64]);
  });

  it("answers a fallback when hash-wasm does not run", async () => {
    vi.resetModules();
    vi.doMock("hash-wasm", () => ({ argon2id: () => Promise.reject(new Error("WebAssembly is not available")) }));
    const wasm = await import("./argon2-wasm");
    expect(await wasm.answerArgon2Request(vectorInput(firstPassphraseVector()))).toEqual({
      kind: "fallback",
      reason: "the WebAssembly Argon2id did not run: WebAssembly is not available",
    });
  });
});

/**
 * A Web Worker that answers in this thread, with the worker entry's handler:
 * Node has no Web Workers, and this tests what the main thread does with the
 * worker's answers. The [P4-15] e2e test runs the real worker in Obsidian.
 */
function fakeWorker(answer: (input: Argon2idInput) => Promise<Argon2WorkerResponse | "error">, started: string[]) {
  return class FakeWorker {
    onmessage: ((event: { data: Argon2WorkerResponse }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    constructor(url: string) {
      started.push(url);
    }
    postMessage(input: Argon2idInput): void {
      void answer(input).then((response) => {
        if (response === "error") this.onerror?.({ message: "worker script refused" });
        else this.onmessage?.({ data: response });
      });
    }
    terminate(): void {
      this.terminated = true;
    }
  };
}

describe("passphrase derivation", { timeout: 120_000 }, () => {
  const vector = firstPassphraseVector();
  const expected = { wrapKey: vector.wrap_key, authKey: vector.auth_key };
  let started: string[];

  beforeEach(() => {
    vi.resetModules();
    started = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@noble/hashes/argon2.js");
    vi.resetModules();
  });

  function stubWorker(answer: (input: Argon2idInput) => Promise<Argon2WorkerResponse | "error">): void {
    vi.stubGlobal("ARGON2_WORKER_SOURCE", "/* worker */");
    vi.stubGlobal("Worker", fakeWorker(answer, started));
  }

  function forbidJavaScript(): void {
    vi.doMock("@noble/hashes/argon2.js", () => ({
      argon2idAsync: () => Promise.reject(new Error("pure-JavaScript Argon2id called")),
    }));
  }

  it("runs in the worker, not in pure JavaScript, when the worker answers", async () => {
    stubWorker(answerArgon2Request);
    forbidJavaScript();
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({ kind: "webassembly" });
    expect(started).toHaveLength(1);
  });

  it("derives in pure JavaScript for the rest of the session once the worker's self-test fails", async () => {
    stubWorker(() => Promise.resolve({ kind: "fallback", reason: "the WebAssembly Argon2id gave a wrong known answer" }));
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({
      kind: "javascript",
      reason: "the WebAssembly Argon2id gave a wrong known answer",
    });
    expect(started).toHaveLength(1);
  });

  it("derives in pure JavaScript when the worker fails", async () => {
    stubWorker(() => Promise.resolve("error" as const));
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({
      kind: "javascript",
      reason: "the Argon2id worker failed: worker script refused",
    });
  });

  it("derives in pure JavaScript when the worker cannot start", async () => {
    vi.stubGlobal("ARGON2_WORKER_SOURCE", "/* worker */");
    vi.stubGlobal("Worker", function refusingWorker(): never {
      throw new Error("blob: workers are refused");
    });
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({
      kind: "javascript",
      reason: "the Argon2id worker did not start: blob: workers are refused",
    });
  });

  it("derives in pure JavaScript when no worker is bundled", async () => {
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({ kind: "javascript", reason: "the Argon2id worker is not bundled" });
  });

  it("derives in pure JavaScript when the runtime has no Web Workers", async () => {
    vi.stubGlobal("ARGON2_WORKER_SOURCE", "/* worker */");
    vi.stubGlobal("Worker", undefined);
    const e2ee = await import("./e2ee");
    expect(await deriveFirstVector(e2ee)).toEqual(expected);
    expect((await import("./argon2")).lastArgon2Implementation()).toEqual({ kind: "javascript", reason: "this runtime has no Web Workers" });
  });
});
