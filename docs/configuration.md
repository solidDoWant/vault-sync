# Server configuration

How the server reads its configuration, how it checks it, and which variables each subcommand reads moved to [Configuration](admin/configuration.md).

## Environment variables

[configuration-reference.md](admin/configuration-reference.md) lists every variable with its default and its allowed values. The sections below explain the main features that these variables control.

### Authentication

Every RPC except `vaultsync.v1.ServerInfoService/GetServerInfo` requires an `Authorization: Bearer` header carrying a JWT access token from the issuer. `GetServerInfo` returns only public data: the build and protocol versions, the realtime subscription limit, the issuer URL and the plugin's client ID. A token is accepted only if:

- it is at most 16 KiB;
- its signature and claims meet the checks in [What the provider must offer](admin/identity-provider.md#what-the-provider-must-offer).

Anything else gets the Connect code `unauthenticated` (HTTP 401) with no detail about the reason; the reason is logged at `debug` level. Tokens and claims are never logged.

The issuer's key set is fetched on the first authenticated request ([Where the server gets the signing keys](admin/identity-provider.md#where-the-server-gets-the-signing-keys)). It is refetched when a token names an unknown key id (key rotation) and when the cached keys are older than one hour (so withdrawn keys stop being trusted), but at most once every 30 seconds, so a flood of tokens with made-up key ids cannot amplify into requests to the issuer. Only one fetch runs at a time, bounded at 10 seconds. While a refetch of hour-old keys is in progress, other requests are verified against the cached keys instead of waiting, so a slow or hanging issuer delays only the request that started the refetch and requests naming an unknown key id.

The rules for `https` and redirects when the server fetches the discovery document and the keys moved to [Where the server gets the signing keys](admin/identity-provider.md#where-the-server-gets-the-signing-keys). A refused URL or redirect fails the fetch: before the first successful fetch every token is rejected, and afterwards the cached keys stay in use.

### Authorization

Every RPC whose request names a `vault_id` is authorized against the caller's membership in that vault before it runs. There is no administrator bypass. A caller who is not a member gets `not_found` (HTTP 404), the same response as for a vault that does not exist. A `viewer` calling a write RPC (committing revisions, uploading blobs) gets `permission_denied` (HTTP 403). A malformed `vault_id` (not a lowercase hyphenated UUID) gets `invalid_argument`.

A user becomes a vault's `owner` by creating it. A user may own at most 100 vaults, not counting deleted ones, and vault names are at most 256 bytes and may not contain control characters (Unicode category `Cc`, such as U+0000 or a newline), format characters (`Cf`, such as the bidi controls U+202A–U+202E and U+2066–U+2069, zero-width spaces and joiners, or the byte order mark) or line and paragraph separators (U+2028, U+2029); such names get `invalid_argument`. Creating an end-to-end encrypted vault is rejected with `failed_precondition` until end-to-end encryption is supported. Inviting other members comes in a later release. `ListVaults` returns at most 1000 vaults per call (100 if the client does not ask for a page size), and a page also ends early where its encoding would come near `VAULT_SYNC_MAX_REQUEST_BYTES`, as for the change feed below, returning a `next_page_token` to continue. An owner can delete a vault (`DeleteVault`; editors and viewers get `permission_denied`). The vault is marked deleted in the `vaults.deleted_at` column, and its rows and blobs are kept. It disappears from `ListVaults`, and every member's request naming it, realtime subscriptions included, gets `not_found` with an error detail of reason `ERROR_REASON_VAULT_DELETED`.

Each plugin installation registers itself as a device (`RegisterDevice`), and so does every reinstall, including a mobile app whose data was wiped. A user may have at most 100 devices that have not been removed. The cap is fixed and cannot be configured. Once a user has 100 devices, every further `RegisterDevice` call from that user fails with `resource_exhausted` (HTTP 429), the message `at most 100 devices may be registered` and an error detail (`vaultsync.v1.ErrorDetail`) of reason `ERROR_REASON_DEVICE_LIMIT`; the user's existing devices keep syncing. The per-user limit on concurrent requests also answers `resource_exhausted`, with reason `ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS`; clients tell the two apart by the reason, not the message. A registration sent with a `registration_id` is idempotent: retrying it with the same public key returns the same device, with its current name (the retry's name is ignored), and uses no further place, so a plugin that crashed before saving its device does not use up the limit. The remedy is to remove devices that no longer exist: `ListDevices` lists the caller's devices (id, name, registration time and last commit, to within a minute; nothing secret), `RemoveDevice` removes one, which frees its place at once, and `RenameDevice` renames one that is not removed, keeping its id. They act only on the caller's own devices: another user's device is `not_found`, like one that does not exist. A removed device's row stays in the `devices` table with `removed_at` set, so the revisions it committed keep their history and the name of the device that made them, but it can no longer commit (`not_found`, with an error detail of reason `ERROR_REASON_DEVICE_NOT_FOUND`); the installation has to register again to sync. A retry, under the new device, of a commit that landed before the removal returns the committed revision instead of `invalid_argument`. The plugin lists and removes devices in its settings (see `docs/plugin.md`); the calls can also be made through the API with the user's access token. Deleting rows from the `devices` table by hand is not supported (revisions record the device that committed them). Device names must not be blank, are at most 256 bytes, and follow the same character rule as vault names (no `Cc`, `Cf`, U+2028 or U+2029); other names get `invalid_argument`. Names registered before this rule was added are kept and keep working; the plugin removes such characters wherever it shows a name.

A user's end-to-end encryption key pair is stored in the `user_keys` table (`UserKeyService`, `SPEC.md` §9.3): the public key, the Ed25519 signing public key (which member lists report; keys stored before it was added get it from the next device that unlocks them), the private key wrapped under the user's recovery passphrase, the wrapping's parameters and the SHA-256 of a verifier derived from the passphrase. Neither the passphrase nor the private key ever reaches the server. The server releases the wrapped key only to its owner and only for the right verifier. After 10 wrong passphrases within one hour, counted per user in PostgreSQL so that every replica enforces the same count, every unlock or passphrase change by that user fails with `resource_exhausted` and an error detail of reason `ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED` whose `retry_time` is the end of the hour. The limit is fixed and cannot be configured; it lifts by itself when the hour ends, so there is nothing for an operator to reset. A wrong passphrase gets `permission_denied` with reason `ERROR_REASON_WRONG_PASSPHRASE`.

Each user's sealed anchor list (the vaults whose genesis the user's devices trust, `docs/design/encryption.md`) is stored in the `anchor_lists` table as opaque bytes with a version number. The server cannot read it. A list may be at most 4,800,045 bytes (100,000 vaults), and the `VAULT_SYNC_MAX_REQUEST_BYTES` request limit also applies.

