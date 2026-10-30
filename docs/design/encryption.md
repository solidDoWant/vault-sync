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

- **What it is:** a resumable job on an owner's device. It pages through every retained revision that isn't on the current epoch with an owner-only `ListStaleRevisions(vault_id, page_token)`. Tombstones, folders and conflict copies are included. For each one it re-seals the path under the target epoch and, for content, uploads the blob under that epoch's `blob_id` if the server lacks it. Then it calls an owner-only `ReplaceRevisionCiphertext(revision, from_epoch, to_epoch, sealed_path, content_ref)`. `path_key` never changes, because it comes from epoch 1.
- **Conditional rewrites:** the server applies a rewrite only if the revision is still at `from_epoch` and `to_epoch` is still current. A rewrite that loses is skipped. A rotation during the job makes the job restart with the newer target.
- **Retiring old keys:** an epoch is retired only by an owner-only conditional server step that confirms no revision still uses it. Epoch 1 is never retired. Retirement deletes the epoch's key slots, member and escrow, and nothing else of the epoch. **Its signed epoch record and commitment stay**, because every later record chains to the previous commitment, and a new device verifies the whole chain. Old content blobs are deleted by the existing unreferenced-blob cleanup, once no revision references them.
- **Content gone mid-sync:** a device whose blob download fails with `NOT_FOUND` re-reads the revision and retries once with the revision's current epoch and content reference. A re-key or retirement may have moved it in the meantime.
- **Current versions:** the job never changes which revision is current, so sync is unaffected while it runs.

## Converting a plaintext vault in place

1. **Every member must have a user key.** Otherwise conversion is refused and the members without one are listed.
2. **One atomic switch:** the owner's device creates epoch 1 with all its slots, submits the HMAC path key of every live document, and flips the vault to encrypted. From then on, plaintext commits are refused with `FAILED_PRECONDITION` and reason `VAULT_ENCRYPTED`. A device that gets it reloads the vault, unlocks its user key (prompting if it must), syncs the keys, re-encrypts the pending change and retries, as after `EPOCH_NOT_CURRENT`. Until the user unlocks, sync of that vault pauses and keeps local files.
3. **Plaintext history becomes epoch 0,** and the re-key job encrypts it. Readers treat epoch 0 as plaintext until then.

## Escrow

