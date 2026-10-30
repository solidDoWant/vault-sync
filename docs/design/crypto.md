# E2EE cipher suite 2

For: developers and agents. You know the architecture (`docs/dev/architecture.md`) and `SPEC.md`. This page fixes the byte formats.

The end-to-end encryption of `SPEC.md` §9.3 has two implementations. The Go one is in `internal/e2ee` (`golang.org/x/crypto`, the standard library and `filippo.io/age`). The TypeScript one is in `plugin/src/core/e2ee` (`@noble/ciphers`, `@noble/hashes`, `@noble/post-quantum` and `age-encryption`, the TypeScript age implementation built on the same `@noble` packages). Both must pass every vector in `testdata/crypto/vectors.json`. The vectors are the contract, and this page explains them.

Suite 2 replaced suite 1, whose key wrapping was a classic X25519 sealed box. Every key wrapping is hybrid post-quantum (ML-KEM-768 + X25519, `docs/design/encryption.md` *Suite 2*). Contents, paths and passphrase wrapping use XChaCha20-Poly1305 and Argon2id. This page also fixes key slots, key commitments, the associated data of contents and paths, invitation keys and the signed membership log. The rest of key management (storing epochs and slots, rotation, recovery) is in `docs/design/encryption.md`.

## Principles

- **Suite version byte.** Every symmetric ciphertext and passphrase-wrapped secret starts with one byte naming its cipher suite. This document defines suite `0x02`. A reader refuses any other value, suite 1's `0x01` included, so a later suite can change any algorithm or layout without a reader misinterpreting it. Hybrid-wrapped values (key slots) are age files, which name their own version in their first line (`age-encryption.org/v1`) and their recipient type in their stanza (`mlkem768x25519`); a reader refuses any other version or recipient type.
- **Everything before the ciphertext is authenticated.** The AEAD associated data of every symmetric format is its whole header (suite byte included) followed by the caller's associated data (`aad`). Changing any header byte, the suite byte or the `aad` makes the open fail. The nonce is authenticated by the AEAD itself. An age file authenticates its header with the header MAC and its payload with the STREAM tags.
- **Fail closed, without detail.** Every open that does not succeed (unknown suite or age version, input too short or too long, truncated or wrong tag, changed `aad` or header, Argon2id parameters out of bounds, another recipient type) fails with one error (`ErrDecrypt` in Go, `DecryptError` in TypeScript) that does not say which check failed.
- **Randomness** comes from the platform CSPRNG only: `crypto/rand` in Go, `crypto.getRandomValues` (through `@noble/ciphers`' `randomBytes`) in TypeScript. Nonces are 24 random bytes, so random nonces are safe for any realistic number of messages under one key.

All integers are big-endian. `||` is concatenation. Symmetric keys and sub-keys are 32 bytes.

## Sub-keys

`subkey(epoch_key, label) = HKDF-SHA256(ikm = epoch_key, salt = empty, info = "vault-sync/v1/subkey/" || label, length = 32)`

for `label` one of `content`, `path`, `path_key_secret` (ASCII). Any other label is refused. The epoch key is uniformly random, so no salt is needed.

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

Each vault has a 32-byte random epoch key per epoch (`SPEC.md` §9.3). A **key slot** is the epoch key wrapped with the hybrid wrapping above to one recipient: a member (`recipient_kind = user`), a pending invitation (`recipient_kind = invitation`, Invitation keys) or the deployment's escrow key (`recipient_kind = escrow`, §9.4). The slot's payload binds the vault, the epoch and the recipient, so a slot cannot be passed off as another vault's, another epoch's or another recipient's:

```
slot_ad    = "vault-sync/v1/key-slot" || vault_id (16) || epoch (u64) || recipient_kind (u8) || len(recipient_id) (u8) || recipient_id
key_slot   = seal_to(recipient_pub, plaintext = epoch_key (32) || slot_ad)
commitment = HMAC-SHA256(key = epoch_key, "vault-sync/v1/key-commitment" || vault_id (16) || epoch (u64))
```

- The labels are ASCII, without a terminator (both have a fixed length).
- `vault_id` is the 16 bytes of the vault's UUID, which callers give in canonical lowercase form (`0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e`). Any other spelling is refused before anything is sealed, opened or computed, so a slot has exactly one encoding.
- `epoch` is an unsigned 64-bit integer. TypeScript accepts epochs up to `Number.MAX_SAFE_INTEGER` (2^53 − 1).
- `recipient_kind` is `0x01` for `user`, `0x02` for `escrow` and `0x03` for `invitation`. No other value is defined.
- `recipient_id` is the 16 bytes of the member's user id (a canonical lowercase UUID) for `user`, and of the invitation's id for `invitation`. For `escrow` it is the UTF-8 bytes of the escrow key's id, 1 to 255 bytes. `SPEC.md` §9.4 defines that id. The one-byte length prefix keeps the encoding unambiguous for both.

Opening a slot (`OpenKeySlot` / `openKeySlot`) opens the age file and fails with `ErrDecrypt` / `DecryptError` unless the payload is exactly 32 bytes followed by this slot's `slot_ad` (compared in constant time), so it refuses any other vault, epoch, recipient kind or recipient id, and a key of any other size. A user slot is about 1750 bytes; an escrow slot with a 255-byte id stays under the 2048-byte bound.

**Recovery with `age`.** An escrow slot is a standard age file, so the operator recovers an epoch key without vault-sync: `age --decrypt --identity escrow.key slot.age | head -c 32`, with `escrow.key` holding the escrow identity (`AGE-SECRET-KEY-PQ-1…`). The bytes after the first 32 are the slot's `slot_ad`. A Go test runs the `age` command (a `tool` of the module) on an escrow slot.

Every epoch stores its **key commitment**. A recipient that unwraps an epoch key checks it against the commitment (`VerifyKeyCommitment` / `verifyKeyCommitment`, a constant-time comparison that refuses with `ErrKeyCommitment` / `KeyCommitmentError`) before using it. Anyone who knows a recipient's public key can seal a key to it, so the wrapping alone proves nothing about the key. The commitment is stored once, when the epoch is created, and every recipient checks against it. So a slot with any other key (from the server, or from a member who wraps a different key for a new member) is refused, and all members of an epoch get the same key. This check alone does not stop a server that replaces the commitment together with the slots. The commitment is an HMAC under the epoch key, so it reveals nothing about the key, and it binds the vault and the epoch.

## Identity keys, the membership log and signed epochs

These implement *Protection against an active server* in `docs/design/encryption.md`. Signatures are Ed25519 (RFC 8032) through `@noble/curves` and Go `crypto/ed25519`. Every signed message is a labelled, length-prefixed byte string. `lp(x)` is `len(x)` as u32 followed by `x`, and `uuid` is the 16 bytes of a canonical lowercase UUID.

```
user_secret        = kem_seed (32) || sign_seed (32)         # the secret the passphrase wraps
bundle             = "vault-sync/v1/bundle" || uuid(user_id) || sign_pub (32) || kem_pub (1216)
fingerprint        = SHA-256("vault-sync/v1/fingerprint" || sign_pub || kem_pub)   # shown as its first 20 bytes in Crockford base32, groups of 4

entry_body         = "vault-sync/v1/log-entry" || uuid(vault_id) || seq (u64) || prev_hash (32) || type (u8) || lp(payload)
entry_hash         = SHA-256(entry_body)                      # prev_hash of genesis (seq 1) is 32 zero bytes
entry_sig          = Ed25519(signer_sign_key, entry_body)

epoch_body         = "vault-sync/v1/epoch" || uuid(vault_id) || epoch (u64) || commitment (32) || prev_commitment (32)
                     || log_seq (u64) || log_hash (32) || count (u16) || recipients
recipient          = kind (u8) || lp(recipient_id) || SHA-256(recipient_public_key)   # sorted by kind, then recipient_id
epoch_sig          = Ed25519(owner_sign_key, epoch_body)      # prev_commitment of epoch 1 is 32 zero bytes
# A device accepts epoch E+1's record only if its log_seq >= epoch E's log_seq, and the current epoch's
# log_seq >= the seq of the last remove-member entry in the verified log.

invite_sign_seed   = HKDF-SHA256(ikm = secret, salt = uuid(vault_id), info = "vault-sync/v1/invitation-sign" || uuid(invitation_id), length = 32)
invite_mac_key     = HKDF-SHA256(ikm = secret, salt = uuid(vault_id), info = "vault-sync/v1/invite-anchor" || uuid(invitation_id), length = 32)
invite_anchor      = genesis_hash (32) || inviter_fingerprint (32) || HMAC-SHA256(invite_mac_key, "vault-sync/v1/invite-anchor" || uuid(vault_id) || uuid(invitation_id) || genesis_hash || inviter_fingerprint)

anchor_key         = HKDF-SHA256(ikm = kem_seed, salt = empty, info = "vault-sync/v1/anchors", length = 32)
anchor_list        = 0x02 || nonce || XChaCha20-Poly1305(anchor_key, nonce, list, ad = 0x02 || "vault-sync/v1/anchors" || uuid(user_id) || version (u64))
list               = count (u32) || (uuid(vault_id) || genesis_hash (32))*

escrow_bundle      = "vault-sync/v1/escrow" || escrow_sign_pub (32) || lp(age_recipient_string)
escrow_rotation    = "vault-sync/v1/escrow-rotation" || SHA-256(old escrow_bundle) || new escrow_bundle, signed by the old escrow_sign_key
escrow_fingerprint = SHA-256("vault-sync/v1/escrow-fingerprint" || escrow_bundle)   # shown like fingerprint: first 20 bytes, Crockford base32, groups of 4
```

Entry types and payloads:

| type | Entry | Payload | Signed by |
|---|---|---|---|
| 0x01 | genesis | `bundle` of the creator, then `0x00` or `0x01 || escrow_bundle` | the creator |
| 0x02 | invite | `uuid(invitation_id)` · role (u8) · `invite_sign_pub` (32) · `invitation_kem_pub` (1216) | an owner |
| 0x03 | revoke invitation | `uuid(invitation_id)` | an owner |
| 0x04 | redeem | `uuid(invitation_id)` · newcomer `bundle` | the invitation key **and** the newcomer (two signatures) |
| 0x05 | remove member | `uuid(user_id)` | an owner |
| 0x06 | leave | `uuid(user_id)` | that member |
| 0x07 | set role | `uuid(user_id)` · role (u8) | an owner |
| 0x08 | escrow | `0x00` (off) or `0x01 || escrow_bundle` (on) | an owner |
| 0x09 | members (conversion) | `converted_at_seq (u64)` · `count (u16)` · (`bundle` · role (u8))* of every member except the creator | the genesis creator |
| 0x0A | escrow reset | `SHA-256(lastEscrow escrow_bundle)` (32) · new `escrow_bundle` | an owner |

The invitation's KEM public key is in the log so that every owner device wraps new epochs to it from the verified log, and verifiers check its recipient hash. Because the server sees that public key, the invitation anchor is authenticated with a MAC under a key derived from `<secret>`, which the server never learns, not by sealing. The redeemer checks the MAC in constant time before trusting the genesis hash.

The replay refuses, as an out-of-order entry: an invite whose invitation id was already used; a redeem or revoke of an invitation that is not pending; a redeem by a user who is already a member; a remove, set-role or leave of a non-member; and any entry that leaves the vault with no owner.

**The escrow chain.** A chain is the root bundle followed by `EscrowRotationStatement`s. A signed rotation is `escrow_rotation` above, with `reset = false`. A reset point is (`old_bundle_hash`, `new_bundle`, `reset = true`) with an empty `signature`. Nothing signs or hashes a reset point, so no labelled bytes are defined for it. The rules for checking a chain (one linked sequence from the root, no repeated bundles, the pin, which paths are chained) are in `encryption.md`, *The escrow chain*.

**`lastEscrow`.** Replay keeps `lastEscrow`: the escrow bundle that the log named last, in genesis, a `0x08` "on" or a `0x0A`. It stays while escrow is off. The replay rules for an *escrow reset* entry (`0x0A`) are in `encryption.md`, *Adoption in a vault*. An *escrow* entry (`0x08`) that turns escrow on, or moves it to a new key, needs a bundle that is `lastEscrow` or that signed rotations alone lead to from `lastEscrow`, so it never crosses a reset point.

A *members* entry (`0x09`) is valid only at sequence number 2, directly after genesis, and only once. Every converted vault has one, even with zero other members, and a vault without one was created encrypted. It names the members the vault already had, and `converted_at_seq`: the vault's last change sequence number before the conversion, which the converting device synced to. The server applies the conversion only if its head change sequence number still equals `converted_at_seq`, as a compare-and-set under the vault row lock. Replay adds each listed member with its role and keys, and refuses a listed user who is the creator or appears twice.

Roles are `0x01` owner, `0x02` editor and `0x03` viewer. An invitation is pending from its invite entry until its redeem or revoke entry. Expiry is enforced by the server, and an owner device appends a revoke entry for an invitation it sees has expired. Recipient kinds and ids are those of the key slots. The escrow recipient's public key is its age recipient string as bytes. Both implementations pass shared vectors for every format above, including rejected inputs: a wrong signer, a broken link, a reordered or omitted recipient, an unsigned rotation, an unchained escrow key, and an escrow reset entry from a non-owner or naming a bundle other than `lastEscrow`.

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

`seed` is the private key of the invitation's MLKEM768-X25519 key pair (Hybrid wrapping), derived by the library's key generation from a seed (`InvitationKeyPair` / `invitationKeyPair`). `secret` is the decoded `<secret>` of the invitation code. For an encrypted vault, the inviting device generates the code's `<id>` and `<secret>`: 128 random bits each, base64url without padding. It sends the server only `SHA-256(<id>)`. A plaintext vault keeps the code that the server generates. Its public key is the `invitation_kem_pub` of the invite entry, and owner devices seal each epoch key to it in a key slot with `recipient_kind = invitation` and `recipient_id` the invitation's id. Opening that slot refuses any other vault, epoch, recipient kind or invitation, like every key slot.

## path_key and blob_id

- `path_key_secret` is `subkey(epoch_1_key, "path_key_secret")` for the vault's whole life, whatever the current epoch.
- `path_key = HMAC-SHA256(path_key_secret, UTF-8(normalize(path)))`, with `normalize` the plaintext `path_key` normalization of `SPEC.md` §5 (`internal/pathkey`, `plugin/src/core/pathkey`), so paths differing only in case or Unicode normalization share a `path_key`.
- `blob_id = SHA-256(sealed content)`, the hash of the ciphertext the server stores, so the server verifies every encrypted blob's id at `CommitBlob` exactly as it does in plaintext vaults. A resumed upload with different bytes, or two uploads spliced together, fails that check and is refused. Each sealing uses a fresh random nonce, so the same plaintext gets a different `blob_id` every time it is sealed. There is no dedup across sealings or devices, and two devices never share a blob id.

`path_key` and `blob_id` are each the raw 32 bytes.

## Passphrase wrapping (user private key)

```
header    = 0x02 || memory (u32, KiB) || iterations (u32) || parallelism (u8) || salt (16)
stretched = Argon2id(password = UTF-8(NFC(passphrase)), salt, t = iterations, m = memory, p = parallelism, length = 32)
wrap_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/wrap", length = 32)
auth_key  = HKDF-SHA256(ikm = stretched, salt = empty, info = "vault-sync/v1/passphrase/auth", length = 32)
wrapped   = header || nonce (24) || XChaCha20-Poly1305(wrap_key, nonce, secret, ad = header || aad)
```

The parameters travel with the ciphertext, so they can be raised later without a new suite. The header is not secret. To unlock, a device gets the parameters and salt from `GetUserKeyParams` (the server stores them with the wrapped key) and derives both keys with one Argon2id run. `ParsePassphraseHeader` / `parsePassphraseHeader` read the same values from a wrapped key. The device presents `auth_key` to get the wrapped key, and opens it with `wrap_key` (`UnwrapWithKey` / `unwrapWithKey`).

A passphrase can contain only code points assigned in Unicode 15.0, the same rule as names (`engine.md` §6). Any other code point is refused when the passphrase is set or used, in both languages, and so is an empty passphrase. No deployment held older keys when this rule came, so nothing migrated. The library normalizes it to NFC (`golang.org/x/text/unicode/norm`, `String.prototype.normalize`). Unicode's normalization stability policy makes the result the same on every runtime for assigned characters, so the same characters derive the same key on any device. The `passphrase` vectors include a decomposed and precomposed pair, and a refused unassigned code point.

Parameters are bounded on wrap and on unwrap; unwrap refuses out-of-bounds parameters **before** deriving, so a hostile stored value cannot make a device allocate or compute without limit, and a downgrade below the minimum is refused:

| Parameter | Minimum | Default | Maximum |
|---|---|---|---|
| memory (KiB) | 19456 (19 MiB, OWASP minimum) | 65536 (64 MiB) | 131072 (128 MiB) |
| iterations | 2 | 3 | 8 |
| parallelism | 1 | 1 | 4 |

### Key separation and the server-checked verifier

`wrap_key` and `auth_key` are two HKDF-SHA256 expansions of one Argon2id output under different `info` labels. HKDF outputs under distinct labels are independent pseudorandom keys. Knowing `auth_key` reveals nothing about `wrap_key` or `stretched`, because recovering either needs an inversion of HMAC-SHA256. So the server, which learns `auth_key`, cannot open the wrapped private key. `wrap_key` never leaves the device.

The server stores `SHA-256(auth_key)`. It returns the wrapped private key only to its owner, and only for the matching `auth_key`, compared in constant time and never logged. PostgreSQL counts failed attempts per user, so every replica sees the same count. After too many failures in a window, the server refuses every attempt with a retry time until the window ends, even one with the correct `auth_key`. `SPEC.md` §9.3 specifies the server side (`UserKeyService`: 10 failures per user per hour). The threat model:

- **A stolen OIDC session** can only guess online, one guess per request, under the per-user rate limit. It cannot download the wrapped key for an offline attack.
- **A dump of the database or of S3** holds the wrapped key, its header and `SHA-256(auth_key)`. Checking a guess against either still costs one Argon2id derivation, because both come from the same Argon2id output. The verifier adds no shortcut, so the offline attack costs what it would without a verifier.
- **Lockout.** A stolen session can lock the real user out by failing on purpose. That attacker already acts as the user. The lockout lasts at most one window and is never permanent.

### Non-blocking derivation

In TypeScript, `derivePassphraseKeys`, `wrapWithPassphrase` and `unwrapWithPassphrase` return promises. Neither implementation (below) holds Obsidian's UI thread for more than a few milliseconds at a time. The WebAssembly one runs in a Web Worker. The pure-JavaScript fallback, `@noble/hashes`' `argon2idAsync`, runs on the UI thread but yields to the event loop after every 10 ms of work. So a derivation that takes seconds on a phone never freezes the UI. The Go implementation has no UI and derives synchronously.

### WebAssembly

The plugin derives Argon2id with `hash-wasm`'s WebAssembly Argon2id (MIT; scalar WebAssembly, since `hash-wasm` does not use SIMD yet) in a Web Worker, and with `@noble/hashes`' pure-JavaScript `argon2idAsync` on the UI thread otherwise (`plugin/src/core/e2ee/argon2.ts`).

- **The worker.** The build bundles `plugin/src/core/e2ee/argon2-worker-entry.ts` (`hash-wasm` and nothing else that computes) into one script (`plugin/scripts/argon2-worker.ts`) and inlines it into `main.js` as `ARGON2_WORKER_SOURCE`. Each derivation starts a worker from a Blob URL of the script, posts the parameters, and terminates the worker after the answer, which releases its 64 MiB.
- **Self-test.** Before every derivation, the worker computes a known answer with `hash-wasm`: Argon2id(t = 2, m = 64 KiB, p = 1) of a fixed password and salt, with the answer from Go's `golang.org/x/crypto/argon2`. It runs on the same path as the real derivation, and catches engine bugs such as wrong WebAssembly results in some WebKit versions.
- **Fallback.** That derivation and every later one in the session use `@noble/hashes` in these cases: no worker is bundled (unit tests), the runtime has no Web Workers or Blob URLs, the worker does not start, fails or does not answer, or the self-test fails. The `[P4-15]` e2e test logs which implementation ran and why.
- **Tests.** `argon2.test.ts` runs both implementations on every `passphrase` vector and on random small parameters, and requires the same output. Node has no Web Workers, so it tests the self-test and each fallback with an in-process stand-in for the worker. The real worker runs in the `[P4-15]` e2e test on desktop and in the Android emulator job.

The default is the second recommended setting of RFC 9106 §4 (64 MiB, 3 passes) with one lane. The plugin derives in one JavaScript thread, where more lanes only add sequential work.

### Measurements

Derivation time of one Argon2id key on Node 24, one core of an AMD EPYC (Turin) VM, best of three, with `hash-wasm` (what the plugin runs on desktop and Android) and the pure-JavaScript fallback (`@noble/hashes`):

| Parameters | WebAssembly (`hash-wasm`) | Pure JavaScript | Process RSS after (WebAssembly) |
|---|---|---|---|
| 19 MiB, t = 2 (minimum) | 31 ms | 150 ms | 122 MiB |
| 64 MiB, t = 3 (default) | 175 ms | 680 ms | 133 MiB |
| 128 MiB, t = 8 (maximum) | 835 ms | 3.7 s | 197 MiB |

The `[P4-15]` e2e test (`plugin/test/e2e/specs/encryption.e2e.ts`) times an unlock at the default parameters inside Obsidian. It requires the WebAssembly implementation and a time under 5 seconds. It also runs in the Android emulator job, and logs the time and, if WebAssembly did not run, the reason.

Nobody measured a real low-end Android device yet, because the development VM has none. The WebView of a low-end ARM phone is typically 5 to 10 times slower than the VM. That puts the default at roughly 1 to 2 seconds on WebAssembly (3.5 to 7 seconds in pure JavaScript) and 64 MiB of memory. A device derives once, when it first unwraps the user's private key, so this is acceptable. The maximum keeps a hostile value well under a minute. Before E2EE ships, a measurement on a real low-end Android device must replace these estimates (section 11 of the Android release checklist, `docs/testing/android.md`). If the default is too slow there, it can be lowered within the bounds without a new suite, because each wrapped key stores its parameters.

## Vectors

`testdata/crypto/vectors.json` holds:

- `standards`: published known-answer tests for the primitives (RFC 5869 HKDF-SHA256, draft-irtf-cfrg-xchacha XChaCha20-Poly1305, RFC 7748 X25519). They pin both languages to the standards, not only to each other.
- `subkeys`, `aead`, `path_key`, `blob_id`, `passphrase` and `key_commitment`: suite 2 outputs from fixed inputs. The vectors fix the nonce and the salt, which are random in real use. Each implementation must produce exactly these bytes and open them.
- `hybrid` and `key_slot`: age files sealed to key pairs from fixed seeds. age draws its own randomness, so the Go generator seals them under a deterministic random source (`testing/cryptotest.SetGlobalRandom`). Each implementation must derive the given public key and age strings from the seed, and open each file to the given payload.
- `identity_keys`: bundles, fingerprints, anchor keys and lists, invitation keys and anchors, escrow bundles and chains, a membership log with every entry type and the state after each entry, a converted vault's log, and signed epoch records. Ed25519 is deterministic, so each implementation must produce exactly the given signatures.
- `rejected`, `rejected_key_slots`, `rejected_key_commitments` and the `rejected_*` lists in `identity_keys`: inputs that both implementations must refuse. Each one breaks one rule of this page, for example another suite byte, a flipped bit, another recipient, a broken log link or an escrow chain that crosses a reset point. The `name` of each vector says which rule it breaks.

A Go test generates the file (`go test ./internal/e2ee -run TestSharedVectorsAreCurrent -update`), and fails when the committed file differs from its output. If an upgrade of `filippo.io/age` draws its randomness in another order, the `hybrid` and `key_slot` bytes change, and the same command regenerates them. The TypeScript side opens whatever the file holds. So a format change changes the vectors, and the TypeScript tests fail until the TypeScript implementation matches.
