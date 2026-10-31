# vault-sync specification

For: developers and agents. This is the authoritative technical reference for vault-sync. It holds the principles, the contracts between components, the invariants and their reasons. It does not repeat what the code, the proto files or the tests already state: where a rule is pinned elsewhere, this document names the rule in one line and points to the file. Update it in the same change that alters any behaviour it describes. The decisions that still bind, with their reasons, are in [`docs/dev/decisions.md`](docs/dev/decisions.md), under the number of the section that holds the rule.

The project follows the conventions of [`tape-archiver`](https://github.com/solidDoWant/tape-archiver) and [`media-processor`](https://github.com/solidDoWant/media-processor): Go, Nix-reproducible builds, issue-driven development with Given/When/Then acceptance criteria, and tests first.

## 1. Purpose

vault-sync is a self-hosted replacement for Obsidian Sync. It has two halves:

- An **Obsidian community plugin** (TypeScript) that watches a vault and synchronizes it.
- A **sync server** (Go) that stores vault state in **PostgreSQL** (metadata, revisions) and an **S3-compatible object store** (file contents).

It exists because the available self-hosted option (obsidian-livesync) needs CouchDB, has a history of data-loss and reconciliation bugs, is thinly documented, and has no multi-user model. vault-sync is for a small number of users (one household or a small team) on infrastructure that the operator already runs.

## 2. Design principles

These are non-negotiable. When a trade-off comes up, resolve it in favor of the principle, not convenience. Call out any change that touches one.

1. **No acknowledged write is ever lost.** Once the server has acknowledged a revision, that content is recoverable (as the current head, in revision history, or as a conflict copy) until an explicit, retention-governed purge. Neither the client nor the server ever silently discards a user edit. Deletion is a tombstone, never an erase.
2. **One source of truth per concern.** The server's revision log is the source of truth for vault history. The local vault on disk is the source of truth for un-pushed local edits. The client keeps exactly one durable journal bridging the two. No additional replicated databases or chunk layers.
3. **Done means the owner's acceptance checklist passes.** Each phase has an owner-approved checklist of user-visible scenarios (`docs/acceptance/`), each tested automatically. Tests guard behaviour and catch regressions. They never raise the bar beyond the checklist and principle 1.
4. **Small, defensible attack surface.** The server is exposed to the internet. Keep the API small, typed, and authenticated by default; every endpoint enforces vault-level authorization; resource usage is bounded (request sizes, decompression, pagination).
5. **Operator infrastructure only.** PostgreSQL, S3-compatible storage, and OIDC. No new database types.

## 3. Target environment

The reference setup, its versions and its deployment detail are in [`docs/admin/requirements.md`](docs/admin/requirements.md). The rules that the code must meet are these:

| Concern | Rule |
|---|---|
| Server | Kubernetes. PostgreSQL 14 or newer (CloudNativePG), S3 (Ceph RGW), OIDC (Authentik). |
| Database credentials | PostgreSQL client certificates rotate. The server reads them again and never keeps them for the life of the process. |
| Request size | A WAF (Coraza, behind an Istio gateway) rejects inspected request bodies above 1 MiB. So every upload is chunked at or below a configurable size, 768 KiB by default. |
| High availability | Two or more identical replicas run behind one Service and share one PostgreSQL database and one S3 bucket. Terminating any replica, for example for node maintenance, has **no client-visible impact**. The rules that make this hold are in §12. |
| Clients | Required: Obsidian desktop on **Windows** and **macOS**, Obsidian mobile on **Android**. Linux desktop is the development and test platform. **iOS is best-effort** (not a release blocker). Take no design decision that rules it out. |
| Backups | A plaintext export of every vault (decrypted where escrow is on, §9.4) goes to a filesystem path that the operator's tape-archival tooling picks up. It replaces livesync-bridge. |

The export follows these rules:

- **No readable live document is ever left out of an export.**
- Each vault's files are in a browsable tree at `<out>/<vault-id>/<path>`.
- A document whose path that tree cannot hold goes to `<out>/<vault-id>.unplaced/<document-id>` instead. Examples are a file/folder collision such as `a` and `a/b.md`, a name the filesystem rejects such as one over 255 bytes, and an invalid or non-UTF-8 path.
- A streamed JSON Lines manifest, `<out>/<vault-id>.manifest.jsonl`, lists every live document: id, original path, kind, head revision id, size, SHA-256, status (`placed`, `unplaced` or `missing`) and where its bytes are.
- The unplaced tree and the manifest sit beside the vault's directory, never inside it. So no user file can be mistaken for them.
- The layout and the manifest are a versioned format (format 2, in the marker and in every manifest), so the Phase 6 importer can restore exactly. The format is specified in `docs/admin/backup-and-restore.md` and the `internal/export` package doc.
- A live document's bytes can be absent for one reason only: its content is missing or corrupt in S3, or, in an escrowed vault, cannot be decrypted. The manifest lists it as `missing`, and the run reports `partial`.
- History, tombstones and E2EE vaults without escrow are not exported.

## 4. Architecture

```
 Obsidian (desktop / Android)                       Kubernetes
 ┌──────────────────────────────┐    HTTPS     ┌──────────────────────────────┐
 │ plugin/src/obsidian  (adapter)│  ConnectRPC │ vault-sync-server (Go)        │
 │   vault events, editor, UI    │◄──────────►│   API (ConnectRPC, protobuf)  │
 │ plugin/src/core  (sync engine)│  WebSocket  │   realtime hub (WebSocket)    │──► PostgreSQL (CNPG)
 │   journal (IndexedDB), merge, │◄──────────►│   authz, quotas, retention     │──► S3 (Ceph RGW)
 │   crypto, protocol client     │             │                               │──► Authentik (OIDC JWKS)
 └──────────────────────────────┘             └──────────────────────────────┘
                                               ┌──────────────────────────────┐
                                               │ vault-sync export (CronJob)   │──► plaintext tree for tape
                                               │   holds escrow private key    │
                                               └──────────────────────────────┘
```

The developer overview of these components is in [`docs/dev/architecture.md`](docs/dev/architecture.md).

### `plugin/src/core`

A pure TypeScript library: the sync engine, journal, merge, crypto and protocol client. It talks to the vault through the `VaultAdapter` interface, so its tests drive it against an in-memory vault. It **must not import `obsidian`** or use Obsidian's globals. `make lint` enforces this with an eslint import fence (`plugin/eslint.config.js`, pinned by `plugin/test/core-import-fence.test.ts`) and a separate type-check of `src/core` without Obsidian's or DOM-only globals (`plugin/tsconfig.core.json` and `plugin/scripts/check-core-program.ts`, pinned by `plugin/test/core-typecheck.test.ts`). That check also refuses non-`.ts` code files, triple-slash directives, `declare global`, and imports of packages that `plugin/package.json` does not declare.

### `plugin/src/obsidian`

The thin adapter: `Vault`/`FileManager` events, editor integration, settings UI, status bar and conflict UI. Each module comment holds the detail. The Test column names the tests that cover each rule, or "none":

| Rule | Module | Test |
|---|---|---|
| `ObsidianVaultAdapter` implements `VaultAdapter` on the Vault API and passes the conformance suite in real Obsidian. Paths with a hidden segment (`.obsidian/`, `.trash/`, any `.name`), and paths that `normalizePath` would change, are outside it: never listed, read or reported, and a write or rename onto them is refused as `path-conflict`. | `plugin/src/obsidian/vault-adapter.ts` | Conformance: `plugin/test/e2e/specs/conformance.e2e.ts`. `normalizePath`: `plugin/test/e2e/specs/paths.e2e.ts`. Hidden segments: none. |
| Renames use `Vault.rename`, never `FileManager.renameFile`, so a synced rename does not rewrite links. | `plugin/src/obsidian/vault-adapter.ts` | none |
| `SyncSession` starts once the workspace layout is ready, resumes from the journal's cursor and stops in `onunload`, so re-enabling the plugin never starts a full resync. It syncs at start, 2 s after the last local change of a burst, on a realtime notice, and every 30 s. Stopping refuses every further engine call and resolves once the engine has settled, so two engines never share a journal. Unpushed edits stay on disk for the next session's full scan (principle 1). | `plugin/src/obsidian/session.ts`, `plugin/src/main.ts` | `plugin/src/obsidian/session.test.ts` |
| `SyncController` runs a session exactly while the device is signed in and the vault is connected to a server vault. It stops the session on sign-out, on "sign-in required" and before it switches vaults. | `plugin/src/obsidian/controller.ts` | `plugin/src/obsidian/controller.test.ts` |
| The device registers once per plugin install and account (server URL, issuer, the token's `sub`) and reuses the id, because the server's device limit counts every registration. The device-limit `RESOURCE_EXHAUSTED` is shown as that limit, and sync does not start. | `plugin/src/obsidian/controller.ts` | `plugin/src/obsidian/controller.test.ts`, `plugin/test/e2e/specs/devices.e2e.ts` |
| Connecting a non-empty local vault to a remote vault with revisions asks for confirmation first. Nothing is overwritten: files at the same path with different content become conflict copies (§7). End-to-end encrypted vaults cannot be connected until Phase 4. | `plugin/src/obsidian/controller.ts` | `plugin/src/obsidian/controller.test.ts` |
| A server RPC with no timeout of its own fails as `UNAVAILABLE` after 30 s, plus 1 s per 8 KiB of blob bytes it carries or asks for. `CommitBlob` gets 10 minutes instead. So a request that gets no answer shows `offline` and is retried. A request to the identity provider counts as unreachable after 30 s. | `plugin/src/core/protocol/client.ts`, `plugin/src/core/auth/oidc.ts` | `plugin/src/core/protocol/timeout.test.ts`, `plugin/src/core/auth/oidc.test.ts` |
| The status bar shows the sync state, the number of pending local changes, and the number of open conflicts (conflict copies that this device made and that still exist). | `plugin/src/obsidian/status.ts` | `plugin/src/obsidian/status.test.ts` |

### `vault-sync-server`

A single Go binary. The server **never merges content**. It orders revisions, enforces optimistic concurrency, stores bytes and fans out notifications. All merging happens on clients, which keeps the server compatible with end-to-end encryption.

### `vault-sync export`

A subcommand of the same binary. It runs as a separate Deployment or CronJob with its own credentials. The admin view is in `docs/admin/backup-and-restore.md` and `docs/admin/encryption.md`. Path safety, staging and the atomic swap are in the `internal/export` package doc. The rules are these:

- It is the only component that may hold the escrow private key.
- It only reads PostgreSQL (its sessions are `default_transaction_read_only`) and S3.
- Each vault is exported as of its `head_seq`: every live document's latest revision at or below it, byte for byte. The directory is named by vault id, because vault names are mutable, user-chosen and can collide.
- An interrupted run leaves the previous export untouched.
- Every path is checked again with the shared vault-relative rule (§6.2), and no file is written through a symbolic link.
- The job prints a JSON summary. It exits non-zero on any failure or missing content. It has no metrics endpoint.
- An E2EE vault with escrow is decrypted with the escrow identity (`VAULT_SYNC_ESCROW_IDENTITY_FILE`). Every epoch's escrow slot must open and match the epoch's key commitment before anything of the vault is written. Otherwise the vault is `failed` and the run is `partial`. Each document's content is checked against its `blob_id`.
- E2EE vaults without escrow, and every E2EE vault when the job has no escrow identity, are skipped and reported.

`vault-sync export rotate-escrow` rotates the escrow key to a bundle that the operator names:

- It covers every escrow slot, including those of deleted, unpurged vaults.
- Unless the chain head is already the target, it appends an escrow rotation statement signed by the chain head's escrow signing key (`VAULT_SYNC_ESCROW_SIGNING_KEY_FILE`). The signing keys stay offline. The operator runs the rotation by hand, never from a cluster workload, so the Helm chart never mounts them.
- It re-wraps a slot only after it checks the slot against its epoch's key commitment. It writes only through `EscrowJobService` (§9.4).
- A slot that fails is reported and left in place. The run exits non-zero while any slot is left on an old key.

### 4.1 Protocol transport (decision)

The API is defined in **protobuf** under `proto/` and served with **ConnectRPC** (the Connect protocol over HTTP/1.1, JSON or binary). One schema generates the Go server stubs and the TypeScript client. The reason is in `docs/dev/decisions.md`.

Realtime traffic (change notifications now, Yjs updates and awareness later) uses a **WebSocket** that carries protobuf-framed messages, because browsers and Electron cannot do client-streaming over fetch.

The server sets CORS headers for Obsidian's app origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`) and checks `Origin` on the WebSocket upgrade.

Generated code is committed. `make generate` regenerates it, and CI fails on drift (`make check-generate`). Schema changes stay backward compatible: `make lint` (and CI) runs `buf breaking` with the `FILE` rule set against `master`. A deliberate exception is a narrowly scoped, temporary `ignore_only` entry in `buf.yaml` (`docs/testing/proto-compatibility.md`).

## 5. Data model

All identifiers are UUIDv7 unless stated. Every table below is scoped by `vault_id`, and every query filters by it. The migrations in `internal/store/migrations/` hold the full column lists. This table names each entity, its key fields and its rules.

| Entity | Key fields | Rules |
|---|---|---|
| `users` | `id`, `oidc_issuer`, `oidc_subject`, `display_name` | Created on the first authenticated request. |
| `devices` | `id`, `user_id`, `name`, `public_key` (X25519), `last_seen`, `removed_at`, `registration_id` | One per plugin install. A user has at most 100 devices that are not removed (§9.2). A removed device keeps its row, with `removed_at` set, because its revisions reference it. `last_seen` is the time of the device's last commit, to within a minute. `registration_id` is the idempotency key that the client chooses for its registration (§9.2). It is unique among the user's devices that are not removed. |
| `vaults` | `id`, `name`, `encryption` (`none` \| `e2ee`), `escrow` (bool), `head_seq`, `current_epoch`, `rotation_pending`, `conversion_seq` | `head_seq` is the change counter of the vault. `current_epoch` is the key epoch that new revisions must use. It is 0 while an E2EE vault has no epoch, and always 0 for a plaintext vault. `rotation_pending` asks an owner's client to create the next epoch (§9.3). `conversion_seq` is set when an owner converts a plaintext vault to E2EE in place (`VaultKeyService.ConvertVault`, `docs/design/encryption.md`). It is the `head_seq` of the vault at the switch, and it must equal the signed `converted_at_seq` of the conversion's *members* log entry. Only revisions up to it can be at epoch 0 (plaintext). Devices take this bound only from the verified *members* entry, never from this column. From the switch on, the server refuses a plaintext commit with `ERROR_REASON_VAULT_ENCRYPTED`. The switch replaces the `path_key` of every document: a live one with the HMAC that the owner's device sent, a deleted one with a placeholder unique to it. |
| `vault_members` | `vault_id`, `user_id`, `role` (`owner` \| `editor` \| `viewer`) | The source of truth for authorization. |
| `vault_invitations` | `id`, `vault_id`, `code_hash`, `role`, `created_by`, `created_at`, `expires_at`, `invite_anchor` | Pending invitations (§9.2). The server stores only the SHA-256 of the invite code (for an E2EE vault, of the code's `<id>`), and it is unique. `invite_anchor` is set only for E2EE invitations (§9.3). Their key slots (`key_slots` with `recipient_kind = invitation`) are deleted whenever the row is. A row exists only while the invitation is pending. The server deletes it when the invitation is redeemed or revoked, or when its creator stops being an owner. When an owner of the vault creates another invitation, the server prunes the expired rows. |
| `documents` | `id`, `vault_id`, `kind` (`blob` \| `text` \| `yjs` \| `folder`), `head_rev_id`, `path_key`, `deleted` | The identity of a document. It stays the same across renames. A `folder` document is a folder with a path and no content, so that empty folders sync (`docs/design/engine.md` §2). Its revisions never have a `content_ref`. It follows the path rules below like any other document, with one exception given there. `deleted` mirrors the tombstone flag of the head revision. `path_key` is unique per vault among live documents (`deleted = false`). A unique partial index on the SHA-256 digest of `path_key` enforces this, because a `path_key` can be up to 8192 bytes and a btree entry holds at most 2704. A digest collision can only refuse a commit. It never makes two paths one, because nothing looks up documents by `path_key`. |
| `revisions` | `id`, `document_id`, `vault_id`, `seq`, `parent_rev_id`, `content_ref`, `path`, `deleted`, `device_id`, `created_at`, `anchor`, `epoch` | Append-only. `epoch` is the key epoch whose key encrypts the revision (0 in plaintext vaults). `seq` comes from `vaults.head_seq` in the same transaction. `anchor` is a random UUID that PostgreSQL draws (`gen_random_uuid()`) when it inserts the row. It is the cursor anchor of §6.1. `parent_rev_id` is the base of the commit, the previous head, so the history of a document is a linear chain. When retention purges a revision (§11), its child is re-parented onto the parent of the purged revision. So `parent_rev_id` always names a revision that exists: the nearest retained ancestor, or none. |
| `blobs` | `vault_id`, `blob_id`, `size`, `state` (`uploading` \| `complete`), `released_at` | Content-addressed per vault. The bytes are in S3 at `vaults/{vault_id}/blobs/{hex(blob_id)}`. The server writes a row only when the blob is complete. Upload progress is in `blob_uploads` (§6.2). `released_at` is the time the blob was stored, or the time a retention purge last removed a revision that referenced it (§11). The collector clears it on a blob that it finds referenced. |
| `blob_deletions` | `vault_id`, `blob_id` | Blobs whose row garbage collection deleted and whose S3 object it did not delete yet (§11). |
| `purged_revisions` | `vault_id`, `seq`, `anchor`, `purged_at` | Purge markers: one row for every revision that retention purges, holding its `seq` and `anchor` and the time of the purge. The purge writes it in the same transaction (§11). It is unique per `(vault_id, seq)`. The anchor checks of `ListChanges` accept a marker as they accept a live revision (§6.1), so a purge never looks like a restore. Retention prunes a marker once it is older than the marker horizon (§11). |
| `retention_scans` | `keep_all`, `keep_daily`, `overrides`, `scanned_through` | At most one row. It holds the policy, a digest of every per-vault override, and the start time of the last complete retention scan. Later scans start from that time (§11). |
| `vault_retention` | `vault_id` (PK), `keep_all`, `keep_daily`, `updated_at` | The operator's retention override for one vault (§11). A vault without a row follows the deployment-wide policy. |
| `blob_uploads`, `blob_upload_chunks` | `id`, `vault_id`, `blob_id`, `size`, `received_size`, `state` (`uploading` \| `finished`). Accepted chunks by `offset`. | Resumable upload sessions (§6.2). At most one `uploading` session per `(vault_id, blob_id)`. |
| `vault_key_epochs` | `vault_id`, `epoch`, `commitment`, `created_by`, `created_at` | E2EE only (§9.3). One row per key epoch, numbered from 1 in each vault. `commitment` (32 bytes) lets a recipient check an unwrapped key. |
| `vault_log_entries` | `vault_id`, `seq`, `prev_hash`, `entry_type`, `payload`, `signatures`, `created_at` | E2EE only (§9.3). The membership log of the vault (`docs/design/crypto.md`). One signed entry per row, numbered from 1 (the genesis entry), stored as signed. |
| `key_slots` | `vault_id`, `epoch`, `recipient_kind` (`user` \| `escrow` \| `invitation`), `recipient_id`, `wrapped_key`, `created_by`, `created_at` | E2EE only (§9.3). An epoch key wrapped to one recipient, as 1 to 256 opaque bytes. Unique per `(vault_id, epoch, recipient_kind, recipient_id)`. No column holds an unwrapped key. A member's slot is never replaced. Every epoch of an escrowed vault has exactly one escrow slot. A new epoch of a vault with escrow off gets no escrow slot, and the escrow slots of earlier epochs stay. Escrow slots follow the rules below this table. |
| `escrow_chain` | `position`, `bundle`, `old_bundle_hash`, `signature`, `reset`, `created_at` | The escrow chain of the deployment (§9.4). Position 0 is the root escrow bundle. Each later position is an escrow rotation statement signed by the signing key of the previous bundle (`reset` false), or a reset point that names the hash of the previous bundle (`reset` true, `signature` empty). The chain is one linked sequence from the root, and no bundle appears twice. Escrow chain changes follow the rules below this table. |
| `anchor_lists` | `user_id` (PK), `version`, `sealed_list`, `updated_at` | E2EE only (§9.3). The sealed anchor list of a user (`docs/design/encryption.md`, *Trust anchors*). It is opaque to the server, and only the next version replaces it. |
| `maintenance_runs` | `job` (PK), `last_success_at` | The time that each server background job last finished a run without errors, on any replica. Today the only job is `retention` (§11). The service-wide metrics read it (§12). |
| `export_status` | `id` (PK, always `true`), `finished_at`, `status`, `last_success_at` | Exactly one row, which migration 0028 inserts. The export updates it at the end of each run with the time the run finished, its status (`ok`, `partial`, `failed`), and the time a run last finished `ok` (`docs/admin/backup-and-restore.md`). |
| `yjs_updates` | `document_id`, `seq`, `update` | Phase 5 (§10). |

**Escrow slots and the escrow chain.** These rules hold for `key_slots` with `recipient_kind = escrow` and for `escrow_chain`:

- Only the export job's escrow key rotation replaces an escrow slot. It calls the job-only `EscrowJobService.ReplaceEscrowSlot` with a bearer job token (`VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`).
- In one statement, the server deletes the slot wrapped to the old escrow key and inserts the slot wrapped to the key of the escrow chain head. It does this only if the old slot is still there, so every epoch keeps exactly one escrow slot.
- The server re-wraps only if signed rotations alone lead from the vault's `lastEscrow` (the escrow bundle that its log named last) to the head. Otherwise it refuses with `ESCROW_NOT_ADOPTED`. This rule also applies to vaults with escrow off and to vaults deleted in the last 30 days.
- In a new epoch E+1 of an existing vault, the escrow slot is wrapped to the bundle that the log names at the log position of the epoch record. The server derives this bundle from the log and does not check the escrow chain.
- A genesis, a conversion, a `0x08` "on" and a `0x0A` must name the head of the escrow chain. Otherwise the server refuses them with `ESCROW_NOT_CURRENT` (`FAILED_PRECONDITION`).
- The export job appends the next rotation statement through the job-only `EscrowJobService.AppendEscrowRotation`. The server first verifies the statement against the signing key of the chain head.
- If the signing key of the head is lost or stolen, `vault-sync export reset-escrow` appends a reset point through `EscrowJobService.ResetEscrowChain` (`docs/design/encryption.md`, *Escrow fingerprint and escrow reset*). The request carries the expected head hash and the new bundle. The server refuses it with `ABORTED` if the head moved, with `INVALID_ARGUMENT` for a malformed bundle or a bundle already in the chain, and with `FAILED_PRECONDITION` if there is no chain.

**Paths.** A path is an attribute of a revision, not an identity. The server enforces uniqueness on `path_key`, a normalized form of the path. So two clients cannot create paths that collide on a case-insensitive file system (Windows, macOS, Android, iOS). The normalization:

- `normalize(path) = NFC(toCasefold(NFD(path)))`. This is Unicode canonical caseless matching (Unicode §3.13, D145), emitted in NFC. It uses full, locale-independent case folding (`CaseFolding.txt` statuses C and F, never the Turkic T mappings). So `Straße` and `STRASSE` collide, and `İ` folds to `i̇`.
- On top of that, the NTFS upcase mapping (`docs/design/engine.md` §6) applies: a code point whose simple uppercase folds differently from it folds as that uppercase does. Only the dotless `ı` is affected, whose uppercase is `I`. So `ı.md` and `I.md` share the key `i.md`. Every other key is plain canonical caseless matching.
- Separators, whitespace and dots do not change, and normalization validates nothing.
- Normalization and case folding come from maintained libraries, never hand-written tables. Go (`internal/pathkey`) uses `golang.org/x/text/unicode/norm` and `golang.org/x/text/cases`. TypeScript (`plugin/src/core/pathkey`) uses `String.prototype.normalize` and the `unicode-case-folding` package. Both must agree on every vector in `testdata/paths/`.
- New names can use only code points assigned in Unicode 15.0 (`docs/design/engine.md` §6, §6.2). Unicode keeps their normalization and case folding stable, so both languages compute the same key on every runtime with Unicode 15.0 or later.
- A change to the key function never migrates stored keys. Documents that were committed with characters from Unicode 16 or 17 before the Unicode 15.0 rule keep their paths, and their key comes from the Unicode data of the libraries. Keys of paths with `ı` that were stored before the NTFS upcase mapping keep their old value.

For an E2EE vault, the path is ciphertext and `path_key = HMAC-SHA256(path_key_secret, normalize(path))`. So the server can enforce uniqueness without learning the path. Both are arbitrary bytes, and the `text` columns `revisions.path` and `documents.path_key` cannot hold them (NUL, invalid UTF-8). So for a revision with an epoch of 1 or more, the server stores both as unpadded base64url and returns the original bytes of the path. Epoch-0 revisions keep their plaintext path and key unchanged.

**Files and folders.** Apart from `folder` documents, folders are implicit. So the path of a live document cannot name the folder of another live document: a file `notes` and a document `notes/c.md` cannot both exist on any file system. A folder of a `path_key` is a proper prefix of it that ends before a `/`. The server refuses a live document in these cases:

| Case | Exception |
|---|---|
| A folder of the new `path_key` is the `path_key` of another live document. | That other document is a `folder` document. |
| The new `path_key` is a folder of the `path_key` of another live document. | The new document is a `folder` document. |

- A `folder` document `Projects` and a file `Projects/Plan.md` can both be live, in either commit order. A file `Projects` and a `folder` document `Projects/Q` cannot. A `folder` document and a file never share a `path_key` (the unique live `path_key` index).
- The comparison uses `path_key`, so `Folder` collides with `folder/c.md`, and `straße` with `STRASSE/a.md`.
- Tombstones never collide.
- Only `/` is a folder boundary. `path_key` keeps `\` unchanged, so `a/b` and `a\b` have different keys, and `notes\c.md` (a document under `notes` on Windows) is not compared with `notes`. No new path can contain `\` (§6.2), so such pairs come only from documents committed before that rule.
- Both checks are index probes, not scans (`internal/store/revisions.go`). A digest collision cannot refuse a commit here, because each probe compares the real `path_key` of the rows whose digests matched.
- There is no maximum folder depth. The 8192-byte `path_key` limit and the per-user RPC concurrency limit (§12) bound the cost of a deep key.
- The check starts with the release that added migration 0004. Collisions committed before it stay, and they stay editable and deletable. During a rolling upgrade (§12), replicas of an older release still accept file and folder collisions until every replica runs the new release. Likewise, replicas of a release from before the `folder` exception refuse a document under a live `folder` document until every replica runs the new release.
- In an E2EE vault, the `path_key` is an HMAC that cannot be split into folders. So there the server enforces only the exact `path_key` rule. Devices resolve a clash between a file and a folder of the same name with rule C of `docs/design/engine.md` (`docs/design/encryption.md`, *Rules for contents, invitations and escrow*).

**Content addressing.** For a plaintext vault, `blob_id = SHA-256(content)`. For an E2EE vault, `blob_id = SHA-256(sealed content)`, the hash of the ciphertext. The server verifies it in the same way (`docs/design/crypto.md`).

## 6. Sync protocol

### 6.1 Pull

`ListChanges(vault_id, since_seq, page_size)` returns the revisions with `seq > since_seq`, in `seq` order, in pages. The `ListChangesRequest` comments in `proto/vaultsync/v1/sync.proto` describe each field.

Pages:

- The client passes the last `seq` it received as the next `since_seq`, until `has_more` is false.
- The server caps `page_size` at 1000. The default is 500.
- The server also ends a page early where its encoding would exceed the send limit. So a page of long paths never fails as too large.
- Every page holds at least one revision if one exists. At startup, the server requires that the send limit fits a response with one revision of maximum size.

Cursor:

- The durable cursor of a client is the highest `seq` that it fully applied to disk.
- A device's own acknowledged commit is already on its disk. If its `seq` is the one right after the cursor, the client records it and moves the cursor onto it, as a pull would. Seqs are gapless, so this skips nothing.
- If another device committed in between, the cursor stays. The next pull fetches that commit and skips the device's own.

Cursor anchor:

- Every revision carries an `anchor`: 16 random bytes that the server draws when it stores the revision. Clients choose revision ids, so a client can commit an id again after a restore. No restored database reproduces a random anchor.
- The client stores the anchor of the revision at its cursor together with the cursor, in one journal write. It sends the anchor as `since_anchor` with every `ListChanges` from a nonzero cursor.
- Before it reads the page, the server checks in the same snapshot that the vault holds a revision with exactly that `seq` and anchor, or a purge marker with them (§5, §11: retention purged that revision). The check is two lookups on `(vault_id, seq)` unique indexes, answered from PostgreSQL alone, so every replica gives the same answer.
- If neither exists, the response sets `diverged` and carries no revisions, and the client resyncs (§8). This happens when the database was restored to below the cursor, whatever `head_seq` is now. A purge never causes it. A false negative cannot happen, because no other revision has the anchor.

Own-commit anchor:

- A device's own acknowledged commit can be above its cursor. A restore to a point between the two keeps the revision at the cursor, so the cursor anchor alone does not detect it.
- So the client records the anchor of each of its acknowledged commits with the journal state of the document. While one of them is above the cursor, the client also sends the `seq` and anchor of the highest such commit as `own_commit_seq` and `own_commit_anchor`.
- The server checks them in the same snapshot and in the same way: a live revision or a purge marker. If neither exists, it sets `diverged`. This also covers a restored `head_seq` that is still below that commit.
- The commits below it need no check, because a restore that lost one of them also lost the highest one.

The server refuses a request that breaks these rules with `INVALID_ARGUMENT`:

| Field | Rule |
|---|---|
| `since_anchor` | Empty or 16 bytes. Empty when `since_seq` is 0. |
| `own_commit_seq`, `own_commit_anchor` | Both given or neither. `own_commit_anchor` is 16 bytes. `own_commit_seq` is above `since_seq` and at most 2^63−1. |

Older peers and missing markers:

- A server from before the own-commit fields ignores them (unknown protobuf fields), so against it the client keeps only the cursor check. An old client sends neither field.
- A request without `since_anchor` (an old client, or a cursor stored without an anchor) gets no check.
- Some purged revisions have no marker: revisions purged before migration 0008, revisions purged by a release without markers during a rolling upgrade, and revisions whose marker retention pruned past the marker horizon (§11). A device whose cursor was on one of them gets one false-positive `diverged`, and it merges (§8).
- The check depends on no operator step, and on no PostgreSQL timeline or system identifier. These change on an HA failover that loses no data.

Clients pull on startup, on a realtime `subscribed{head_seq}` or `vault_changed{seq}` whose head is above the durable cursor (§6.4), and on a timer as a fallback.
### 6.2 Push (optimistic concurrency)

1. Upload the content: `BeginBlob`, then `PutBlobChunk` zero or more times, then `CommitBlob`. The rules are in the Upload groups below.
2. Commit the revision: `CommitRevision(document_id, revision_id, base_rev_id, kind, content_ref, path, path_key, deleted, device_id)`. The rules are in "Commit" below.
3. On `FAILED_PRECONDITION` (head moved), the client pulls the new head, merges (§7) against the common base, and retries with the new head as base.

A revision is **acknowledged** only when `CommitRevision` returns success. Principle 1 applies from that moment.

Upload, client side:

- An upload is idempotent: a `BeginBlob` for a `blob_id` that is already complete short-circuits.
- An upload is resumable. `BeginBlob` reports the bytes that the server already received. Chunks are appended strictly in sequence by offset.
- A chunk is at most the configured size (§3).
- The client first looks the blob up with a zero-length `DownloadBlob` at offset `size`. If the server already holds the blob, the client uploads nothing and does not read the local file.
- Otherwise the client reads the local content and checks its hash before `BeginBlob`.
- If the hash does not match (the content changed or disappeared after the operation was recorded), the client opens no session. It only looks the blob up with a zero-length `DownloadBlob` at offset `size`. If the server holds the blob, the client commits the operation. If not, the client replaces the operation with the current content of the file. If the hash matches, the client uploads with `BeginBlob`.

Downloads:

- Downloads are ranged (`DownloadBlob(offset, length)`), and the server bounds each response. If a range is shorter than the client asked for, the client continues from its end.

Chunk and range sizes hold in the codec of the request:

- `BeginBlob` advertises the chunk size as `max_chunk_size`. To binary clients it is the configured chunk size. To JSON clients it is the largest chunk whose base64 encoding (four bytes for every three), plus 1 KiB of framing and a thousandth for gzip, fits the request limit.
- `DownloadBlob` caps a range at the same size. It also caps a binary range at the request limit less a thousandth and 512 bytes. So a gzip-compressed response of incompressible content (for example E2EE content) still fits the send limit when the chunk size is right at the limit. With the default and smallest limits, a binary range is still the chunk size.
- The size depends only on the request, so every replica agrees.

Upload, server side:

- For a plaintext vault, the server verifies the content hash on commit.
- S3 multipart parts must be at least 5 MiB, except the last. Chunks are below the 1 MiB body limit, so they never are. So chunks are staged objects, and a server-side compose joins them.
- Each accepted chunk is its own object under `vaults/{vault_id}/uploads/{upload_id}/`. Its key is unique to the write. So a writer that lost a race for an offset never overwrites the accepted chunk.
- A compare-and-set on the `received_size` of the session accepts a chunk. Concurrent uploaders of one blob share a session. A loser gets `FAILED_PRECONDITION` and resumes from `BeginBlob`.
- Every chunk but the last is at least 64 KiB, or the maximum chunk size for the codec of the request if that is smaller. This bounds the objects per upload.
- `CommitBlob` streams the staged chunks in order into the object of the blob, and hashes them as it goes. It uses one `PutObject` up to 8 MiB, and a multipart upload of 8 MiB parts above that.
- The server writes the object, or completes its multipart upload, only after the hash matched. It writes the `blobs` row only after that. So an upload whose hash does not match never becomes visible, and the server discards its session.

Upload bounds:

- The maximum chunk size plus 1 KiB of framing must fit the maximum request body. The server checks this at startup.
- The Connect send limit equals the request limit.
- A blob is at most the configured maximum. The maximum is at most 80 GiB (S3 allows 10,000 parts, and the server uses 8 MiB parts).
- A vault has a bounded number of sessions in progress (`VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT`).

Reclaiming idle sessions:

- No RPC abandons a session. A client whose upload was interrupted and whose file then changed leaves its session behind.
- So a `BeginBlob` that would create a session in a vault at the limit first reclaims the sessions of that vault that were idle for longer than `VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE`. The default is 10 minutes, the minimum is 10 minutes, and the maximum is the upload TTL. The `BeginBlob` refuses with `RESOURCE_EXHAUSTED` only if it reclaimed no session.
- An upload in progress records activity on every chunk. So a session that was idle that long was abandoned.
- Reclaiming finishes the sessions in the same transaction, under the same vault row lock, that counts them. So concurrent `BeginBlob` calls on any instance reclaim each session once and never overshoot the limit.
- A chunk or commit that races the reclaim either records its activity first, and the session stays, or finds the session finished.
- A reclaimed session refuses more chunks (`FAILED_PRECONDITION`) and its commit (`NOT_FOUND`). The client then starts the upload again from `BeginBlob` with a new session, and its operation stays pending. The cleanup below removes the staged objects and the row of the session, as for any finished session.

Cleanup of expired sessions:

- A periodic, bounded cleanup reaps the sessions that were idle for longer than the upload TTL. It deletes their staged objects and then the session.
- It also aborts multipart uploads older than the TTL, unless their blob has a session that was active within the TTL. Otherwise the multipart uploads of an interrupted commit are invisible and leak storage.
- Every server instance runs the cleanup at the same time, so every step is idempotent. A session is claimed atomically. An upload or object that another instance already removed counts as removed.
- A commit records session activity after every 8 MiB part that it composes, and at least every minute while it waits for a compose slot. So the cleanup never reaps a commit in progress on any instance, however long it takes, unless composing one part takes longer than the TTL.
- If the session of a commit was finished or reaped meanwhile, on any instance, the commit returns `FAILED_PRECONDITION` and the client uploads again. This holds whether composing noticed it when it recorded activity, or by failing to read a staged chunk that the cleanup deleted. The cleanup claims a session in PostgreSQL before it deletes any of its objects, so a failed commit checks the session there.
- A staged chunk that is missing from a session that is still active is `INTERNAL`.
- Upload sessions hold no state per instance. So chunks and the commit can go to different instances. If an instance dies during a commit, a retry on another instance succeeds.

Compose slots:

- Each replica composes at most 4 blobs at once, and at most 2 of them for one user. So one user can never hold every slot, and the commit of another user always finds one.
- Further commits of a user wait for the slots of that user, and hold none of the slots of the replica.
- A `CommitBlob` of a blob whose commit is already in progress on the same replica waits for that commit, and holds no slot of the replica. Then it returns that result: the blob complete, or the same failure that the state of the session implies. So duplicates neither compose the blob again nor hold a slot of the replica. A duplicate is a retry of a slow commit, another device that commits the same content, or a client that repeats the commit.
- A commit takes one of the slots of its user before it claims the blob. So a commit that waits behind other compositions of its own user never makes the commit of another user for the same blob wait behind that queue.
- Both limits are in-process and per replica. Replicas share no state, so duplicates sent to different replicas can still each compose the blob once.

Commit:

- The server accepts a commit only if `base_rev_id` equals the current head of the document, or the document is new and `base_rev_id` is empty.
- It assigns `seq`, advances `head_seq`, and broadcasts `vault_changed`.
- Document and revision ids are UUIDv7s that the client generates.
- A retry of a commit with the same `revision_id` and identical fields returns the revision that is already committed. So a lost response does not turn into a false head-moved conflict.
- `path_key` is sent only for E2EE vaults (§5). There it is the 32-byte HMAC of the client, and `path` is ciphertext of 1 to 4137 bytes (a sealed 4096-byte path, plus the suite byte, the 24-byte nonce and the 16-byte tag). Both are opaque to the server. The server checks only their sizes (`INVALID_ARGUMENT` otherwise), and applies none of the plaintext path rules below.
- For plaintext vaults, `path_key` must be empty, and the server derives it from `path`.

Commit transaction:

- A commit is one PostgreSQL transaction that first locks the vault row. So the database serializes the commits to one vault across every server replica, with no state per process.
- `seq` comes from `UPDATE vaults SET head_seq = head_seq + 1 … RETURNING` in that transaction, so it is gapless.
- A revision commits (becomes visible to `ListChanges`) only after every lower `seq`, so a cursor never skips one.

In the transaction, the checks run in this order:

1. The device belongs to the caller and is not removed. If not: `NOT_FOUND` with an `ErrorDetail` of reason `ERROR_REASON_DEVICE_NOT_FOUND`.
2. If this vault has a revision with this `revision_id`, the server returns it if its fields are identical. If they differ: `INVALID_ARGUMENT`. The rules for this check are in the list after this one.
3. The head comparison. If it fails: `FAILED_PRECONDITION` that carries the document, with its current `head_rev_id`, as a `Document` error detail. A base given for a document that does not exist in the vault is also `FAILED_PRECONDITION`.
4. The kind matches the kind of the document.
5. The content is a `complete` blob in the same vault, and its stored size equals `content_ref.size`. If the blob is not complete: `FAILED_PRECONDITION`. On a size mismatch: `INVALID_ARGUMENT`. A `DOCUMENT_KIND_FOLDER` commit carries no `content_ref`, and one that does is `INVALID_ARGUMENT`. Every other kind needs one, tombstones included. The stored size is the size that the server ever returns.

Rules for check 2, the idempotent retry:

- A base that retention has since purged matches the re-parented revision (§11).
- A `device_id` other than the device of the revision matches only if the device of the revision is the caller's and is removed. That is the same installation that retries a commit whose response was lost after it registered again.
- The check runs before the head comparison. So a retry whose first attempt was applied still succeeds after other commits moved the head.
- A retry of a revision that retention has since purged (§11) is a new commit. The server has no record of the id any more, so it judges the retry against the head.

After the checks:

- The server updates the `head_rev_id`, `path_key` and `deleted` of the document row in the same transaction as the revision insert. So `deleted` always mirrors the head, and the index on the live `path_key` is exact. A collision on it is `ALREADY_EXISTS`.
- Then, if the revision is live and its `path_key` is new to the document (or the document was a tombstone), a file/folder collision with another live document (§5) is also `ALREADY_EXISTS`. This check runs under the vault row lock. So two commits that would each complete a collision, on any replicas, are serialized, and the server refuses the second.
- The server never refuses a revision for a file/folder collision if the revision keeps the live `path_key` of its document (an edit) or deletes it. So a collision committed before the rule existed never blocks an edit or a delete.
- Client-generated ids that another vault already uses are `INVALID_ARGUMENT`. Every lookup is scoped to the authorized vault, so the ids of another vault are otherwise not found.
- The commit transaction also queues a PostgreSQL `NOTIFY` on channel `vault_changed` (payload `<vault_id>:<seq>`). PostgreSQL delivers it to every replica exactly when, and only if, the transaction commits. An idempotent retry notifies nothing (§6.4).

Plaintext path rules. Every plaintext path:

- Is at most 4096 bytes of UTF-8, without control characters (Unicode category `Cc`).
- Is vault-relative (below).
- Is at most 8192 bytes once normalized.

Vault-relative is defined for every supported client platform:

- `/` and `\` are both separators.
- The path must not start with a separator. This also rules out UNC, `\\?\` and `\\.\` prefixes.
- The path must not start with an ASCII letter and a colon: a drive prefix such as `C:`, `C:\x` or the drive-relative `C:x`.
- A segment must not be empty or consist only of dots and spaces: `.`, `..`, and forms such as `.. ` or `...` that Windows reduces to them.
- Names that only Windows cannot create pass this rule: reserved device names such as `CON.md`, a colon anywhere but a leading drive prefix, and trailing dots or spaces on other names. But a new path must be portable (below).
- Look-alike characters are not separators or dots. U+FF0F, U+FF3C, U+2215 and U+29F5 are ordinary characters, and a segment of fullwidth full stops (U+FF0E) is an ordinary name. The wide APIs of Windows, which Electron and Node use, do not treat them as separators, and `path_key` uses NFC, not NFKC.

A path that a commit gives a document (a new path) must also:

- Be at most 1024 bytes in total. No part (between `/`) is longer than 255 bytes of UTF-8.
- Contain no `\` at all. Windows reads it as a separator, and other platforms read it as part of a name. Otherwise `a/b` and `a\b`, or a file `notes` and a document `notes\c.md`, can both be live while they name one file on Windows.
- Not start with any single code point followed by `:`, such as `1:x.md` or `é:x.md`. Win32 reads any first character followed by a colon as a drive, and `subst` can create drives that are not letters.
- Be portable (`docs/design/engine.md` §6). No part contains any of `< > : " | ? *`, starts or ends with a space, ends in a dot, or is a Windows reserved name. The reserved names are `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and `LPT1`–`LPT9`, in any case, with or without an extension (the name is the part up to its first dot).
- Use only code points that are assigned in Unicode 15.0 (`docs/design/engine.md` §6). Private-use characters are assigned. Noncharacters, and code points added in Unicode 15.1 or later, are not. So the libraries of both languages normalize and fold the path identically (§5).
- Be in Unicode NFC (`docs/design/engine.md` §6). Obsidian stores every path in NFC, so a decomposed spelling such as `Cafe` followed by U+0301 can never match a file on any device.

Refused and older paths:

- The refusal names the rule that the path breaks.
- A path that is vault-relative but breaks a new-path rule is accepted only as the unchanged path of the live head of the document. So a document committed before the rules can still be edited and deleted in place, or renamed to a valid path. Creating a document there, moving one there, or bringing a tombstone back there is `INVALID_ARGUMENT`. The server checks this under the lock of the document in the commit transaction.
- No stored path is migrated. Such documents stay readable and exportable.
- A path that breaks a rule is `INVALID_ARGUMENT`, and nothing is written.
- A path or `path_key` that the database refuses (empty, over its bound, or text that it cannot store) is `INVALID_ARGUMENT`, never `INTERNAL`.

Both languages must agree on the path rules:

- Go (`internal/vaultpath`: `Check`, and `CheckNew` for the new-path rules, used by `CommitRevision`) and TypeScript (`isVaultRelativePath` and `isNewVaultPath` in `plugin/src/core/vaultpath`) agree on every vector in `testdata/paths/validity.json` (its `valid` and `new` fields).
- On the length and character-set rule, Go `CheckText` and TypeScript `isPathText` agree on every vector in `testdata/paths/text.json`.
- On the normalized length rule, `CommitRevision` and TypeScript `fitsPathKeyLimit` agree on every vector in `testdata/paths/key.json`. A path can grow when normalized: U+1D160 decomposes into three code points that NFC does not recompose, so 683 of them (2732 bytes) have an 8196-byte `path_key`.

Path rules on the client:

- Clients apply every one of these path rules before they commit (`pathProblem` in `plugin/src/core/vaultpath`). A local file at a path that the server would refuse is never uploaded or committed, on any push. It stays on disk, untouched, with its operation pending. Every push reports it as rejected, with the rule that it breaks, until the user renames or removes it (§8).
- A client must apply the length and character-set rule (`isPathText`) and the vault-relative rule (`isVaultRelativePath`), but not the new-path rules, to every path that it receives before it touches its disk. This includes E2EE paths after decryption, which the server cannot check.
- The client must apply them to the exact string that it hands to the file system. The adapters for the Obsidian vault and config folder refuse any path that the Obsidian `normalizePath` would change. The Obsidian `DataAdapter` normalizes every path that it is given, and `normalizePath` turns, for example, the accepted `..` followed by U+00A0 into the traversal segment `.. `.

### 6.3 Renames, deletes, creates

The engine design, `docs/design/engine.md` §5, defines client behaviour for renames, deletes and creates. The server rules still apply:

- A rename is a new revision with a new path.
- A delete is a tombstone revision.
- A create is a revision with an empty `base_rev_id`.
- A live path must not collide with the `path_key` of another live document.

### 6.4 Realtime channel

Each device opens one WebSocket (`GET /v1/realtime`) with the same bearer token as its RPCs. The socket multiplexes subscriptions to any number of the user's vaults, up to a server cap (`GetServerInfo.max_realtime_subscriptions`). Each binary WebSocket message is one protobuf frame: `ClientFrame` or `ServerFrame` in `proto/vaultsync/v1/realtime.proto`, each a `oneof` envelope.

- Client to server: `subscribe{vault_id}`, `unsubscribe{vault_id}`.
- Server to client: `subscribed{vault_id, head_seq}`, `vault_changed{vault_id, seq}`, `error`, and later membership and key-epoch changes.
- Field numbers 100–199 of both envelopes are reserved for the Phase 5 Yjs frames. Phase 5 adds Yjs subscribe, update and awareness messages, multiplexed by `document_id`.

The channel only makes sync faster. Correctness never depends on receiving a notification.

Server rules:

- **Upgrade.** The client offers the subprotocols `vaultsync.v1` and `vaultsync.bearer.<access token>`, because a browser cannot set headers on a WebSocket request. A non-browser client can send `Authorization: Bearer` instead, but not both. The server checks `Origin` against the CORS allow-list. An absent `Origin` is allowed, for non-browser clients. The server authenticates the token with the RPC authenticator and echoes only `vaultsync.v1`. The token never appears in a URL, and the server never logs the `Sec-WebSocket-Protocol` header.
- **Refused upgrades.** The server refuses the upgrade with these HTTP statuses:

  | Status | Reason |
  |---|---|
  | 403 | The origin is not allowed. |
  | 401 | The token is missing or not valid. |
  | 400 | The client did not offer `vaultsync.v1`. |
  | 429 | The user has too many connections. |
  | 503 | The instance is full or draining. |

- **Authorization.** Every `subscribe` resolves the caller's `vault_members` role. A non-member and a vault that does not exist get the same non-fatal `NOT_FOUND` error frame.
- **Membership on delivery.** The server checks membership again before every delivery, in one query per vault for up to 1,000 subscribed users (more take one query per 1,000). The subscription of a removed member ends with an unsolicited `NOT_FOUND` error frame that names the vault, and the server sends no more notifications for that vault. If the check fails (a database error), the server does not send that notification and keeps the subscription. The periodic pull of the clients catches up.
- **Member removal.** `RemoveMember` and `LeaveVault` (§9.2) queue a `vault_changed` notification at the current `head_seq` of the vault, in the same transaction. So every replica runs the membership check at once, and the subscriptions of the removed member end without waiting for a commit. The other subscribers receive a head that they already have, which starts no pull.
- **Deleted vaults.** `DeleteVault` queues the same notification. Every subscriber of a deleted vault, and a member that subscribes to one, gets a `NOT_FOUND` error frame whose `reason` is `ERROR_REASON_VAULT_DELETED`. A non-member still gets the plain `NOT_FOUND` frame.
- **Token expiry.** There is no in-band refresh. When the `exp` of the access token passes, the server sends a fatal `UNAUTHENTICATED` error frame and closes the socket (1008). The client reconnects with a fresh token and subscribes again.
- **Fan-out.** Each replica holds one PostgreSQL connection that `LISTEN`s on `vault_changed` and delivers each notification to its local subscribers. So a commit on any replica reaches subscribers on every replica. The replica coalesces the undelivered notifications of one vault to the newest `seq`. If the listening connection is lost, the replica reconnects with jittered backoff. Then it sends the current `head_seq` of every locally subscribed vault, so it misses no commit made in the meantime. Subscriptions are state of one connection only. A client that reconnects to another replica subscribes again and pulls from its cursor.
- **Bounds.** An inbound frame is at most 4 KiB. A larger frame closes the socket with 1009. The inbound rate is 20 frames per second, with a burst of the subscription cap plus 32. More is a fatal `RESOURCE_EXHAUSTED`. Subscriptions per connection, connections per user and connections per replica are capped (`docs/admin/security.md`). The send queue of each connection is bounded. The server disconnects a client that is too slow to drain it, or that does not answer pings, and does not buffer for it. A malformed frame or a text frame is a fatal `INVALID_ARGUMENT`.
- **Drain.** On shutdown, the server closes every socket with 1001 ("going away"). Clients reconnect with backoff and jitter.

Client rules:

- **Token.** The plugin offers the token only as the `vaultsync.bearer.` subprotocol. It never puts the token in the URL and never logs it. It takes the token from its token manager, which refreshes the token before it expires. On the fatal `UNAUTHENTICATED` frame, the plugin invalidates that token in the token manager. So the reconnect carries a freshly refreshed token, with no user interaction.
- **Pull on `subscribed`.** The plugin pulls from its durable cursor after every `subscribed` whose `head_seq` is above the durable cursor. Notifications sent while it was not subscribed are lost, so the head tells it whether it missed any. This is safe because the server registers the subscription before it reads the head, and reports the larger of that head and any `seq` announced in the meantime. So every commit above the reported `head_seq` reaches the client as a `vault_changed`, and a cursor at or above `head_seq` has nothing to fetch.
- **Pull on `vault_changed`.** The plugin pulls on every `vault_changed` of its vault whose `seq` is above the durable cursor. The server also notifies the committing device. An acknowledged commit that is the next `seq` moves the cursor onto it (§6.1), so the notification of a device's own commit starts no pull, and its status stays idle. A notification above the cursor always pulls. This includes a notification coalesced from another device's commit and the device's own, because the newest `seq` is above the cursor while the other commit is not applied.
- **Cursor checks.** The plugin checks the cursor when the notification arrives, and again when the pull gets its turn after a running push. So a notification that arrives before the response of its commit does not start a pull either.
- **Status.** A subscribe that completes after the startup push, with nothing new, starts no pull and leaves the status idle. A skipped pull is not a successful sync: it keeps an earlier `offline` or `error` status.
- **One pull at a time.** Pulls never overlap. If `subscribed` and `vault_changed` frames arrive during a pull, the plugin runs one more pull after it, if the cursor is below the highest head among them.
- **Timer.** The pull timer runs whether the channel is up or not. A server whose history was restored to below the cursor announces heads at or below the cursor, which start no pull. The pull of the timer still finds it.
- **Reconnect.** After every close, or a failed upgrade, the plugin reconnects after a delay with equal jitter. The delay is half of a ceiling plus a uniformly random part of the other half. The ceiling starts at 1 s and doubles with each consecutive failure, up to 60 s. It starts over only once a subscription stayed up for 30 s. So the delay still grows against a server that subscribes and then closes at once, for example a replica that keeps draining.
- **Refused upgrades.** A browser does not expose the HTTP status of a refused upgrade: 401, 429 and 503 all look like a 1006 close. So these back off alike. The next RPC that fails as unauthenticated also invalidates a token that the server no longer accepts.
- **Error frames.** A non-fatal error frame for the vault (for example `NOT_FOUND` after a membership change) drops the connection, and the plugin retries with the same backoff.

## 7. Merge rules (client side)

`docs/design/engine.md` §5 defines the merge rules (rule M, rule W, rule C), and rule M has the table of strategies. In short:

| Files | Rule |
|---|---|
| Markdown (`TEXT`) | Merged three-way. |
| Obsidian Bases (`.base`) | Merged three-way as schema-validated YAML. Views are matched by name. Filter `and`/`or` lists are sets. |
| JSON Canvas (`.canvas`) | Merged three-way. Nodes and edges are matched by `id`. The result is validated: ids are unique and edge endpoints are present. |
| Other JSON (`.json`) | Merged three-way per key. An array is one value. |
| Plain-text types (`txt`, `csv`, `tsv`, common source and markup files, `yaml`/`yml`/`toml`), valid UTF-8 up to 1 MiB | Merged three-way line by line with diff3 semantics. Overlapping changes refuse the merge. A YAML or TOML result must still parse. |
| Every other `BLOB` file (no merge) | The newest wins, and the other is kept as a conflict copy. |

- The merged types other than Markdown are picked by extension. Their kind stays `BLOB`.
- If the merge of one of the extension-picked types has a conflict, a side does not parse or validate, or the merged result is invalid, the whole file falls back to the `BLOB` rule. Markdown never falls back: see the last bullet. Conflict markers are never written.
- If the merge equals one side, the bytes of that side are kept as they are.
- If Markdown edits overlap, the version of the server stays at the path. The local version is saved as a conflict copy, named `<name> (Conflicted copy <user> <device> <YYYYMMDDHHMM>).<ext>` after the local user and device.

## 8. Client durability

Defined by `docs/design/engine.md` §2 (journal), §8 (crash safety) and §9 (resync after an offline server restore).

## 9. Authentication, authorization, encryption

### 9.1 Authentication

Overview:

- The plugin authenticates against Authentik with the **OAuth 2.0 Device Authorization Grant**. It works the same on desktop and Android, with no redirect handling.
- The plugin stores the refresh token in the per-vault, device-local storage of Obsidian (`app.saveLocalStorage`, key `vault-sync-refresh-token`), never in `data.json`. So tools that back up or sync the vault folder never copy it. The unlocked encryption keys are kept the same way (§9.3).
- Access tokens are JWTs. The server validates them against the JWKS of the issuer, which it refreshes on an unknown `kid`, with a bounded refresh rate.
- `iss`, `aud` and `exp` are always checked.

Client: transport and identity provider:

- The OAuth calls live in `plugin/src/core/auth` and go through an injected HTTP client. In the plugin, that is the `requestUrl` of Obsidian, which is not subject to CORS and behaves the same on desktop and Android.
- The ConnectRPC transport of the plugin uses `requestUrl` too. `requestUrl` cannot be cancelled, so an aborted or timed-out RPC rejects at once, and its late response is dropped.
- Identity provider responses are bounded at 64 KiB of UTF-8. The check runs once `requestUrl` has buffered the body, because it offers no streaming.
- The discovery document must name the configured issuer exactly.
- The issuer, every endpoint and the server URL must be `https`. Plain `http` is allowed only to loopback hosts.
- The plugin checks the protocol version from `GetServerInfo` before it signs in, and takes the identity provider from it. `GetServerInfo` advertises the issuer (`VAULT_SYNC_OIDC_ISSUER_URL`) and the public client id of the plugin (`VAULT_SYNC_OIDC_CLIENT_ID`, by default the audience). Both are public, so only the server URL must be entered.
- The issuer and client id settings of the plugin are optional overrides. An entered client id wins. An entered issuer is used only when the server advertises none. An entered issuer that differs from the advertised issuer is refused.
- So the server URL decides the identity provider unless the issuer is entered. With none entered, the first sign-in trusts the issuer that the server advertises, and a malicious or compromised server can send the user to a verification page of its choosing. This is accepted, because the user already trusts that server with the notes of the vault. Entering the issuer pins it.
- The advertised issuer must pass the same `https` rule. An advertised client id must be 1 to 255 printable ASCII characters.
- The issuer and client id that a sign-in used are stored with the refresh token and used for its refreshes. So refreshing never depends on the server.

Client: sign-in:

- The device flow requests `openid offline_access`.
- It follows RFC 8628 polling: the interval of the provider, plus 5 s on every `slow_down`. Network failures and 5xx responses are retried until the code expires.
- It is cancelled when its dialog closes, which leaves the authentication state as it was.
- The server and identity provider settings are locked while a sign-in runs and while signed in.
- A signed-in device must sign out before it can sign in again.
- A grant without a refresh token is refused.

Client: tokens:

- The refresh token is the only token stored (device-local storage, never synced).
- A refresh token found in `data.json` (written by older versions) is moved to local storage on load and removed from `data.json`.
- When `data.json` still names the identity provider of the sign-in but local storage holds no token (it was cleared), the device starts in "sign-in required", as after a revoked token.
- The access token is kept in memory. It is refreshed a minute before its `exp` (from the JWT, else `expires_in`), or halfway through its lifetime if that is shorter.
- Concurrent callers share one refresh.
- A rotated refresh token is persisted before the new access token is used.
- Writes of the refresh token never overlap.
- A sign-in or sign-out wins over a refresh that is still running. The tokens of that refresh are dropped, and its rotated refresh token is never left on disk.
- A sign-in forgets the tokens of the previous session before it stores the new refresh token. So while that write runs, no caller gets the access token of the previous session.
- If that write fails, the device is left signed out, and the stored refresh token is then removed (best effort). So a restart does not resume the session that the sign-in replaced.
- A unary RPC refused with `UNAUTHENTICATED` invalidates its token and is sent once more, unchanged, with a fresh one. So a retried `CommitRevision` keeps its `revision_id` (§6.2).
- `GetServerInfo`, the one public procedure, never waits for a token.

Client: failures:

- A refresh refused with `invalid_grant` (the refresh token expired or was revoked, or the provider session ended) deletes the refresh token and moves to "sign-in required".
- From then on, authenticated calls fail with `UNAUTHENTICATED` without reaching the server. The engine keeps its pending operations (principle 1) until a new sign-in.
- A provider that cannot be reached fails calls with `UNAVAILABLE` and keeps the device signed in.
- A request that `requestUrl` could not deliver at all (no network, DNS, TLS) fails with `UNAVAILABLE` too.
- "Sign-in required" stops sync. The session that starts after the next sign-in pushes what was changed meanwhile.
- Tokens are never logged.

Server: tokens:

- Only RS256, ES256 and EdDSA signatures are accepted. `none` and HMAC algorithms are rejected.
- Tokens are size-bounded before parsing.
- `exp` has no leeway. `nbf`, when present, tolerates one minute of clock skew.

Server: JWKS:

- The JWKS is discovered from the OpenID configuration of the issuer.
- It is fetched lazily, and fetched again on an unknown `kid` and when it is older than one hour, but never more than once per 30 seconds.
- A failed refetch keeps the cached keys.
- At most one fetch is in flight, and no lock is held across it. While keys that are an hour old are fetched again, other requests use the cached keys rather than wait.
- The discovery document, `jwks_uri` and redirects must be `https`. Plain `http` is allowed only to loopback hosts, and only for a loopback `http` issuer.
- Redirects must stay on the requested host and never downgrade to `http`.

Server: users:

- Users are created on their first authenticated request, keyed by `(issuer, subject)`. Concurrent first requests create exactly one user.
- `sub` must be non-empty, at most 255 bytes, and free of control characters (Unicode `Cc`). Other tokens are rejected as unauthenticated before any user lookup.

Server: default-deny:

- Authentication is **default-deny**. One interceptor on every ConnectRPC service authenticates every procedure that is not on an explicit public allow-list.
- The allow-list holds only `ServerInfoService/GetServerInfo`. It returns only public data derived from the configuration: versions, the realtime subscription cap, the issuer and the public client id of the plugin.
- The realtime WebSocket upgrade (§6.4) authenticates with the same authenticator.
- A test enumerates every procedure in the schema and asserts that it is authenticated or allow-listed.

### 9.2 Authorization

Every RPC and every WebSocket message resolves `(user, vault_id)` to a `vault_members` role before it touches data. A `viewer` can read. An `editor` can read and write. An `owner` can also manage members and vault settings. The API has no admin bypass.

The central check:

- Authorization is **central and runs before the handler**: one interceptor, after authentication, on every ConnectRPC service.
- A single table (`server.VaultProcedures`) classifies every vault-scoped procedure as read or write. A vault-scoped procedure is every procedure whose request carries `vault_id`.
- A request that carries a `vault_id` for an unclassified procedure is rejected. A test derived from the schema descriptors fails if any such procedure is missing from the table.
- The interceptor reads only the top-level `vault_id`, so a request must name its vault nowhere else.
- A second schema-derived test walks every RPC input message (nested messages, `oneof` members, repeated and map fields, stopping at recursive types). It fails, and names the procedure and the field path, on any vault-identifying field other than a single top-level, singular, non-`oneof` `string vault_id`.
- A field is vault-identifying if its name ends in `vault`, `vaults`, `vault_id` or `vault_ids` (also without the underscore before `id`, for example `target_vault_id`), or if its type is the `Vault` message.
- Streaming calls to vault-scoped procedures are rejected before the handler runs, because their messages arrive only after it starts.
- `vault_id` must be a canonical lowercase UUID (`INVALID_ARGUMENT` otherwise). It is checked before any query.
- The role is then resolved with one `vault_members` lookup. A vault that does not exist and a vault that the caller is not a member of take the same path and return the same `NOT_FOUND` error.
- A `viewer` that calls a write procedure gets `PERMISSION_DENIED`.
- Handlers take the authorized vault from the interceptor, never from the request. They query through a vault-scoped store handle whose every query filters by that vault. So ids from another vault (documents, revisions, blobs) are not found.

Vaults:

- `CreateVault` makes the caller the `owner`. A user can own at most 100 vaults that are not deleted.
- `ListVaults` returns only the vaults that the caller is a member of, with the role of the caller. It is paginated by an opaque `page_token`. `page_size` defaults to 100 and is capped at 1000.
- Like `ListChanges`, a `ListVaults` page also ends early where its encoding would exceed the send limit, with a `next_page_token` to continue. It holds at least one vault if one remains. Startup requires the send limit to fit a response with one vault with a maximum-length name.
- Vault names are non-blank and at most 256 bytes.
- Vault names contain no control characters (Unicode category `Cc`, including U+0000, which PostgreSQL `text` cannot store), no format characters (`Cf`: bidi embeddings, overrides, isolates and marks, zero-width characters, the byte order mark, tag characters) and no line or paragraph separator (`Zl`, `Zp`). So a name that other members see cannot hide text or reorder the label around it.
- Any other vault name is `INVALID_ARGUMENT` before the database is touched.

Deleting a vault (`docs/design/sharing.md`):

- `VaultService.DeleteVault(vault_id)` is owner-only (`Manage`). Editors and viewers get `PERMISSION_DENIED`, and the vault is unchanged.
- It sets `vaults.deleted_at` under the vault row lock and keeps every row and blob.
- From then on, every vault-scoped RPC from a member of the vault, `DeleteVault` included, is `NOT_FOUND` with an `ErrorDetail` of reason `ERROR_REASON_VAULT_DELETED`. Its realtime subscriptions end the same way (§6.4).
- A non-member gets the same `NOT_FOUND` as for a vault that does not exist.
- `ListVaults` no longer lists the vault, its pending invitations no longer redeem, and it no longer counts toward the limit of 100 owned vaults of its owners.
- The check is read from PostgreSQL on every request, so it takes effect on every replica at once.

Purge and undelete:

- The retention job (§11) purges a vault that was deleted more than 30 days ago.
- One transaction sets `vaults.purged_at` (migration 0018) and deletes every row of the vault. Then the job deletes every object under the S3 prefix of the vault, at most 10,000 per run. Then it deletes the `vaults` row.
- A purge that is cut short resumes on the next run.
- `vault-sync-server vault undelete <vault-id>` clears `deleted_at` while `purged_at` is unset. For an unknown vault, or one whose purge started, it exits 1.
- The export keeps writing a deleted vault until its purge starts, with a `<vault-id>.DELETED` file that holds the deletion time (`docs/admin/backup-and-restore.md`).

Membership:

- `MembershipService` manages members.
- `CreateInvitation`, `ListInvitations`, `RevokeInvitation`, `ListMembers`, `UpdateMemberRole` and `RemoveMember` are owner-only: the `Manage` class of `server.VaultProcedures`, `PERMISSION_DENIED` for editors and viewers.
- `LeaveVault` is open to every member (`Read`).
- `RedeemInvitation` is not vault-scoped, because the person who redeems is not a member yet. It carries only the code.
- An invitation grants one role (owner, editor or viewer). It expires after `ttl_seconds` (default 7 days, at most 30 days). More is `INVALID_ARGUMENT`.
- Its code is 32 random bytes, base64url-encoded without padding. Only `CreateInvitation` returns it. The server stores only its SHA-256.
- Redeeming makes the caller a member with the role of the invitation and deletes the invitation, in one transaction. So a code works once, even when it is redeemed concurrently.
- A code that is malformed, unknown, expired, revoked or used gets one and the same `NOT_FOUND` error, which names no vault.
- When a member is removed or leaves, or an owner is demoted, the invitations that they created are deleted in the same transaction. Their codes get that same `NOT_FOUND`, and `ListInvitations` no longer lists them. So a former owner cannot use a code that they created earlier to get back in.
- Redeeming as an existing member is `ALREADY_EXISTS`. It leaves both the role and the invitation as they were.
- A vault has at most 100 members and 100 pending invitations (`RESOURCE_EXHAUSTED`). A redemption that the member limit refuses keeps the invitation. So `ListMembers` and `ListInvitations` are not paginated.
- A vault always has at least one owner. Demoting or removing its last owner, and the last owner leaving, is `FAILED_PRECONDITION`.
- Every membership change locks the vault row (as commits do). So concurrent changes cannot leave a vault without an owner or over the member limit.
- Changes take effect on the next request of the member on every replica, because authorization reads `vault_members` on every request and nothing caches roles.
- A removal ends the realtime subscriptions of the member at once (§6.4).
- A request in flight that was authorized before the change can still complete, except a commit.
- `CommitRevision` re-reads the role of the caller and the `deleted_at` of the vault under the vault row lock, which membership changes and `DeleteVault` also take. So once a removal, a demotion to viewer or a vault deletion returns, no revision by that member lands after it.
- A commit that waits for that lock is refused with `NOT_FOUND` (with reason `ERROR_REASON_VAULT_DELETED` for a deleted vault), or with `PERMISSION_DENIED` for a viewer.
- An owner role granted by invitation or promotion counts toward the `CreateVault` limit of 100 owned vaults, but that limit never refuses it.

Registering devices:

- `RegisterDevice` registers a device for the caller, one per plugin installation, so every reinstall adds one.
- A user can have at most 100 devices that are not removed.
- The 101st call gets `RESOURCE_EXHAUSTED` ("at most 100 devices may be registered") with an `ErrorDetail` of reason `ERROR_REASON_DEVICE_LIMIT`. Clients match the reason instead of the message.
- Registrations are serialized on the user row, so concurrent calls cannot overshoot the cap.
- Registration is idempotent with a `registration_id` that the client chooses (a canonical lowercase UUID). The plugin saves one before its first attempt and sends it with every retry.
- A retry with the same id and public key returns the device that the first call registered, as it is now, with its current name. It uses no other place, even at the cap. The name of the retry is ignored, because the device may have been renamed in between. So a crash or a lost response between the server registering the device and the plugin saving it does not burn a place.
- The plugin drops the saved id after `INVALID_ARGUMENT` or `ALREADY_EXISTS`, which mean that nothing was registered under it. So its next attempt uses a new id and the current Device name. After any other error, it keeps the id, because the first call may have registered the device.
- The same id with a different public key is `ALREADY_EXISTS`.
- The id is scoped to the caller and to devices that are not removed. So after a removal, it registers a new device.
- An empty id registers a new device on every call (older plugins).
- Device names follow the same character rule as vault names (no `Cc`, `Cf`, `Zl` or `Zp`), are non-blank and are at most 256 bytes. Names stored before this character rule existed are kept as they are.
- The plugin registers at most 256 bytes of its Device name setting (§11).
- The public key is empty or exactly 32 bytes.
- Any other registration input is `INVALID_ARGUMENT` before the database is touched.

How the plugin shows names (display only):

- Wherever the plugin shows the name of another device or of a vault, it strips `Cc`, `Cf`, `Zl` and `Zp` characters, replaces double quotation marks, bounds the shown length and isolates the name (Unicode FSI/PDI).
- In file paths that it shows, it writes invisible characters as `\uXXXX` and a backslash as `\\`, except the zero-width joiners of an emoji sequence. It lays each path out on its own (an element with `dir="auto"`) inside the label that shows it.

Listing and removing devices:

- `ListDevices` returns the devices of the caller that are not removed, oldest first. Each has its id, name, registration time and last activity: its last commit, to within a minute, unset if it never committed. It returns nothing secret (no public key).
- `ListDevices` is not paginated: the device limit bounds it to 100 entries.
- `RemoveDevice` removes one of the devices of the caller. `device_id` must be a canonical lowercase UUID (`INVALID_ARGUMENT`).
- A device that is not the caller's, does not exist or is already removed is `NOT_FOUND`. So a user can neither see nor remove the devices of another user.
- The row is kept with `removed_at` set, because `revisions.device_id` references it. The revisions of the device keep their history and attribution, and their device name is still shown (§11).
- A removed device no longer counts toward the limit and is not listed.
- A removed device can no longer commit: `CommitRevision` answers `NOT_FOUND`, as for an unknown device, with the reason `ERROR_REASON_DEVICE_NOT_FOUND`. The installation must register again to sync.
- The plugin lists the devices of the user in its settings and removes another one there, never its own.
- When a commit of its own is refused with that reason, the plugin stops sync, says so, and waits for the user to register the installation again. It never does that by itself, because the device may have been removed because it was lost.
- Its pending operations stay in the journal and are pushed under the new device. A retry of a commit that landed before the removal gets the committed revision back (§6.2).
- Removal is not undoable.
- Removal takes effect on every replica once the call returns, with PostgreSQL as the only coordination. Every commit locks its device row (after the vault row, so no deadlock) until it ends, and checks `removed_at` under that lock. The removal updates that row. So it waits for the commits of the device that are in flight, and every later commit, on any replica, sees it.
- No replica caches devices.
- Removed rows are not deleted, so the device rows of a user grow by one per removal. Each removal needs an authenticated registration and removal, and the rows are small.
- The rows are kept on purpose. Deleting one is only safe once no revision references it. Checking that needs an index on `revisions (device_id)`, which every commit would have to maintain, for rows of about a hundred bytes.

Renaming devices:

- `RenameDevice(device_id, name)` renames one of the devices of the caller that is not removed, and returns it. Its id stays the same, and `ListDevices` and history (`device_names`, §11) show the new name.
- The name follows the rules of `RegisterDevice`, and `device_id` must be canonical (`INVALID_ARGUMENT`).
- The device of another user, a removed device and an unknown id are `NOT_FOUND`, as for `RemoveDevice`.
- The rename is one update of the device row. So it takes the lock of that row, like a removal and every commit by the device, and is serialized with them.
- The plugin renames its own device when the Device name setting is edited while signed in, once the edit settled (debounced). It stores the name that the server accepted. A failed rename shows a notice and puts the setting back to that name.
- After a registration completes, the plugin renames the device to the setting only if the setting changed while the registration was pending (setting ≠ the pending name). Otherwise it keeps the name of the server.

### 9.3 End-to-end encryption (opt-in per vault)

Creating an E2EE vault:

- Encryption is chosen when a vault is created (`CreateVault` with `VAULT_ENCRYPTION_E2EE`).
- The device of the owner then creates epoch 1 itself (`RotateEpoch(expected_epoch = 0)`). It wraps the key to the owner and, with escrow, to the escrow key (§9.4). So the server never sees an epoch key.
- Escrow on a plaintext vault is `INVALID_ARGUMENT`. Escrow on a server without an escrow key is `FAILED_PRECONDITION`.
- An E2EE `CreateVault` carries the id of the vault (`new_vault_id`, chosen by the device of the creator) and the genesis entry of its membership log. The creator signs the genesis over that id (`docs/design/crypto.md`).
- The server checks the genesis with the log replay (`e2ee.ReplayLog`). It must be the first entry of the log of that vault, signed by its creator. The creator must be the caller. The genesis records an escrow bundle exactly when escrow is requested.
- Otherwise the request is `INVALID_ARGUMENT`. An id that names an existing vault is `ALREADY_EXISTS`. A refused request creates no vault.
- The vault and its genesis are stored in one transaction.
- A plaintext `CreateVault` takes neither field, and the server chooses its id.

Reading the membership log:

- `VaultKeyService.ListLogEntries` returns the log of the vault in `seq` order to every member, viewers included. Non-members get `NOT_FOUND`.
- Pages hold 100 entries by default and at most 1000, cut to the send limit. The log of a plaintext vault is empty.
- A non-member can also read the log with `invitation_id`, the `<id>` of an E2EE invite code (22 characters of base64url). So a newcomer can verify the log and sign its redeem entry before it redeems (`docs/design/encryption.md`, *Redemption takes two steps*).
- The server serves that request when SHA-256 of the 16 bytes of the id names a pending, unexpired invitation to the requested vault (the `ReadOrInvitation` class of `server.VaultProcedures`).
- A malformed, unknown, expired, revoked or redeemed id, or an id for another vault, gets the same `NOT_FOUND` as `GetInvitationSlots`.
- Members are served whatever `invitation_id` they send. Anonymous callers are still `UNAUTHENTICATED`.

Signed log entries for membership changes:

- In an E2EE vault, `CreateInvitation`, `RevokeInvitation`, `RedeemInvitation`, `UpdateMemberRole`, `RemoveMember` and `LeaveVault` each carry their signed log entry (`log_entry`: invite, revoke invitation, redeem, set role, remove member, leave).
- Under the vault row lock, in the transaction of the change, the server requires the `seq` of the entry to be the next of the log. Otherwise the change is `ABORTED`: the client lists the log and retries on top of the new head.
- The server then replays the entry onto the stored log (signatures, hash chain, the right of the signer to sign). It makes sure that the entry records exactly the requested change: the id of an invitation is the id of its invite entry, a redeem names the redeemed invitation and the caller, and a leave names the caller. Then it appends the entry.
- A missing entry, or an entry that fails these checks, is `INVALID_ARGUMENT`. A refused change changes nothing.
- An E2EE `RevokeInvitation` also accepts an invitation that expired but is still pending in the log, so owner devices can record its end.
- Membership changes of a plaintext vault take no entry (`INVALID_ARGUMENT` with one).

Invitations carry key slots (`docs/design/encryption.md`, *Invitations*):

- For an E2EE vault, the inviting device generates the code `<id>.<secret>` (128 random bits each, base64url without padding).
- `CreateInvitation` carries only `id_hash` (SHA-256 of the 16 bytes of `<id>`), the invite anchor (96 bytes) and the key slots of the invitation. It needs exactly one slot per existing epoch, each for this invitation (`KEY_RECIPIENT_KIND_INVITATION`). Otherwise it is `INVALID_ARGUMENT`, or `FAILED_PRECONDITION` with reason `ERROR_REASON_EPOCH_NOT_CURRENT` when an epoch is missing.
- The response carries no code. An `id_hash` in use is `ALREADY_EXISTS`.
- A plaintext invitation takes none of these fields and keeps its server-generated code.
- `MembershipService.GetInvitationSlots(id)` is open to any authenticated user and names no vault. For a pending E2EE invitation, it returns the invitation id, the vault id and the role, its slots, the epochs of the vault with their commitments and records, and the invite anchor.
- A malformed, unknown, expired, revoked or used id gets the same `NOT_FOUND` as a failed redemption.
- `RedeemInvitation(code, slots)` then takes the own slots of the redeemer: exactly one per existing epoch, all for the user id of the caller. The caller must have a user key.
- Under the vault row lock, in one transaction, the redemption stores the slots, makes the caller a member, and deletes the invitation and its slots. So a member never lacks a slot for an epoch that existed when they joined.
- A missing epoch (the vault rotated since `GetInvitationSlots`) is `FAILED_PRECONDITION` with reason `ERROR_REASON_EPOCH_NOT_CURRENT`. Other mismatches, or slots on a plaintext redemption, are `INVALID_ARGUMENT`. A refused redemption changes nothing.
- Revoking, redeeming, pruning expired rows and deleting the invitations of a former owner delete the slots of those invitations in the same transaction. The vault purge deletes the rest.
- `ListKeySlots` never lists invitation slots, and `AddKeySlots` refuses them.

Signed epoch records:

- An E2EE `RotateEpoch` carries the signed record of the new epoch (`record`: the log position, the sorted recipients with their key hashes, and the signature of an owner over `epoch_body`, `docs/design/crypto.md`).
- Under the vault row lock, the server replays the stored log, and the record must verify there with `e2ee.VerifyEpochRecord`. It must be signed by an owner at the position that it names, over this vault, epoch, commitment and the commitment of the current epoch, with exactly the recipients that the log names there.
- The user, invitation and escrow slots must be exactly the user, invitation and escrow recipients of the record.
- Every stored invitation (expired ones included, until revoked) needs its slot. A slot for a pending invitation whose expired row was already pruned is accepted and dropped.
- To turn escrow on or off, or to move an escrowed vault to a later key of the published escrow chain (§9.4), the request also carries the signed escrow entry of the owner (`escrow_entry`, type 8). The position of the record must be that entry.
- The server replays the log with its stored escrow chain at every check. So an escrow entry that names a key that the chain links to the previous key of the log verifies, and any other new key is refused.
- An owner device sends that entry with its next rotation when the log of the vault still names an older escrow key that the chain links to the key that the device pinned.
- In such a vault, a member removal first runs that rotation, then the removal (two epochs).
- The server appends the entry, sets the escrow flag of the vault, and creates the epoch in one transaction.
- A record or entry that does not verify is `INVALID_ARGUMENT`, and nothing changes.
- An E2EE `RemoveMember` carries the signed record of its `next_epoch` the same way (`record`). Its position must be the remove-member entry of the request: the record must be signed by an owner at that entry, and its recipients must be those of the log after it.
- The server appends the entry, creates the epoch with its record, and removes the member in one transaction.
- A missing record, another signer, another position or other recipients are `INVALID_ARGUMENT`, as for `RotateEpoch`, and nothing changes. The removal in a plaintext vault takes no `record`.
- The compare-and-set on the current epoch is unchanged. `RotateEpoch` on a plaintext vault is still `FAILED_PRECONDITION`.
- `ListEpochs` and `RotateEpoch` return the stored record of each epoch.

Commits:

- `CommitRevision` in an E2EE vault takes a ciphertext path and a client-computed `path_key` under the current epoch of the vault (§5, §6.2). The server never derives a `path_key` there.

Envelope encryption with multiple recipients:

- Each **user** has a hybrid post-quantum key pair, ML-KEM-768 + X25519 in the `mlkem768x25519` format of age (cipher suite 2, `docs/design/encryption.md`). It has a 32-byte private key (an age hybrid identity) and a 1216-byte public key.
- The private key is stored on the server, wrapped by a key derived from a user recovery passphrase (Argon2id).
- HKDF-SHA256 splits the Argon2id output into a `wrap_key` and an `auth_key`. The `wrap_key` wraps the private key and never leaves the device. The `auth_key` is a verifier that the device presents so that the server releases the wrapped key.
- The server stores only `SHA-256(auth_key)`, compares in constant time, and rate-limits failed attempts per user in PostgreSQL.
- Neither key can be derived from the other, so the server cannot unwrap the key.
- So a stolen session allows only a rate-limited online guessing attack. A dump of the database allows an offline attack at Argon2id cost per guess. A lockout ends with its window.
- Devices unwrap the key once and keep it in local storage. (Device-to-device linking and Shamir-split recovery are later enhancements.)

User key storage:

- `UserKeyService` stores the key pair of each user. Every procedure acts on the own key of the caller only, and none names a user. So another user can neither read, unlock nor replace it.
- The server stores the public key, the Ed25519 signing public key, the wrapped private key, the public parameters of the wrapping (suite, Argon2id memory, passes, lanes and salt) and `SHA-256(auth_key)`.
- The server never stores `auth_key`, the passphrase, the Argon2id output or the private key. It never logs `auth_key` or key material.
- `GetUserKeyParams` returns the public key and the parameters that a device needs to derive `auth_key`.
- `CreateUserKey` is create-only. A user who has a key gets `ALREADY_EXISTS`, and the stored key is unchanged. So two devices that enable encryption at once cannot replace each other's key.
- `UnlockUserKey` returns the wrapped private key only for the matching `auth_key`. A wrong one is `PERMISSION_DENIED` with reason `ERROR_REASON_WRONG_PASSPHRASE` and no key material.
- `ChangePassphrase` takes the current `auth_key` and the stored public key. It replaces the wrapped key, its parameters and the verifier in one transaction, as a compare-and-swap on the public key. A different public key is `FAILED_PRECONDITION` and changes nothing.
- Rotating or resetting the user key pair is out of scope.
- `CreateUserKey` takes the signing public key (`sign_public_key`, exactly 32 bytes) with the key pair. `GetUserKeyParams` and `UnlockUserKey` return it, empty for a key stored without one.
- `AddSignPublicKey` adds a signing public key to such a key once. It takes `auth_key`: a wrong one is `PERMISSION_DENIED` and is counted as below. Presenting the stored signing public key again succeeds without a change. Another one is `ALREADY_EXISTS` and changes nothing.
- `Member.sign_public_key` reports the signing public key of each member next to `public_key` (empty without one). So a member list gives the `bundle` of every keyed member (`docs/design/crypto.md`).
- A user without a key gets `NOT_FOUND`.
- `GetUserKeyParams`, `CreateUserKey` and `UnlockUserKey` also return `user_id`, the server user id of the caller (`Member.user_id`, a canonical lowercase UUID). It is the id that a signed genesis, redeem or leave entry must name for the caller. A device cannot learn it from its token, whose `sub` is the OIDC subject.

Passphrase attempt limit:

- Wrong `auth_key`s presented to `UnlockUserKey`, `ChangePassphrase` or `AddSignPublicKey` are counted per user in the `user_keys` row, under its row lock and with the database clock. So every replica sees one count.
- After 10 within one hour (the hour that starts at the first counted failure), every attempt is `RESOURCE_EXHAUSTED` with reason `ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED` and `ErrorDetail.retry_time` set to the end of the hour, even with the right `auth_key`.
- Refused attempts are not counted and do not extend the hour. A success does not reset the count.

User key input bounds and parameters:

- Inputs are bounded before the database is touched (`INVALID_ARGUMENT`): public key exactly 1216 bytes, `auth_key` exactly 32 bytes, wrapped private key 1 to 256 bytes, suite 2, salt exactly 16 bytes, and the Argon2id bounds below.
- A device remembers, per account, the Argon2id parameters that it saw (in its plugin data, kept on sign-out). It refuses to unlock or change the passphrase with parameters lower in memory, passes or lanes, before it derives or sends anything (`docs/design/encryption.md`, *Passphrase parameters*).

Anchor list storage:

- `UserKeyService` also stores the sealed anchor list of each user (`docs/design/encryption.md`, *Trust anchors*): opaque bytes and a version, which the server never opens.
- `GetAnchorList` and `PutAnchorList` act on the own list of the caller only and name no user.
- A user without a list reads version 0 and an empty list.
- `PutAnchorList` is a compare-and-set. It stores the list only when its version is the stored version plus one (1 for the first list). Otherwise it returns `FAILED_PRECONDITION` and leaves the stored list unchanged. So of concurrent writers of one version, exactly one succeeds.
- Inputs are bounded before the database is touched (`INVALID_ARGUMENT`): version 1 to 2^63 - 1, and sealed list 1 to 4,800,045 bytes, the sealed size of `MaxAnchors` (100,000) vaults. The request size limit (`VAULT_SYNC_MAX_REQUEST_BYTES`) also applies.

Plugin key manager:

- Enabling E2EE creates the key pair on the device (`plugin/src/core/keys`). The device calls `CreateUserKey` with only the public key, the signing public key, the wrapped private key, its parameters and `auth_key`.
- A new passphrase has at least 10 characters.
- The wrap binds the associated data `"vault-sync/v1/user-key" || public_key`, so a wrapped key cannot be passed off as the key of another key pair.
- After unwrapping, the device makes sure that the private key yields the stored public key and that the signing seed yields the stored signing public key. When the server has no signing public key, the device adds it (`AddSignPublicKey`).
- If a device gets `ALREADY_EXISTS` (another device enabled E2EE first), it unlocks the stored key with the passphrase that it was given instead of replacing it.
- Unlocking derives `auth_key` from the parameters that `GetUserKeyParams` returns, presents it to `UnlockUserKey`, and unwraps the released key on the device.
- A wrong passphrase and the attempt limit (with the `retry_time` of the server) are reported to the user.
- The unlocked key pair is cached only in the per-vault, device-local storage of Obsidian (`app.saveLocalStorage`, key `vault-sync-user-key`), never in `data.json`. So tools that back up or sync the vault folder never copy it.
- The cache holds the key with the server and the account that it belongs to. The key is never logged and is dropped on sign-out.
- A cached key is used only while its public key is the one that `GetUserKeyParams` returns. Otherwise the device reports the key as locked, says that the key of the server is not the one that it unlocked, and asks for the passphrase again.
- Only that unlock replaces the cached key. The cached key is never deleted silently.

Vault keys and key slots:

- Each **vault** has a symmetric vault key per **epoch**.
- `key_slots` hold the epoch key wrapped to every member, and to the escrow public key if escrow is enabled.
- Every wrapping is a binary age file to the hybrid ML-KEM-768 + X25519 key of the recipient, 1 to 2048 bytes. So the standard `age` tool opens an escrow slot with the escrow identity.
- User keys stored under suite 1 (X25519, 32 bytes) before migration 0019 stay stored as they are. The server accepts only suite 2 keys.
- The payload of a slot is the epoch key followed by `"vault-sync/v1/key-slot" || vault_id || epoch || recipient_kind || recipient_id`. The reader checks it, so the slot opens only as the slot of that vault, epoch and recipient.
- Every epoch stores a key commitment, `HMAC-SHA256(epoch_key, "vault-sync/v1/key-commitment" || vault_id || epoch)`. A recipient verifies it after unwrapping.
- Byte encodings: `docs/design/crypto.md`.

Ciphers and suites:

- Sub-keys are derived from the epoch key with HKDF: `content`, `path`, `path_key_secret`.
- Content and paths are encrypted with **XChaCha20-Poly1305**, with a random nonce, and the document id and the epoch of the revision bound as associated data.
- Every ciphertext carries a **suite version** byte so that the algorithms can change later.
- Every open authenticates the whole header (suite byte included) with the associated data of the caller. So a ciphertext with an unknown suite, a changed header or associated data, or a truncated tag fails closed.
- Suite 1 (byte formats in `docs/design/crypto.md`):
  - HKDF-SHA256 sub-keys.
  - XChaCha20-Poly1305 with a random 24-byte nonce from the platform CSPRNG.
  - Sealed box = ephemeral X25519, HKDF-SHA256 salted with both public keys, XChaCha20-Poly1305, refusing low-order keys.
  - HMAC-SHA256 `path_key`.
  - SHA-256 `blob_id` of the sealed content.
  - The private key of the user is wrapped under a `wrap_key`. HKDF-SHA256 derives the `wrap_key`, and an `auth_key` under a separate label, from the Argon2id output (default 64 MiB, 3 passes, 1 lane) of the passphrase in NFC (the libraries of §5).
  - A passphrase can use only code points assigned in Unicode 15.0. Any other passphrase is refused when it is set or used, so every device derives the same key.
  - The parameters are stored in the header and bounded (19–128 MiB, 2–8 passes, 1–4 lanes) before any derivation. So a stored value can neither weaken the derivation nor exhaust a device.

Member removal:

- **Member removal** creates a new epoch. Later revisions use it. Historical content is not re-encrypted (the removed member may already hold it).

Epochs and key slots:

- `VaultKeyService` stores epochs and slots as opaque bytes. The server never sees an epoch key.
- A new E2EE vault has no epoch (`current_epoch = 0`) and a pending rotation. An owner client creates epoch 1.
- Every epoch change is a compare-and-set on `vaults.current_epoch` under the vault row lock (which commits and membership changes take too). So of concurrent changes with the same `expected_epoch`, exactly one wins, on any replica. The others get `FAILED_PRECONDITION` with reason `ERROR_REASON_EPOCH_NOT_CURRENT` and adopt the epoch of the winner.
- The recipients of an epoch are exactly the members of the vault **who have a user key**, plus exactly one escrow slot in an escrow vault and none in a vault without escrow.
- A member without a user key cannot be wrapped to and is not required. Missing or extra recipients are `INVALID_ARGUMENT`.
- An owner's `RemoveMember` on an E2EE vault must carry `next_epoch` (a commitment and a slot for every remaining recipient, not the removed member). It commits the removal and epoch N+1 in one transaction. Without a valid one, the member stays.
- A plaintext vault takes no `next_epoch`.
- An owner cannot remove themselves from an E2EE vault with `RemoveMember`, because they would create, and so know, the epoch that is meant to exclude them. It is `FAILED_PRECONDITION`, names `LeaveVault`, and changes nothing.
- Self-removal from an E2EE vault goes through `LeaveVault`. In a plaintext vault, an owner can still remove themselves with `RemoveMember`.
- `LeaveVault` (no owner client involved) sets `rotation_pending`. An owner client then calls `RotateEpoch(expected_epoch = N)`, which creates N+1 and clears the flag.
- `CommitRevision` carries the `epoch` of the revision: 0 in a plaintext vault, and the current epoch of the vault in an E2EE vault. It is checked under the vault row lock after the idempotency check, so a retry of a commit applied before a rotation gets its revision back. Any other epoch is `FAILED_PRECONDITION` with reason `ERROR_REASON_EPOCH_NOT_CURRENT`.
- A pending rotation does not change the current epoch. So commits under it continue until the next epoch exists.
- A new member gets slots for every epoch. `ListMissingSlots` (owner-only) lists every pair of an epoch and a member with a user key that has no slot, with the public key of the member, until an owner grants it with `AddKeySlots`. `AddKeySlots` keeps an existing slot rather than replacing it.
- `ListKeySlots` returns the own slots of the caller. `ListEpochs` returns the epochs with their commitments and the key state of the vault. Both are open to every member, viewers included.
- With `recipient_kind = KEY_RECIPIENT_KIND_ESCROW`, `ListKeySlots` returns the escrow slots of the vault instead, to editors and owners only (a viewer gets `PERMISSION_DENIED`). So the import can open them with the escrow identity. An escrow slot is useless without that identity.
- No call returns the slots of another member.
- `ListMembers` reports the user public key of each member.
- Inputs are bounded before the database is touched (`INVALID_ARGUMENT`):
  - commitment exactly 32 bytes;
  - wrapped key 1 to 256 bytes;
  - user recipient ids canonical lowercase UUIDs;
  - escrow recipient ids 1 to 255 printable ASCII bytes (the key-slot format allows 255);
  - at most 101 slots in a new epoch, and 1 to 1000 per `AddKeySlots`;
  - no duplicate slots;
  - list pages of 100 by default and at most 1000, cut to the send limit.

Re-encrypting history and retiring epochs:

- Three owner-only `VaultKeyService` calls serve the re-key job (`docs/design/encryption.md`, *Re-encrypting history*). Editors, viewers and non-members are refused as for every owner-only call.
- `ListStaleRevisions(vault_id, page_size, page_token)` pages through every retained revision whose epoch is not the current epoch, in `seq` order and from one snapshot per page. That includes tombstones, folders and conflict copies, and the epoch 0 history of a converted vault too.
- Each entry has the stored sealed path, the content reference and the epoch of the revision, and the current epoch that the job re-seals to.
- It is empty on a plaintext vault. Pages are capped at 1000 revisions (default 100) and by the response size limit.
- `ReplaceRevisionCiphertext(revision_id, from_epoch, to_epoch, path, content_ref)` replaces the stored sealed path and content reference of one revision with ones sealed under `to_epoch`. It runs under the vault row lock that commits and rotations take.
- It replaces them only while the revision is still at `from_epoch` and `to_epoch` is the current epoch. Otherwise the rewrite is skipped and reported (`replaced = false`), and the job restarts with the newer target.
- It changes nothing else: not the `seq`, document or tombstone flag of the revision, not the `path_key` of the document, and not which revision is the head. So sync is unaffected.
- The new content must be a complete blob of the vault, given exactly when the revision has content.
- The replaced blob is released, so the blob garbage collector (§11) deletes the old ciphertext once no revision references it.
- `RetireEpoch(epoch)` refuses epoch 1 (its key derives every `path_key`), the current epoch, and any epoch that a stored revision still uses (`FAILED_PRECONDITION`).
- Otherwise it deletes the key slots of the epoch, for every recipient, and marks the epoch retired. Retiring it again changes nothing.
- The commitment and signed record of the epoch stay, and `ListEpochs` reports `retired`. So devices can still verify the chain of epoch records.
- A retired epoch needs no slots. `ListMissingSlots` skips it. `AddKeySlots`, `CreateInvitation` and `RedeemInvitation` accept slots for it but do not store them.

Plugin vault key manager:

- `plugin/src/core/keys` keeps the epoch keys of an E2EE vault on the device.
- Each sync reads every page of `ListEpochs` and `ListKeySlots`. It unwraps each slot of the user that it does not hold yet with the unlocked user key.
- It uses a key only once the key matches the key commitment of its epoch. A slot that does not open, has no commitment or does not match is refused and reported to the user, never used.
- A held key whose epoch commitment changes is refused too. The key of an epoch never changes, so the device then stops using and sharing it.
- The keys are cached only in the device-local storage of Obsidian (key `vault-sync-vault-keys`), never in `data.json`, for the server, account and vault that they belong to. They are never logged, and are dropped on sign-out together with the user key.
- Only an owner device rotates and grants.
- When the vault is rotation-pending (a new vault has no epoch yet, or a member left), an owner device creates the next epoch with `RotateEpoch(expected_epoch = current)`.
- The next epoch has a fresh random key, wrapped for every member that `ListMembers` lists with a user public key. A member without one is skipped.
- If the device gets `ERROR_REASON_EPOCH_NOT_CURRENT` because another owner device won, it re-reads and adopts that epoch without creating another.
- When an owner removes a member, the device sends `RemoveMember` with the next epoch built the same way, without the removed member. It retries over a newer epoch at most three times when another epoch change wins.
- Once a sync is done reading, an owner device grants every `ListMissingSlots` entry for an epoch whose key it holds, in `AddKeySlots` batches of at most 1000.
- The key of a new epoch is kept once the server accepted it. If the response is lost, the own slot of the device in that epoch still holds it.
- Until the device holds the key of every epoch up to the current one, the member sees "Waiting for an owner to share the vault key."

Implementations:

- `@noble/ciphers`, `@noble/curves`, `@noble/hashes` in TypeScript (pure JS, audited, identical on Electron and Android WebView). `golang.org/x/crypto` in Go.
- A shared set of **cross-language test vectors** in `testdata/crypto/` must pass in both (`internal/e2ee`, `plugin/src/core/e2ee`). The Go tests generate them, including published known answers for the primitives and ciphertexts that must be refused.
- With E2EE, the server cannot merge, search, or render content. It does none of these anyway (§4).

### 9.4 Escrow for plaintext backups

What escrow is:

- A vault with `escrow = true` also wraps each epoch key to a deployment-wide **escrow public key**.
- The escrow private key exists only in the Secret of the export job, which is never mounted into the internet-facing server. So a compromise of the API server, PostgreSQL or S3 exposes only ciphertext.
- The export job decrypts and writes plaintext for tape archival.
- Escrow is chosen at vault creation and shown clearly in the UI.
- Optionally, the escrow private key can be split with Shamir secret sharing for offline disaster recovery. The automated path does not use this.

The escrow bundle and chain:

- The escrow key comes with an Ed25519 escrow signing key (`VAULT_SYNC_ESCROW_SIGNING_KEY`). Together they are the escrow bundle of the deployment.
- The escrow chain is the root bundle and the escrow rotation statements after it, each signed by the signing key of the previous bundle. It is stored in PostgreSQL (`escrow_chain`), and `GetServerInfo` publishes it (`docs/design/encryption.md`, *Escrow key*).
- On the first start with an escrow key, the configured bundle becomes the root.
- At every start, the chain must link in order from the root, and its head must be the configured bundle. Each point is a signed rotation or a reset point that names the previous bundle, and no bundle occurs twice. Otherwise the server stops.

What the server publishes:

- `GetServerInfo` publishes the escrow public key (`VAULT_SYNC_ESCROW_RECIPIENT`, an age hybrid recipient), the id of the key and the escrow default (`VAULT_SYNC_ESCROW_DEFAULT`, on unless configured otherwise).
- The key id is `sha256:` and the hex SHA-256 of the 1216-byte key. It is the `recipient_id` of escrow slots.
- A client refuses a published key whose id does not name it.
- The escrow toggle of the plugin starts at the default, and the owner can turn it off.

Pinning on the client:

- The plugin pins the current escrow bundle per server the first time it sees it, after it checks the published chain.
- Afterwards, it accepts a different current bundle only when rotation statements, each signed by the key that it replaces, chain it to the pinned one. It then moves the pin.
- It also pins the length and head hash of the chain that it verified. A published chain that does not extend that prefix is a hard stop for escrow.
- Every device verifies the membership log of a vault with the published chain. So a log that an owner moved to a chained key verifies (§9.3, `RotateEpoch`).

The escrow fingerprint:

- The **escrow fingerprint** is SHA-256("vault-sync/v1/escrow-fingerprint" || escrow_bundle), over the encoded bundle. It is shown like the key fingerprint of a member (`docs/design/crypto.md`).
- The operator prints it with `vault-sync-server escrow fingerprint`, which needs no database, network or private key, and publishes it out of band (`docs/encryption.md`).
- The plugin shows the fingerprint of the pinned bundle next to the escrow toggle when a vault is created.
- In the fingerprints of an escrowed vault, it shows the bundle that the verified log of the vault names. It also shows the fingerprint of the pinned bundle when the two differ.

Escrow reset:

- A change of the current bundle that rotation statements, each signed by the key that it replaces, do not chain to the pinned bundle (for example, after an unsigned reset point in the chain) is an **escrow reset**.
- The plugin wraps no key to the new bundle until the user accepts it in a prompt. The prompt shows the old and the new escrow fingerprint and needs the last group of the new fingerprint typed.
- Declining keeps the vaults that the user owns escrowed to the previous key.
- An accepted reset reaches each escrowed vault only through an owner-signed *escrow reset* log entry sent with a rotation. Until then, the new epochs of the vault stay escrowed to the bundle that its log names, and the server accepts that slot.
- A malicious server that holds a stolen escrow signing key can still move a device that never saw the reset point. Only the fingerprint comparison protects it. This risk is accepted (`docs/design/encryption.md`, *Escrow fingerprint and escrow reset*).

Escrow key rotation:

- During an escrow key rotation, the export job writes through the job-only `EscrowJobService`. It appends the next rotation statement and replaces escrow slots conditionally (§5).
- `EscrowJobService` is authenticated only by a static bearer token (`VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`, compared in constant time). User tokens are refused. Without a token configured, the service refuses every call.

## 10. Live collaborative editing (Phase 5)

The v1 protocol has the hooks for this from the start: stable document ids, the `kind` field, the multiplexed WebSocket, and an append-only log per document.

- The state of a `yjs` document is its ordered `yjs_updates` log plus periodic snapshots. For E2EE vaults, each update is encrypted, and the server stores and relays opaque bytes.
- **Conversion** of a `text` document to `yjs` happens **exactly once**. It is a server-side compare-and-set on `documents.kind`, done by a single elected client that holds a lease from the server. If two clients each initialize a `Y.Text` from the same file, the content is duplicated (the classic Yjs bug). This must be impossible.
- The plugin binds `Y.Text` to the CodeMirror 6 editor of Obsidian (`y-codemirror.next`) and to the file on disk. Edits that arrive outside the editor (other plugins, `processFrontMatter`, external editors, git) are diffed into the `Y.Text`.
- Awareness (cursors, presence) is ephemeral over the WebSocket and is never persisted.
- **Compaction** folds the update log into a snapshot. Plaintext and escrow vaults can compact on the server (for escrow vaults, the export job can do it). Other E2EE vaults compact on clients. The compaction runtime is an open question for Phase 5, because no Go Yjs implementation is mature.

## 11. Retention and history

Policy:

- Revisions are append-only. A retention policy purges old **non-head** revisions, including tombstones that are not the head.
- The policy is deployment-wide (`docs/admin/history-and-retention.md`), with per-vault overrides that the operator sets (below).
- By default, every revision younger than 90 days is kept. Older revisions are thinned to the newest revision of each document per UTC day until they are a year old, and to the newest per ISO week (from Monday, UTC) after that.
- Ages are measured by the database clock from `created_at`. A revision is in the daily or the weekly zone, never both, so a day and the week that starts on it are separate buckets.

Heads and purge markers:

- **The head revision of a document is never purged**, however old, and that includes a head tombstone. A deleted document keeps its tombstone indefinitely. So it stays findable and restorable, and a client that was offline for longer than the policy still learns of the delete instead of resurrecting the document.
- `ListChanges` skips purged revisions, so a cursor can skip `seq` values.
- The purge keeps the `seq` and `anchor` of each purged revision in `purged_revisions` (§5), in the transaction that deletes it. So every snapshot sees either the revision or its marker, on any replica.
- So a client whose cursor (or own commit above it) is on a purged revision passes the anchor check and pulls on as usual (§6.1). A document that it did not change takes the newer heads, remote deletes included.
- Revisions purged before migration 0008 have no marker (§6.1).

Marker horizon:

- Each marker records its purge time (`purged_at`, migration 0009). The retention job deletes the markers older than `VAULT_SYNC_RETENTION_PURGE_MARKER_HORIZON` (default 365 days, at least one day). So one horizon of purges bounds `purged_revisions` (principle 4).
- Pruning is bounded per run: at most 100,000 markers, in statements of 1,000, oldest first. So the table stays bounded by one horizon of purges only while the sustained purge rate stays below about 100,000 revisions per hour per replica. A run starts every hour on each replica, and one run can purge up to 1,000 x 1,000 revisions. That rate is far above the expected scale. If `vault_sync_retention_purge_markers_pruned_total` grows by the cap every run, pruning falls behind.
- Pruning is safe on concurrent replicas. Each statement locks the rows that it deletes with `SKIP LOCKED`. So replicas take disjoint markers, never wait for each other, and together delete what one run would.
- Pruning never loses an acknowledged write (principle 1). Only a device that did not pull since the purge consults a marker. A purged revision always has a newer revision of its document, so any later pull moves the cursor (and the own commits of the device) past it.
- Once its marker is gone, such a device gets a false-positive `diverged` and resyncs (§8). It pulls the heads of the server over the notes that it never changed at revisions that it only pulled. It merges every other note that it holds with the version of the server. Nothing is lost. But a note that it last committed itself and that another device deleted comes back (an edit wins over a delete), and a note whose merge base was purged gets a conflict copy.
- Deleting a marker can only turn a passing anchor check into `diverged`, never the reverse. So pruning never hides a restore.

Per-vault overrides:

- The operator can give a vault its own `keep_all` and `keep_daily` with `vault-sync-server retention set|unset|list` (`docs/admin/history-and-retention.md`). They are stored in `vault_retention`. A vault without an override follows the deployment-wide policy.
- No API or plugin setting exists for it (principle 4). Only the operator, who already holds the database, can shorten the history of a vault, and purges are irreversible.
- `set` refuses a `keep_all` below one day or below `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL` of the operator, a `keep_daily` below `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY`, and a `keep_daily` below its `keep_all`. The checks of the table refuse a non-positive `keep_all` and a `keep_daily` below it.
- The purge query joins the override and applies `coalesce(override, deployment)` per revision. That is one policy per document, because a document belongs to one vault. The query bounds its scan by the shortest `keep_all` in force, so the `created_at` index still applies.
- Overrides need no state per replica: every replica reads them in each run.
- Replicas of a release before migration 0010 ignore overrides. So overrides are set only after a rollout completes (`docs/admin/upgrades.md`).

Parent links after a purge:

- A purged revision is almost always the parent of another. In the same transaction, the purge re-parents the child onto the parent of the purged revision. So `parent_rev_id` keeps naming a revision that exists (the foreign key is unchanged and still enforced): the nearest retained ancestor, or none once every older revision is gone. History stays a connected chain.
- This is compatible with "append-only". Revisions are never added out of order or changed by clients. The only later change to a revision is this rewrite of its parent link when an ancestor is purged. Content, path, tombstone flag, device and time never change.
- A commit retried after its base was purged is still the same commit (§6.2). Its base no longer exists, so it matches whatever parent the revision has now.

Blob garbage collection:

- A blob row starts released: `released_at` defaults to the time it is stored, because `CommitBlob` stores a blob before any revision references it. Each purge sets `released_at` on the blobs that its revisions referenced.
- A blob that no revision references, and that was released longer ago than the grace period (default 24 hours), is collected in two steps.
- Step one: the collector deletes its row and writes a `blob_deletions` record, in one transaction under `FOR UPDATE SKIP LOCKED` on the row. A commit holds `FOR KEY SHARE` on the blob that it references until it commits, so the collector skips a blob that is being committed. A commit that starts while the blob is being collected finds it not complete (`FAILED_PRECONDITION`, and the client uploads it again).
- Step two: the collector deletes the S3 object and then the record, under `FOR UPDATE SKIP LOCKED` on the record. If the blob is complete again, it leaves the object alone and drops the record. While an upload of the blob is in progress, the record stays for a later run.
- `CommitBlob` waits for a deletion of its blob that is in progress before it writes the object, so a re-uploaded object is never deleted.
- Four S3 idle timeouts (`VAULT_SYNC_S3_IDLE_TIMEOUT`) bound each object deletion, retries included. So even a store that keeps sending a byte now and then holds the lock of the record, and that commit, no longer than that.
- The row goes first, so that no revision can ever reference a blob whose object is gone.
- The grace period lets a client that just read a purged revision restore its content without uploading it again.
- A blob that never had a referencing revision (an upload whose revision was never committed) is collected the same way, with the grace period counted from its upload. A blob that a revision references when the collector looks is kept and is no longer released.

Concurrency:

- The retention job runs on every replica (§12). Each document is purged in its own transaction under `FOR NO KEY UPDATE SKIP LOCKED` on the document row. So concurrent purges skip each other, and the first pass of a purge never waits for a commit to the document.
- The documents that it skipped are purged again afterwards, one at a time, while the run holds no other lock, waiting for each lock (see incremental scans below). A commit waits at most for the bounded purge of one document.
- Every step is idempotent and bounded per run.

Incremental scans:

- A revision only becomes purgeable when it, or a newer revision of its bucket, crosses the 90-day or one-year age of the policy.
- So a run that found fewer candidate documents than its bound, and purged each of them fully, records the policy and the database time that it started in the single-row `retention_scans`. Later runs under the same policy only consider documents with revisions whose `created_at` crossed one of the two ages since then (indexed on `created_at`).
- A document that a run skipped because it was locked (a commit, or a purge of another replica) is purged again, waiting for the lock, before the run counts as complete.
- Replicas record their own complete scans. The record only moves forward. A run under another policy (a configuration change) scans every document and replaces the record.
- The record also holds a digest of every per-vault override, read before the candidate query of the scan. Setting, changing or removing any override makes the next run, on every replica, a full scan, because a changed override can make revisions purgeable that crossed no age.
- Incremental runs also consider documents with revisions that crossed the own ages of an overridden vault.

History and restore:

- Users can browse the history of a document and restore any revision. A restore is a new revision: a `CommitRevision` based on the current head with the `content_ref` of the old revision, and `deleted = false` to restore a deleted document.

Client history and restore. The engine pages `GetDocumentHistory` into entries, each with:

- The time of the revision (`create_time`).
- The user (`user_id`), named by `user_names` in the response. That lists each user who committed a revision on the page, once, by their display name: the `name` claim of the identity provider, or else `preferred_username`. The server records it from the latest token of the user (`docs/design/sharing.md`, Attribution).
- The device (`device_id`), named by `device_names` in the response. That lists each device that committed a revision on the page, once, by its registered name. Every member of the vault, a viewer included, sees them. A non-member gets `NOT_FOUND`, as for any history. A device that the server does not name is shown by id.

Preview and restore rules:

- The engine downloads any revision for a preview. If the revision is larger than 256 KiB, it downloads only the first 256 KiB, in `DownloadBlob` ranges. That start cannot be checked against the content hash, so it is only shown, never written or uploaded. A revision no larger is downloaded whole and verified.
- A restore commits the `content_ref` of the revision on the current head, at the path of the head, with `deleted = false`, and then syncs, so the disk shows the result. A restore never moves a document, except as below.
- A local edit that is not pushed yet meets the restored head through the decision table like any remote change (`docs/design/engine.md` §5).
- If the head moves meanwhile, the engine reads it again and retries the commit on it.
- `FAILED_PRECONDITION` without a `Document` detail means that the blob was garbage-collected after a purge. The engine uploads the content again and retries. It uploads from the preview of the user if that is the whole revision and hashes right, or else from a download of the whole revision. If neither has it, the restore fails with nothing committed.
- `ALREADY_EXISTS` (the path of a deleted document now belongs to another live document) fails the restore too. The user can then restore it at another path that they choose: the same commit with that path. The client first checks that path as it checks the path of a new document (§6.2), against the platform (§8) and against the sync scope of the vault. A path that would be refused, cannot be written here, or would not sync fails with nothing committed.
- So does `INVALID_ARGUMENT` for a deleted document whose path contains a `\` (§6.2). Nothing is committed, and its history stays readable.
- The plugin restores a revision of a note that it holds (per-note history, `docs/design/engine.md` §10). It has no list of deleted files.

## 12. Operations

Build and deployment:

- The server is a single static Go binary. One OCI image (server and export) is built by Nix (`streamLayeredImage`, with the pinned Go of the flake, checked with `govulncheck -mode=binary`), mirroring tape-archiver.
- The Helm chart under `deploy/charts/vault-sync` is built on the bjw-s `common` library chart. It renders the server Deployment and one Service (ports `http` and `metrics`). On request, it also renders the export CronJob, a ServiceMonitor, an HTTPRoute and the Grafana dashboards shipped in the chart (grafana-operator `GrafanaDashboard`s or sidecar ConfigMaps). Each is named after the release.
- The chart computes only what the server needs to run correctly. It sets no scheduling or capacity policy (PodDisruptionBudget, resources, spread). It checks `config` against `values.schema.json`. It references Secrets that the operator creates, and creates none.
- The chart mounts the escrow Secret (§9.4) into the export job only. It refuses to render any values that would put the Secret into the server, and `make chart-lint` checks this.
- Deployment: `docs/admin/install.md`.
- Configuration is by environment variables, documented in `docs/admin/configuration.md`.

Observability:

- **JSON structured logs** (`log/slog`), Prometheus metrics on a separate port, `/healthz` and `/readyz`.
- Service-wide metrics are served on a third port. They are counts over the whole deployment, named `vault_sync_service_*`, with no label per user, vault or device. Each replica refreshes them from PostgreSQL in the background, so a scrape never queries the database (`docs/admin/monitoring.md`).
- Among them is the last successful retention run. The retention job records it in `maintenance_runs` (migration 0028) after each run without errors on any replica.
- Among them is also the last successful export. The export records the outcome of every run in the single-row `export_status`. The role of the export has `INSERT`/`UPDATE` on that table and only reads every other table (`docs/admin/backup-and-restore.md`).
- PostgreSQL client certificates and S3 credentials are read again from disk when they change.

Schema migrations:

- Migrations are embedded (`internal/store/migrations`) and run on startup behind a PostgreSQL advisory lock, each in its own transaction, recorded in `schema_migrations`.
- Migrations are forward-only and must be backward-compatible with the previous release.
- Released migrations are never edited. The runner rejects a changed name for an applied version.
- Migrations can use any feature of PostgreSQL 14, the minimum supported version.
- A migration that rebuilds an index holds an exclusive lock on its table until it commits.

The lock and rollout effects of each migration:

| Migration | Effect |
|---|---|
| 0003 | Defines its index function with a SQL-standard `RETURN` body, which binds its references at creation, so `search_path` cannot change what the index computes. Rebuilds the live-path index on `documents`, which briefly blocks commits and reads of documents on every replica while it is applied. |
| 0004 | Builds the live-folder GIN index (§5). It holds a lock that blocks commits, but not reads, while it is applied. |
| 0005 | Builds the `revisions` indexes that retention needs (§11). They block commits, but not reads, while it is applied. |
| 0006 | Adds `revisions.anchor` (§6.1) and backfills it in the same transaction. Its `ADD COLUMN` takes an exclusive lock (`ACCESS EXCLUSIVE`) on `revisions`. It holds the lock through the `UPDATE` of every revision and the scan for `SET NOT NULL`, until it commits. So while it is applied, every commit, `ListChanges` and retention run blocks on every replica of both releases. The pause grows with the number of revisions. |
| 0007 | Sets a default on `blobs.released_at`. This takes an exclusive lock on `blobs` that it holds until it commits, through its backfill of unreferenced blobs and its build of the `revisions (created_at, document_id)` index. While it is applied, every blob read and write blocks on every replica, the previous release included (downloads, `CommitBlob`, the blob checks of `CommitRevision`). Commits also block on the index build. |
| 0008 | Only creates the empty `purged_revisions` table (§11), which the previous release never names. While the retention job of the previous release still runs during a rollout, it purges without writing markers. That costs a device whose cursor was on such a revision one false-positive resync (§6.1). Markers cannot be backfilled for revisions purged before 0008, because their anchors are gone. |
| 0009 | Adds `purged_revisions.purged_at` with a `now()` default (no table rewrite on PostgreSQL 11 and later) and its index. The previous release never names the table. Markers written before 0009 get the time of the migration, which only delays their pruning. Its `ADD COLUMN` takes an exclusive lock (`ACCESS EXCLUSIVE`) on `purged_revisions` that it holds through the index build until it commits. While it is applied, purges and the anchor check of every `ListChanges` with a cursor (§6.1, a read of the table) block on every replica that knows the table. That is brief: 0008 was never released without 0009, so the table is empty or small when 0009 runs. |
| 0012 | Adds the nullable `devices.registration_id` and a unique index on the small `devices` table (§9.2). The previous release never names the column, and registers every call as a new device until every replica runs the new release. |
| 0016 | Allows the `folder` document kind and drops the `revisions` check that every live revision has content. A check on `revisions` cannot see the kind of the document, so `CommitRevision` enforces it. Re-adding the kind check scans `documents` under an exclusive lock that blocks commits and document reads until it commits. The previous release refuses `DOCUMENT_KIND_FOLDER` commits, and lists a folder revision with kind `DOCUMENT_KIND_UNSPECIFIED`, until every replica runs the new release. |
| 0019 | Widens the `user_keys.public_key` check to 32 or 1216 bytes and the `key_slots.wrapped_key` check to 1 to 2048 bytes (cipher suite 2). Re-adding each check scans its small table under an exclusive lock until it commits. The previous release keeps accepting only suite 1 keys, which the new checks still allow. |

**High availability (§3).** Every replica must obey these rules, and every new feature must keep them:

- **Stateless replicas.** A replica keeps no state per client that lives only in its own process. Sessions, cursors and upload progress live in PostgreSQL (and S3). Consecutive requests of one client, including the chunks of one upload and its commit, can land on different replicas, and must behave exactly as against one. Caches that every replica can rebuild (the OIDC key set, credentials) are fine.
- **Coordination through PostgreSQL only.** Advisory locks, `SELECT … FOR UPDATE SKIP LOCKED`, conditional updates and `LISTEN/NOTIFY` are the only mechanisms across replicas (principle 5): no new infrastructure.
  - So realtime fan-out (§6.4) must reach clients connected to any replica.
  - `LISTEN` needs a session that lasts. So the server needs a direct PostgreSQL connection or a pooler in session mode. Transaction or statement pooling (such as that of PgBouncer) is unsupported.
  - Every commit transaction issues `NOTIFY`, and PostgreSQL serializes the commits of notifying transactions on one database-wide lock. This is accepted at the expected scale.
- **Background jobs run on every replica** and must be safe to run concurrently. Their combined effect equals one run. If a replica finds that another got there first, that is not an error, and it is not logged as one.
- **Retry-safe RPCs.** A replica can be killed without warning (`SIGKILL`) at any point. So every RPC must be safe for the client to retry on another replica: the retry succeeds, and no acknowledged write is lost or applied twice. Blob uploads are content-addressed and resumable. Revision commits are deduplicated by their revision id, which the client chooses.
- **Graceful drain.**
  - On `SIGTERM`, a replica fails `/readyz` at once and keeps serving for a configurable delay (`VAULT_SYNC_SHUTDOWN_DELAY`). It closes each connection after its response, so traffic moves to other replicas before any connection is refused. Idle keep-alive connections stay open until the delay ends, so a request sent on one as the signal arrives is not reset.
  - Then it stops accepting connections, and closes open WebSockets with close code 1001 ("going away") so that clients reconnect elsewhere.
  - In-flight RPCs get a configurable drain timeout (`VAULT_SYNC_SHUTDOWN_TIMEOUT`). The process exits 0 after a clean drain.
- **Database connection resets** (a PostgreSQL restart or switchover) are tolerated. Connections are checked before use and replaced, and the client retries a request that fails mid-query. Managing PostgreSQL failover is the concern of the operator (CloudNativePG).
- **Rolling upgrades.** The previous and the new release serve side by side during a rollout. This is why migrations must be backward-compatible with the previous release (above). An integration test runs both releases against one database. A check that a release adds holds only once every replica runs it. For example, replicas of a release before migration 0004 still accept file/folder collisions (§5) until the rollout completes.
- **Server before plugin.** Users update the plugin independently of the server, so a plugin can be newer than the server that it syncs with. A plugin with purge markers, against a server without them, sees every retention purge of a revision at the cursor of a device (or its own commit above it) as divergence, and resyncs (§8). Nothing is lost. But a note that another device deleted can come back after a retention purge, and a note whose merge base was purged gets a conflict copy. This lasts until the server is upgraded. So operators upgrade the server first (or together with the plugin), as `docs/admin/upgrades.md` recommends.
- The recommended deployment (at least 2 replicas, a PodDisruptionBudget, readiness and termination-grace ordering) is documented in `docs/admin/configuration.md`.

Bounded resource use:

- Max request size, max chunk size, decompression limits, pagination caps, and rate limits per user.
- Each user can have at most `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` authenticated RPCs in flight per replica, counted from authentication until the response is fully written. A further call is rejected at once, before its handler runs (no queueing), with `RESOURCE_EXHAUSTED` and an `ErrorDetail` of reason `ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS`.
- The client backs off. After the server refuses a sync call with `RESOURCE_EXHAUSTED`, the next pull or push of the engine waits before it calls the server. The wait uses the equal jitter of the realtime reconnect (§6.4): half of a ceiling plus a random part of the other half. The ceiling starts at 1 s and doubles with each consecutive refusal, up to 60 s. A pull or push that succeeds resets it. When the wait ends, the engine pushes. Refused operations stay pending and are retried with their revision ids. The server sends no retry hint.
- The limit is an in-process count keyed by user ID, dropped when the last call of the user ends. So it needs no state across replicas, and no state that a client sees is lost with a replica.
- The same size bounds responses as requests (the bytes sent).
- `VAULT_SYNC_WRITE_TIMEOUT` bounds writing each API response, counted from the first byte of the response, so a client that stops reading releases its connection. It does not bound the time before the response starts, so a long commit is not cut short (§6.2).
- The upgraded realtime WebSocket is exempt, and is bounded by its own pings and send queue (§6.4).
- Concurrent `/readyz` checks share one database ping.
- Every object-store request fails once its connection makes no progress in either direction for `VAULT_SYNC_S3_IDLE_TIMEOUT` (the S3 SDK retries a bounded number of times). So a store that stops answering cannot hold a request, a compose slot or the cleanup routine forever. The bound is on silence, not on a whole operation, so a long commit or export that keeps moving is not cut short (§6.2).
- Each cleanup run is cut short when the next is due.

Plugin releases:

- The plugin is distributed through GitHub releases (installable with BRAT) that carry `main.js`, `manifest.json` and `styles.css`. `make release` cuts them (a dry run unless `PUSH_ALL=true`).
- The tag of a release, its name and the version in its `manifest.json` are the same semantic version, without a `v`, as Obsidian and BRAT require. The image and chart use the same version.
- Publishing to the Obsidian community catalog is a non-goal for now.

## 13. Testing strategy

| Layer | Tooling | Runs in |
|---|---|---|
| Go unit | `go test -race`, testify | `make test`, CI |
| TS unit | vitest | `make test`, CI |
| Server integration | real PostgreSQL + S3-compatible store via `docker compose` | `make test-integration`, CI |
| **Acceptance** | One test per scenario in `docs/acceptance/phase-N.md`, named `[AC-nn] …` (Go: `TestACnn…` or an `[AC-nn] …` subtest, see `docs/testing/acceptance.md`). It runs end-to-end in Obsidian, or as a server integration test where no Obsidian is involved. `make acceptance` runs them and prints the scoreboard. AC-25 is the seeded three-device convergence test. | `make acceptance`, CI |
| Crypto vectors | shared `testdata/crypto/` vectors | Go + TS unit tests |
| Path vectors | shared `testdata/paths/` vectors: `path_key` (`vectors.json`) and validity (`validity.json`) | Go + TS unit tests; validity also through `CommitRevision` (integration) |
| Plugin e2e | `wdio-obsidian-service`: WebdriverIO drives the built plugin in a real Obsidian whose version is pinned (Renovate bumps it), against a real `vault-sync-server` that an `e2e`-tagged Go driver starts. The specs check that the plugin loads, that a second vault opens, and that the server is reachable with a test token. Through a test-only harness plugin, they run the `VaultAdapter` conformance suite inside Obsidian against the Obsidian adapter. The `Journal` conformance suite runs there too, against the IndexedDB journal on the IndexedDB of Obsidian. The specs also cover editor-safe writes to an open note, that startup indexing is not reported as changes, that the journal of each vault is keyed by its own vault id, and that disabling and re-enabling the plugin resumes sync from the IndexedDB journal. The suite also runs in emulated mobile mode. See `docs/testing/e2e.md`. | `make test-e2e` (Linux, headless via xvfb, in the dev VM); CI on Linux, Windows and macOS, plus emulated mobile |
| Android | The checklist in `docs/testing/android.md`. Each check that the layers above can make is an automated test there, including that the manifest allows mobile and that the bundle loads no Node or Electron module. Only what needs a physical device is manual: BRAT on Android, Android pausing or killing the app, real network changes, battery. The Android emulator job runs the real Android app (`docs/testing/e2e.md`, "Android emulator job"). | CI for the automated checks; a human, on a device, before each release |

## 14. Repository layout

```
cmd/vault-sync-server/   server + export and retention subcommands
internal/                server packages (api, store, blobstore, auth, realtime, export, config, …)
proto/vaultsync/v1/      protobuf API definitions (source of truth for the protocol)
gen/                     generated Go code (committed)
plugin/                  Obsidian plugin (npm project; nested empty go.mod fences it out of ./...)
  src/core/              pure sync engine, no `obsidian` imports
  src/obsidian/          Obsidian adapter + UI
  src/gen/               generated TS protocol code (committed)
  test/e2e/              e2e suite in real Obsidian (wdio specs, test-only harness plugin, fixture vaults)
testdata/crypto/         cross-language crypto test vectors (E2EE suite 1, §9.3)
testdata/paths/          cross-language path_key (§5) and path validity (§6.2) vectors
deploy/charts/           Helm chart(s)
deploy/compose/          docker compose stack for integration tests (PostgreSQL + S3-compatible store)
docs/                    operator + design docs; docs/agents/ holds the agent playbooks
nix/                     Nix package/image definitions
.claude/                 agent definitions and slash commands
```

## 15. Phases

GitHub milestones and parent issues track the work. A phase is done when its acceptance checklist, approved by the owner, passes. A security review runs where a phase touches the attack surface.

1. **Foundations:** protocol schema, server core (store, blobs, revisions, auth, authz), simulation harness skeleton, CI.
2. **Single-user file sync:** a new plugin engine (`docs/design/engine.md`) plus the adapter for desktop and Android, conflicts, history and restore, Markdown import, and the Helm chart. It is done as `docs/acceptance/phase-2.md` defines: the checklist passes on `master`, a security review and a narrow bug hunt ran and their critical and high findings are fixed, and `0.2.0` is released.
3. **Vault sharing:** membership management, invitations, roles in the UI.
4. **End-to-end encryption:** key hierarchy, escrow, export decryption, crypto vectors, independent crypto review. Until then, creating an E2EE vault is rejected (§9.3).
5. **Live collaborative editing:** Yjs documents, conversion, editor binding, awareness, compaction.

## 16. Open questions

Issues labelled `question` track them. The planner agent logs the decisions it makes on its own on the decision-log issue, for later human review.
