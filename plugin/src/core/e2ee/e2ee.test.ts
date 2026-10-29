import { bytesToHex } from "@noble/hashes/utils.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ARGON2_BOUNDS,
  DecryptError,
  derivePassphraseKeys,
  deriveSubkey,
  generateKey,
  KEY_SIZE,
  NONCE_SIZE,
  open,
  parsePassphraseHeader,
  pathKey,
  SALT_SIZE,
  seal,
  SUITE_V2,
  type SubkeyLabel,
  TAG_SIZE,
  unwrapWithKey,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from "./e2ee";

const encoder = new TextEncoder();

// Argon2id derivations take a few hundred milliseconds each; shared CI
// runners can be several times slower than a quiet machine.
const ARGON2_TIMEOUT = { timeout: 60_000 };

interface Construction {
  name: string;
  headerSize: number;
  /** The header and nonce bytes to flip; all of them if absent. */
  flipped?: number[];
  seal(aad: Uint8Array): Uint8Array | Promise<Uint8Array>;
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Asserts that `attempt` throws or rejects with a DecryptError. */
async function expectDecryptError(attempt: () => Uint8Array | Promise<Uint8Array>, message?: string): Promise<void> {
  await expect((async () => attempt())(), message).rejects.toThrow(DecryptError);
}

function constructions(): Construction[] {
  const key = generateKey();
  const passphrase = "correct horse battery staple";
  // The minimum parameters keep the many derivations below cheap.
  const params = { memory: ARGON2_BOUNDS.minMemory, iterations: ARGON2_BOUNDS.minIterations, parallelism: 1 };
  const plaintext = encoder.encode("k");
  return [
    {
      name: "aead",
      headerSize: 1,
      seal: (aad) => seal(key, plaintext, aad),
      open: (sealed, aad) => open(key, sealed, aad),
    },
    {
      name: "passphrase",
      headerSize: 1 + 4 + 4 + 1 + SALT_SIZE,
      // Every flip that passes the bounds costs a derivation, so one byte of
      // each field: version, memory, iterations, parallelism, salt, nonce.
      flipped: [0, 4, 8, 9, 10, 25, 26, 49],
      seal: async (aad) => (await wrapWithPassphrase(passphrase, plaintext, aad, params)).wrapped,
      open: (sealed, aad) => unwrapWithPassphrase(passphrase, sealed, aad),
    },
  ];
}

describe("seal and open", () => {
  it("opens only with its key and associated data", () => {
    const key = generateKey();
    const plaintext = encoder.encode("# Note\n");
    const aad = encoder.encode("document 1, epoch 1");
    const sealed = seal(key, plaintext, aad);
    expect(sealed[0]).toBe(SUITE_V2);
    expect(sealed.length).toBe(1 + NONCE_SIZE + plaintext.length + TAG_SIZE);
    expect(open(key, sealed, aad)).toEqual(plaintext);
    expect(() => open(generateKey(), sealed, aad)).toThrow(DecryptError);
    expect(() => open(key, sealed, encoder.encode("document 2, epoch 1"))).toThrow(DecryptError);
  });
});

describe("opening fails closed", ARGON2_TIMEOUT, () => {
  for (const construction of constructions()) {
    describe(construction.name, () => {
      const aad = encoder.encode("vault 1, epoch 3");
      let sealed: Uint8Array = new Uint8Array(0);
      beforeAll(async () => {
        sealed = await construction.seal(aad);
      }, ARGON2_TIMEOUT.timeout);

      it("opens the untouched ciphertext", async () => {
        expect((await construction.open(sealed, aad)).length).toBe(1);
      });

      it("refuses an unknown suite version", async () => {
        for (const version of [0x00, 0x01, 0x03, 0x80, 0xff]) {
          const tampered = sealed.slice();
          tampered[0] = version;
          await expectDecryptError(() => construction.open(tampered, aad));
        }
      });

      it("refuses modified associated data", async () => {
        for (const other of [new Uint8Array(0), encoder.encode("vault 1, epoch 4"), Uint8Array.of(...aad, 0)]) {
          await expectDecryptError(() => construction.open(sealed, other));
        }
      });

      it("refuses every truncation", async () => {
        for (let length = 0; length < sealed.length; length++) {
          await expectDecryptError(() => construction.open(sealed.subarray(0, length), aad), `length ${String(length)}`);
        }
      });

      it("refuses any flipped header, nonce or tag bit", async () => {
        const positions = [sealed.length - 1, sealed.length - TAG_SIZE];
        for (let index = 0; index < construction.headerSize + NONCE_SIZE; index++) {
          if (construction.flipped === undefined || construction.flipped.includes(index)) {
            positions.push(index);
          }
        }
        for (const index of positions) {
          const tampered = sealed.slice();
          tampered[index] = (tampered[index] ?? 0) ^ 0x01;
          await expectDecryptError(() => construction.open(tampered, aad), `byte ${String(index)}`);
        }
      });
    });
  }
});

// Each test seals hundreds to 100,000 messages: seconds of work on a loaded machine.
describe("randomness", ARGON2_TIMEOUT, () => {
  it("draws a fresh nonce for every seal", () => {
    const samples = 100_000;
    const key = generateKey();
    const empty = new Uint8Array(0);
    const nonces = new Set<string>();
    for (let index = 0; index < samples; index++) {
      const nonce = bytesToHex(seal(key, empty, empty).subarray(1, 1 + NONCE_SIZE));
      expect(nonces.has(nonce)).toBe(false);
      nonces.add(nonce);
    }
    expect(nonces.size).toBe(samples);
  });
});

describe("wrapWithPassphrase", ARGON2_TIMEOUT, () => {
  // The minimum parameters keep the derivations cheap.
  const minimum = { memory: ARGON2_BOUNDS.minMemory, iterations: ARGON2_BOUNDS.minIterations, parallelism: 1 };

  it("uses the default parameters and a fresh salt", async () => {
    const secret = encoder.encode("secret");
    const empty = new Uint8Array(0);
    const first = await wrapWithPassphrase("passphrase", secret, empty);
    const second = await wrapWithPassphrase("passphrase", secret, empty);
    // memory 65536 KiB, 3 iterations, 1 lane.
    expect(Array.from(first.wrapped.subarray(0, 10))).toEqual([SUITE_V2, 0, 1, 0, 0, 0, 0, 0, 3, 1]);
    expect(bytesToHex(first.wrapped.subarray(10, 10 + SALT_SIZE))).not.toBe(bytesToHex(second.wrapped.subarray(10, 10 + SALT_SIZE)));
    expect(bytesToHex(first.authKey)).not.toBe(bytesToHex(second.authKey));
    expect(await unwrapWithPassphrase("passphrase", first.wrapped, empty)).toEqual(secret);
    await expect(wrapWithPassphrase("", secret, empty)).rejects.toThrow();
  });

  it("refuses parameters outside the bounds", async () => {
    const secret = encoder.encode("secret");
    const empty = new Uint8Array(0);
    for (const params of [
      { memory: ARGON2_BOUNDS.maxMemory + 1, iterations: 2, parallelism: 1 },
      { memory: ARGON2_BOUNDS.minMemory, iterations: 1, parallelism: 1 },
      { memory: ARGON2_BOUNDS.minMemory, iterations: 2, parallelism: 0 },
      { memory: ARGON2_BOUNDS.minMemory + 0.5, iterations: 2, parallelism: 1 },
    ]) {
      await expect(wrapWithPassphrase("passphrase", secret, empty, params), JSON.stringify(params)).rejects.toThrow(/out of bounds/);
    }
  });

  // An unlock derives once: it reads the parameters and salt, derives both
  // keys, presents the auth key to the server and opens the wrapped secret
  // with the wrap key. The auth key, which the server sees, opens nothing.
  it("returns an auth key that does not open the wrapped secret", async () => {
    const secret = encoder.encode("user private key");
    const aad = encoder.encode("user 1");
    const { wrapped, authKey } = await wrapWithPassphrase("passphrase", secret, aad, minimum);
    expect(authKey.length).toBe(KEY_SIZE);

    const { params, salt } = parsePassphraseHeader(wrapped.subarray(0, 1 + 4 + 4 + 1 + SALT_SIZE));
    expect(params).toEqual(minimum);
    const keys = await derivePassphraseKeys("passphrase", params, salt);
    expect(bytesToHex(keys.authKey)).toBe(bytesToHex(authKey));
    expect(bytesToHex(keys.wrapKey)).not.toBe(bytesToHex(keys.authKey));
    expect(unwrapWithKey(keys.wrapKey, wrapped, aad)).toEqual(secret);
    expect(() => unwrapWithKey(keys.authKey, wrapped, aad)).toThrow(DecryptError);
    expect(bytesToHex(wrapped)).not.toContain(bytesToHex(authKey));
  });

  it("refuses a bad header before deriving", () => {
    const header = Uint8Array.of(SUITE_V2, 0, 0, 0x4c, 0, 0, 0, 0, 2, 1, ...new Uint8Array(SALT_SIZE));
    expect(parsePassphraseHeader(header).params).toEqual(minimum);
    expect(() => parsePassphraseHeader(header.subarray(0, header.length - 1))).toThrow(DecryptError);
    expect(() => parsePassphraseHeader(Uint8Array.of(0x01, ...header.subarray(1)))).toThrow(DecryptError);
    expect(() => parsePassphraseHeader(Uint8Array.of(...header.subarray(0, 9), 0, ...header.subarray(10)))).toThrow(DecryptError);
  });

  it("refuses an empty passphrase or a wrong-sized salt", async () => {
    const salt = new Uint8Array(SALT_SIZE);
    await expect(derivePassphraseKeys("", minimum, salt)).rejects.toThrow();
    await expect(derivePassphraseKeys("passphrase", minimum, salt.subarray(1))).rejects.toThrow();
  });
});

// The derivation takes from a few hundred milliseconds to seconds on a phone;
// it must not hold the UI thread for all of it (#657). A timer queued before
// the call fires only if the derivation hands control back to the event loop
// before it completes.
describe("passphrase derivation does not block the event loop", ARGON2_TIMEOUT, () => {
  const minimum = { memory: ARGON2_BOUNDS.minMemory, iterations: ARGON2_BOUNDS.minIterations, parallelism: 1 };

  async function yieldsBeforeCompleting(run: () => Promise<unknown>): Promise<boolean> {
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    try {
      await run();
      return ticked;
    } finally {
      clearTimeout(timer);
    }
  }

  it("yields while unlocking", async () => {
    const { wrapped } = await wrapWithPassphrase("passphrase", encoder.encode("secret"), new Uint8Array(0), minimum);
    expect(await yieldsBeforeCompleting(() => unwrapWithPassphrase("passphrase", wrapped, new Uint8Array(0)))).toBe(true);
  });

  it("yields while creating the wrapped key", async () => {
    expect(await yieldsBeforeCompleting(() => wrapWithPassphrase("passphrase", encoder.encode("secret"), new Uint8Array(0), minimum))).toBe(true);
  });
});

describe("deriveSubkey", () => {
  const epochKey = new Uint8Array(KEY_SIZE).fill(7);

  it("derives a different key for every label", () => {
    const labels: SubkeyLabel[] = ["content", "path", "path_key_secret", "blob_id_secret"];
    const subkeys = new Set(labels.map((label) => bytesToHex(deriveSubkey(epochKey, label))));
    expect(subkeys.size).toBe(labels.length);
  });

  it("refuses an unknown label or a wrong-sized epoch key", () => {
    expect(() => deriveSubkey(epochKey, "contents" as SubkeyLabel)).toThrow();
    expect(() => deriveSubkey(epochKey.subarray(0, 31), "content")).toThrow();
    expect(() => deriveSubkey(new Uint8Array(33), "content")).toThrow();
  });
});

describe("pathKey", () => {
  it("ignores case and normalization", () => {
    const secret = generateKey();
    const lower = pathKey(secret, "notes/café.md");
    expect(pathKey(secret, "Notes/CAFÉ.md")).toEqual(lower);
    expect(pathKey(generateKey(), "notes/café.md")).not.toEqual(lower);
  });
});
