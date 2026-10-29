import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import shared from "../../../../testdata/crypto/vectors.json";
import { nfc } from "../pathkey/normalize";
import { argon2Implementation, argon2idJavaScript, argon2idWebAssembly } from "./argon2";

const encoder = new TextEncoder();

function firstPassphraseVector(): (typeof shared.passphrase)[number] {
  const [vector] = shared.passphrase;
  if (vector === undefined) throw new Error("no passphrase vectors");
  return vector;
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
describe("Argon2id on WebAssembly", { timeout: 120_000 }, () => {
  it("passes its self-test in this runtime", async () => {
    // Without it, derivations would use the pure-JavaScript implementation
    // and the comparisons below would be all that tests WebAssembly.
    expect(await argon2Implementation()).toEqual({ kind: "webassembly" });
  });

  for (const vector of shared.passphrase) {
    it(`derives the same key as the pure-JavaScript implementation: ${vector.name}`, async () => {
      const input = {
        password: encoder.encode(nfc(vector.passphrase)),
        salt: hexToBytes(vector.salt),
        memory: vector.memory,
        iterations: vector.iterations,
        parallelism: vector.parallelism,
        length: 32,
      };
      const webAssembly = await argon2idWebAssembly(input);
      expect(bytesToHex(webAssembly)).toBe(bytesToHex(await argon2idJavaScript(input)));
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
});

describe("Argon2id when WebAssembly fails its self-test", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.doUnmock("hash-wasm");
    vi.resetModules();
  });

  it("derives with the pure-JavaScript implementation when the WebAssembly answer is wrong", async () => {
    vi.resetModules();
    const calls: number[] = [];
    vi.doMock("hash-wasm", () => ({
      argon2id: (options: { memorySize: number; hashLength: number }) => {
        calls.push(options.memorySize);
        return Promise.resolve(new Uint8Array(options.hashLength).fill(1));
      },
    }));
    const argon2 = await import("./argon2");
    expect(await argon2.argon2Implementation()).toEqual({ kind: "javascript", reason: "the WebAssembly Argon2id gave a wrong known answer" });
    const vector = firstPassphraseVector();
    expect(await deriveFirstVector(await import("./e2ee"))).toEqual({ wrapKey: vector.wrap_key, authKey: vector.auth_key });
    // Only the self-test ran on WebAssembly.
    expect(calls).toEqual([64]);
  });

  it("derives with the pure-JavaScript implementation when WebAssembly does not run", async () => {
    vi.resetModules();
    vi.doMock("hash-wasm", () => ({
      argon2id: () => Promise.reject(new Error("WebAssembly is not available")),
    }));
    const argon2 = await import("./argon2");
    expect(await argon2.argon2Implementation()).toEqual({ kind: "javascript", reason: "the WebAssembly Argon2id did not run: WebAssembly is not available" });
    const vector = firstPassphraseVector();
    expect(await deriveFirstVector(await import("./e2ee"))).toEqual({ wrapKey: vector.wrap_key, authKey: vector.auth_key });
  });
});

describe("passphrase derivation when WebAssembly passes its self-test", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.doUnmock("@noble/hashes/argon2.js");
    vi.resetModules();
  });

  it("does not run the pure-JavaScript implementation", async () => {
    vi.resetModules();
    vi.doMock("@noble/hashes/argon2.js", () => ({
      argon2idAsync: () => Promise.reject(new Error("pure-JavaScript Argon2id called")),
    }));
    const vector = firstPassphraseVector();
    expect(await deriveFirstVector(await import("./e2ee"))).toEqual({ wrapKey: vector.wrap_key, authKey: vector.auth_key });
  });
});
