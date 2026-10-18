# vault-sync — Specification

This is the authoritative technical reference for vault-sync: its purpose, design principles, architecture, data model, sync protocol, encryption scheme, and repository layout. It is a living document — update it in the same change that alters any behavior it describes. Where this document says "decision", the reasoning is recorded so that a later change can revisit it deliberately rather than by accident.

This project is bootstrapped to mirror the conventions of [`tape-archiver`](https://github.com/solidDoWant/tape-archiver) and [`media-processor`](https://github.com/solidDoWant/media-processor): Go, Nix-reproducible builds, issue-driven development with Given/When/Then acceptance criteria, and a testing-first philosophy.

## 1. Purpose

vault-sync is a self-hosted replacement for Obsidian Sync. It has two halves:

- an **Obsidian community plugin** (TypeScript) that watches a vault and synchronizes it, and
- a **sync server** (Go) that stores vault state in **PostgreSQL** (metadata, revisions) and an **S3-compatible object store** (file contents).

It exists because the available self-hosted option (obsidian-livesync) requires CouchDB, has a history of data-loss and reconciliation bugs, is thinly documented, and has no multi-user model. vault-sync targets a small number of users (one household / small team) on infrastructure the operator already runs.

## 2. Design principles

These are non-negotiable. When a trade-off arises, resolve it in favor of the principle, not convenience. Call out any change that touches one.

1. **No acknowledged write is ever lost.** Once the server has acknowledged a revision, that content is recoverable — as the current head, in revision history, or as a conflict copy — until an explicit, retention-governed purge. Neither the client nor the server ever silently discards a user edit. Deletion is a tombstone, never an erase.
2. **One source of truth per concern.** The server's revision log is the source of truth for vault history. The local vault on disk is the source of truth for un-pushed local edits. The client keeps exactly one durable journal bridging the two. No additional replicated databases or chunk layers.
3. **Everything is tested — including adversarially.** Sync correctness is proven by a deterministic, seeded, multi-client simulation with fault injection (partitions, crashes, reordering), not by example tests alone. If it is not tested, it does not work.
4. **Small, defensible attack surface.** The server is exposed to the internet. Keep the API small, typed, and authenticated by default; every endpoint enforces vault-level authorization; resource usage is bounded (request sizes, decompression, pagination).
5. **Operator infrastructure only.** PostgreSQL, S3-compatible storage, and OIDC. No new database types.

## 3. Target environment

- **Server:** Kubernetes (Talos) homelab. PostgreSQL via CloudNativePG (client-certificate auth; certificates rotate — the server must re-read them, never cache them for the process lifetime). Object storage via Ceph RGW (S3 API). Identity via Authentik (OIDC). Exposed through an Istio gateway with a Coraza WAF in front: **inspected request bodies above 1 MiB are rejected**, so every upload is chunked at or below a configurable size (default 768 KiB).
- **Clients (required):** Obsidian desktop on **Windows** and **macOS**, Obsidian mobile on **Android**. Linux desktop is the development/test platform. **iOS is best-effort** (not a release blocker) — do not take design decisions that preclude it.
- **Backups:** a plaintext export of every vault (decrypted where escrow is enabled, §9.4) is written to a filesystem path that the operator's tape-archival tooling picks up. This replaces livesync-bridge.

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

- **`plugin/src/core`** is a pure TypeScript library: the sync engine, journal, merge, crypto, and protocol client. It **must not import `obsidian`** (lint-enforced) or use Obsidian's globals: `make lint` type-checks it, with its tests and `sim/`, as a separate program (`plugin/tsconfig.core.json`) that has neither Obsidian's global augmentations nor DOM-only globals, and fails if any route (import, `/// <reference>`, `src/main.ts`) brings Obsidian into it. Core code must be plain `.ts` modules with no triple-slash directives, no `declare global` and no JavaScript imports, and the program may contain nothing from outside `src/core`, `sim/`, `src/gen` and dependencies. Packages that `src/core` and `sim/` import directly must be declared in `plugin/package.json` (`dependencies` or `devDependencies`, or their `@types` package) and are never `obsidian`, so Obsidian's own transitive dependencies (e.g. `@codemirror/view`, `moment`) cannot slip in. Any other code file under `src/core` (`.js`, `.mts`, `.tsx`, `.d.ts`, …) fails the check even if nothing imports it; non-code files there are ignored. It talks to the vault through a `VaultAdapter` interface so the simulation harness can drive it against an in-memory vault.
- **`plugin/src/obsidian`** is the thin adapter: `Vault`/`FileManager` events, editor integration, settings UI, status bar, conflict UI.
- **`vault-sync-server`** is a single Go binary. The server **never merges content**: it orders revisions, enforces optimistic concurrency, stores bytes, and fans out notifications. All merging happens on clients (this keeps the server compatible with end-to-end encryption).
- **`vault-sync export`** is a subcommand of the same binary, run as a separate Deployment/CronJob with its own credentials. It is the only component that may hold the escrow private key.

### 4.1 Protocol transport (decision)

The API is defined in **protobuf** under `proto/` and served with **ConnectRPC** (Connect protocol over HTTP/1.1 + JSON or binary) — one schema generates both the Go server stubs and the TypeScript client. Realtime traffic (change notifications now, Yjs updates and awareness later) uses a **WebSocket** carrying protobuf-framed messages, because browsers/Electron cannot do client-streaming over fetch. The server sets CORS headers for Obsidian's app origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`) and validates `Origin` on WebSocket upgrade.

Generated code is committed (`make generate` regenerates; CI fails on drift). Schema changes must stay backward compatible: `make lint` (and CI) runs `buf breaking` with the `FILE` rule set against `master`, and any deliberate exception is a narrowly scoped, temporary `ignore_only` entry in `buf.yaml` (`docs/testing/proto-compatibility.md`).

## 5. Data model

All identifiers are UUIDv7 unless stated. Every table below is scoped by `vault_id`; every query filters by it.

| Entity | Key fields | Notes |
|---|---|---|
| `users` | `id`, `oidc_issuer`, `oidc_subject`, `display_name` | Created on first authenticated request (JIT). |
| `devices` | `id`, `user_id`, `name`, `public_key` (X25519), `last_seen` | One per plugin install. |
| `vaults` | `id`, `name`, `encryption` (`none` \| `e2ee`), `escrow` (bool), `head_seq` | `head_seq` is the vault-wide change counter. |
| `vault_members` | `vault_id`, `user_id`, `role` (`owner` \| `editor` \| `viewer`) | Authorization source of truth. |
| `documents` | `id`, `vault_id`, `kind` (`blob` \| `text` \| `yjs`), `head_rev_id`, `path_key`, `deleted` | Stable identity across renames. `deleted` mirrors the head revision's tombstone flag. `path_key` unique per vault among live (`deleted = false`) documents, enforced by a unique partial index. |
| `revisions` | `id`, `document_id`, `vault_id`, `seq`, `parent_rev_id`, `content_ref`, `path`, `deleted`, `device_id`, `created_at` | Append-only. `seq` is assigned from `vaults.head_seq` in the same transaction. |
| `blobs` | `vault_id`, `blob_id`, `size`, `state` (`uploading` \| `complete`) | Content-addressed per vault; bytes live in S3 at `vaults/{vault_id}/blobs/{blob_id}`. |
| `key_slots` | `vault_id`, `epoch`, `recipient_kind` (`user` \| `escrow`), `recipient_id`, `wrapped_key` | E2EE only (§9). |
| `yjs_updates` | `document_id`, `seq`, `update` | Phase 5 (§10). |

**Paths.** A path is an attribute of a revision, not an identity. Uniqueness is enforced on `path_key`, a normalized form of the path: Unicode NFC, then case-folded, so that two clients cannot create paths that collide on case-insensitive (Windows, macOS, Android/iOS) filesystems. Precisely (decision): `normalize(path) = NFC(toCasefold(NFD(path)))` — Unicode canonical caseless matching (Unicode §3.13, D145) emitted in NFC, using **full, locale-independent** case folding (`CaseFolding.txt` statuses C and F; never the Turkic T mappings), so `Straße`/`STRASSE` collide, `İ` folds to `i̇` and dotless `ı` folds to itself. Full folding was chosen over simple folding because it catches strictly more collisions; locale independence keeps the key identical on every device. Separators, whitespace and dots are not altered and no validation happens here. Go (`internal/pathkey`) and TypeScript (`plugin/src/core/pathkey`) share one folding table generated from a vendored `CaseFolding.txt` and must agree on every vector in `testdata/paths/`. Normalization uses each platform's NFC/NFD (`golang.org/x/text/unicode/norm`, `String.prototype.normalize`), so keys can differ only for characters whose normalization data one side does not yet have (characters added in recent Unicode versions); closing that gap is deferred to [#63](https://github.com/solidDoWant/vault-sync/issues/63). For E2EE vaults the path itself is ciphertext and `path_key = HMAC-SHA256(path_key_secret, normalize(path))`, so the server can still enforce uniqueness without learning the path.

**Content addressing.** For plaintext vaults `blob_id = SHA-256(content)`. For E2EE vaults `blob_id = HMAC-SHA256(blob_id_secret, plaintext)` (equality leaks only within a vault), and clients verify the id after decryption.

## 6. Sync protocol

### 6.1 Pull

`ListChanges(vault_id, since_seq, page_size)` returns revisions with `seq > since_seq` in `seq` order, paginated (the client passes the last `seq` it received as the next `since_seq` until `has_more` is false). A client's durable cursor is the highest `seq` it has fully applied to disk. Clients pull on startup, on a realtime `vault_changed{seq}` notification, and on a timer as a fallback.

### 6.2 Push (optimistic concurrency)

1. Upload content: `BeginBlob` → `PutBlobChunk`* → `CommitBlob`. Idempotent: an already-complete `blob_id` short-circuits. Resumable: `BeginBlob` reports the bytes already received, and chunks are appended strictly sequentially by offset. Chunks are at most the configured size (§3). The server verifies the content hash on commit for plaintext vaults. Downloads are ranged (`DownloadBlob(offset, length)`), each response bounded by the server.
2. `CommitRevision(document_id, revision_id, base_rev_id, kind, content_ref, path, path_key, deleted, device_id)`. The server accepts only if `base_rev_id` equals the document's current head (or the document is new and `base_rev_id` is empty). It assigns `seq`, advances `head_seq`, and broadcasts `vault_changed`. Document and revision ids are client-generated UUIDv7s; retrying a commit with the same `revision_id` and identical fields returns the already-committed revision, so a lost response does not turn into a spurious head-moved conflict. `path_key` is sent only for E2EE vaults (§5); for plaintext vaults the server derives it from `path`.
3. On `FAILED_PRECONDITION` (head moved), the client pulls the new head, merges (§7) against the common base, and retries with the new head as base.

A revision is **acknowledged** only when `CommitRevision` returns success. Principle 1 applies from that moment.

### 6.3 Renames, deletes, creates

- **Rename** is a revision with a new `path` and the same `content_ref`.
- **Delete** is a revision with `deleted = true` (tombstone). Its content stays reachable through history.
- **Create** races: if two clients create documents whose `path_key` collides, the second commit fails with `ALREADY_EXISTS`; that client renames its document to `<name> (conflict <device> <date>).<ext>` and commits again.
- Concurrent **rename vs. edit** of the same document merges cleanly: path and content are independent fields of the merge.
- Concurrent **delete vs. edit**: the edit wins (the document is resurrected with the edited content) — never lose an edit to a delete.

### 6.4 Realtime channel

One WebSocket per open vault per device, authenticated with the same bearer token. Each binary WebSocket message is one protobuf frame (`ClientFrame` / `ServerFrame` in `proto/vaultsync/v1/realtime.proto`, each a `oneof` envelope). Client → server: `subscribe{vault_id}`, `unsubscribe{vault_id}`. Server → client: `subscribed{vault_id, head_seq}`, `vault_changed{vault_id, seq}`, `error`, and later membership/key-epoch changes. Field numbers 100–199 of both envelopes are reserved for the Phase 5 Yjs frames. Phase 5 adds Yjs subscribe/update/awareness messages multiplexed by `document_id`. The channel is a latency optimization only; correctness never depends on receiving a notification.

## 7. Merge rules (client side)

Classification is by extension and is configurable:

| Kind | Default for | Concurrent-edit behavior |
|---|---|---|
| `text` | `.md`, `.txt`, `.css`, `.js`, other UTF-8 text | 3-way merge (`base`, `local`, `remote`). Non-overlapping changes merge silently. Overlapping changes: remote wins in place, and the local version is written as a conflict copy next to it. Never inject conflict markers into the note. |
| `blob` | everything else (images, PDFs, `.canvas` until a JSON merge exists) | Remote wins in place; local version becomes a conflict copy. |
| `yjs` | `.md` in vaults with live editing enabled (Phase 5) | CRDT merge; no conflicts. |

Conflict copies are ordinary documents and sync like any other file. Every conflict is also logged to the client's conflict view.

## 8. Client durability

- **Journal.** The engine keeps a journal in IndexedDB: per document, the last synced `rev_id`, the base content hash, and pending local operations. A pending operation is removed only after `CommitRevision` succeeds.
- **Never overwrite unsynced local edits.** Before writing remote content to disk, the engine checks the on-disk content hash against the journal's base hash. On a mismatch it treats the disk content as a local edit and merges first.
- **Base content.** For 3-way merge the client needs the base content. It is fetched from the server by `rev_id` when it is not cached locally.
- **Echo suppression.** Writes performed by the engine are recorded (path + content hash) so that the resulting vault events are not treated as user edits.
- **Change detection uses content hashes, never mtimes.** mtimes are unreliable across platforms and sync tools.
- **Crash safety.** Mobile apps are killed without warning. Every step must be resumable from the journal: an interrupted upload resumes, an interrupted apply re-checks hashes.
- **Platform path rules.** Paths that cannot be materialized on the local platform (Windows reserved names `CON`/`NUL`/…, trailing dots or spaces, `\`, `:` and other forbidden characters, over-long paths) are not silently dropped: the document is tracked as "unmaterializable" and surfaced in the UI.
- **`.obsidian/` config sync** is opt-in and allow-listed per category (themes, snippets, hotkeys, plugin list, plugin data). `workspace*.json` and the plugin's own state are never synced.

## 9. Authentication, authorization, encryption

### 9.1 Authentication

The plugin authenticates against Authentik with the **OAuth 2.0 Device Authorization Grant** (works identically on desktop and Android, with no redirect handling). The plugin stores the refresh token in plugin data; access tokens are JWTs validated by the server against the issuer's JWKS (refreshed on unknown `kid`, with a bounded refresh rate). `iss`, `aud`, and `exp` are always checked.

Server-side details (decision):

- Only RS256, ES256 and EdDSA signatures are accepted; `none` and HMAC algorithms are rejected. Tokens are size-bounded before parsing. `exp` has no leeway; `nbf`, when present, tolerates one minute of clock skew.
- The JWKS (discovered from the issuer's OpenID configuration) is fetched lazily, refetched on an unknown `kid` and when older than one hour, and never more than once per 30 seconds. A failed refetch keeps the cached keys. At most one fetch is in flight and no lock is held across it: while hour-old keys are being refetched, other requests use the cached keys rather than wait. The discovery document, `jwks_uri` and redirects must be `https` (plain `http` only to loopback hosts, and only for a loopback `http` issuer); redirects must stay on the requested host and never downgrade to `http`.
- Users are created on their first authenticated request, keyed by `(issuer, subject)`; concurrent first requests create exactly one user. `sub` must be non-empty, at most 255 bytes, and free of control characters (Unicode `Cc`); other tokens are rejected as unauthenticated before any user lookup.
- Authentication is **default-deny**: one interceptor on every ConnectRPC service authenticates every procedure that is not on an explicit public allow-list (only `ServerInfoService/GetServerInfo`). The realtime WebSocket upgrade (§6.4) authenticates with the same authenticator. A test enumerates every procedure in the schema and asserts it is authenticated or allow-listed.

### 9.2 Authorization

Every RPC and every WebSocket message resolves `(user, vault_id)` to a `vault_members` role before touching data. `viewer` can read; `editor` can read and write; `owner` can also manage members and vault settings. There is no admin bypass in the API.

Server-side details (decision):

- Authorization is **central and runs before the handler**: one interceptor, after authentication, on every ConnectRPC service. A single table (`server.VaultProcedures`) classifies every vault-scoped procedure — every procedure whose request carries `vault_id` — as read or write. A request carrying a `vault_id` for an unclassified procedure is rejected, and a test derived from the schema descriptors fails if any such procedure is missing from the table.
- `vault_id` must be a canonical lowercase UUID (`INVALID_ARGUMENT` otherwise) and is checked before any query. The role is then resolved with one `vault_members` lookup: a vault that does not exist and a vault the caller is not a member of take the same path and return the same `NOT_FOUND` error. A `viewer` calling a write procedure gets `PERMISSION_DENIED`.
- Handlers take the authorized vault from the interceptor, never from the request, and query through a vault-scoped store handle whose every query filters by that vault, so ids from another vault (documents, revisions, blobs) are simply not found.
- `CreateVault` makes the caller the `owner` (a user may own at most 100 vaults); `ListVaults` returns only vaults the caller is a member of, with the caller's role. Vault names are non-blank, at most 256 bytes, and contain no control characters (Unicode category `Cc`, including U+0000, which PostgreSQL `text` cannot store); anything else is `INVALID_ARGUMENT` before the database is touched.

### 9.3 End-to-end encryption (opt-in per vault)

Until Phase 4 (§15) delivers key management, the server rejects `CreateVault` for an E2EE vault (with or without escrow) with `FAILED_PRECONDITION` ("end-to-end encrypted vaults are not supported yet"), so that no client can commit plaintext into a vault marked as encrypted, whose `path_key` the server could not derive (§5; principle 1). Escrow on a plaintext vault is `INVALID_ARGUMENT`.

Envelope encryption with multiple recipients:

- Each **user** has an X25519 key pair. The private key is stored server-side wrapped by a key derived from a user recovery passphrase (Argon2id). Devices unwrap it once and keep it in local storage. (Device-to-device linking and Shamir-split recovery are later enhancements.)
- Each **vault** has a symmetric vault key per **epoch**. `key_slots` hold the epoch key wrapped (X25519 + HKDF + XChaCha20-Poly1305, sealed-box style) to every member, and to the escrow public key if escrow is enabled.
- Sub-keys are derived from the epoch key with HKDF: `content`, `path`, `path_key_secret`, `blob_id_secret`.
- Content and paths are encrypted with **XChaCha20-Poly1305**, random nonce, the revision's document id and epoch bound as associated data.
- Every ciphertext carries a **suite version** byte so that the algorithms can change later.
- **Member removal** creates a new epoch. Subsequent revisions use it; historical content is not re-encrypted (the removed member may already hold it).
- Implementations: `@noble/ciphers`, `@noble/curves`, `@noble/hashes` in TypeScript (pure JS, audited, identical on Electron and Android WebView); `golang.org/x/crypto` in Go. A shared set of **cross-language test vectors** in `testdata/crypto/` must pass in both.
- With E2EE, the server cannot merge, search, or render content — none of which it does anyway (§4).

### 9.4 Escrow for plaintext backups

A vault with `escrow = true` also wraps each epoch key to a deployment-wide **escrow public key**. The escrow private key exists only in the export job's Secret, which is never mounted into the internet-facing server. A compromise of the API server, PostgreSQL, or S3 therefore exposes only ciphertext. The export job decrypts and writes plaintext for tape archival. Escrow is chosen at vault creation and shown clearly in the UI. Optionally, the escrow private key may be split with Shamir secret sharing for offline disaster recovery; this is not used by the automated path.

## 10. Live collaborative editing (Phase 5)

The v1 protocol includes the hooks for this from the start: stable document ids, the `kind` field, the multiplexed WebSocket, and an append-only per-document log.

- A `yjs` document's state is its ordered `yjs_updates` log plus periodic snapshots. For E2EE vaults each update is encrypted (the server stores and relays opaque bytes).
- **Conversion** of a `text` document to `yjs` happens **exactly once**, as a server-side compare-and-set on `documents.kind` performed by a single elected client (the server grants a lease). Two clients independently initializing a `Y.Text` from the same file duplicates the content — the classic Yjs bug — and must be impossible.
- The plugin binds `Y.Text` to Obsidian's CodeMirror 6 editor (`y-codemirror.next`) and to the file on disk. Edits that arrive outside the editor (other plugins, `processFrontMatter`, external editors, git) are diffed into the `Y.Text`.
- Awareness (cursors, presence) is ephemeral over the WebSocket and never persisted.
- **Compaction** folds the update log into a snapshot. Plaintext and escrow vaults can compact server-side (the export job can do it for escrow vaults); other E2EE vaults compact on clients. The compaction runtime (a Go Yjs implementation is not mature) is an open question for Phase 5.

## 11. Retention and history

- Revisions are append-only. A retention policy (per vault; default: keep everything for 90 days, then thin to daily/weekly) purges **non-head** revisions and tombstones only. Unreferenced blobs are garbage-collected after their last referencing revision is purged, with a grace period.
- Users can browse a document's history and restore any revision (a restore is a new revision).

## 12. Operations

- Single static Go binary; OCI images built by Nix (`streamLayeredImage`), mirroring tape-archiver. Helm chart built on bjw-s `app-template` under `deploy/charts/`.
- Configuration by environment variables, documented in `docs/configuration.md`.
- **JSON structured logs** (`log/slog`), Prometheus metrics on a separate port, `/healthz` and `/readyz`.
- PostgreSQL client certificates and S3 credentials are re-read from disk on change.
- Schema migrations are embedded (`internal/store/migrations`) and run on startup behind a PostgreSQL advisory lock, each in its own transaction, recorded in `schema_migrations`; migrations are forward-only and must be backward-compatible with the previous release. Released migrations are never edited (the runner rejects a changed name for an applied version).
- Bounded resource use: max request size, max chunk size, decompression limits, pagination caps, per-user rate limits.
- The plugin is distributed through GitHub releases (installable with BRAT); publishing to the Obsidian community catalog is a non-goal for now.

## 13. Testing strategy

| Layer | Tooling | Runs in |
|---|---|---|
| Go unit | `go test -race`, testify | `make test`, CI |
| TS unit | vitest | `make test`, CI |
| Server integration | real PostgreSQL + S3-compatible store via `docker compose` | `make test-integration`, CI |
| **Sync simulation** | Seeded multi-client harness (`sim/`, TypeScript): N `core` engines over in-memory vaults against a real `vault-sync-server` process (real PostgreSQL + S3). Each client's transport is wrapped in a seeded fault injector (drop request, drop response after the server applied it, delay, reorder, partition, client crash/restart losing in-memory state). Operation schedules are derived from the seed so a failing seed replays the same client-side schedule. Invariants: convergence, no lost acknowledged writes, no resurrected deletes without a concurrent edit, no duplicate content. Failing seeds are minimized and committed as regression cases. | `make test-sim`, CI (short), nightly (long) |
| Crypto vectors | shared `testdata/crypto/` vectors | Go + TS unit tests |
| Path-key vectors | shared `testdata/paths/` vectors | Go + TS unit tests |
| Plugin e2e | `wdio-obsidian-service` (real Obsidian; emulated mobile mode) | Linux in the dev VM; Windows + macOS in GitHub Actions |
| Android | manual checklist in `docs/testing/android.md` until automated | human |

## 14. Repository layout

```
cmd/vault-sync-server/   server + export subcommands
internal/                server packages (api, store, blobstore, auth, realtime, export, config, …)
proto/vaultsync/v1/      protobuf API definitions (source of truth for the protocol)
gen/                     generated Go code (committed)
plugin/                  Obsidian plugin (npm project; nested empty go.mod fences it out of ./...)
  src/core/              pure sync engine — no `obsidian` imports
  src/obsidian/          Obsidian adapter + UI
  src/gen/               generated TS protocol code (committed)
sim/                     sync simulation harness (TS, drives src/core against the Go server)
testdata/crypto/         cross-language crypto test vectors
testdata/paths/          cross-language path_key vectors (§5)
deploy/charts/           Helm chart(s)
deploy/compose/          docker compose stack for integration tests (PostgreSQL + S3-compatible store)
docs/                    operator + design docs; docs/agents/ holds the agent playbooks
nix/                     Nix package/image definitions
.claude/                 agent definitions and slash commands
```

## 15. Phases

Work is tracked as GitHub milestones and parent issues. Each phase ends with a bug hunt (and a security review where the phase touches the attack surface) before the next starts.

1. **Foundations** — protocol schema, server core (store, blobs, revisions, auth, authz), simulation harness skeleton, CI.
2. **Single-user file sync** — plugin engine + adapter for desktop and Android, merge, conflicts, history/restore, export job, Helm chart. Dogfooding starts here.
3. **Vault sharing** — membership management, invitations, roles in UI.
4. **End-to-end encryption** — key hierarchy, escrow, export decryption, crypto vectors, independent crypto review. Until then, creating an E2EE vault is rejected (§9.3).
5. **Live collaborative editing** — Yjs documents, conversion, editor binding, awareness, compaction.

## 16. Open questions

Tracked as issues labelled `question`. Decisions made autonomously by the project-manager agent are logged on the decision-log issue for later human review.
