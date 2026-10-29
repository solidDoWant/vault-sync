# Encryption design (Phase 4)

Status: approved by the owner on 2026-10-29. It adds to `SPEC.md` §9.3–§9.4, and wherever they disagree it wins. Byte formats are in `docs/design/crypto.md`. Agents implement this design and do not change it; questions go to the operator.

## Model

- **Users.** Each user has one key pair and one recovery passphrase. Argon2id wraps the private key. The server stores it wrapped and releases it only to a device that proves it knows the passphrase. Unlocking once on a device opens every encrypted vault the user belongs to.
- **Vaults (envelope encryption).** Each vault has one symmetric key per **epoch**. Contents and paths are encrypted once, under the current epoch key. Each recipient gets a **slot**: the epoch key wrapped to that recipient's public key. The recipients are:
  - every member;
  - every pending invitation;
  - the deployment's escrow key, if escrow is on for the vault.
- **Path keys and blob ids** are HMACs. The server compares them without learning names or contents. Path keys use one secret for the vault's lifetime and blob ids use the revision's epoch (*Formats and rules*, below).
- **Merging happens on the device.** A device decrypts, applies `engine.md` rule M, and encrypts the result. The engine itself is unchanged.

## Suite 2: hybrid post-quantum

- **Wrapping:** every key wrapping (member slots, invitation slots, escrow slots) uses a hybrid of X25519 and ML-KEM-768 (FIPS 203).
- **Format:** where possible it uses age's hybrid recipient format, so that an escrow identity is a standard age identity. If age's TypeScript support isn't usable, the same hybrid construction is built directly on `@noble/post-quantum` and Go's `crypto/mlkem`, with a documented format.
- **Unchanged:** contents and paths stay on XChaCha20-Poly1305 with 256-bit keys.
- **No suite 1:** no encrypted vault exists yet, so suite 1 is replaced, not migrated.
- **Test vectors:** cross-language vectors in `testdata/crypto/`.

## Creating a vault

- **Choice at creation:** encryption is chosen when a vault is created. To encrypt an existing vault, use in-place conversion (below).
- **Escrow default:** the server publishes its escrow default (an environment variable, on by default) and its escrow public key in `GetServerInfo`. The plugin uses them as the default, and the owner can turn escrow off.
- **Who wraps:** the client does all wrapping, including the escrow slot. The server never sees an epoch key.

## Invitations

- **The code:** an invitation code is `<id>.<secret>`. The server sees only a hash of `<id>`. `<secret>` is 128 random bits, and the invitation key pair is derived from it.
- **At creation:** the inviting device wraps every epoch key, so the full history, to the invitation's public key. Those are the invitation's slots.
- **On redemption:** the newcomer derives the private key from the code, unwraps the epoch keys, and writes slots for its own user key. A member may only write slots for itself, and every reader verifies a slot against the epoch's key commitment. The invitation's slots are then deleted.
- **On revocation or expiry:** the invitation's slots are deleted.
- **During rotations:** pending invitations are recipients, so their slots get the new epoch key.

## Rotation

- **Starting an epoch is a compare-and-set:** "create epoch E+1, only if the current epoch is E", under the vault row lock that commits and membership changes also take. Its slots for all current recipients are written in the same step. A concurrent rotation loses the compare-and-set and adopts the winner's epoch.
- **When it happens:** removing a member rotates automatically. Owners can also rotate by hand.
- **Commits under an old epoch** get `EPOCH_NOT_CURRENT`. The device fetches the new key, re-encrypts, and retries.
- **Devices pick up new epochs at every sync,** and keep every epoch key they hold so that history stays readable.

## Re-encrypting history (re-key job)

- **What it is:** a resumable job on an owner's device. It walks every retained revision that isn't on the current epoch, re-encrypts it, and calls an owner-only `ReplaceRevisionCiphertext(revision, from_epoch, to_epoch, …)`.
- **Conditional rewrites:** the server applies a rewrite only if the revision is still at `from_epoch` and `to_epoch` is still current. A rewrite that loses is skipped. A rotation during the job makes the job restart with the newer target.
- **Retiring old keys:** epochs are retired (their slots and old ciphertext deleted) only by a conditional server step that confirms no revision still uses them.
- **Current versions:** the job never changes which revision is current, so sync is unaffected while it runs.

## Converting a plaintext vault in place

1. **Every member must have a user key.** Otherwise conversion is refused and the members without one are listed.
2. **One atomic switch:** the owner's device creates epoch 1 with all its slots, submits the HMAC path key of every live document, and flips the vault to encrypted. From then on, plaintext commits are refused.
3. **Plaintext history becomes epoch 0,** and the re-key job encrypts it. Readers treat epoch 0 as plaintext until then.

## Escrow

