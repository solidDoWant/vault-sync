# Server configuration

How the server reads its configuration, how it checks it, and which variables each subcommand reads moved to [Configuration](admin/configuration.md).

## Environment variables

[configuration-reference.md](admin/configuration-reference.md) lists every variable with its default and its allowed values. The sections below explain the main features that these variables control.

### Authentication

The token checks and how the server fetches the signing keys moved to [Sign-in tokens](admin/security.md#sign-in-tokens).

### Authorization

The operator's view (no administrator bypass, the errors for non-members and viewers, and the fixed limits) moved to [Security model](admin/security.md#authorization).

Every RPC whose request names a `vault_id` is authorized against the caller's membership in that vault before it runs. There is no administrator bypass. A caller who is not a member gets `not_found` (HTTP 404), the same response as for a vault that does not exist. A `viewer` calling a write RPC (committing revisions, uploading blobs) gets `permission_denied` (HTTP 403). A malformed `vault_id` (not a lowercase hyphenated UUID) gets `invalid_argument`.

A user becomes a vault's `owner` by creating it. A user may own at most 100 vaults, not counting deleted ones, and vault names are at most 256 bytes and may not contain control characters (Unicode category `Cc`, such as U+0000 or a newline), format characters (`Cf`, such as the bidi controls U+202A–U+202E and U+2066–U+2069, zero-width spaces and joiners, or the byte order mark) or line and paragraph separators (U+2028, U+2029); such names get `invalid_argument`. Creating an end-to-end encrypted vault is rejected with `failed_precondition` until end-to-end encryption is supported. Inviting other members comes in a later release. `ListVaults` returns at most 1000 vaults per call (100 if the client does not ask for a page size), and a page also ends early where its encoding would come near `VAULT_SYNC_MAX_REQUEST_BYTES`, as for the change feed below, returning a `next_page_token` to continue. An owner can delete a vault (`DeleteVault`; editors and viewers get `permission_denied`). The vault is marked deleted in the `vaults.deleted_at` column, and its rows and blobs are kept. It disappears from `ListVaults`, and every member's request naming it, realtime subscriptions included, gets `not_found` with an error detail of reason `ERROR_REASON_VAULT_DELETED`.

Each plugin installation registers itself as a device (`RegisterDevice`), and so does every reinstall, including a mobile app whose data was wiped. A user may have at most 100 devices that have not been removed. The cap is fixed and cannot be configured. Once a user has 100 devices, every further `RegisterDevice` call from that user fails with `resource_exhausted` (HTTP 429), the message `at most 100 devices may be registered` and an error detail (`vaultsync.v1.ErrorDetail`) of reason `ERROR_REASON_DEVICE_LIMIT`; the user's existing devices keep syncing. The per-user limit on concurrent requests also answers `resource_exhausted`, with reason `ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS`; clients tell the two apart by the reason, not the message. A registration sent with a `registration_id` is idempotent: retrying it with the same public key returns the same device, with its current name (the retry's name is ignored), and uses no further place, so a plugin that crashed before saving its device does not use up the limit. The remedy is to remove devices that no longer exist: `ListDevices` lists the caller's devices (id, name, registration time and last commit, to within a minute; nothing secret), `RemoveDevice` removes one, which frees its place at once, and `RenameDevice` renames one that is not removed, keeping its id. They act only on the caller's own devices: another user's device is `not_found`, like one that does not exist. A removed device's row stays in the `devices` table with `removed_at` set, so the revisions it committed keep their history and the name of the device that made them, but it can no longer commit (`not_found`, with an error detail of reason `ERROR_REASON_DEVICE_NOT_FOUND`); the installation has to register again to sync. A retry, under the new device, of a commit that landed before the removal returns the committed revision instead of `invalid_argument`. The plugin lists and removes devices in its settings (see `docs/plugin.md`); the calls can also be made through the API with the user's access token. Deleting rows from the `devices` table by hand is not supported (revisions record the device that committed them). Device names must not be blank, are at most 256 bytes, and follow the same character rule as vault names (no `Cc`, `Cf`, U+2028 or U+2029); other names get `invalid_argument`. Names registered before this rule was added are kept and keep working; the plugin removes such characters wherever it shows a name.

