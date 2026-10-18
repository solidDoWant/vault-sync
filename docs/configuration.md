# Server configuration

`vault-sync-server` is configured entirely by environment variables. An empty variable is treated as unset. On startup the server validates every variable and, if any is missing or invalid, exits with status 1 after logging one `invalid configuration` record whose `problems` field names each offending variable. Secret values (such as the database password) are never echoed.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VAULT_SYNC_DATABASE_URL` | (required) | PostgreSQL connection string, as a `postgres://` URL or libpq keyword/value string. It must not contain `sslcert` or `sslkey`; use the TLS file variables below instead, so rotated client certificates are picked up. |
| `VAULT_SYNC_DATABASE_TLS_CERT_FILE` | unset | PEM client certificate for PostgreSQL. Must be set together with `VAULT_SYNC_DATABASE_TLS_KEY_FILE`. Re-read for every new connection. |
| `VAULT_SYNC_DATABASE_TLS_KEY_FILE` | unset | PEM private key for the client certificate. Must be set together with `VAULT_SYNC_DATABASE_TLS_CERT_FILE`. Re-read for every new connection. |
| `VAULT_SYNC_DATABASE_TLS_CA_FILE` | unset | PEM bundle of CAs trusted to sign the PostgreSQL server certificate. Re-read for every new connection. See the note below about verification. |
| `VAULT_SYNC_LISTEN_ADDRESS` | `:8080` | `host:port` for the API listener (ConnectRPC). This is the port to expose through the ingress. |
| `VAULT_SYNC_METRICS_LISTEN_ADDRESS` | `:9090` | `host:port` for the metrics and health listener (`/metrics`, `/healthz`, `/readyz`). Must differ from `VAULT_SYNC_LISTEN_ADDRESS`. Do not expose it to the internet. |
| `VAULT_SYNC_MAX_REQUEST_BYTES` | `1048576` (1 MiB) | Maximum size of a request body in bytes, applied both to the bytes on the wire and to the decompressed message. Allowed range: 1024 to 67108864. The default matches the 1 MiB inspected-body limit of the WAF in front of the server. Request bodies are read and decoded before the bearer token is checked, so unauthenticated callers can make the server read up to this many bytes per request; keep the limit low. |
| `VAULT_SYNC_SHUTDOWN_TIMEOUT` | `30s` | How long in-flight requests may finish after `SIGTERM` or `SIGINT` before the remaining connections are closed. A Go duration (`30s`, `1m`); must be positive. Keep it below the pod's `terminationGracePeriodSeconds`. |
| `VAULT_SYNC_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn` or `error`. |
| `VAULT_SYNC_OIDC_ISSUER_URL` | (required) | OIDC issuer identifier, for example `https://auth.example.com/application/o/vault-sync/` for Authentik. Access tokens' `iss` claim must equal it exactly (including any trailing slash). The signing keys are discovered from `<issuer>/.well-known/openid-configuration`. Must be `https`; plain `http` is accepted only for a loopback host (`localhost`, `127.0.0.1`, `::1`) for local development. |
| `VAULT_SYNC_OIDC_AUDIENCE` | (required) | Audience that access tokens' `aud` claim must contain; for Authentik, the client ID of the vault-sync provider. |
| `VAULT_SYNC_S3_BUCKET` | unset | S3 bucket holding every vault's blobs. It must already exist. Required when any `VAULT_SYNC_S3_*` variable is set. When no `VAULT_SYNC_S3_*` variable is set, the server starts without an object store, logs a warning, and every `BlobService` RPC returns `unimplemented`. |
| `VAULT_SYNC_S3_ENDPOINT` | unset (AWS S3) | Base URL of the S3-compatible store, for example `https://rgw.example.com`. Must be `http` or `https`, without credentials, query or fragment. |
| `VAULT_SYNC_S3_REGION` | `us-east-1` | Region of the bucket. Ceph RGW accepts any region by default. |
| `VAULT_SYNC_S3_ACCESS_KEY_ID_FILE` | unset | File containing the S3 access key id. Required with the bucket. |
| `VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE` | unset | File containing the S3 secret access key. Required with the bucket. Both credential files are read at startup (failing if missing, empty or larger than 4 KiB) and again every 10 seconds, so rotated credentials (for example a swapped Kubernetes Secret) are used without a restart. Their contents are never logged. |
| `VAULT_SYNC_S3_FORCE_PATH_STYLE` | `true` | `true` addresses the bucket as `<endpoint>/<bucket>` (what Ceph RGW and most self-hosted stores need); `false` uses virtual-hosted `<bucket>.<endpoint>`. |
| `VAULT_SYNC_S3_TLS_CA_FILE` | unset (system roots) | PEM bundle of CAs trusted for the S3 endpoint's certificate instead of the system roots. Re-read for every new connection. |
| `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES` | `786432` (768 KiB) | Largest upload chunk, and the largest range one `DownloadBlob` returns. At least 65536. It plus 1024 bytes of request framing must not exceed `VAULT_SYNC_MAX_REQUEST_BYTES`, or the server refuses to start. |
| `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` | `1073741824` (1 GiB) | Largest blob (file) that can be uploaded. At most 83886080000 (80 GiB). |
| `VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT` | `32` | Upload sessions that may be in progress at once in one vault (1 to 10000). Further `BeginBlob` calls get `resource_exhausted` until one completes or expires. |
| `VAULT_SYNC_BLOB_UPLOAD_TTL` | `24h` | How long an upload session may be idle before the cleanup routine removes it. A Go duration of at least `10m`; keep it well above the time a commit of the largest blob takes. |

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

