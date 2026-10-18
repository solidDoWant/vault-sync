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

- **Server:** Kubernetes (Talos) homelab. PostgreSQL 14 or newer via CloudNativePG (client-certificate auth; certificates rotate — the server must re-read them, never cache them for the process lifetime). Object storage via Ceph RGW (S3 API). Identity via Authentik (OIDC). Exposed through an Istio gateway with a Coraza WAF in front: **inspected request bodies above 1 MiB are rejected**, so every upload is chunked at or below a configurable size (default 768 KiB).
- **High availability:** the server runs as an HA deployment: two or more identical replicas behind one Service, sharing one PostgreSQL database and one S3 bucket. Terminating any replica, for example for node maintenance, must have **no client-visible impact**. The rules that make this hold are in §12.
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
- **`vault-sync export`** is a subcommand of the same binary, run as a separate Deployment/CronJob with its own credentials. It is the only component that may hold the escrow private key. It only reads PostgreSQL (its sessions are `default_transaction_read_only`) and S3. Each vault is exported as of its `head_seq` (every document's latest revision at or below it; tombstoned documents are left out) to `<out>/<vault-id>/<path>`, byte for byte; the directory is named by id because vault names are mutable, user-chosen and can collide (decision, #29). The tree is written to a staging directory beside `<out>` and swapped in atomically (`renameat2` `RENAME_EXCHANGE`), so an interrupted run leaves the previous export untouched. Every path is re-checked with the shared vault-relative rule (§6.2) and written through a handle confined to the vault directory, without following symbolic links. A document that cannot be written faithfully (invalid or conflicting path, missing or corrupt content) is left out and reported by id, and the run still swaps in its tree. The job prints a JSON summary and exits non-zero on any failure or left-out document; it has no metrics endpoint. Until Phase 4, E2EE vaults are skipped. Details: `docs/export.md`.

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
| `documents` | `id`, `vault_id`, `kind` (`blob` \| `text` \| `yjs`), `head_rev_id`, `path_key`, `deleted` | Stable identity across renames. `deleted` mirrors the head revision's tombstone flag. `path_key` unique per vault among live (`deleted = false`) documents, enforced by a unique partial index on the SHA-256 digest of `path_key` (decision, #121): a btree entry holds at most 2704 bytes, while a `path_key` may be up to 8192, so the key itself cannot be indexed. A digest collision could only refuse a commit, never treat two paths as one, since nothing looks documents up by `path_key`. |
| `revisions` | `id`, `document_id`, `vault_id`, `seq`, `parent_rev_id`, `content_ref`, `path`, `deleted`, `device_id`, `created_at` | Append-only. `seq` is assigned from `vaults.head_seq` in the same transaction. |
| `blobs` | `vault_id`, `blob_id`, `size`, `state` (`uploading` \| `complete`) | Content-addressed per vault; bytes live in S3 at `vaults/{vault_id}/blobs/{hex(blob_id)}`. A row is written only once the blob is complete; upload progress lives in `blob_uploads` (§6.2). |
| `blob_uploads`, `blob_upload_chunks` | `id`, `vault_id`, `blob_id`, `size`, `received_size`, `state` (`uploading` \| `finished`); accepted chunks by `offset` | Resumable upload sessions (§6.2). At most one `uploading` session per `(vault_id, blob_id)`. |
| `key_slots` | `vault_id`, `epoch`, `recipient_kind` (`user` \| `escrow`), `recipient_id`, `wrapped_key` | E2EE only (§9). |
| `yjs_updates` | `document_id`, `seq`, `update` | Phase 5 (§10). |

**Paths.** A path is an attribute of a revision, not an identity. Uniqueness is enforced on `path_key`, a normalized form of the path: Unicode NFC, then case-folded, so that two clients cannot create paths that collide on case-insensitive (Windows, macOS, Android/iOS) filesystems. Precisely (decision): `normalize(path) = NFC(toCasefold(NFD(path)))` — Unicode canonical caseless matching (Unicode §3.13, D145) emitted in NFC, using **full, locale-independent** case folding (`CaseFolding.txt` statuses C and F; never the Turkic T mappings), so `Straße`/`STRASSE` collide, `İ` folds to `i̇` and dotless `ı` folds to itself. Full folding was chosen over simple folding because it catches strictly more collisions; locale independence keeps the key identical on every device. Separators, whitespace and dots are not altered and no validation happens here. Go (`internal/pathkey`) and TypeScript (`plugin/src/core/pathkey`) share one folding table generated from a vendored `CaseFolding.txt` and must agree on every vector in `testdata/paths/`. Normalization uses each platform's NFC/NFD (`golang.org/x/text/unicode/norm`, `String.prototype.normalize`), so keys can differ only for characters whose normalization data one side does not yet have (characters added in recent Unicode versions); closing that gap is deferred to [#63](https://github.com/solidDoWant/vault-sync/issues/63). For E2EE vaults the path itself is ciphertext and `path_key = HMAC-SHA256(path_key_secret, normalize(path))`, so the server can still enforce uniqueness without learning the path.

**Content addressing.** For plaintext vaults `blob_id = SHA-256(content)`. For E2EE vaults `blob_id = HMAC-SHA256(blob_id_secret, plaintext)` (equality leaks only within a vault), and clients verify the id after decryption.

## 6. Sync protocol

### 6.1 Pull

`ListChanges(vault_id, since_seq, page_size)` returns revisions with `seq > since_seq` in `seq` order, paginated (the client passes the last `seq` it received as the next `since_seq` until `has_more` is false; the server caps `page_size` at 1000 and defaults it to 500, and also ends a page early where its encoding would exceed the send limit, so a page of long paths never fails as too large; every page holds at least one revision if one exists, and startup requires the send limit to fit a response with one maximum-size revision). A client's durable cursor is the highest `seq` it has fully applied to disk. Clients pull on startup, on a realtime `vault_changed{seq}` notification, and on a timer as a fallback.

### 6.2 Push (optimistic concurrency)

1. Upload content: `BeginBlob` → `PutBlobChunk`* → `CommitBlob`. Idempotent: an already-complete `blob_id` short-circuits. Resumable: `BeginBlob` reports the bytes already received, and chunks are appended strictly sequentially by offset. Chunks are at most the configured size (§3). The server verifies the content hash on commit for plaintext vaults. Downloads are ranged (`DownloadBlob(offset, length)`), each response bounded by the server.

   Server-side details (decision): S3 multipart parts must be at least 5 MiB (except the last), which chunks below the 1 MiB body limit never are, so chunks are **staged objects plus a server-side compose**. Each accepted chunk is its own object under `vaults/{vault_id}/uploads/{upload_id}/`, its key unique to the write so a writer that lost a race for an offset never overwrites the accepted chunk; a chunk is accepted by a compare-and-set on the session's `received_size`, so concurrent uploaders of one blob share a session and a loser gets `FAILED_PRECONDITION` and resumes from `BeginBlob`. Every chunk but the last is at least 64 KiB (or the maximum chunk size, if smaller), bounding the objects per upload. `CommitBlob` streams the staged chunks in order into the blob's object, with one `PutObject` up to 8 MiB and a multipart upload of 8 MiB parts above that, hashing as it goes; the object is written or its multipart upload completed only after the hash matched, and the `blobs` row is written only after that, so a mismatching upload never becomes visible and its session is discarded. Bounds: the maximum chunk size plus 1 KiB of framing must fit the maximum request body (checked at startup), the Connect send limit equals the request limit, a blob is at most the configured maximum (at most 80 GiB, S3's 10,000 parts of 8 MiB), and a vault has a bounded number of sessions in progress. Sessions idle for longer than the upload TTL are reaped by a periodic, bounded cleanup that deletes their staged objects and then the session, and aborts multipart uploads older than the TTL (an interrupted commit's are otherwise invisible and leak storage) unless their blob has a session active within the TTL. Every server instance runs the cleanup at the same time, so every step is idempotent: a session is claimed atomically, and an upload or object another instance already removed counts as removed. A commit records session activity after every 8 MiB part it composes (and at least every minute while it waits for a compose slot), so a commit in progress, on any instance, is never reaped however long it takes; upload sessions hold no per-instance state, so chunks and the commit may go to different instances, and a commit interrupted by an instance dying is retried to success on another.
2. `CommitRevision(document_id, revision_id, base_rev_id, kind, content_ref, path, path_key, deleted, device_id)`. The server accepts only if `base_rev_id` equals the document's current head (or the document is new and `base_rev_id` is empty). It assigns `seq`, advances `head_seq`, and broadcasts `vault_changed`. Document and revision ids are client-generated UUIDv7s; retrying a commit with the same `revision_id` and identical fields returns the already-committed revision, so a lost response does not turn into a spurious head-moved conflict. `path_key` is sent only for E2EE vaults (§5); for plaintext vaults the server derives it from `path`.

   Server-side details (decision): a commit is one PostgreSQL transaction that first locks the vault row, so commits to one vault are serialized by the database across every server replica, with no per-process state: `seq` comes from `UPDATE vaults SET head_seq = head_seq + 1 … RETURNING` in that transaction, so it is gapless, and a revision commits (becomes visible to `ListChanges`) only after every lower `seq`, so a cursor never skips one. Within the transaction the checks run in this order: the device belongs to the caller (`NOT_FOUND`); an existing revision with this `revision_id` in this vault is returned if its fields are identical and is `INVALID_ARGUMENT` otherwise — **before** the head comparison, so a retry whose first attempt was applied still succeeds after other commits moved the head; the head comparison (`FAILED_PRECONDITION` carrying the document, with its current `head_rev_id`, as a `Document` error detail; also `FAILED_PRECONDITION` if a base is given for a document that does not exist in the vault); the kind matches the document's; the content is a `complete` blob in the same vault whose stored size equals `content_ref.size` (`FAILED_PRECONDITION` if not complete, `INVALID_ARGUMENT` on a size mismatch; the stored size is what is ever returned). The document row's `head_rev_id`, `path_key` and `deleted` are updated in the same transaction as the revision insert, so `deleted` always mirrors the head and the live `path_key` index is exact; a collision on it is `ALREADY_EXISTS`. Client-generated ids already used in another vault are `INVALID_ARGUMENT`; all lookups are scoped to the authorized vault, so another vault's ids are otherwise simply not found. Plaintext paths are at most 4096 bytes of UTF-8 without control characters, vault-relative, and at most 8192 bytes once normalized. Vault-relative is defined for every supported client platform (decision): `/` and `\` are both separators; the path must not start with a separator (which also rules out UNC, `\\?\` and `\\.\` prefixes) or with an ASCII letter and a colon (a drive prefix such as `C:`, `C:\x` or the drive-relative `C:x`); and no segment may be empty or consist only of dots and spaces (`.`, `..`, and forms such as `.. ` or `...` that Windows reduces to them). Names that are merely unmaterializable on Windows (reserved device names such as `CON.md`, a colon anywhere but a leading drive prefix, trailing dots or spaces on other names) are accepted; the client handles them. Go (`internal/vaultpath`, used by `CommitRevision`) and TypeScript (`isVaultRelativePath` in `plugin/src/core/vaultpath`) must agree on every vector in `testdata/paths/validity.json`, and a client must apply the rule to every path it receives before touching its disk, including E2EE paths after decryption, which the server cannot check. A path that breaks the rule is `INVALID_ARGUMENT` and nothing is written; a path or `path_key` the database refuses (empty, over its bound, or text it cannot store) is `INVALID_ARGUMENT`, never `INTERNAL`. Until Phase 4, commits to E2EE vaults are `FAILED_PRECONDITION` (§9.3). The commit transaction also queues a PostgreSQL `NOTIFY` on channel `vault_changed` (payload `<vault_id>:<seq>`), which PostgreSQL delivers to every replica exactly when, and only if, the transaction commits; an idempotent retry notifies nothing (§6.4).
3. On `FAILED_PRECONDITION` (head moved), the client pulls the new head, merges (§7) against the common base, and retries with the new head as base.

A revision is **acknowledged** only when `CommitRevision` returns success. Principle 1 applies from that moment.

### 6.3 Renames, deletes, creates

- **Rename** is a revision with a new `path` and the same `content_ref`.
- **Delete** is a revision with `deleted = true` (tombstone). Its content stays reachable through history.
- **Create** races: if two clients create documents whose `path_key` collides, the second commit fails with `ALREADY_EXISTS`; that client renames its document to `<name> (conflict <device> <date>).<ext>` and commits again.
- Concurrent **rename vs. edit** of the same document merges cleanly: path and content are independent fields of the merge.
- Concurrent **delete vs. edit**: the edit wins (the document is resurrected with the edited content) — never lose an edit to a delete.

### 6.4 Realtime channel

One WebSocket per device (`GET /v1/realtime`), multiplexing subscriptions to any number of the user's vaults up to a server cap (`GetServerInfo.max_realtime_subscriptions`), authenticated with the same bearer token. Each binary WebSocket message is one protobuf frame (`ClientFrame` / `ServerFrame` in `proto/vaultsync/v1/realtime.proto`, each a `oneof` envelope). Client → server: `subscribe{vault_id}`, `unsubscribe{vault_id}`. Server → client: `subscribed{vault_id, head_seq}`, `vault_changed{vault_id, seq}`, `error`, and later membership/key-epoch changes. Field numbers 100–199 of both envelopes are reserved for the Phase 5 Yjs frames. Phase 5 adds Yjs subscribe/update/awareness messages multiplexed by `document_id`. The channel is a latency optimization only; correctness never depends on receiving a notification.

Server-side details (decision, #52):

- **Upgrade.** The client offers the subprotocols `vaultsync.v1` and `vaultsync.bearer.<access token>` (browsers cannot set headers on a WebSocket request; non-browser clients may send `Authorization: Bearer` instead, but not both). The server validates `Origin` against the CORS allow-list (an absent `Origin` is allowed for non-browser clients), authenticates the token with the RPC authenticator, and echoes only `vaultsync.v1`. It refuses the upgrade with 403 (origin), 401 (missing or invalid token), 400 (no `vaultsync.v1`), 429 (too many connections for the user) or 503 (instance full or draining). The token never appears in a URL, and the `Sec-WebSocket-Protocol` header is never logged.
- **Authorization.** Every `subscribe` resolves the caller's `vault_members` role; a non-member and a vault that does not exist get the same non-fatal `NOT_FOUND` error frame. Membership is checked again before every delivery: a removed member's subscription ends with an unsolicited `NOT_FOUND` error frame naming the vault, and no further notifications for it are sent.
- **Token expiry.** There is no in-band refresh. When the access token's `exp` passes, the server sends a fatal `UNAUTHENTICATED` error frame and closes (1008); the client reconnects with a fresh token and re-subscribes.
- **Fan-out.** Each replica holds one PostgreSQL connection that `LISTEN`s on `vault_changed` and delivers each notification to its local subscribers, so a commit on any replica reaches subscribers on every replica. Undelivered notifications of one vault are coalesced to the newest `seq`. If the listening connection is lost the replica reconnects with jittered backoff and then sends every locally subscribed vault's current `head_seq`, so commits made meanwhile are not missed. Subscriptions are per-connection state only: a client reconnecting to another replica re-subscribes and pulls from its cursor.
- **Bounds.** Inbound frames are at most 4 KiB (larger closes with 1009); the inbound rate is 20 frames per second with a burst of the subscription cap plus 32 (excess is a fatal `RESOURCE_EXHAUSTED`); subscriptions per connection, connections per user and connections per replica are capped (`docs/configuration.md`). Each connection's send queue is bounded; a client too slow to drain it, or that does not answer pings, is disconnected rather than buffered. Malformed or text frames are a fatal `INVALID_ARGUMENT`.
- **Drain.** On shutdown every socket is closed with 1001 ("going away"); clients reconnect with backoff and jitter.

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

- Authorization is **central and runs before the handler**: one interceptor, after authentication, on every ConnectRPC service. A single table (`server.VaultProcedures`) classifies every vault-scoped procedure — every procedure whose request carries `vault_id` — as read or write. A request carrying a `vault_id` for an unclassified procedure is rejected, and a test derived from the schema descriptors fails if any such procedure is missing from the table. The interceptor reads only the top-level `vault_id`, so a request must name its vault nowhere else: a second schema-derived test walks every RPC input message (nested messages, `oneof` members, repeated and map fields, stopping at recursive types) and fails, naming the procedure and field path, on any vault-identifying field other than a single top-level, singular, non-`oneof` `string vault_id`. A field is vault-identifying if its name ends in `vault`, `vaults`, `vault_id` or `vault_ids` (also without the underscore before `id`; for example `target_vault_id`) or its type is the `Vault` message. Streaming calls to vault-scoped procedures are rejected before the handler runs, because their messages arrive only after it starts.
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
- Schema migrations are embedded (`internal/store/migrations`) and run on startup behind a PostgreSQL advisory lock, each in its own transaction, recorded in `schema_migrations`; migrations are forward-only and must be backward-compatible with the previous release. Released migrations are never edited (the runner rejects a changed name for an applied version). Migrations may use any feature of PostgreSQL 14, the minimum supported version (0003 defines its index function with a SQL-standard `RETURN` body, which binds its references at creation so `search_path` cannot change what the index computes). A migration that rebuilds an index holds an exclusive lock on its table until it commits; 0003 rebuilds the live-path index on `documents`, briefly blocking commits and reads of documents on every replica while it is applied.
- **High availability (§3).** Every replica must obey these rules, and every new feature must keep them:
  - **Stateless replicas.** A replica keeps no per-client state that lives only in its own process. Sessions, cursors and upload progress live in PostgreSQL (and S3). Consecutive requests of one client, including the chunks of one upload and its commit, may land on different replicas and must behave exactly as against one. Caches every replica can rebuild (the OIDC key set, credentials) are fine.
  - **Coordination through PostgreSQL only.** Advisory locks, `SELECT … FOR UPDATE SKIP LOCKED`, conditional updates and `LISTEN/NOTIFY` are the only cross-replica mechanisms (principle 5): no new infrastructure. Realtime fan-out (§6.4) must therefore reach clients connected to any replica.
  - **Background jobs run on every replica** and must be safe to run concurrently. Their combined effect equals one run, and a replica finding that another got there first is not an error and is not logged as one.
  - **Retry-safe RPCs.** A replica may be killed without warning (`SIGKILL`) at any point. Every RPC must therefore be safe for the client to retry on another replica: the retry succeeds, and no acknowledged write is lost or applied twice. Blob uploads are content-addressed and resumable; revision commits are deduplicated by their client-chosen revision id.
  - **Graceful drain.** On `SIGTERM` a replica fails `/readyz` at once and keeps serving for a configurable delay (`VAULT_SYNC_SHUTDOWN_DELAY`), closing each connection after its response so traffic moves to other replicas before any connection is refused. It then stops accepting connections and closes open WebSockets with close code 1001 ("going away") so clients reconnect elsewhere. In-flight RPCs get a configurable drain timeout (`VAULT_SYNC_SHUTDOWN_TIMEOUT`), and the process exits 0 after a clean drain.
  - **Database connection resets** (a PostgreSQL restart or switchover) are tolerated: connections are checked before use and replaced, and a request that fails mid-query is retried by the client. Managing PostgreSQL failover is the operator's concern (CloudNativePG).
  - **Rolling upgrades.** The previous and the new release serve side by side during a rollout. This is why migrations must be backward-compatible with the previous release (below). An integration test runs both releases against one database.
  - The recommended deployment (at least 2 replicas, a PodDisruptionBudget, readiness and termination-grace ordering) is documented in `docs/configuration.md`.
- Bounded resource use: max request size, max chunk size, decompression limits, pagination caps, per-user rate limits. Each user may have at most `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` authenticated RPCs in flight per replica, counted from authentication until the response is fully written; a further call is rejected at once with `RESOURCE_EXHAUSTED` before its handler runs (no queueing). The limit is an in-process count keyed by user ID, dropped when the user's last call ends, so it needs no cross-replica state and no client-visible state is lost with a replica. Responses are bounded by the same size as requests (the bytes sent). Writing each API response is bounded by `VAULT_SYNC_WRITE_TIMEOUT`, counted from the response's first byte, so a client that stops reading releases its connection. It does not bound the time before the response starts, so a long commit is not cut short (§6.2). The upgraded realtime WebSocket is exempt and bounded by its own pings and send queue (§6.4). Concurrent `/readyz` checks share one database ping.
- The plugin is distributed through GitHub releases (installable with BRAT); publishing to the Obsidian community catalog is a non-goal for now.

## 13. Testing strategy

| Layer | Tooling | Runs in |
|---|---|---|
| Go unit | `go test -race`, testify | `make test`, CI |
| TS unit | vitest | `make test`, CI |
| Server integration | real PostgreSQL + S3-compatible store via `docker compose` | `make test-integration`, CI |
| **Sync simulation** | Seeded multi-client harness (`sim/`, TypeScript): N `core` engines over in-memory vaults against a real `vault-sync-server` process (real PostgreSQL + S3). Each client's transport is wrapped in a seeded fault injector (drop request, drop response after the server applied it, delay, reorder, partition, client crash/restart losing in-memory state). Operation schedules are derived from the seed so a failing seed replays the same client-side schedule. Invariants: convergence, no lost acknowledged writes, no resurrected deletes without a concurrent edit, no duplicate content. Failing seeds are minimized and committed as regression cases. Phase 1 (decision): scripted protocol clients stand in for the engines, and the invariants are server-side, checked by the Go driver directly in PostgreSQL. Every acknowledged revision is in history unchanged; `seq` is exactly `1..head_seq`; no two live documents share a `path_key`; and each document's revisions form one chain, so no commit succeeded against a stale base. Messages are delivered one at a time in logical (step) time, so a seed replays deterministically, and concurrency is modelled by interleaving. A server built with the `simfault` tag skips the base-revision check, and CI proves the harness catches it; no runtime switch exists. See `docs/testing/simulation.md`. | `make test-sim`, CI (short), nightly (long) |
| Crypto vectors | shared `testdata/crypto/` vectors | Go + TS unit tests |
| Path vectors | shared `testdata/paths/` vectors: `path_key` (`vectors.json`) and validity (`validity.json`) | Go + TS unit tests; validity also through `CommitRevision` (integration) |
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
testdata/paths/          cross-language path_key (§5) and path validity (§6.2) vectors
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
