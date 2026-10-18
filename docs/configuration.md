# Server configuration

`vault-sync-server` is configured entirely by environment variables. An empty variable is treated as unset. On startup the server validates every variable and, if any is missing or invalid, exits with status 1 after logging one `invalid configuration` record whose `problems` field names each offending variable. Secret values (such as the database password) are never echoed.

The `vault-sync-server export` subcommand reads the database, S3 and log-level variables below and ignores the rest; see [export.md](export.md).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VAULT_SYNC_DATABASE_URL` | (required) | PostgreSQL connection string, as a `postgres://` URL or libpq keyword/value string. It must not contain `sslcert` or `sslkey`; use the TLS file variables below instead, so rotated client certificates are picked up. |
| `VAULT_SYNC_DATABASE_TLS_CERT_FILE` | unset | PEM client certificate for PostgreSQL. Must be set together with `VAULT_SYNC_DATABASE_TLS_KEY_FILE`. Re-read for every new connection. |
| `VAULT_SYNC_DATABASE_TLS_KEY_FILE` | unset | PEM private key for the client certificate. Must be set together with `VAULT_SYNC_DATABASE_TLS_CERT_FILE`. Re-read for every new connection. |
| `VAULT_SYNC_DATABASE_TLS_CA_FILE` | unset | PEM bundle of CAs trusted to sign the PostgreSQL server certificate. Re-read for every new connection. See the note below about verification. |
| `VAULT_SYNC_LISTEN_ADDRESS` | `:8080` | `host:port` for the API listener (ConnectRPC). This is the port to expose through the ingress. |
| `VAULT_SYNC_METRICS_LISTEN_ADDRESS` | `:9090` | `host:port` for the metrics and health listener (`/metrics`, `/healthz`, `/readyz`). Must differ from `VAULT_SYNC_LISTEN_ADDRESS`. Do not expose it to the internet. |
| `VAULT_SYNC_MAX_REQUEST_BYTES` | `1048576` (1 MiB) | Maximum size of a request body in bytes, applied both to the bytes on the wire and to the decompressed message. Allowed range: 16384 to 67108864 (a response carrying one revision with a maximum-length path, or one vault with a maximum-length name, must fit; the chunk size check below requires more in practice). The default matches the 1 MiB inspected-body limit of the WAF in front of the server. Request bodies are read and decoded before the bearer token is checked, so unauthenticated callers can make the server read up to this many bytes per request; keep the limit low. |
| `VAULT_SYNC_WRITE_TIMEOUT` | `2m` | How long writing an API response may take, counted from its first byte until the whole response is written. A response the client has not finished reading by then is cut off and the connection closed, so a client that sends a request and then stops reading cannot hold a connection open. The timeout does not limit how long the server works on a request before it starts the response: a long `CommitBlob` (composing a large blob in the object store) is not cut short. The default lets a 1 MiB response reach a client on a link of about 100 kbit/s. Raise it if you raise `VAULT_SYNC_MAX_REQUEST_BYTES` for slow clients. The timeout does not apply to the realtime WebSocket once it is open. A Go duration from `1s` to `1h`. |
| `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` | `32` | Authenticated RPCs one user may have in flight on this replica at once (1 to 10000). A further call from that user is rejected immediately with `resource_exhausted`, before any work is done for it, and is not queued; other users are unaffected. An RPC counts from authentication until its response has been completely written, so a client that stops reading its responses keeps holding its calls until `VAULT_SYNC_WRITE_TIMEOUT` cuts them off. The limit is per replica and keeps no state shared between replicas or after a user's calls end. The plugin makes one RPC at a time per device, so the default admits 32 devices of one user syncing on the same replica at once (matching `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER`) while one user can hold at most 32 response buffers of up to `VAULT_SYNC_MAX_REQUEST_BYTES` each. `GetServerInfo`, which needs no authentication, is not counted. |
| `VAULT_SYNC_SHUTDOWN_DELAY` | `5s` | How long after `SIGTERM` or `SIGINT` `/readyz` fails while the API keeps serving, so load balancers stop sending traffic before any connection is refused (see [Startup and shutdown](#startup-and-shutdown)). A Go duration from `0s` to `5m`. |
| `VAULT_SYNC_SHUTDOWN_TIMEOUT` | `30s` | The drain timeout: how long in-flight requests may finish after `VAULT_SYNC_SHUTDOWN_DELAY` before the remaining connections are closed. A Go duration (`30s`, `1m`); must be positive. Keep the delay plus the timeout below the pod's `terminationGracePeriodSeconds`. |
| `VAULT_SYNC_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn` or `error`. |
| `VAULT_SYNC_OIDC_ISSUER_URL` | (required) | OIDC issuer identifier, for example `https://auth.example.com/application/o/vault-sync/` for Authentik. Access tokens' `iss` claim must equal it exactly (including any trailing slash). The signing keys are discovered from `<issuer>/.well-known/openid-configuration`. Must be `https`; plain `http` is accepted only for a loopback host (`localhost`, `127.0.0.1`, `::1`) for local development. |
| `VAULT_SYNC_OIDC_AUDIENCE` | (required) | Audience that access tokens' `aud` claim must contain; for Authentik, the client ID of the vault-sync provider. The plugin signs in as that client with the device flow; see `docs/plugin.md` for the provider setup. |
| `VAULT_SYNC_S3_BUCKET` | unset | S3 bucket holding every vault's blobs. It must already exist. Required when any `VAULT_SYNC_S3_*` variable is set. When no `VAULT_SYNC_S3_*` variable is set, the server starts without an object store, logs a warning, and every `BlobService` RPC returns `unimplemented`. |
| `VAULT_SYNC_S3_ENDPOINT` | unset (AWS S3) | Base URL of the S3-compatible store, for example `https://rgw.example.com`. Must be `http` or `https`, without credentials, query or fragment. |
| `VAULT_SYNC_S3_REGION` | `us-east-1` | Region of the bucket. Ceph RGW accepts any region by default. |
| `VAULT_SYNC_S3_ACCESS_KEY_ID_FILE` | unset | File containing the S3 access key id. Required with the bucket. |
| `VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE` | unset | File containing the S3 secret access key. Required with the bucket. Both credential files are read at startup (failing if missing, empty or larger than 4 KiB) and again every 10 seconds, so rotated credentials (for example a swapped Kubernetes Secret) are used without a restart. Their contents are never logged. |
| `VAULT_SYNC_S3_FORCE_PATH_STYLE` | `true` | `true` addresses the bucket as `<endpoint>/<bucket>` (what Ceph RGW and most self-hosted stores need); `false` uses virtual-hosted `<bucket>.<endpoint>`. |
| `VAULT_SYNC_S3_TLS_CA_FILE` | unset (system roots) | PEM bundle of CAs trusted for the S3 endpoint's certificate instead of the system roots. Re-read for every new connection. The certificate must still name the host connected to: a DNS SAN for a host-name endpoint (`<bucket>.<host>` with virtual-hosted addressing), an IP SAN for an IP-address endpoint. A certificate that fails verification (wrong host, untrusted CA, expired), with or without this setting, is not retried: the request fails on its first attempt and the log shows the certificate error. |
| `VAULT_SYNC_S3_IDLE_TIMEOUT` | `2m` | How long a connection to the object store may make no progress, sending or receiving nothing, before the request on it fails. The SDK retries a timed-out request up to twice, so an object store that accepts connections and then stops answering fails a call after at most about three timeouts (plus a few seconds of backoff): `PutBlobChunk`, `DownloadBlob` and `CommitBlob` return `internal` and the client retries, and a cleanup run logs the failure. The timeout is not a limit on a whole call: a slow transfer that keeps moving, a long `CommitBlob` of a large blob, or a long export stream is never cut short. Raise it if the store can legitimately stay silent for longer before answering (for example while completing a very large multipart upload without sending keep-alive whitespace), or if the link to it is so slow that the last few MiB of a request buffered in the network take longer than this to drain. Pooled connections idle for half the timeout are closed. A Go duration from `1s` to `1h`. |
| `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES` | `786432` (768 KiB) | Largest upload chunk, and the largest range one `DownloadBlob` returns, for clients using the binary protobuf codec (the plugin). At least 65536. It plus 1024 bytes of request framing must not exceed `VAULT_SYNC_MAX_REQUEST_BYTES`, or the server refuses to start. Clients using the Connect JSON codec, which base64-encodes chunk data, are advertised (in `BeginBlob`'s `max_chunk_size`) and served smaller chunks, so their messages fit `VAULT_SYNC_MAX_REQUEST_BYTES` too: 784878 bytes with the defaults. |
| `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` | `1073741824` (1 GiB) | Largest blob (file) that can be uploaded. At most 83886080000 (80 GiB). |
| `VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT` | `32` | Upload sessions that may be in progress at once in one vault (1 to 10000). Further `BeginBlob` calls get `resource_exhausted` until one completes or expires. |
| `VAULT_SYNC_BLOB_UPLOAD_TTL` | `24h` | How long an upload session may be idle before the cleanup routine removes it. A Go duration of at least `10m`. A commit in progress records activity after every 8 MiB part it composes, so it is never removed, however long it takes. |
| `VAULT_SYNC_REALTIME_MAX_CONNECTIONS` | `10000` | Open realtime WebSocket connections this replica accepts (1 to 1000000). Further upgrades get HTTP 503, and the client reconnects, through the load balancer, to another replica. |
| `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER` | `32` | Open realtime connections one user may hold on this replica (1 to 10000). Further upgrades get HTTP 429. Each device needs one. |
| `VAULT_SYNC_REALTIME_MAX_SUBSCRIPTIONS` | `128` | Vaults one realtime connection may subscribe to (1 to 10000). Reported to clients as `max_realtime_subscriptions` by `GetServerInfo`; a further `subscribe` gets a `RESOURCE_EXHAUSTED` error frame. |

### Authentication

Every RPC except `vaultsync.v1.ServerInfoService/GetServerInfo` requires an `Authorization: Bearer` header carrying a JWT access token from the issuer. A token is accepted only if:

- it is at most 16 KiB;
- it is signed with RS256, ES256 or EdDSA (never `none` or an HMAC algorithm) by a key in the issuer's key set;
- `iss` equals `VAULT_SYNC_OIDC_ISSUER_URL`, `aud` contains `VAULT_SYNC_OIDC_AUDIENCE`, `sub` is present (at most 255 bytes, without control characters), `exp` is present and not in the past (no leeway), and `nbf`, if present, is no more than one minute in the future.

Anything else gets the Connect code `unauthenticated` (HTTP 401) with no detail about the reason; the reason is logged at `debug` level. Tokens and claims are never logged.

The issuer's key set is fetched on the first authenticated request, not at startup, so the server starts even when the issuer is unreachable. It is refetched when a token names an unknown key id (key rotation) and when the cached keys are older than one hour (so withdrawn keys stop being trusted), but at most once every 30 seconds, so a flood of tokens with made-up key ids cannot amplify into requests to the issuer. A newly rotated key is therefore accepted at most 30 seconds after the previous fetch. If a refetch fails, the cached keys stay in use. Only one fetch runs at a time, bounded at 10 seconds. While a refetch of hour-old keys is in progress, other requests are verified against the cached keys instead of waiting, so a slow or hanging issuer delays only the request that started the refetch and requests naming an unknown key id.

The discovery document, the `jwks_uri` it names and every redirect are fetched over `https` only. The `jwks_uri` may be on another host than the issuer. Plain `http` is used only when `VAULT_SYNC_OIDC_ISSUER_URL` is itself a loopback `http` URL, and then only to loopback hosts. A redirect is followed only if it stays on the host (and port) of the URL first requested and does not change `https` to `http`, for at most 5 redirects. A redirect to another host is refused, so if your issuer moves its discovery document or keys to another host with a redirect, configure the final issuer URL instead. A refused URL or redirect fails the fetch: before the first successful fetch every token is rejected, and afterwards the cached keys stay in use.

The first authenticated request of a new `(issuer, subject)` pair creates its user.

### Authorization

Every RPC whose request names a `vault_id` is authorized against the caller's membership in that vault before it runs. There is no administrator bypass. A caller who is not a member gets `not_found` (HTTP 404), the same response as for a vault that does not exist. A `viewer` calling a write RPC (committing revisions, uploading blobs) gets `permission_denied` (HTTP 403). A malformed `vault_id` (not a lowercase hyphenated UUID) gets `invalid_argument`.

A user becomes a vault's `owner` by creating it. A user may own at most 100 vaults, and vault names are at most 256 bytes and may not contain control characters (Unicode category `Cc`, such as U+0000 or a newline); such names get `invalid_argument`. Creating an end-to-end encrypted vault is rejected with `failed_precondition` until end-to-end encryption is supported. Inviting other members comes in a later release. `ListVaults` returns at most 1000 vaults per call (100 if the client does not ask for a page size), and a page also ends early where its encoding would come near `VAULT_SYNC_MAX_REQUEST_BYTES`, as for the change feed below, returning a `next_page_token` to continue.

Each plugin installation registers itself as a device (`RegisterDevice`), and so does every reinstall, including a mobile app whose data was wiped. A user may register at most 100 devices over the lifetime of the account: devices cannot be listed, removed or replaced in this release, so a device counts against the cap forever, whether or not the installation still exists. The cap is fixed and cannot be configured. Once a user has 100 devices, every further `RegisterDevice` call from that user fails with `resource_exhausted` (HTTP 429) and the message `at most 100 devices may be registered`; the user's existing devices keep syncing. There is no supported remedy yet: the server has no way to free a device, and deleting rows from the `devices` table by hand is not supported (revisions record the device that committed them, and an installation whose device row is gone can no longer commit). Device names must not be blank, are at most 256 bytes, and may not contain control characters (Unicode category `Cc`); other names get `invalid_argument`.

### Blob storage

File contents are stored in the S3 bucket as one object per blob at `vaults/<vault_id>/blobs/<hex(blob_id)>`. Uploads arrive in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`, so no request exceeds the WAF's body limit; each chunk is staged as its own object under `vaults/<vault_id>/uploads/<upload_id>/` and `CommitBlob` streams the chunks into the blob's object, verifying the SHA-256 for plaintext vaults before anything becomes visible. Every chunk but the last must be at least 64 KiB (or the advertised `max_chunk_size`, if smaller). The server needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` and `s3:AbortMultipartUpload` on the bucket. At startup it checks that the bucket is reachable (`HeadBucket`, 30 seconds) and exits with status 1 if not.

Every 5 minutes a cleanup routine removes upload sessions idle for longer than `VAULT_SYNC_BLOB_UPLOAD_TTL` (deleting their staged objects) and aborts multipart uploads under `vaults/` older than the TTL whose blob has no upload session active within the TTL, which an interrupted commit leaves behind and which S3 would otherwise keep, invisibly, forever. Every replica runs the cleanup on the same schedule; concurrent runs are safe, and an upload or object another replica already removed is not an error. Each run removes at most 100 sessions and 10,000 objects, so a backlog is worked off over several runs. A run still going when the next one is due (for example behind an object store that stopped answering) is cut short and logged as a failure, and the next run starts on schedule; the work it left undone is picked up by later runs. Blobs no longer referenced by any revision are not deleted yet.

Requests and responses are bounded by `VAULT_SYNC_MAX_REQUEST_BYTES` in both directions. A response is measured by the bytes sent, after compression when the client accepts it, and one over the limit fails with `RESOURCE_EXHAUSTED`. A maximum-size chunk fits only in the binary protobuf encoding, which the plugin uses; a client using the Connect JSON encoding (base64 bytes, a third larger) must send smaller chunks and request smaller download ranges.

### Revisions and the change feed

`SyncService` stores document revisions in PostgreSQL. It needs no configuration beyond the database; revisions name their content by blob id, so committing one requires that blob to have been uploaded completely to the same vault first (`failed_precondition` otherwise). The fixed bounds are:

- A path is at most 4096 bytes of UTF-8 without control characters and at most 8192 bytes once normalized (Unicode normalization and case folding can lengthen it). It must stay inside the vault on every client platform, so both `/` and `\` count as separators: it may not start with a separator (including UNC, `\\?\` and `\\.\` prefixes) or with a drive prefix such as `C:`, and no segment may be empty or consist only of dots and spaces (`.`, `..`, `...`). Names Windows merely cannot create, such as `CON.md` or `ab:c.md`, are accepted. Anything else gets `invalid_argument`. The full rule is in `SPEC.md` §6.2.
- `ListChanges` returns at most 1000 revisions per call (500 if the client does not ask for a page size); `GetDocumentHistory` at most 1000 (default 100). Larger page sizes are reduced, not rejected.
- A page also ends early where its encoding, in the encoding the client uses (binary protobuf or JSON), would come near `VAULT_SYNC_MAX_REQUEST_BYTES`, which also bounds responses: with 4096-byte paths, about 240 revisions fit the default 1 MiB in binary protobuf (about 175 in JSON). Such a page reports more to come (`has_more`, or a `next_page_token`), so the client continues where it stopped. A page always holds at least one revision when there is one.
- Paths are unique per vault ignoring case and Unicode normalization, among documents that are not deleted: creating or renaming a document onto a path that differs from a live document's only in case or normalization gets `already_exists`. A file and a folder cannot share a name either, again ignoring case and normalization: while `notes` is a live document, creating or renaming a document to `Notes/c.md` gets `already_exists`, and while `notes/c.md` is live, so does `NOTES`. Deleted documents never collide.

Commits to a vault are serialized by a PostgreSQL row lock on the vault, held for the duration of one short transaction, so any number of server replicas can accept commits for the same vault concurrently: each revision gets the vault's next sequence number with no gaps, and a revision is never visible in the change feed before one with a lower number. Revisions of end-to-end encrypted vaults are rejected (`failed_precondition`), like creating such a vault.

### Realtime channel

Clients learn about new revisions through one WebSocket per device at `GET /v1/realtime` on the API listener (SPEC.md §6.4); it carries binary protobuf frames, a few bytes each. Your ingress must allow WebSocket upgrades on that path and should not time out idle connections faster than every 30 seconds (the server pings each client every 30 seconds and disconnects one that does not answer within 10).

- **Authentication.** Browser clients (the Obsidian plugin) send the access token as the WebSocket subprotocol `vaultsync.bearer.<token>`, next to `vaultsync.v1`; other clients may send `Authorization: Bearer <token>` instead. The token is never put in the URL, and the server never logs the `Sec-WebSocket-Protocol` header; if your proxy logs request headers, exclude that one. Upgrades are refused with HTTP 401 without a valid token and HTTP 403 from a browser origin other than the Obsidian app origins. When the token expires the server sends an `UNAUTHENTICATED` error frame and closes the connection, and the client reconnects with a fresh token.
- **Authorization.** Each subscription is checked against the caller's vault membership, and so is every notification before it is sent: a non-member gets `NOT_FOUND`, exactly as for a vault that does not exist, and a member removed from a vault stops receiving its notifications.
- **Multiple replicas.** Commits are announced through PostgreSQL `LISTEN/NOTIFY` (channel `vault_changed`), so a client connected to any replica is notified of commits made on every replica. Each replica holds one extra database connection for this, outside the connection pool. If it is lost (a database restart), the replica reconnects with backoff and then re-announces the current state of every subscribed vault, so no notification is lost for long. Clients also pull periodically, so notifications only ever reduce latency.
- **Limits.** Besides the variables above, a client frame may be at most 4 KiB and clients may send 20 frames per second on average. Notifications for a slow client are queued only up to a fixed bound; a client that falls further behind is disconnected and reconnects.

### PostgreSQL TLS

TLS is enabled with the DSN's `sslmode`; use `require`, `verify-ca` or `verify-full`. Setting any of the TLS file variables with a DSN whose first connection attempt is plaintext (`sslmode=disable` or `allow`) is rejected at startup. With `sslmode=prefer` (the libpq default when `sslmode` is omitted) and a TLS file set, the plaintext fallback is removed, so the connection never silently downgrades.

**Setting `VAULT_SYNC_DATABASE_TLS_CA_FILE` always turns on full verification**: the server certificate chain is checked against the CA bundle and the host name in the DSN must match the certificate, even when the DSN says `sslmode=require` or `sslmode=verify-ca`. Make sure the DSN's host is a name (or IP) present in the PostgreSQL server certificate. With CloudNativePG, use the `<cluster>-rw` service name the operator puts in the certificate.

## Endpoints

The API listener serves only the ConnectRPC services under `/vaultsync.v1.*/` and the realtime WebSocket at `/v1/realtime`. Cross-origin requests are allowed only from the Obsidian app origins `app://obsidian.md`, `capacitor://localhost` and `http://localhost`.

The metrics listener serves:

| Path | Meaning |
|---|---|
| `/healthz` | Liveness. Returns 200 while the process is serving. |
| `/readyz` | Readiness. Returns 200 when PostgreSQL answers a ping within 2 seconds, and 503 when it does not or while the server is shutting down. Concurrent checks share one ping, so a burst of probes against a slow database holds at most one pool connection. No result is reused after its ping ends, and each replica checks only its own connection pool. |
| `/metrics` | Prometheus metrics. |

## Metrics

Besides the standard Go runtime (`go_*`) and process (`process_*`) metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `vault_sync_rpc_requests_total` | counter | `procedure`, `code` | RPCs handled, by full procedure name (for example `/vaultsync.v1.ServerInfoService/GetServerInfo`) and Connect status code (`ok`, `unimplemented`, ...). |
| `vault_sync_rpc_request_duration_seconds` | histogram | `procedure`, `code` | Time spent handling each RPC. |
| `vault_sync_rpc_concurrency_rejections_total` | counter | `procedure` | Authenticated RPCs rejected with `resource_exhausted` because their user already had `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` calls in flight on this replica. These calls are also counted in `vault_sync_rpc_requests_total` with code `resource_exhausted`. |
| `vault_sync_rpc_in_flight` | gauge | | Authenticated RPCs in flight on this replica, counted until their response is written. |
| `vault_sync_rpc_in_flight_users` | gauge | | Users with at least one authenticated RPC in flight on this replica. |
| `vault_sync_realtime_connections` | gauge | | Open realtime WebSocket connections on this replica. |
| `vault_sync_realtime_refused_upgrades_total` | counter | `reason` | Realtime upgrades refused: `origin`, `unauthenticated`, `protocol`, `user_limit`, `instance_limit`, `draining`, `unavailable`. |
| `vault_sync_realtime_disconnects_total` | counter | `reason` | Realtime connections ended: `client`, `drain`, `slow_client`, `rate_limit`, `invalid_frame`, `frame_too_large`, `token_expired`, `ping_timeout`, `write_failed`. |
| `vault_sync_realtime_notifications_total` | counter | | `vault_changed` frames queued to realtime clients. |
| `vault_sync_realtime_listener_up` | gauge | | 1 while this replica listens for commits (PostgreSQL `LISTEN`), 0 while it reconnects. Alert if it stays 0. |
| `vault_sync_realtime_listener_reconnects_total` | counter | | Times the commit listener lost its database connection and reconnected. |

Calls rejected for authentication are counted with code `unauthenticated`. Requests rejected before reaching an RPC handler (oversized declared bodies, unknown routes, malformed messages) are not counted.

## Startup and shutdown

On startup the server connects to PostgreSQL (exiting with status 1 if it cannot), applies any pending schema migrations, and, if an object store is configured, checks that its bucket is reachable before it starts listening.

The server requires **PostgreSQL 14 or newer**; on older versions the schema migrations fail and the server exits. Upgrading to the release that adds migration 0003 rebuilds the unique index on live document paths while holding an exclusive lock on the `documents` table, so commits and reads of documents briefly block on every replica until the migration finishes (the time grows with the number of documents). Upgrading to the release that adds migration 0004 builds an index over the folders of live document paths, which blocks commits (but not reads) on every replica until it finishes; the time grows with the number of documents and the depth of their paths.

On `SIGTERM` or `SIGINT` it shuts down in this order:

1. `/readyz` starts returning 503 immediately.
2. For `VAULT_SYNC_SHUTDOWN_DELAY` the API keeps accepting and serving requests, but every response closes its connection, so clients and proxies reconnect, through the load balancer, to another replica. Connections that are idle at the signal stay open until the delay ends, so a request a client sends on one at that moment is still served instead of reset.
3. The API stops accepting connections, and in-flight requests get up to `VAULT_SYNC_SHUTDOWN_TIMEOUT` to finish. Open realtime WebSockets are closed at this step with close code 1001 ("going away"), so clients reconnect elsewhere and re-subscribe.
4. The process exits with status 0 after a clean drain, or status 1 if the timeout forced connections closed.

Background jobs (the blob upload cleanup) stop at the signal. Work they leave half-done is finished by the next run on any replica.

PostgreSQL connections are checked before every use. A connection the database dropped while it sat idle (a restart, a CloudNativePG switchover) is replaced without the request noticing. A request whose query was already running when its connection broke fails, and the client retries it. Failing over the database itself is the operator's concern.

## High-availability deployment

The server is designed to run as several identical replicas behind one Service, sharing one PostgreSQL database and one S3 bucket. Terminating any replica, for example to drain a node, must have no client-visible effect:

- Replicas keep no per-client state of their own beyond open realtime connections, whose subscriptions a client re-creates when it reconnects anywhere. Upload sessions, memberships and users live in PostgreSQL, and blob contents live in S3. Any replica can serve any request, including different chunks of one upload and its commit. Caches (the OIDC key set, S3 credentials) are rebuilt by each replica on its own.
- Background jobs run on every replica. They coordinate only through PostgreSQL, so concurrent runs have the same effect as one run.
- A replica killed without warning (`SIGKILL`, a node crash) loses only its in-flight requests. Every RPC is safe to retry on another replica, and anything already acknowledged is kept.
- During a rolling upgrade the previous release and the new one run side by side. The new release's migrations are backward-compatible with the previous release (SPEC.md §12), and an integration test runs both releases against one database.

Recommended Kubernetes settings (the Helm chart will adopt these):

- **At least 2 replicas** (`replicas: 2` or more), spread across nodes, for example with `topologySpreadConstraints` on `kubernetes.io/hostname`.
- **A PodDisruptionBudget** with `maxUnavailable: 1` (or `minAvailable: 1`), so a node drain never evicts every replica at once.
- **Readiness before termination.** Point the readiness probe at `/readyz` on the metrics port, with a short `periodSeconds` (for example 2). `VAULT_SYNC_SHUTDOWN_DELAY` keeps serving while endpoints and proxies (Istio) catch up with the pod's removal, so no `preStop` hook is needed. If you add a `preStop` sleep anyway, it runs before the signal and adds to the delay. Point the liveness probe at `/healthz`, never at `/readyz`.
- **`terminationGracePeriodSeconds`** above `VAULT_SYNC_SHUTDOWN_DELAY` + `VAULT_SYNC_SHUTDOWN_TIMEOUT` plus a margin. With the defaults (5 s + 30 s), use at least `45`.
- A rolling-update strategy with `maxUnavailable: 0` and `maxSurge: 1`, so a new pod is ready before an old one is told to stop.