- **Export:** the export job holds the escrow identity. It decrypts escrowed vaults for plaintext backups, and skips and reports vaults without escrow.
- **Rotating the escrow key:** the server publishes the new escrow public key, and new epochs use it. The job re-wraps every existing escrow slot to the new key through a job-only endpoint, after checking each slot against its key commitment, including vaults deleted within the last 30 days. It repeats until no slot uses the old key, then the old identity can be destroyed.
- **Turning escrow off** for a vault rotates the key without an escrow slot. Older epochs stay escrowed until the re-key job moves their revisions to a newer epoch and retires them, so turning escrow off eventually removes escrow from all content history (epoch 1's slots stay, see *Formats and rules*).

## Protection against an active server

Owner decision of 2026-10-29: end-to-end encryption also protects against a server that is actively malicious while members use it, or an attacker who controls the running server. Such a server must not obtain an epoch key, either by adding or swapping a public key, by injecting an epoch, or by rolling one back.

It may still see metadata, withhold, delay or replay changes (devices detect key and membership rollback, not content freshness), and refuse service. Encryption still does not prove which member wrote a revision. All of this is said in `docs/encryption.md`.

The rule: **a device wraps an epoch key only to recipients, and uses an epoch key only from an epoch, that an owner signed in a log the device has verified.** It never relies on the server's word for either. Byte formats are in `crypto.md`.

- **Identity keys.** Each user's key pair gains an Ed25519 signing key (`@noble/curves`, Go `crypto/ed25519`). The user's private key, wrapped under the passphrase, holds both seeds. The user key bundle is (user id, signing public key, hybrid public key). Its **fingerprint** is shown in the member list so that people can compare keys out of band. Ed25519 is fine for now: forging a signature needs a quantum computer at the time of the attack, unlike decrypting recorded traffic. A later suite can move to ML-DSA.
- **Membership log.** Each encrypted vault has an append-only, hash-chained log. Every entry is signed:
  - *Genesis*, by the creator: the creator's bundle and the escrow key, if any.
  - *Invite* and *revoke invitation*, by an owner. An invite entry carries the invitation's role and the invitation's own signing public key, which is derived from `<secret>`.
  - *Redeem*, by the newcomer and by the invitation's signing key: the newcomer's bundle.
  - *Remove member* and *set role*, by an owner.
  - *Leave*, by the leaving member.
  - *Escrow on/off*, by an owner.

  Every membership change sends its entry in the same request (`CreateInvitation`, `RedeemInvitation`, `RemoveMember`, `LeaveVault`, role change, escrow change). The server verifies the signatures and the chain, appends with compare-and-set on the next sequence number under the vault row lock, and applies the change in the same transaction. A concurrent append loses and retries on top of the winner, just as rotation does. The server's own membership tables stay what authorization uses; the log is what devices trust.
- **Verifying the log.** A device replays the log from genesis, checking every hash link, every signature, and every signer's right to sign at that point (owners for owner entries). The member set and each member's keys come only from this replay. A device stores the highest sequence number and hash it has verified for each vault. A shorter log, or a different hash at a sequence number it has already verified, is a **hard stop**.
- **Signed epochs.** An epoch record is signed by an owner who is an owner in the log at the sequence number it names. It holds the vault, the epoch number, its commitment, the previous epoch's commitment, that log position, and the sorted recipients with their key fingerprints. The recipients must be exactly the members at that log position, the pending invitations, and the escrow key if escrow is on. A device uses an epoch key only from a verified record. It wraps keys only to recipients from the verified log, and it refuses an epoch number below the highest it has verified. `RotateEpoch` carries the signed record. The server checks it as it already checks recipients, and still applies the compare-and-set.
- **Trust anchors.** A device must know which genesis is real:
  - The creator's device knows it, because it made it.
  - A newcomer learns it from the invitation: the inviting device authenticates the genesis hash and its own fingerprint with a key derived from `<secret>`. The server cannot forge that, because it never learns `<secret>`.
  - A user's other devices read the user's **anchor list**: vault id to genesis hash, sealed under a key derived from the user's private key and stored on the server with a version number. Writes are compare-and-set on the version, and a device refuses a lower version than it has seen.
- **Escrow key.** The escrow key has its own Ed25519 signing key, held with the escrow identity. A device pins the deployment's escrow bundle when it first sees it and records it in genesis. A new escrow key is accepted only with an **escrow rotation statement** signed by the previous escrow signing key. The server publishes the chain of statements, and the export job writes the next one when the escrow key rotates. Any other change is a hard stop at vault creation and at rotation. The operator also publishes the escrow fingerprint, so an owner can compare it when creating a vault.
- **Converting a plaintext vault.** The converting owner writes genesis and then a *members* entry (`crypto.md`, type `0x09`) listing every other member's bundle and role as the server reports them then. Epoch 1's signed record names that position. The server checks that the entry lists exactly its members, roles and current keys, and applies genesis, the members entry, epoch 1 and the switch to encrypted in one transaction. Conversion is refused while the vault has pending plaintext invitations, which have no keys a slot could wrap to; the owner revokes them first, and the refusal lists them, as it lists members without a key. That moment trusts the server, like any first meeting. The plugin therefore shows every member's fingerprint and asks the owner to compare them before converting.
- **Escrow on/off entry.** Turning escrow on or off is an owner's rotation. `RotateEpoch` carries the signed *escrow* entry together with the epoch record. The record's log position is that entry, and the server appends the entry and creates the epoch in one transaction.
- **Where the escrow chain lives.** The escrow rotation statements are stored in PostgreSQL. The export job writes the next one through its job-only endpoint (bearer token) when it rotates the escrow key, and `GetServerInfo` publishes the root bundle and every statement. At startup the configured escrow recipient and signing key must equal the chain's head. With no chain yet, the configured bundle becomes its root. Any other mismatch stops the server with an error. The operator's order is: rotate with the job, then update the configuration.
- **Passphrase parameters.** A device remembers the Argon2id parameters it has seen for an account and refuses lower ones at unlock.
- **Hard stop.** On any verification failure the plugin stops syncing that vault, keeps the local files, and shows what failed: "the server sent key or membership data that doesn't verify". It never falls back to trusting the server.
- **Lost passphrase without escrow.** The user's identity is gone. An owner removes them and invites them again with a new key. There is no "replace a member's key" entry.

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

## Interaction matrix

Every state change below runs on the server under the vault row lock as a compare-and-set, or, for escrow re-wrapping, as a conditional replace of one row. Concurrent changes therefore happen in some sequential order. A device reacts to a finite set of outcomes, so this table is the complete list of interactions between encryption and sync. Each row has a test. A case missing from it is a design gap and goes to the operator.

**What a device does with each outcome.** These apply in every row below:
- **`EPOCH_NOT_CURRENT`:** sync keys, re-seal under the current epoch, recompute `blob_id` and upload if needed, then retry.
- **`VAULT_ENCRYPTED`:** reload, unlock (prompting the user if needed), sync keys, re-encrypt, then retry. Until the user unlocks, the vault pauses and its files stay.
- **`ABORTED` on a log append:** re-read the log, rebuild the entry on the new head, then retry.
- **`NOT_FOUND` on a blob:** re-read the revision, then retry once.
- **`PERMISSION_DENIED`, or `NOT_FOUND` on the vault:** the rules of `docs/design/sharing.md` apply. The device stops syncing and keeps its files.
- **A revision whose epoch key the device lacks after a key sync:** that document waits, and the device retries at the next sync. The pull applies the rest of the change list: the device records the document and its revision in the journal's `waiting` set and moves its cursor on. Every later sync reads that revision again (`GetRevision`, so a re-key since is seen) and applies it once the key is there; a later revision of the document in the change list takes its place.
- **Any verification failure:** a hard stop.

| Server change | Devices with work in flight | Test |
|---|---|---|
| Rotate (manual or escrow on/off), E → E+1 | A push or blob upload under E gets `EPOCH_NOT_CURRENT`. The orphaned blob goes to unreferenced-blob cleanup. A pull reads E+1 revisions after a key sync. A concurrent rotation loses the compare-and-set and adopts the winner. A running re-key job restarts with E+1 as its target. | P4-08 |
| Remove member | As rotate, for the other members. The removed device gets `PERMISSION_DENIED` and stops. An owner's concurrent log append gets `ABORTED`. | P4-07 |
| Leave | A log append. The rotation is marked pending, and an owner device's next sync performs it (the rotate row). | P4-07 (leave case) |
| Invite / revoke / expire | A log append. A concurrent rotation must include the pending invitation, because its recipient check sees it. A redeem racing a revoke is serialized, and the loser gets `NOT_FOUND`. | P4-05, P4-06 |
| Redeem | The newcomer's slots for every epoch land in one transaction. If a rotation came between `GetInvitationSlots` and `RedeemInvitation`, the redeem is refused. The newcomer re-reads the invitation's slots, which now include the new epoch, and retries. | P4-05 |
| Set role | A log append. A device demoted to viewer gets `PERMISSION_DENIED` on its next commit. A demoted owner's rotation or append fails the signer check, so it re-reads the log. | P3 role tests plus a demoted-signer case |
| Grant missing slots | Idempotent: an existing slot is kept. Concurrent grants converge. | P4-05 |
| Re-key rewrite of one revision | Only if the revision is still at `from_epoch` and `to_epoch` is current; otherwise skipped, and a later pass retries. Plaintext and which revision is current are unchanged, so the engine sees nothing. A device reading the old blob after cleanup re-reads and retries. | P4-09 |
| Retire an epoch (not 1, unused) | Slots deleted, record and commitment kept. No revision uses the epoch, so no read needs it. It is never current, so no commit targets it. | P4-09 |
| Convert | Plaintext commits in flight get `VAULT_ENCRYPTED`. Readers treat epoch-0 revisions from before the conversion's sequence number as plaintext and refuse later ones. The re-key job then encrypts history. | P4-10 |
| Escrow re-wrap | A conditional replace of one escrow slot. A slot written to a retiring key during the switch is caught by the repeat pass. Devices never read escrow slots. | P4-12 |
| Escrow key change | Devices follow chained statements only. Anything else is a hard stop at vault creation and at rotation. | P4-22 |
| Delete / undelete vault | Existing sharing rules. Key operations get `VAULT_DELETED`. Escrow re-wrapping still covers vaults deleted within 30 days. | P3, P4-12 |
| Another device's commit | `engine.md`'s decision table, on plaintext. Encryption only seals and opens. | P4-02 |

## Import

`#1199`: a client-side tool. It encrypts with the vault's current key, unwrapped through the escrow identity or the user's passphrase.

- **It needs two keys:** the current epoch's key and epoch 1's key, for `path_key_secret`. It signs in as a member with the `editor` or owner role.
- **Escrow slots:** `ListKeySlots` takes an optional recipient kind, and returns the vault's escrow slots to editors and owners only. An escrow slot is useless without the escrow identity.
- **Verification (active server):** the import verifies the log and the signed epoch records the way a device does, before it uses a key.
  - With the user's passphrase, it anchors through the user's anchor list.
  - With the escrow identity, it has no anchor list. The operator passes the vault's genesis hash (`--genesis`), which the plugin shows as the **vault fingerprint** in the vault's settings, and the import refuses to run without it.

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
