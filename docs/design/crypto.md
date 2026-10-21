# E2EE cipher suite 1

This document fixes the byte formats of the end-to-end encryption primitives of `SPEC.md` §9.3. They are implemented twice, in `internal/e2ee` (Go, `golang.org/x/crypto` and the standard library) and `plugin/src/core/e2ee` (TypeScript, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`), and both must pass every vector in `testdata/crypto/vectors.json`. Key management (epochs, key slots, recovery, which associated data each use binds) is built on top of these primitives and is not described here.

## Principles

- **Suite version byte.** Every ciphertext starts with one byte naming its cipher suite. This document defines suite `0x01`. A reader refuses any other value, so a later suite can change any algorithm or layout without a reader misinterpreting it.
- **Everything before the ciphertext is authenticated.** The AEAD associated data of every format is its whole header (suite byte included) followed by the caller's associated data (`aad`). Changing any header byte, the suite byte or the `aad` makes the open fail. The nonce is authenticated by the AEAD itself.
- **Fail closed, without detail.** Every open that does not succeed (unknown suite, input too short, truncated or wrong tag, changed `aad` or header, Argon2id parameters out of bounds, low-order ephemeral key) fails with one error (`ErrDecrypt` in Go, `DecryptError` in TypeScript) that does not say which check failed.
- **Randomness** comes from the platform CSPRNG only: `crypto/rand` in Go, `crypto.getRandomValues` (through `@noble/ciphers`' `randomBytes`) in TypeScript. Nonces are 24 random bytes, so random nonces are safe for any realistic number of messages under one key.

All integers are big-endian. `||` is concatenation. Keys, sub-keys and X25519 keys are 32 bytes.

## Sub-keys

`subkey(epoch_key, label) = HKDF-SHA256(ikm = epoch_key, salt = empty, info = "vault-sync/v1/subkey/" || label, length = 32)`

for `label` one of `content`, `path`, `path_key_secret`, `blob_id_secret` (ASCII). Any other label is refused. The epoch key is uniformly random, so no salt is needed.

## Symmetric encryption (content, paths)

```
sealed = 0x01 || nonce (24) || XChaCha20-Poly1305(key, nonce, plaintext, ad = 0x01 || aad)
```

The output is `1 + 24 + len(plaintext) + 16` bytes.

## Sealed box (key slots)

Encrypts to an X25519 public key, for wrapping an epoch key to a member or to the escrow key:

```
eph       = 32 random bytes (X25519 private key), eph_pub = X25519(eph, 9)
shared    = X25519(eph, recipient_pub)          -- refused if all zero (low-order key)
key       = HKDF-SHA256(ikm = shared, salt = eph_pub || recipient_pub, info = "vault-sync/v1/sealed-box", 32)
header    = 0x01 || eph_pub
sealed    = header || nonce (24) || XChaCha20-Poly1305(key, nonce, plaintext, ad = header || aad)
```

The recipient computes `shared = X25519(recipient, eph_pub)`. Salting with both public keys binds the key to this pair, so a box cannot be re-addressed.

## path_key and blob_id

- `path_key = HMAC-SHA256(path_key_secret, UTF-8(normalize(path)))`, with `normalize` the plaintext `path_key` normalization of `SPEC.md` §5 (`internal/pathkey`, `plugin/src/core/pathkey`), so paths differing only in case or Unicode normalization share a `path_key`.
- `blob_id = HMAC-SHA256(blob_id_secret, plaintext)`.

Both are the raw 32 bytes; how they travel on the wire is part of key management.

## Passphrase wrapping (user private key)

```
header    = 0x01 || memory (u32, KiB) || iterations (u32) || parallelism (u8) || salt (16)
stretched = Argon2id(password = UTF-8(NFC(passphrase)), salt, t = iterations, m = memory, p = parallelism, length = 32)
wrap_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/wrap", length = 32)
auth_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/auth", length = 32)
wrapped   = header || nonce (24) || XChaCha20-Poly1305(wrap_key, nonce, secret, ad = header || aad)
```

The parameters travel with the ciphertext so that they can be raised later without a new suite. The header is not secret. A device that unlocks reads the parameters and salt from it (`ParsePassphraseHeader` / `parsePassphraseHeader`) and derives both keys with one Argon2id run. It then presents `auth_key` to have the wrapped key released and opens it with `wrap_key` (`UnwrapWithKey` / `unwrapWithKey`). The passphrase is NFC-normalized with the pinned Unicode 17.0.0 tables of the `path_key` normalization (`pathkey.NFC` in Go, `nfc` in `plugin/src/core/pathkey/normalize.ts`), never the runtime's, so that the same characters typed on any device derive the same key whatever Unicode version the device has. The `passphrase` vectors include a pair that differs only by a Unicode 17 combining mark's effect on composition. An empty passphrase is refused.

Parameters are bounded on wrap and on unwrap; unwrap refuses out-of-bounds parameters **before** deriving, so a hostile stored value cannot make a device allocate or compute without limit, and a downgrade below the minimum is refused:

| Parameter | Minimum | Default | Maximum |
|---|---|---|---|
| memory (KiB) | 19456 (19 MiB, OWASP minimum) | 65536 (64 MiB) | 131072 (128 MiB) |
| iterations | 2 | 3 | 8 |
| parallelism | 1 | 1 | 4 |

### Key separation and the server-checked verifier

`wrap_key` and `auth_key` are two HKDF-SHA256 expansions of one Argon2id output under different `info` labels. HKDF's outputs under distinct labels are independent pseudorandom keys, so knowing `auth_key` reveals nothing about `wrap_key` or about `stretched`. Recovering either requires inverting HMAC-SHA256. So the server, which learns `auth_key`, cannot open the wrapped private key. `wrap_key` never leaves the device.

The server stores `SHA-256(auth_key)` and returns the wrapped private key only to its owner, and only when the owner presents the matching `auth_key`. The comparison is constant-time, and `auth_key` is never logged. Failed attempts are counted per user in PostgreSQL, so every replica sees the same count. After too many failures in a window, every attempt is refused with a retry time until the window ends, including an attempt with the correct `auth_key`. The server side is specified with its storage, not here. The threat model:

- **A stolen OIDC session** can only guess online, one guess per request, under the per-user rate limit. It cannot download the wrapped key for an offline attack.
- **A dump of the database or of S3** holds the wrapped key, its header and `SHA-256(auth_key)`. Checking a guess against either still costs one Argon2id derivation, because both come from the same Argon2id output. The verifier adds no shortcut, so the offline attack costs what it would without a verifier.
- **Lockout.** A stolen session can lock the real user out by failing on purpose. That attacker already acts as the user. The lockout lasts at most one window and is never permanent.

### Non-blocking derivation

In TypeScript, `derivePassphraseKeys`, `wrapWithPassphrase` and `unwrapWithPassphrase` return promises. They derive with `@noble/hashes`' `argon2idAsync`, which hands control back to the event loop after every 10 ms of work. A derivation that takes seconds on a phone (see Measurements) therefore never holds Obsidian's UI thread for more than a few milliseconds at a time. The derivation runs no faster, and its memory is the same. The Go implementation has no UI and derives synchronously.

The default is RFC 9106 §4's second recommended setting (64 MiB, 3 passes) with one lane, since the plugin derives in a single JavaScript thread and more lanes would only add sequential work there.

### Measurements

Derivation time of one Argon2id key with `@noble/hashes` (pure JavaScript, the implementation the plugin runs on desktop and Android) on Node 24, one core of an AMD EPYC (Turin) VM, best of three:

| Parameters | Time | Process RSS after |
|---|---|---|
| 19 MiB, t = 2 (minimum) | 150 ms | 105 MiB |
| 64 MiB, t = 3 (default) | 680 ms | 153 MiB |
| 128 MiB, t = 8 (maximum) | 3.7 s | 217 MiB |

Not yet measured on a real low-end Android device (no device in the development VM; Android checks are in `docs/testing/android.md`). Pure-JavaScript integer code on a low-end ARM phone's WebView typically runs 5 to 10 times slower than this, which puts the default at roughly 3.5 to 7 seconds and 64 MiB of memory. The derivation runs once per device, when it first unwraps the user's private key, so this is tolerable; the maximum bounds a hostile value to well under a minute. The derivation yields to the event loop as it runs (see Non-blocking derivation). These estimates must be replaced by a measurement on a real low-end Android device before E2EE ships (the key-management flow adds it to the Android release checklist, `docs/testing/android.md`); if the default turns out too slow there, it can be lowered within the bounds without a new suite, since the parameters are stored with each wrapped key.

## Vectors

`testdata/crypto/vectors.json` holds:

- `standards`: published known-answer tests for the primitives (RFC 5869 HKDF-SHA256, draft-irtf-cfrg-xchacha XChaCha20-Poly1305, RFC 7748 X25519), so both languages are pinned to the standards and not only to each other;
- `subkeys`, `aead`, `sealed_box`, `path_key`, `blob_id`, `passphrase` (with each vector's `wrap_key` and `auth_key`): suite 1 outputs from fixed inputs (the vectors fix the nonce, ephemeral key and salt, which are random in real use); each implementation must produce exactly these bytes and open them;
- `rejected`: ciphertexts both implementations must refuse — other suite bytes (authenticated as if the byte were valid, so only the suite check refuses them), changed `aad`, truncated or removed tags, flipped header, nonce and tag bits, a low-order ephemeral key, a wrong passphrase, a wrapped key sealed under `auth_key` instead of `wrap_key`, and Argon2id parameters outside the bounds.

The Go test generates the file: `go test ./internal/e2ee -run TestSharedVectorsAreCurrent -update`, and fails when the committed file differs from what it generates. A format change therefore changes the vectors, and the TypeScript tests then fail until the TypeScript implementation matches.