- **Export:** the export job holds the escrow identity. It decrypts escrowed vaults for plaintext backups, and skips and reports vaults without escrow.
- **Rotating the escrow key:** the server publishes the new escrow public key, and new epochs use it. The job re-wraps every existing escrow slot to the new key through a job-only endpoint, after checking each slot against its key commitment, including vaults deleted within the last 30 days. It repeats until no slot uses the old key, then the old identity can be destroyed.
- **Turning escrow off** for a vault rotates the key without an escrow slot. Older epochs stay escrowed until the re-key job moves their revisions to a newer epoch and retires them, so turning escrow off eventually removes escrow from all content history (epoch 1's slots stay, see *Formats and rules*).

## Formats and rules settled during implementation

Operator decisions of 2026-10-29, from the questions on #1206, #1207, #1210 and #1227 and the Phase 4 design review. Byte formats are in `crypto.md`.

**Contents and paths**
- **Associated data.** A path binds the vault, the document and the epoch. Content binds the vault and the epoch only, so two documents with equal content share one blob; a reader checks `blob_id` after decrypting. This replaces `SPEC.md` §9.3's "the revision's document id … bound as associated data" for content.
- **One epoch per revision.** A commit under epoch E references only content sealed under E. On a path-only rename, a restore from history, or a retry after `EPOCH_NOT_CURRENT`, the device recomputes `blob_id` under E and uploads the blob if the server lacks it. A reader opens a revision's content and path with that revision's epoch.
- **`path_key` across rotations.** `path_key_secret` comes from epoch 1's key for the vault's whole life, so a path has the same `path_key` before and after any rotation, and the server's uniqueness rule keeps working. Epoch 1 is therefore never retired: its slots are written for every new member and invitation like any epoch, and retirement keeps them, though the re-key job still moves its content to the current epoch. The cost: a removed member keeps `path_key_secret`, and with a later copy of the database could test guessed file names. `docs/encryption.md` says so. `blob_id_secret` follows the revision's epoch.
- **Folder rule.** In an encrypted vault the server enforces only the exact `path_key` rule. A clash between a file and a folder at the same name is resolved on the devices by `engine.md` rule C. `engine.md` principle 5 applies in full to plaintext vaults.
- **Epoch 0.** A vault created encrypted never accepts epoch 0. A converted vault accepts epoch 0 only for revisions committed before the conversion. The conversion records its change sequence number, and readers refuse a later epoch-0 revision. The re-key job covers every stored path and content: revisions, tombstones, folders and conflict copies.

**Invitations**
- **Slot.** `recipient_kind = 0x03` (invitation), `recipient_id` = the 16 bytes of the invitation's UUID. The server accepts invitation slots for pending invitations, and requires one in every new epoch for each pending invitation.
- **Key pair.** The seed is `HKDF-SHA256(ikm = secret, salt = vault_id, info = "vault-sync/v1/invitation-key" || invitation_id, length = 32)`, turned into an MLKEM768-X25519 key pair by the library's key generation from a seed.
- **Code.** For encrypted vaults the inviting device generates `<id>` and `<secret>` (128 random bits each, base64url without padding) and sends only `SHA-256(<id>)`. Plaintext vaults keep today's server-generated code.
- **Redemption takes two steps,** so a crash never leaves a member without keys: `GetInvitationSlots(id)` returns the invitation's UUID, its slots and the commitments. Then `RedeemInvitation(code, own_slots)` grants membership, stores the newcomer's slots and deletes the invitation's slots in one transaction. The newcomer creates its user key first.
- **Expiry.** An expired, revoked or used `<id>` gets `NOT_FOUND` at once. Its slots are deleted by the existing prune and purge; no new sweep.

**Escrow**
- **Every epoch of an escrowed vault has exactly one escrow slot.** Its `recipient_id` is the current escrow key id, or a retiring id listed in `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS` during an escrow rotation. The server refuses anything else. The plugin reads the escrow key for every epoch it creates and refuses to rotate an escrowed vault without one.
- **Rotation endpoint.** The job-only endpoint takes a static bearer token from a Secret mounted only into the export job, compared in constant time.
- **Re-wrapping replaces an escrow slot:** delete the old-key slot and insert the new one, only if the old one is still there. Member slots are still never replaced.

**Passphrases.** A passphrase may contain only code points assigned in Unicode 15.0, the same rule as names (`engine.md` §6). Others are refused when the passphrase is set or used, in both languages. It is NFC-normalized by the library (`golang.org/x/text`, `String.prototype.normalize`). Unicode's normalization stability policy makes this identical on every runtime for assigned characters. No deployment holds older keys, so nothing migrates.

**Keys on the device.** The unlocked user private key and the epoch keys live in Obsidian's per-device local storage (`App.saveLocalStorage`), like the refresh token. They are never in `data.json`, which sits inside the vault folder and is copied by any other sync or backup tool.

## Import

`#1199`: a client-side tool. It encrypts with the vault's current key, unwrapped through the escrow identity or the user's passphrase.

## No hand-written cryptography

Every primitive comes from an established, maintained library:
- `@noble/*` and `@noble/post-quantum` in TypeScript;
- the Go standard library and `golang.org/x/crypto` in Go;
- age, where its format is used;
- an established WebAssembly Argon2id package.

Agents never implement a cipher, hash, KDF or KEM themselves, nor hand-encode WebAssembly for one. Our code only composes library calls, in the formats `crypto.md` defines, and is checked against cross-language vectors.

## Argon2id

64 MiB of memory, 3 passes, 1 lane. It uses an established WebAssembly Argon2id library (for example `hash-wasm`), and `@noble/hashes` otherwise. A known-answer self-test at first use falls back to `@noble/hashes` if the WebAssembly result is wrong, which guards against engine bugs. The target is an unlock of about 2 seconds or less on a Snapdragon 855-class phone.

## Documentation

`docs/encryption.md` explains all of this for users and operators:
- what the server can and can't see;
- passphrases, and what is lost without escrow;
- invitations, rotation, re-encryption and conversion;
- escrow, and recovery with `age`.
