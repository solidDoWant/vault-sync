# E2EE cipher suite 2

This document fixes the byte formats of the end-to-end encryption primitives of `SPEC.md` §9.3. They are implemented twice, in `internal/e2ee` (Go, `golang.org/x/crypto`, the standard library and `filippo.io/age`) and `plugin/src/core/e2ee` (TypeScript, `@noble/ciphers`, `@noble/hashes`, `@noble/post-quantum` and `age-encryption`, the TypeScript age implementation, which is built on the same `@noble` packages), and both must pass every vector in `testdata/crypto/vectors.json`. Suite 2 replaces suite 1, whose key wrapping was a classic X25519 sealed box: every key wrapping is now hybrid post-quantum (ML-KEM-768 + X25519, `docs/design/encryption.md` *Suite 2*), and contents, paths and passphrase wrapping keep XChaCha20-Poly1305 and Argon2id. The key-slot and key-commitment formats of vault key epochs are fixed here too (Key slots and key commitments). The associated data of contents and paths, and invitation keys, are fixed here too. The rest of key management (storing epochs and slots, rotation, recovery) is in `docs/design/encryption.md`.

## Principles

- **Suite version byte.** Every symmetric ciphertext and passphrase-wrapped secret starts with one byte naming its cipher suite. This document defines suite `0x02`. A reader refuses any other value, suite 1's `0x01` included, so a later suite can change any algorithm or layout without a reader misinterpreting it. Hybrid-wrapped values (key slots) are age files, which name their own version in their first line (`age-encryption.org/v1`) and their recipient type in their stanza (`mlkem768x25519`); a reader refuses any other version or recipient type.
- **Everything before the ciphertext is authenticated.** The AEAD associated data of every symmetric format is its whole header (suite byte included) followed by the caller's associated data (`aad`). Changing any header byte, the suite byte or the `aad` makes the open fail. The nonce is authenticated by the AEAD itself. An age file authenticates its header with the header MAC and its payload with the STREAM tags.
- **Fail closed, without detail.** Every open that does not succeed (unknown suite or age version, input too short or too long, truncated or wrong tag, changed `aad` or header, Argon2id parameters out of bounds, another recipient type) fails with one error (`ErrDecrypt` in Go, `DecryptError` in TypeScript) that does not say which check failed.
- **Randomness** comes from the platform CSPRNG only: `crypto/rand` in Go, `crypto.getRandomValues` (through `@noble/ciphers`' `randomBytes`) in TypeScript. Nonces are 24 random bytes, so random nonces are safe for any realistic number of messages under one key.

All integers are big-endian. `||` is concatenation. Symmetric keys and sub-keys are 32 bytes.

## Sub-keys

`subkey(epoch_key, label) = HKDF-SHA256(ikm = epoch_key, salt = empty, info = "vault-sync/v1/subkey/" || label, length = 32)`

for `label` one of `content`, `path`, `path_key_secret`, `blob_id_secret` (ASCII). Any other label is refused. The epoch key is uniformly random, so no salt is needed.

## Symmetric encryption (content, paths)

```
sealed = 0x02 || nonce (24) || XChaCha20-Poly1305(key, nonce, plaintext, ad = 0x02 || aad)
```

The output is `1 + 24 + len(plaintext) + 16` bytes.

## Hybrid wrapping (key slots)

Every key wrapping uses age's hybrid post-quantum recipient type `mlkem768x25519` ([age v1 format](https://age-encryption.org/v1), `filippo.io/age` v1.3 and later, `age-encryption` 0.3 and later), so a recipient's private key is a standard age identity:

- **Private key:** 32 random bytes, the seed of an MLKEM768-X25519 key pair (the HPKE KEM of draft-ietf-hpke-pq, combining ML-KEM-768 of FIPS 203 with X25519). As an age identity it is the Bech32 encoding under `AGE-SECRET-KEY-PQ-`, upper-cased (`AGE-SECRET-KEY-PQ-1…`).
- **Public key:** 1216 bytes, the ML-KEM-768 encapsulation key (1184 bytes) followed by the X25519 public key (32 bytes), both derived from the seed. As an age recipient it is the Bech32 encoding under `age1pq` (`age1pq1…`), without Bech32's 90-character limit.
- **Sealing:** `seal_to(recipient_pub, plaintext)` is a binary (not armored) age file encrypted to that one recipient: the header `age-encryption.org/v1`, one stanza `-> mlkem768x25519 <encapsulated key>` whose body is age's 16-byte file key sealed through HPKE (label `age-encryption.org/mlkem768x25519`), the header MAC, then the payload (a 16-byte nonce and the plaintext in age's STREAM chunks of ChaCha20-Poly1305). The file key, the encapsulation and the payload nonce are random, so sealing the same plaintext twice gives different files.
- **Opening:** `open_from(recipient, sealed)` refuses an input of 0 bytes or more than 2048 bytes before parsing it, and any file that age refuses with the identity (another version, a stanza of another type such as a classic X25519 one, a changed header or MAC, another recipient, a truncated or changed payload).