A user's end-to-end encryption key pair is stored in the `user_keys` table (`UserKeyService`, `SPEC.md` §9.3): the public key, the Ed25519 signing public key (which member lists report; keys stored before it was added get it from the next device that unlocks them), the private key wrapped under the user's recovery passphrase, the wrapping's parameters and the SHA-256 of a verifier derived from the passphrase. Neither the passphrase nor the private key ever reaches the server. The server releases the wrapped key only to its owner and only for the right verifier. After 10 wrong passphrases within one hour, counted per user in PostgreSQL so that every replica enforces the same count, every unlock or passphrase change by that user fails with `resource_exhausted` and an error detail of reason `ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED` whose `retry_time` is the end of the hour. The limit is fixed and cannot be configured; it lifts by itself when the hour ends, so there is nothing for an operator to reset. A wrong passphrase gets `permission_denied` with reason `ERROR_REASON_WRONG_PASSPHRASE`.

Each user's sealed anchor list (the vaults whose genesis the user's devices trust, `docs/design/encryption.md`) is stored in the `anchor_lists` table as opaque bytes with a version number. The server cannot read it. A list may be at most 4,800,045 bytes (100,000 vaults), and the `VAULT_SYNC_MAX_REQUEST_BYTES` request limit also applies.

End-to-end encrypted vaults keep one key per epoch, which the server never sees. The `vault_key_epochs` table records each epoch with a 32-byte key commitment, and `key_slots` holds each epoch key wrapped to a member's user key, or to the escrow key, as opaque bytes of at most 256 (`VaultKeyService`, `SPEC.md` §9.3). A new encrypted vault has no epoch until its owner's client creates epoch 1, with the owner's slot and, for an escrow vault, the escrow slot. Owner clients create epochs and grant slots. The server checks only that every new epoch covers exactly the members who have a user key, and that revisions are committed under the vault's current epoch (otherwise `failed_precondition` with reason `ERROR_REASON_EPOCH_NOT_CURRENT`). The epoch counter is coordinated in PostgreSQL, so it is the same on every replica. Nothing here can be configured.

### Blob storage

Where blobs and staged chunks live in the bucket, the S3 permissions and the upload cleanup moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#what-lives-where).

The chunk and request limits moved to [Request size and the WAF](admin/security.md#request-size-and-the-waf) and [Fixed limits](admin/security.md#fixed-limits). A `CommitBlob` of a blob that the same replica is already committing waits for that commit and returns its result instead of composing the blob again. The startup check of the bucket moved to [Troubleshooting](admin/troubleshooting.md#cannot-use-the-s3-object-store).

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

This section moved to [The realtime channel](admin/security.md#the-realtime-channel) and, for the database connection, [PostgreSQL and S3](admin/postgresql-and-s3.md#poolers-and-realtime).

### PostgreSQL TLS

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#postgresql-tls).

## Endpoints

The listeners and their paths moved to [Endpoints](admin/configuration.md#endpoints). Cross-origin requests moved to [Security model](admin/security.md#cross-origin-requests).

The metrics listener's paths (`/healthz`, `/readyz`, `/metrics`) moved to [Monitoring](admin/monitoring.md#health-checks-and-metrics-endpoints).

## Metrics

[metrics-reference.md](admin/metrics-reference.md#per-replica-metrics) lists every per-replica metric, with its type, labels and meaning.

## Service-wide metrics

This section moved to [Monitoring](admin/monitoring.md#service-wide-metrics).

## Startup and shutdown

Migrations, the startup order, graceful shutdown and database connection resets moved to [Upgrades and high availability](admin/upgrades.md#migrations) and [PostgreSQL and S3](admin/postgresql-and-s3.md#switchover-and-restarts).

What the server logs when it cannot start, and what to do, moved to [Troubleshooting](admin/troubleshooting.md#the-server-does-not-start).

## High-availability deployment

This section moved to [Upgrades and high availability](admin/upgrades.md#high-availability).