End-to-end encrypted vaults keep one key per epoch, which the server never sees. The `vault_key_epochs` table records each epoch with a 32-byte key commitment, and `key_slots` holds each epoch key wrapped to a member's user key, or to the escrow key, as opaque bytes of at most 256 (`VaultKeyService`, `SPEC.md` §9.3). A new encrypted vault has no epoch until its owner's client creates epoch 1, with the owner's slot and, for an escrow vault, the escrow slot. Owner clients create epochs and grant slots. The server checks only that every new epoch covers exactly the members who have a user key, and that revisions are committed under the vault's current epoch (otherwise `failed_precondition` with reason `ERROR_REASON_EPOCH_NOT_CURRENT`). The epoch counter is coordinated in PostgreSQL, so it is the same on every replica. Nothing here can be configured.

### Blob storage

Where blobs and staged chunks live in the bucket, the S3 permissions and the upload cleanup moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#what-lives-where).

Uploads arrive in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`, so no request exceeds the WAF's body limit. Each replica composes at most 4 blobs at once, at most 2 of them for one user, so one user's large commits cannot keep other users' commits waiting; a user's further commits wait their turn. A `CommitBlob` of a blob that the same replica is already committing waits for that commit and returns its result instead of composing the blob again. These limits are fixed and cannot be configured. Every chunk but the last must be at least 64 KiB (or the advertised `max_chunk_size`, if smaller). At startup the server checks that the bucket is reachable (`HeadBucket`, 30 seconds) and exits with status 1 if not.

Requests and responses are bounded by `VAULT_SYNC_MAX_REQUEST_BYTES` in both directions. A response is measured by the bytes sent, after compression when the client accepts it, and one over the limit fails with `RESOURCE_EXHAUSTED`. A maximum-size chunk fits only in the binary protobuf encoding, which the plugin uses; a client using the Connect JSON encoding (base64 bytes, a third larger) must send smaller chunks and request smaller download ranges.

### Revisions and the change feed

Page sizes and response limits moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#page-sizes-and-response-limits).

`SyncService` stores document revisions in PostgreSQL. Revisions name their content by blob id, so committing one requires that blob to have been uploaded completely to the same vault first (`failed_precondition` otherwise). The fixed bounds are:

- A path is at most 4096 bytes of UTF-8 without control characters and at most 8192 bytes once normalized (Unicode normalization and case folding can lengthen it). It must stay inside the vault on every client platform, so both `/` and `\` count as separators: it may not start with a separator (including UNC, `\\?\` and `\\.\` prefixes) or with a drive prefix such as `C:`, and no segment may be empty or consist only of dots and spaces (`.`, `..`, `...`). A new path may not contain `\` at all, may not start with any single character followed by a colon (such as `1:x.md` or `é:x.md`, which Windows also reads as a drive), and must be portable: no file or folder name in it contains any of `< > : " | ? *`, starts or ends with a space, ends in a dot, is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension) or is longer than 255 bytes, and the whole path is at most 1024 bytes. A commit that creates a document at such a path, moves one there, or brings a deleted one back there gets `invalid_argument`. Documents committed at such paths before these rules keep their paths and can still be edited, deleted, or renamed to a valid path. Anything else gets `invalid_argument`. The full rule is in `SPEC.md` §6.2.
- Paths are unique per vault ignoring case and Unicode normalization, among documents that are not deleted: creating or renaming a document onto a path that differs from a live document's only in case or normalization gets `already_exists`. A file and a folder cannot share a name either, again ignoring case and normalization: while `notes` is a live document, creating or renaming a document to `Notes/c.md` gets `already_exists`, and while `notes/c.md` is live, so does `NOTES`. Deleted documents never collide.