The KEM derives its shared secret from both the ML-KEM-768 and the X25519 shared secrets, so the wrapping stays secret as long as either of them holds.

## Key slots and key commitments

Each vault has a 32-byte random epoch key per epoch (`SPEC.md` §9.3). A **key slot** is the epoch key wrapped with the hybrid wrapping above to one recipient: a member (`recipient_kind = user`) or the deployment's escrow key (`recipient_kind = escrow`, §9.4). The slot's payload binds the vault, the epoch and the recipient, so a slot cannot be passed off as another vault's, another epoch's or another recipient's:

```
slot_ad    = "vault-sync/v1/key-slot" || vault_id (16) || epoch (u64) || recipient_kind (u8) || len(recipient_id) (u8) || recipient_id
key_slot   = seal_to(recipient_pub, plaintext = epoch_key (32) || slot_ad)
commitment = HMAC-SHA256(key = epoch_key, "vault-sync/v1/key-commitment" || vault_id (16) || epoch (u64))
```

- The labels are ASCII, without a terminator (both have a fixed length).
- `vault_id` is the 16 bytes of the vault's UUID, which callers give in canonical lowercase form (`0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e`). Any other spelling is refused before anything is sealed, opened or computed, so a slot has exactly one encoding.
- `epoch` is an unsigned 64-bit integer. TypeScript accepts epochs up to `Number.MAX_SAFE_INTEGER` (2^53 − 1).
- `recipient_kind` is `0x01` for `user`, `0x02` for `escrow` and `0x03` for `invitation`. No other value is defined.
- `recipient_id` is the 16 bytes of the member's user id (a canonical lowercase UUID) for `user`, and of the invitation's id for `invitation`. For `escrow` it is the UTF-8 bytes of the escrow key's id, 1 to 255 bytes. #40 defines that id. The one-byte length prefix keeps the encoding unambiguous for both.

Opening a slot (`OpenKeySlot` / `openKeySlot`) opens the age file and fails with `ErrDecrypt` / `DecryptError` unless the payload is exactly 32 bytes followed by this slot's `slot_ad` (compared in constant time), so it refuses any other vault, epoch, recipient kind or recipient id, and a key of any other size. A user slot is about 1750 bytes; an escrow slot with a 255-byte id stays under the 2048-byte bound.

**Recovery with `age`.** An escrow slot is a standard age file, so the operator recovers an epoch key without vault-sync: `age --decrypt --identity escrow.key slot.age | head -c 32`, with `escrow.key` holding the escrow identity (`AGE-SECRET-KEY-PQ-1…`). The bytes after the first 32 are the slot's `slot_ad`. A Go test runs the `age` command (a `tool` of the module) on an escrow slot.

