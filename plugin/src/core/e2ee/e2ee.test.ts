import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  ARGON2_BOUNDS,
  DecryptError,
  deriveSubkey,
  generateKey,
  generateKeyPair,
  KEY_SIZE,
  NONCE_SIZE,
  open,
  openFrom,
  pathKey,
  SALT_SIZE,
  seal,
  sealTo,
  SUITE_V1,
  type SubkeyLabel,
  TAG_SIZE,
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
  seal(aad: Uint8Array): Uint8Array;
  open(sealed: Uint8Array, aad: Uint8Array): Uint8Array;
}

function constructions(): Construction[] {
  const key = generateKey();
  const recipient = generateKeyPair();
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
      name: "sealed box",
      headerSize: 1 + KEY_SIZE,
      seal: (aad) => sealTo(recipient.publicKey, plaintext, aad),
      open: (sealed, aad) => openFrom(recipient.privateKey, sealed, aad),
    },
    {
      name: "passphrase",
      headerSize: 1 + 4 + 4 + 1 + SALT_SIZE,
      // Every flip that passes the bounds costs a derivation, so one byte of
      // each field: version, memory, iterations, parallelism, salt, nonce.
      flipped: [0, 4, 8, 9, 10, 25, 26, 49],
      seal: (aad) => wrapWithPassphrase(passphrase, plaintext, aad, params),
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
    expect(sealed[0]).toBe(SUITE_V1);
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
      const sealed = construction.seal(aad);

      it("opens the untouched ciphertext", () => {
        expect(construction.open(sealed, aad).length).toBe(1);
      });

      it("refuses an unknown suite version", () => {
        for (const version of [0x00, 0x02, 0x80, 0xff]) {
          const tampered = sealed.slice();
          tampered[0] = version;
          expect(() => construction.open(tampered, aad)).toThrow(DecryptError);
        }
      });

      it("refuses modified associated data", () => {
        for (const other of [new Uint8Array(0), encoder.encode("vault 1, epoch 4"), Uint8Array.of(...aad, 0)]) {
          expect(() => construction.open(sealed, other)).toThrow(DecryptError);
        }
      });

      it("refuses every truncation", () => {
        for (let length = 0; length < sealed.length; length++) {
          expect(() => construction.open(sealed.subarray(0, length), aad), `length ${String(length)}`).toThrow(DecryptError);
        }
      });

      it("refuses any flipped header, nonce or tag bit", () => {
        const positions = [sealed.length - 1, sealed.length - TAG_SIZE];
        for (let index = 0; index < construction.headerSize + NONCE_SIZE; index++) {
          if (construction.flipped === undefined || construction.flipped.includes(index)) {
            positions.push(index);
          }
        }
        for (const index of positions) {
          const tampered = sealed.slice();
          tampered[index] = (tampered[index] ?? 0) ^ 0x01;
          expect(() => construction.open(tampered, aad), `byte ${String(index)}`).toThrow(DecryptError);
        }
      });
    });
  }
});

describe("randomness", () => {
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

  it("draws a fresh ephemeral key and nonce for every sealed box", () => {
    const samples = 500;
    const { publicKey } = generateKeyPair();
    const empty = new Uint8Array(0);
    const ephemeralKeys = new Set<string>();
    const nonces = new Set<string>();
    for (let index = 0; index < samples; index++) {
      const sealed = sealTo(publicKey, empty, empty);
      ephemeralKeys.add(bytesToHex(sealed.subarray(1, 1 + KEY_SIZE)));
      nonces.add(bytesToHex(sealed.subarray(1 + KEY_SIZE, 1 + KEY_SIZE + NONCE_SIZE)));
    }
    expect(ephemeralKeys.size).toBe(samples);
    expect(nonces.size).toBe(samples);
  });
});

describe("sealTo", () => {
  it("refuses a low-order recipient key", () => {
    expect(() => sealTo(new Uint8Array(KEY_SIZE), encoder.encode("epoch key"), new Uint8Array(0))).toThrow();
  });
});

describe("wrapWithPassphrase", ARGON2_TIMEOUT, () => {
  it("uses the default parameters and a fresh salt", () => {
    const secret = encoder.encode("secret");
    const empty = new Uint8Array(0);
    const first = wrapWithPassphrase("passphrase", secret, empty);
    const second = wrapWithPassphrase("passphrase", secret, empty);
    // memory 65536 KiB, 3 iterations, 1 lane.
    expect(Array.from(first.subarray(0, 10))).toEqual([SUITE_V1, 0, 1, 0, 0, 0, 0, 0, 3, 1]);
    expect(bytesToHex(first.subarray(10, 10 + SALT_SIZE))).not.toBe(bytesToHex(second.subarray(10, 10 + SALT_SIZE)));
    expect(unwrapWithPassphrase("passphrase", first, empty)).toEqual(secret);
    expect(() => wrapWithPassphrase("", secret, empty)).toThrow();
  });

  it("refuses parameters outside the bounds", () => {
    const secret = encoder.encode("secret");
    const empty = new Uint8Array(0);
    for (const params of [
      { memory: ARGON2_BOUNDS.maxMemory + 1, iterations: 2, parallelism: 1 },
      { memory: ARGON2_BOUNDS.minMemory, iterations: 1, parallelism: 1 },
      { memory: ARGON2_BOUNDS.minMemory, iterations: 2, parallelism: 0 },
      { memory: ARGON2_BOUNDS.minMemory + 0.5, iterations: 2, parallelism: 1 },
    ]) {
      expect(() => wrapWithPassphrase("passphrase", secret, empty, params), JSON.stringify(params)).toThrow(/out of bounds/);
    }
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
