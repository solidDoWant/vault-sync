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
| `VAULT_SYNC_MAX_REQUEST_BYTES` | `1048576` (1 MiB) | Maximum size of a request body in bytes, applied both to the bytes on the wire and to the decompressed message. Allowed range: 1024 to 67108864. The default matches the 1 MiB inspected-body limit of the WAF in front of the server. |
| `VAULT_SYNC_SHUTDOWN_TIMEOUT` | `30s` | How long in-flight requests may finish after `SIGTERM` or `SIGINT` before the remaining connections are closed. A Go duration (`30s`, `1m`); must be positive. Keep it below the pod's `terminationGracePeriodSeconds`. |
| `VAULT_SYNC_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn` or `error`. |

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

Requests rejected before reaching an RPC handler (oversized declared bodies, unknown routes, malformed messages) are not counted.

## Startup and shutdown

On startup the server connects to PostgreSQL (exiting with status 1 if it cannot) and applies any pending schema migrations before it starts listening. On `SIGTERM` or `SIGINT` it stops accepting connections, reports not ready on `/readyz`, and waits up to `VAULT_SYNC_SHUTDOWN_TIMEOUT` for in-flight requests. It exits with status 0 after a clean drain and status 1 if the timeout forced connections closed.