Every epoch stores its **key commitment**. A recipient that unwraps an epoch key checks it against the commitment (`VerifyKeyCommitment` / `verifyKeyCommitment`, a constant-time comparison that refuses with `ErrKeyCommitment` / `KeyCommitmentError`) before using it. The wrapping only proves that someone sealed this key to the recipient, and anyone who knows the recipient's public key can do that. The commitment ties the key to the epoch: every recipient checks against the same commitment, stored once when the epoch is created, so a slot that holds any other key (sealed by the server, or by a member who wraps a different key for a new member) is refused, and all members of an epoch end up with the same key. This check alone does not stop a server that replaces an epoch's commitment together with its slots. The commitment is an HMAC under the epoch key itself, so it reveals nothing about the key. It binds the vault and the epoch, so one epoch's commitment cannot be reused for another.

## Associated data of contents and paths

```
path_aad    = "vault-sync/v1/path"    || vault_id (16) || document_id (16) || epoch (u64)
content_aad = "vault-sync/v1/content" || vault_id (16) || epoch (u64)
```

A path is sealed with `subkey(epoch_key, "path")` and `path_aad`, content with `subkey(epoch_key, "content")` and `content_aad`, where `epoch` is the revision's epoch. The labels are ASCII without a terminator; ids are the 16 bytes of canonical lowercase UUIDs.

## Invitation keys

```
seed = HKDF-SHA256(ikm = secret (16), salt = vault_id (16), info = "vault-sync/v1/invitation-key" || invitation_id (16), length = 32)
```

`seed` is the private key of the invitation's MLKEM768-X25519 key pair (Hybrid wrapping), derived by the library's key generation from a seed. `secret` is the decoded `<secret>` of the invitation code.

## path_key and blob_id

- `path_key_secret` is `subkey(epoch_1_key, "path_key_secret")` for the vault's whole life, whatever the current epoch. `blob_id_secret` is `subkey(epoch_key, "blob_id_secret")` of the revision's epoch.
- `path_key = HMAC-SHA256(path_key_secret, UTF-8(normalize(path)))`, with `normalize` the plaintext `path_key` normalization of `SPEC.md` §5 (`internal/pathkey`, `plugin/src/core/pathkey`), so paths differing only in case or Unicode normalization share a `path_key`.
- `blob_id = HMAC-SHA256(blob_id_secret, plaintext)`.

Both are the raw 32 bytes; how they travel on the wire is part of key management.

## Passphrase wrapping (user private key)

```
header    = 0x02 || memory (u32, KiB) || iterations (u32) || parallelism (u8) || salt (16)
stretched = Argon2id(password = UTF-8(NFC(passphrase)), salt, t = iterations, m = memory, p = parallelism, length = 32)
wrap_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/wrap", length = 32)
auth_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/auth", length = 32)
wrapped   = header || nonce (24) || XChaCha20-Poly1305(wrap_key, nonce, secret, ad = header || aad)
```

The parameters travel with the ciphertext so that they can be raised later without a new suite. The header is not secret. A device that unlocks gets the parameters and salt before the wrapped key is released, from `GetUserKeyParams` (the server stores them alongside the wrapped key), and derives both keys with one Argon2id run; `ParsePassphraseHeader` / `parsePassphraseHeader` read the same values from a wrapped key. It then presents `auth_key` to have the wrapped key released and opens it with `wrap_key` (`UnwrapWithKey` / `unwrapWithKey`). The passphrase may contain only code points assigned in Unicode 15.0; any other is refused when it is set or used. It is NFC-normalized by the library (`golang.org/x/text/unicode/norm`, `String.prototype.normalize`). Unicode's normalization stability policy makes the result identical on every runtime for assigned characters, so the same characters typed on any device derive the same key. The `passphrase` vectors include a decomposed and precomposed pair, and a refused unassigned code point. An empty passphrase is refused.

Parameters are bounded on wrap and on unwrap; unwrap refuses out-of-bounds parameters **before** deriving, so a hostile stored value cannot make a device allocate or compute without limit, and a downgrade below the minimum is refused:

| Parameter | Minimum | Default | Maximum |
|---|---|---|---|
| memory (KiB) | 19456 (19 MiB, OWASP minimum) | 65536 (64 MiB) | 131072 (128 MiB) |
| iterations | 2 | 3 | 8 |
| parallelism | 1 | 1 | 4 |

### Key separation and the server-checked verifier