Revisions of end-to-end encrypted vaults are rejected (`failed_precondition`), like creating such a vault.

### Retention and history

This section moved to [History and retention](admin/history-and-retention.md#the-retention-policy).

#### Per-vault overrides

This section moved to [History and retention](admin/history-and-retention.md#per-vault-overrides).

### Realtime channel

Clients learn about new revisions through one WebSocket per device (SPEC.md §6.4). What your ingress needs for it moved to [Install](admin/install.md#the-ingress).

- **Authentication.** Browser clients (the Obsidian plugin) send the access token as the WebSocket subprotocol `vaultsync.bearer.<token>`, next to `vaultsync.v1`; other clients may send `Authorization: Bearer <token>` instead. The token is never put in the URL, and the server never logs the `Sec-WebSocket-Protocol` header; if your proxy logs request headers, exclude that one. Upgrades are refused with HTTP 401 without a valid token and HTTP 403 from a browser origin other than the Obsidian app origins. When the token expires the server sends an `UNAUTHENTICATED` error frame and closes the connection, and the client reconnects with a fresh token.
- **Authorization.** Each subscription is checked against the caller's vault membership, and so is every notification before it is sent: a non-member gets `NOT_FOUND`, exactly as for a vault that does not exist, and a member removed from a vault stops receiving its notifications. Before each delivery one membership query per vault covers up to 1,000 subscribed users. If that query fails, the notification is not sent (clients catch up on their next pull).
- **Multiple replicas.** Commits are announced through PostgreSQL `LISTEN/NOTIFY` (channel `vault_changed`), so a client connected to any replica is notified of commits made on every replica. Each replica holds one extra database connection for this, outside the connection pool. `LISTEN` needs a long-lived session, so `VAULT_SYNC_DATABASE_URL` must point at PostgreSQL directly or at a pooler in session mode; a pooler in transaction or statement mode (such as PgBouncer with `pool_mode = transaction`) silently breaks notifications. Every commit sends a `NOTIFY`, and PostgreSQL serializes the commits of transactions that notify on one database-wide lock; this is negligible at the scale of a sync server but worth knowing if the database is shared with write-heavy workloads. If it is lost (a database restart), the replica reconnects with backoff and then re-announces the current state of every subscribed vault, so no notification is lost for long. Clients also pull periodically, so notifications only ever reduce latency.
- **Limits.** Besides the variables in [configuration-reference.md](admin/configuration-reference.md#realtime-channel), a client frame may be at most 4 KiB and clients may send 20 frames per second on average. Notifications for a slow client are queued only up to a fixed bound; a client that falls further behind is disconnected and reconnects.

### PostgreSQL TLS

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#postgresql-tls).

## Endpoints

The listeners and their paths moved to [Endpoints](admin/configuration.md#endpoints). On the API listener, cross-origin requests are allowed only from the Obsidian app origins `app://obsidian.md`, `capacitor://localhost` and `http://localhost`.

The metrics listener serves:

| Path | Meaning |
|---|---|
| `/healthz` | Liveness. Returns 200 while the process is serving. |
| `/readyz` | Readiness. Returns 200 when PostgreSQL answers a ping within 2 seconds, and 503 when it does not or while the server is shutting down. Concurrent checks share one ping, so a burst of probes against a slow database holds at most one pool connection. No result is reused after its ping ends, and each replica checks only its own connection pool. |
| `/metrics` | Prometheus metrics of this replica (see [Metrics](#metrics)). |


## Metrics

[metrics-reference.md](admin/metrics-reference.md#per-replica-metrics) lists every per-replica metric, with its type, labels and meaning.

## Service-wide metrics

These describe the whole deployment rather than one replica, and are served only on `VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS` (`/metrics`), never on the per-instance metrics port. Every replica serves the same values, so a scrape config may scrape them from a single replica. A scrape never queries the database: each replica reads the values from PostgreSQL in the background every `VAULT_SYNC_SERVICE_METRICS_INTERVAL`, each query bounded by a 10-second timeout, and serves the last values read. A query that fails is logged (`service metrics query failed`) and keeps its metrics' previous values; alert when `vault_sync_service_metrics_last_refresh_success_timestamp_seconds` falls behind. No metric has a per-user, per-vault or per-device label.

[metrics-reference.md](admin/metrics-reference.md#service-wide-metrics) lists every service-wide metric, with its type, labels and meaning.

## Startup and shutdown

Migrations, the startup order, graceful shutdown and database connection resets moved to [Upgrades and high availability](admin/upgrades.md#migrations) and [PostgreSQL and S3](admin/postgresql-and-s3.md#switchover-and-restarts).

On startup the server exits with status 1 if it cannot connect to PostgreSQL. The server requires PostgreSQL 14 or newer; on older versions the schema migrations fail and the server exits.

## High-availability deployment

This section moved to [Upgrades and high availability](admin/upgrades.md#high-availability).