A user becomes a vault's `owner` by creating it. A user may own at most 100 vaults, and vault names are at most 256 bytes and may not contain control characters (Unicode category `Cc`, such as U+0000 or a newline); such names get `invalid_argument`. Creating an end-to-end encrypted vault is rejected with `failed_precondition` until end-to-end encryption is supported. Inviting other members comes in a later release.

### Blob storage

File contents are stored in the S3 bucket as one object per blob at `vaults/<vault_id>/blobs/<hex(blob_id)>`. Uploads arrive in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`, so no request exceeds the WAF's body limit; each chunk is staged as its own object under `vaults/<vault_id>/uploads/<upload_id>/` and `CommitBlob` streams the chunks into the blob's object, verifying the SHA-256 for plaintext vaults before anything becomes visible. Every chunk but the last must be at least 64 KiB. The server needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` and `s3:AbortMultipartUpload` on the bucket. At startup it checks that the bucket is reachable (`HeadBucket`, 30 seconds) and exits with status 1 if not.

Every 5 minutes a cleanup routine removes upload sessions idle for longer than `VAULT_SYNC_BLOB_UPLOAD_TTL` (deleting their staged objects) and aborts multipart uploads under `vaults/` older than the TTL, which an interrupted commit leaves behind and which S3 would otherwise keep, invisibly, forever. Each run removes at most 100 sessions and 10,000 objects, so a backlog is worked off over several runs. Blobs no longer referenced by any revision are not deleted yet.

Requests and responses are bounded by `VAULT_SYNC_MAX_REQUEST_BYTES` in both directions. A maximum-size chunk fits only in the binary protobuf encoding, which the plugin uses; a client using the Connect JSON encoding (base64 bytes, a third larger) must send smaller chunks and request smaller download ranges.

### PostgreSQL TLS

TLS is enabled with the DSN's `sslmode`; use `require`, `verify-ca` or `verify-full`. Setting any of the TLS file variables with a DSN whose first connection attempt is plaintext (`sslmode=disable` or `allow`) is rejected at startup. With `sslmode=prefer` (the libpq default when `sslmode` is omitted) and a TLS file set, the plaintext fallback is removed, so the connection never silently downgrades.

**Setting `VAULT_SYNC_DATABASE_TLS_CA_FILE` always turns on full verification**: the server certificate chain is checked against the CA bundle and the host name in the DSN must match the certificate, even when the DSN says `sslmode=require` or `sslmode=verify-ca`. Make sure the DSN's host is a name (or IP) present in the PostgreSQL server certificate. With CloudNativePG, use the `<cluster>-rw` service name the operator puts in the certificate.

## Endpoints

The API listener serves only the ConnectRPC services under `/vaultsync.v1.*/`. Cross-origin requests are allowed only from the Obsidian app origins `app://obsidian.md`, `capacitor://localhost` and `http://localhost`.

The metrics listener serves:

| Path | Meaning |
|---|---|
| `/healthz` | Liveness. Returns 200 while the process is serving. |
| `/readyz` | Readiness. Returns 200 when PostgreSQL answers a ping within 2 seconds, and 503 when it does not or while the server is shutting down. |
| `/metrics` | Prometheus metrics. |

## Metrics

Besides the standard Go runtime (`go_*`) and process (`process_*`) metrics:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `vault_sync_rpc_requests_total` | counter | `procedure`, `code` | RPCs handled, by full procedure name (for example `/vaultsync.v1.ServerInfoService/GetServerInfo`) and Connect status code (`ok`, `unimplemented`, ...). |
| `vault_sync_rpc_request_duration_seconds` | histogram | `procedure`, `code` | Time spent handling each RPC. |

Calls rejected for authentication are counted with code `unauthenticated`. Requests rejected before reaching an RPC handler (oversized declared bodies, unknown routes, malformed messages) are not counted.

## Startup and shutdown

On startup the server connects to PostgreSQL (exiting with status 1 if it cannot), applies any pending schema migrations, and, if an object store is configured, checks that its bucket is reachable before it starts listening. On `SIGTERM` or `SIGINT` it stops accepting connections, reports not ready on `/readyz`, and waits up to `VAULT_SYNC_SHUTDOWN_TIMEOUT` for in-flight requests. It exits with status 0 after a clean drain and status 1 if the timeout forced connections closed.
