# Configuration

For: admins. You install the server with the Helm chart, or you run `vault-sync-server` yourself, and you know PostgreSQL, S3 and OIDC.

This page explains how the server reads its configuration, which groups of settings exist, which settings each subcommand reads, and which endpoints the server serves. [configuration-reference.md](configuration-reference.md) lists every variable with its default and its allowed values.

## How the server reads its configuration

`vault-sync-server` reads its configuration only from environment variables. It reads no configuration file. Its only flag is `-version`, which prints the version and exits. An empty variable counts as unset.

If you install with the Helm chart, the chart sets the variables from its values. [Chart values](../deployment.md#chart-values) names the variable that each value sets.

## Validation and exit status

At startup the server checks every variable before it does anything else. If a required variable is missing, or a value is not valid, the server does not start:

1. It logs one record with the message `invalid configuration; see docs/admin/configuration.md`. The `problems` field of that record names each variable that is wrong.
2. It exits with status 1.

The log never shows secret values, such as the database password. Three variables are required: `VAULT_SYNC_DATABASE_URL`, `VAULT_SYNC_OIDC_ISSUER_URL` and `VAULT_SYNC_OIDC_AUDIENCE`. All other variables have a default, or are off when unset.

## Groups of settings

The reference has one section for each group below.

[PostgreSQL connection](configuration-reference.md#postgresql-connection): the connection string and the TLS files for the client certificate, its key and the CA bundle. The server reads the TLS files again for each new connection, so rotated certificates work without a restart. [PostgreSQL and S3](postgresql-and-s3.md) explains how to set up the database.

[Listeners, request limits, shutdown and logging](configuration-reference.md#listeners-request-limits-shutdown-and-logging): the addresses of the three listeners (see [Endpoints](#endpoints)), the largest request, the write timeout, the limit of RPCs in flight for each user, the shutdown delay and timeout, and the log level.

[Sign-in (OIDC)](configuration-reference.md#sign-in-oidc): the issuer URL, the audience, and the client ID that the plugin signs in as. [Identity provider](identity-provider.md) explains what the provider must offer and how to set these values.

[Escrow](configuration-reference.md#escrow): the public escrow key of the deployment and its signing key, the keys that a rotation retires, the escrow default for new vaults, and the token of the job-only rotation endpoint. `VAULT_SYNC_ESCROW_IDENTITY_FILE` and `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` are for the export and the escrow rotation only. Never give them to the server. [Encryption for operators](encryption.md#the-escrow-key) explains the escrow key.

[Object store (S3)](configuration-reference.md#object-store-s3): the bucket, the endpoint, the region, the credential files, the addressing style, the CA bundle and the idle timeout. If you set no `VAULT_SYNC_S3_*` variable, the server starts without an object store and logs a warning. Then every `BlobService` RPC returns `unimplemented`. [PostgreSQL and S3](postgresql-and-s3.md) explains how to set up the bucket.

[Blob uploads](configuration-reference.md#blob-uploads): the chunk size, the largest file, the number of uploads in progress in one vault, and how long an idle upload stays.

[Retention and history](configuration-reference.md#retention-and-history): how long the server keeps old versions, how long it keeps the marker of a purged version, how long a blob that no version uses stays before the server deletes it, and the lowest values that a per-vault override can have. [Retention and history](history-and-retention.md#the-retention-policy) explains the policy.

[Realtime channel](configuration-reference.md#realtime-channel): the limits on realtime connections for each replica and each user, and on the vaults that one connection can follow.

## Which variables each command reads

The server and its subcommands are one binary. Each subcommand reads only some of the variables and ignores the rest.

| Command | Variables it reads |
|---|---|
| `vault-sync-server` (the server) | Every variable in the reference, except the ones marked for the export, the escrow rotation or `retention set` only. |
| `vault-sync-server export` | The PostgreSQL, S3 and log-level variables, and `VAULT_SYNC_ESCROW_IDENTITY_FILE`. The S3 variables are required. See [export.md](backup-and-restore.md#the-export-job). |
| `vault-sync-server export rotate-escrow` | The PostgreSQL and log-level variables, `VAULT_SYNC_ESCROW_IDENTITY_FILE`, `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` and `VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`. See [Rotate the escrow key](encryption.md#rotate-the-escrow-key). |
| `vault-sync-server export reset-escrow` | The PostgreSQL and log-level variables and `VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`. See [Reset the escrow chain](encryption.md#reset-the-escrow-chain). |
| `vault-sync-server escrow fingerprint` | Only `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY`, and only when you do not give its flags. See [Publish the escrow fingerprint](encryption.md#publish-the-escrow-fingerprint). |
| `vault-sync-server retention` | The PostgreSQL variables, `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL` and `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY`. See [Per-vault retention](history-and-retention.md#per-vault-overrides). |
| `vault-sync-server vault` | Only the PostgreSQL variables. See [Undeleting a vault](backup-and-restore.md#undelete-a-vault). |
| `vault-sync-server import` | Only `VAULT_SYNC_LOG_LEVEL` and `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`. The import talks to the server through its API, not to PostgreSQL or S3. See [import.md](backup-and-restore.md#import-markdown). |

The Helm chart never sets `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE`. Keep the escrow signing keys offline, and never give them to a pod in the cluster.

## Endpoints

The server has three listeners. Each one needs its own address.

| Listener | Variable (default) | Paths |
|---|---|---|
| API | `VAULT_SYNC_LISTEN_ADDRESS` (`:8080`) | The ConnectRPC services under `/vaultsync.v1.*/`, and the realtime WebSocket at `/v1/realtime`. |
| Metrics and health | `VAULT_SYNC_METRICS_LISTEN_ADDRESS` (`:9090`) | `/healthz` (liveness), `/readyz` (readiness) and `/metrics` (the metrics of this replica). |
| Service-wide metrics | `VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS` (`:9091`) | Only `/metrics`, the metrics of the whole deployment. |

Expose only the API listener through the ingress. Do not expose the two metrics listeners to the internet.

For more detail:

- The origins that the API accepts cross-origin requests from, and what each health check tests, are in [Endpoints](../configuration.md#endpoints).
- The metrics are in [metrics-reference.md](metrics-reference.md). How the service-wide metrics are refreshed is in [Service-wide metrics](../configuration.md#service-wide-metrics).