`wrap_key` and `auth_key` are two HKDF-SHA256 expansions of one Argon2id output under different `info` labels. HKDF's outputs under distinct labels are independent pseudorandom keys, so knowing `auth_key` reveals nothing about `wrap_key` or about `stretched`. Recovering either requires inverting HMAC-SHA256. So the server, which learns `auth_key`, cannot open the wrapped private key. `wrap_key` never leaves the device.

The server stores `SHA-256(auth_key)` and returns the wrapped private key only to its owner, and only when the owner presents the matching `auth_key`. The comparison is constant-time, and `auth_key` is never logged. Failed attempts are counted per user in PostgreSQL, so every replica sees the same count. After too many failures in a window, every attempt is refused with a retry time until the window ends, including an attempt with the correct `auth_key`. The server side (`UserKeyService`: 10 failures per user per hour) is specified in `SPEC.md` §9.3. The threat model:

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

Not yet measured on a real low-end Android device (no device in the development VM; Android checks are in `docs/testing/android.md`). Pure-JavaScript integer code on a low-end ARM phone's WebView typically runs 5 to 10 times slower than this, which puts the default at roughly 3.5 to 7 seconds and 64 MiB of memory. The derivation runs once per device, when it first unwraps the user's private key, so this is tolerable; the maximum bounds a hostile value to well under a minute. The derivation yields to the event loop as it runs (see Non-blocking derivation). These estimates must be replaced by a measurement on a real low-end Android device before E2EE ships (section 11 of the Android release checklist, `docs/testing/android.md`); if the default turns out too slow there, it can be lowered within the bounds without a new suite, since the parameters are stored with each wrapped key.

## Vectors

`testdata/crypto/vectors.json` holds:

- `standards`: published known-answer tests for the primitives (RFC 5869 HKDF-SHA256, draft-irtf-cfrg-xchacha XChaCha20-Poly1305, RFC 7748 X25519), so both languages are pinned to the standards and not only to each other;
- `subkeys`, `aead`, `path_key`, `blob_id`, `passphrase` (with each vector's `wrap_key` and `auth_key`) and `key_commitment`: suite 2 outputs from fixed inputs (the vectors fix the nonce and salt, which are random in real use); each implementation must produce exactly these bytes and open them;
- `hybrid` (with each key pair's age identity and recipient strings) and `key_slot` (with each slot's `ad`): age files sealed to key pairs from fixed seeds. age draws the file key, encapsulation and payload nonce itself and takes no fixed randomness, so the Go generator seals them under a deterministic random source (`testing/cryptotest.SetGlobalRandom`); each implementation must derive exactly the given public key and age strings from the seed and open the files to exactly the given payload;
- `rejected`: ciphertexts both implementations must refuse — other suite bytes, suite 1's included (authenticated as if the byte were valid, so only the suite check refuses them), changed `aad`, truncated or removed tags, flipped header, nonce and tag bits, a wrong passphrase, a wrapped key sealed under `auth_key` instead of `wrap_key`, Argon2id parameters outside the bounds, and age files of another version or stanza type, with a flipped encapsulated-key, MAC, nonce, payload or tag bit, truncated, to another recipient, to a classic X25519 recipient, and one byte over the 2048-byte bound;
- `rejected_key_slots`: key slots opened as another slot (other vault, epoch, recipient kind, recipient id or recipient key), files to the recipient whose payload holds a key of the wrong size, the epoch key alone, associated data without the key-slot label, with a trailing byte, or before the key; `rejected_key_commitments`: commitments checked against another key, vault or epoch, or truncated, extended or flipped. Both implementations must refuse every one.

The Go test generates the file: `go test ./internal/e2ee -run TestSharedVectorsAreCurrent -update`, and fails when the committed file differs from what it generates. An upgrade of `filippo.io/age` that draws its randomness in another order changes the `hybrid` and `key_slot` bytes, which the same command regenerates; the TypeScript side opens whatever the file holds. A format change therefore changes the vectors, and the TypeScript tests then fail until the TypeScript implementation matches.
