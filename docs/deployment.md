# Deploying vault-sync

This guide deploys the vault-sync server and its plaintext export job on Kubernetes with the Helm chart in `deploy/charts/vault-sync`, on the infrastructure vault-sync is built for (SPEC.md §3): PostgreSQL run by CloudNativePG, Ceph RGW for S3, Authentik for sign-in, and an Istio gateway with a Coraza WAF in front. Every server variable the chart sets is described in [configuration.md](configuration.md), the export in [export.md](export.md), and the plugin side in [plugin.md](plugin.md).

What you deploy:

- **The server**, a Deployment of two or more identical replicas behind one Service. It is the only internet-facing part. Replicas share one PostgreSQL database and one S3 bucket and keep no state of their own, so any replica can be stopped at any time (configuration.md, High-availability deployment).
- **The export job**, a CronJob running `vault-sync-server export`, which writes a plaintext copy of every vault to a volume your tape-archival tooling reads. It has its own credentials and is the only part that may ever hold the escrow private key. It is off by default; turning it on (`config.export.enabled: true`, see [The export job](#the-export-job)) is recommended, because it is the plaintext disaster-recovery copy of every vault.
- **Nothing else.** The chart creates no database, bucket, Secret or identity-provider client: it references the ones you create below.

## The image

`ghcr.io/soliddowant/vault-sync:<version>` holds one static binary, `/bin/vault-sync-server`, and CA roots: no shell and no package manager. It runs as user and group `65532` and needs no writable path except, for the export, its output volume. The same image runs the server (no arguments), the export (`export -out DIR`) and the Markdown import (`import VAULT_ID DIR`, see [import.md](import.md)).

It is built reproducibly with Nix (`nix/server.nix`, `nix/server-image.nix`, `dockerTools.streamLayeredImage`), with the flake's pinned Go toolchain, and every build checks the binary with `govulncheck -mode=binary` (see [Releasing](#releasing)).

## PostgreSQL (CloudNativePG)

vault-sync needs PostgreSQL 14 or newer and creates its schema itself on startup (migrations run behind an advisory lock, so replicas starting together are safe). Give it its own database and role. With CloudNativePG, for example:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: vault-sync-postgres
spec:
  instances: 3
  bootstrap:
    initdb:
      database: vault_sync
      owner: vault_sync
  postgresql:
    pg_hba:
      # Certificate authentication for the application role(s); add the
      # export's role here if it has its own.
      - hostssl vault_sync vault_sync all cert
```

**Client certificates.** With that `pg_hba` rule, CloudNativePG authenticates the role by a client certificate signed by the cluster's client CA. Create one for the server's role (and, if the export uses its own role, one for it):

```sh
kubectl cnpg certificate vault-sync-postgres-client --cnpg-cluster vault-sync-postgres --cnpg-user vault_sync
```

This creates a `kubernetes.io/tls` Secret with `tls.crt` and `tls.key`. Set `config.database.tls.clientCertificate.secretName` to its name (`config.database.tls.clientCertificate.certKey` and `config.database.tls.clientCertificate.keyKey` name the keys if your Secret uses others, for example one issued by cert-manager). Point `config.database.tls.caCert.secretKeyRef` at the cluster's server CA, the `<cluster>-ca` Secret, key `ca.crt`. The server re-reads all three files for every new connection, so certificates that CloudNativePG or cert-manager rotate are picked up without a restart. The chart projects only the named keys of each Secret (so the `ca.key` in `<cluster>-ca` never reaches a pod), and never with `subPath`, so rotated files actually reach the pod.

**The connection string.** Use the read-write service, whose name is in the server certificate, and full verification:

```
host=vault-sync-postgres-rw dbname=vault_sync user=vault_sync sslmode=verify-full
```

It holds no password with certificate authentication, so `config.database.url.value` is fine; put it in a Secret and use `config.database.url.secretKeyRef` (`name` and `key`) if it carries one. Exactly one of the two may be set. Do not put `sslcert` or `sslkey` in it (configuration.md, PostgreSQL TLS).

The server rides out a CloudNativePG switchover: broken connections are replaced, and clients retry the requests that failed. Run migrations-heavy upgrades knowing that some migrations briefly block commits (configuration.md, Startup and shutdown).

## S3 (Ceph RGW)

vault-sync stores file contents in one bucket, which must exist. With Rook, an ObjectBucketClaim creates the bucket and a Secret with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, which are the chart's default key names:

```yaml
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: vault-sync
spec:
  generateBucketName: vault-sync
  storageClassName: ceph-bucket
```

Set `config.s3.bucket` to the bucket name (the claim's ConfigMap has it as `BUCKET_NAME`), `config.s3.endpoint` to the RGW URL (for example `https://rgw.example.com`, or the in-cluster `http://rook-ceph-rgw-objectstore.rook-ceph.svc`), and `config.s3.credentials.secretName` to the Secret. `config.s3.credentials.accessKeyIdKey` and `config.s3.credentials.secretAccessKeyKey` name its keys if they differ. The credentials are mounted as files and re-read every 10 seconds, so a rotated Secret is used without a restart.

RGW accepts any region, so `config.s3.region` can stay empty, and it needs path-style addressing, which is the default (`config.s3.forcePathStyle` empty or `"true"`). If RGW's certificate is signed by a private CA, set `config.s3.caCert.secretKeyRef` to a Secret key holding it. `config.s3.idleTimeout` bounds how long a silent connection to RGW may hold a request.

The server needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` and `s3:AbortMultipartUpload` on the bucket (the bucket owner has all of them). The export needs only `s3:GetObject` and `s3:ListBucket`; to give it read-only credentials, create an RGW user with a read-only bucket policy and set `config.export.s3.credentials.secretName` (with `config.export.s3.credentials.accessKeyIdKey` and `config.export.s3.credentials.secretAccessKeyKey`).

## Authentik (the device-flow application)

The plugin signs in with the OAuth 2.0 device authorization grant, so Authentik needs a public OAuth2/OpenID provider with the device code flow enabled. [plugin.md](plugin.md#identity-provider-setup-authentik) lists what the plugin requires; in Authentik:

1. **Flow.** Under *System → Brands*, edit your brand and set *Default flows → Device code flow* (for example to the default authorization flow). Without it the provider's OpenID configuration has no `device_authorization_endpoint` and the plugin reports that the device authorization grant is not supported.
2. **Provider.** Under *Applications → Providers*, create an *OAuth2/OpenID Provider*: client type **Public** (the plugin cannot keep a secret), and among the scopes the `offline_access` mapping, so that a refresh token is issued. Redirect URIs are not used by the device flow. Choose access-token and refresh-token lifetimes: the plugin refreshes access tokens ahead of expiry, and the refresh-token lifetime decides how long an offline device stays signed in.
3. **Application.** Under *Applications → Applications*, create an application for the provider, with slug `vault-sync`. Bind the users or groups that may sync.

Then set:

- `config.oidc.issuerUrl` to the provider's issuer, `https://auth.example.com/application/o/vault-sync/` (the trailing slash matters: tokens' `iss` must equal it exactly);
- `config.oidc.audience` to the provider's client ID, which Authentik puts in the access token's `aud`;
- `config.oidc.clientId` only if the plugin should sign in as another client than the audience; empty leaves `VAULT_SYNC_OIDC_CLIENT_ID` unset, and the audience is used.

Enter the same issuer URL and client ID in the plugin's settings. The server fetches the issuer's keys over `https` on the first authenticated request, so it starts even while Authentik is down.

## The WAF body limit (Istio and Coraza)

The Coraza WAF in front of the server rejects inspected request bodies above 1 MiB. vault-sync never sends a larger request: files are uploaded in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES` (768 KiB by default) and every request is at most `VAULT_SYNC_MAX_REQUEST_BYTES` (1 MiB by default). Keep it that way:

- Leave `config.server.maxRequestBytes` at or below the WAF's limit. The server refuses to start if a chunk (`config.server.blob.maxChunkBytes`) plus 1024 bytes does not fit in it.
- Responses are bounded by the same `VAULT_SYNC_MAX_REQUEST_BYTES`. If the WAF also inspects response bodies, its response limit must be at least as large.
- Request bodies are read before the bearer token is checked, so keep the limit low: it is also what an unauthenticated caller can make the server read per request.

The rest of the ingress:

- Route the host to port `http` (8080) of the Service, for example with `config.route` (a Gateway API HTTPRoute, see [Route](#route)) or `resources.ingress`. Only port `http` may be routed to from outside the cluster: never expose port `metrics` (9090) or `service-metrics` (9091). The chart renders one Service, so an ingress's backend resolves to port `http` without naming a Service:

  ```yaml
  resources:
    ingress:
      main:
        hosts:
          - host: sync.example.com
            paths:
              - path: /
                service:
                  port: http
  ```
- Allow WebSocket upgrades on `/v1/realtime`, and do not time out idle connections faster than every 30 seconds (the server pings every 30). Do not limit how long a request or the WebSocket may last below what the chart's route sets: 15 minutes for requests, because a `CommitBlob` response starts only once the server has composed the whole blob (up to 10 minutes, SPEC.md §6.2), and no limit for `/v1/realtime`, a long-lived WebSocket. The WAF must not log the `Sec-WebSocket-Protocol` header, which carries the access token.
- The server sends CORS headers for Obsidian's app origins itself; do not strip them.

## The export job

The export job is off by default. Turn it on with `config.export.enabled: true` and an output volume (`config.export.output.persistence`): it is the plaintext disaster-recovery copy of every vault, readable without vault-sync, so running it is recommended ([export.md](export.md)).

The CronJob runs `vault-sync-server export -out /export/<directory>` on `config.export.schedule` (a cron expression, daily at 03:00 by default; `config.export.timeZone` sets an IANA time zone, otherwise the cluster's default applies). It writes every plaintext vault as a browsable tree with a manifest, replacing the previous export atomically ([export.md](export.md) describes the layout and how to verify it). Runs never overlap (`concurrencyPolicy: Forbid`), each run is stopped after `config.export.activeDeadlineSeconds` (6 hours by default, so a hung run, for example on a stalled NFS volume, cannot block every later one), a failed run is retried twice, and the job exits non-zero when anything failed or was missing, so alert on failed Jobs.

- **Output volume.** `config.export.output.persistence` is the volume it writes to, as a bjw-s persistence item, for example `{type: persistentVolumeClaim, existingClaim: vault-sync-export}` or an `nfs` volume shared with your tape tooling. It is required while `config.export.enabled` is true and mounted at `/export` in the export job only. `config.export.output.directory` is the directory inside it (`vaults` by default); the export also keeps a lock file and a staging directory next to it, so the volume's top level must be writable. Files are created `0640` and directories `0750`, owned by user and group `65532` (the pod's `fsGroup`), so give your tape tooling that group.
- **Own credentials.** By default the export uses the server's database and S3 settings. Give it its own database role (`SELECT` on `vaults`, `documents`, `revisions` and `blobs`, plus `INSERT` and `UPDATE` on `export_status`, where it records each run's outcome; see [export.md](export.md)) with `config.export.database.url` (`value` or `secretKeyRef`) and `config.export.database.tls.clientCertificate.secretName` (`config.export.database.tls.clientCertificate.certKey` and `config.export.database.tls.clientCertificate.keyKey` name the keys), and read-only S3 credentials as above. Empty fields fall back to the server's; the CA certificates are shared. Its sessions are read-only in any case, except the one transaction that records the run in `export_status`.
- **Escrow.** `config.export.escrow.secretName` names the Secret holding the escrow private key (SPEC.md §9.4; generating it and recovering a vault with `age` are in [encryption.md](encryption.md#escrow)). Its key `config.export.escrow.key` (default `escrow.key`) holds the identity file (`age-keygen -pq` output). It is mounted read-only at `/etc/vault-sync/escrow` in the export job, which reads it as `VAULT_SYNC_ESCROW_IDENTITY_FILE` to decrypt escrowed vaults, and never into the server: the chart refuses to render if any value (a persistence entry, an env var, `envFrom`, default pod options) would put it into the server, and `make chart-lint` checks that the rendered server Deployment never names it. The escrow signing keys never go into the cluster. They stay offline, and you bring them out only for a manual escrow key rotation, which you run from your own machine or as a one-off pod ([export.md](export.md#rotating-the-escrow-key)). The chart has no value for them, and it refuses to render if any controller gets `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` or runs `export rotate-escrow`.
- **Escrow job token.** `config.escrowJobToken.secretName` names the Secret holding the static bearer token of the export job's escrow rotation endpoint (`VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`, [configuration.md](configuration.md)); its key `config.escrowJobToken.key` (default `token`) holds one line of at least 32 characters, for example `openssl rand -base64 32`. It is mounted read-only at `/etc/vault-sync/escrow-job-token` into the server, which checks it, and the export job, which presents it, and into nothing else. Empty leaves the endpoint off.
- `config.export.enabled: false` (the default) drops the CronJob and all of its mounts.

## Installing the chart

The chart is published to `oci://ghcr.io/soliddowant/charts/vault-sync`, versioned like the image. A minimal values file for the setup above:

```yaml
config:
  database:
    url:
      value: host=vault-sync-postgres-rw dbname=vault_sync user=vault_sync sslmode=verify-full
    tls:
      clientCertificate:
        secretName: vault-sync-postgres-client
      caCert:
        secretKeyRef:
          name: vault-sync-postgres-ca
          key: ca.crt
  s3:
    bucket: vault-sync-0b7c…
    endpoint: http://rook-ceph-rgw-objectstore.rook-ceph.svc
    credentials:
      secretName: vault-sync
  oidc:
    issuerUrl: https://auth.example.com/application/o/vault-sync/
    audience: <client id>
  export:
    enabled: true
    output:
      persistence:
        type: persistentVolumeClaim
        existingClaim: vault-sync-export
  route:
    enabled: true
    parentRefs:
      - name: public-gateway
        namespace: istio-ingress
    hostnames:
      - sync.example.com
```

```sh
helm install vault-sync oci://ghcr.io/soliddowant/charts/vault-sync --version <version> -n vault-sync -f values.yaml
```

The chart then renders, each named after the release (here `vault-sync`): the server Deployment, one Service with ports `http` (8080), `metrics` (9090) and `service-metrics` (9091), an HTTPRoute, a ServiceAccount without an API token, and the export CronJob `vault-sync-export`. With `config.server.metrics.serviceMonitor.enabled: true` it adds a ServiceMonitor, and with `config.server.metrics.serviceWide.enabled: true` as well that ServiceMonitor also scrapes port `service-metrics`. With `config.alerts.prometheusRule.enabled: true` it adds a PrometheusRule with the alerting rules ([Alerts](#alerts)). It creates no Secrets, and sets no PodDisruptionBudget, container resources or spread constraints: see [High availability](#high-availability) for what to add.

Every resource is named after the release, never with the chart name in it twice: a release `obsidian-vault-sync` renders the Deployment, Service, ServiceAccount, ServiceMonitor, HTTPRoute and PodDisruptionBudget `obsidian-vault-sync` and the CronJob `obsidian-vault-sync-export`. The chart sets the bjw-s `global.nameOverride` to the release name unless you set it.

## Upgrading

Upgrade with `helm upgrade` and the new chart version. The server rolls out replica by replica: the new release's migrations run on startup and are backward-compatible with the previous release, so both serve side by side during the rollout (configuration.md, Startup and shutdown; SPEC.md §12).

**Some migrations pause sync while they run.** A migration that takes an exclusive lock on a table blocks every replica, of both releases, on that table until it commits; clients retry and nothing is lost, but sync stalls meanwhile. The longest is migration 0006 (adding the cursor anchor): it rewrites every row of `revisions` while holding an exclusive lock on it, so on a large `revisions` table every commit and pull waits for the whole backfill, which grows with the number of revisions (as a rough guide, about as long as an `UPDATE` of every row of that table takes on your database). Plan such an upgrade for a quiet time. configuration.md (Startup and shutdown) lists what each migration blocks.

**Set per-vault retention overrides only once every replica runs a release that has them.** During a rollout, replicas of the previous release still purge every vault under the deployment-wide policy, so an override longer than that policy would not protect the vault's history until they are gone. For the same reason, rolling back to a release before migration 0010 (the one that added per-vault overrides) after setting overrides purges every overridden vault under the deployment-wide policy again, so the history an override longer than that policy kept is purged. To keep it, give the release you roll back to a `VAULT_SYNC_RETENTION_KEEP_ALL` and `VAULT_SYNC_RETENTION_KEEP_DAILY` at least as long as the longest override. During a rollout, the previous release's retention runs may also record their scans as complete under the new release's overrides; the only effect is that a newly shortened override may purge less than it allows until the next full scan, never that anything the policy keeps is purged.

**Remove devices only once every replica runs a release that can remove them.** Migration 0011 adds device removal (`RemoveDevice`, see configuration.md). Replicas of the previous release do not know about it: during a rollout they still accept commits from a removed device and still count removed devices toward the 100-device limit. Rolling back to a release before migration 0011 brings every removed device back, both in the limit and for commits. The migration itself only adds a column, so it does not pause sync. Replicas from before #590 refuse a removed device's commit without the reason the plugin recognises (the plugin shows a plain error and retries, and recognises the removal once its retry reaches an upgraded replica), and refuse a retry, under the re-registered device, of a commit that landed before the removal as `invalid_argument`; so remove devices once every replica runs a release with #590.

**Rename devices only once every replica runs a release that can rename them.** `RenameDevice` needs no migration, but replicas of the previous release answer it `unimplemented`, and still refuse, as `already_exists`, a `RegisterDevice` retry whose name differs from the device's current name; the new release returns the device with its current name. A plugin that gets `already_exists` drops its saved registration id and registers anew, so nothing is lost, but the retry may use one more place under the device limit.

**Upgrade the server before the plugin, or together with it.** Users update the Obsidian plugin on their own, so a plugin can run against an older server. The plugin's sync engine relies on the server's purge markers (SPEC.md §6.1, §11): a plugin newer than the server, against a server from before purge markers, takes every retention purge of a revision a device last synced as a server restore and merges every note it holds with the server's. Nothing is lost, but a note another device deleted can come back (an edit wins over a delete), and a note whose merge base was purged gets a conflict copy instead of a merge. This lasts until the server is upgraded. Upgrade the server first, then tell users to update the plugin.

## Per-vault retention

To give one vault its own retention policy (configuration.md, Per-vault overrides), run the server binary's `retention` subcommand with the server's database settings, for example in a running server pod (here the Deployment of a release named `vault-sync`; the image has no shell, so call the binary directly):

```sh
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention set -vault 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 -keep-all 4320h -keep-daily 17520h
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention list
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention unset -vault 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12
```

Every replica applies the change from its next hourly run. The chart has no values for overrides: they live in PostgreSQL. To refuse overrides shorter than a floor, set `config.server.retention.overrideMinKeepAll` (and `config.server.retention.overrideMinKeepDaily`): they put `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL` and `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY` into the server's environment, which the subcommand run in its pod reads (the server itself ignores them). The export's read-only role cannot set overrides.

## Undeleting a vault

An owner's deleted vault is kept for 30 days and then purged by the retention job (`docs/design/sharing.md`, Deleting a vault). Before then, the operator can restore it with the server binary's `vault` subcommand, run with the server's database settings like `retention`:

```sh
kubectl exec deploy/vault-sync -- /bin/vault-sync-server vault undelete 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12
```

Its members can use the vault again at once, on every replica, with all its documents, history and attachments. It is allowed even if an owner already owns 100 vaults. The command exits 1 with `no vault ID: it does not exist or has been purged` for an unknown vault or one whose purge has started, and with `vault ID is not deleted` for a vault that is not deleted; it exits 2 on a usage error.

## Chart values

The chart has two top-level keys. `config` is the chart's own interface, described below; every `null` value (the default for optional settings) leaves its variable unset, so the server's default applies. `values.schema.json` checks `config` strictly: an unknown key (a typo such as `config.s3.forcepathstyle`), a value of the wrong type or a malformed duration fails the install. Byte sizes and counts are integers, switches are booleans, and durations are Go duration strings such as `30s` or `1h30m`. `resources` is passed to the [bjw-s common library chart](https://github.com/bjw-s-labs/helm-charts/tree/main/charts/library/common) (5.3.0) and deep-merged over what the chart computes, so anything that library supports can be overridden or added there (see [Overriding the computed resources](#overriding-the-computed-resources)).

### Shared settings

| Value | Default | Description |
|---|---|---|
| `config.logLevel` | null (`info`) | `VAULT_SYNC_LOG_LEVEL` for the server and the export: `debug`, `info`, `warn` or `error`. |

### PostgreSQL

| Value | Default | Description |
|---|---|---|
| `config.database.url.value` | empty | `VAULT_SYNC_DATABASE_URL` as a plain value. Required, unless `config.database.url.secretKeyRef` is set; setting both fails the render. |
| `config.database.url.secretKeyRef.name` | empty | Secret holding `VAULT_SYNC_DATABASE_URL`. Set together with `config.database.url.secretKeyRef.key`. |
| `config.database.url.secretKeyRef.key` | empty | Key of that Secret. |
| `config.database.tls.clientCertificate.secretName` | empty | Secret with the PostgreSQL client certificate and key, mounted at `/etc/vault-sync/database-client-cert`; sets `VAULT_SYNC_DATABASE_TLS_CERT_FILE` and `VAULT_SYNC_DATABASE_TLS_KEY_FILE`. |
| `config.database.tls.clientCertificate.certKey` | `tls.crt` | Key of the certificate in that Secret. |
| `config.database.tls.clientCertificate.keyKey` | `tls.key` | Key of the private key in that Secret. |
| `config.database.tls.caCert.secretKeyRef.name` | empty | Secret with the CA bundle for the PostgreSQL server certificate, mounted at `/etc/vault-sync/database-ca` (server and export); sets `VAULT_SYNC_DATABASE_TLS_CA_FILE`, which turns on full verification. |
| `config.database.tls.caCert.secretKeyRef.key` | `ca.crt` | Key of the CA bundle in that Secret. |

### S3

| Value | Default | Description |
|---|---|---|
| `config.s3.bucket` | empty | `VAULT_SYNC_S3_BUCKET`. Required. |
| `config.s3.endpoint` | null (AWS S3) | `VAULT_SYNC_S3_ENDPOINT`, for example the RGW URL. |
| `config.s3.region` | null (`us-east-1`) | `VAULT_SYNC_S3_REGION`. |
| `config.s3.forcePathStyle` | null (`true`) | `VAULT_SYNC_S3_FORCE_PATH_STYLE`, a boolean. |
| `config.s3.idleTimeout` | null (`2m`) | `VAULT_SYNC_S3_IDLE_TIMEOUT`, a Go duration. |
| `config.s3.credentials.secretName` | empty | Secret with the S3 credentials, mounted at `/etc/vault-sync/s3-credentials`; sets `VAULT_SYNC_S3_ACCESS_KEY_ID_FILE` and `VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE`. Required. |
| `config.s3.credentials.accessKeyIdKey` | `AWS_ACCESS_KEY_ID` | Key of the access key id in that Secret. |
| `config.s3.credentials.secretAccessKeyKey` | `AWS_SECRET_ACCESS_KEY` | Key of the secret access key in that Secret. |
| `config.s3.caCert.secretKeyRef.name` | empty (system roots) | Secret with a CA bundle for the S3 endpoint, mounted at `/etc/vault-sync/s3-ca` (server and export); sets `VAULT_SYNC_S3_TLS_CA_FILE`. |
| `config.s3.caCert.secretKeyRef.key` | `ca.crt` | Key of the CA bundle in that Secret. |

### OIDC

| Value | Default | Description |
|---|---|---|
| `config.oidc.issuerUrl` | empty | `VAULT_SYNC_OIDC_ISSUER_URL`. Required. |
| `config.oidc.audience` | empty | `VAULT_SYNC_OIDC_AUDIENCE`. Required. |
| `config.oidc.clientId` | null | `VAULT_SYNC_OIDC_CLIENT_ID`, the client the plugin signs in as when it differs from the audience. null leaves it unset. |

### Server

The listen addresses are fixed by the chart: `VAULT_SYNC_LISTEN_ADDRESS` is `:8080` (port `http`) `VAULT_SYNC_METRICS_LISTEN_ADDRESS` is `:9090` (port `metrics`, which the probes and the ServiceMonitor use), and `VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS` is `:9091` (port `service-metrics`). Every value below sets the variable named, documented in configuration.md; null uses the server's default. Byte sizes, counts and limits are integers, `config.server.escrow.default` is a boolean, and the rest are Go durations, except the escrow keys and ids (strings).

| Value | Variable |
|---|---|
| `config.server.maxRequestBytes` | `VAULT_SYNC_MAX_REQUEST_BYTES` (keep it at or below the WAF limit) |
| `config.server.writeTimeout` | `VAULT_SYNC_WRITE_TIMEOUT` |
| `config.server.maxConcurrentRpcsPerUser` | `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` |
| `config.server.shutdownDelay` | `VAULT_SYNC_SHUTDOWN_DELAY` |
| `config.server.shutdownTimeout` | `VAULT_SYNC_SHUTDOWN_TIMEOUT` (the chart sets `terminationGracePeriodSeconds` to the delay plus the timeout plus 10 seconds, at least 45) |
| `config.server.blob.maxChunkBytes` | `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES` |
| `config.server.blob.maxSizeBytes` | `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` |
| `config.server.blob.maxUploadsPerVault` | `VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT` |
| `config.server.blob.uploadTtl` | `VAULT_SYNC_BLOB_UPLOAD_TTL` |
| `config.server.blob.uploadReclaimIdle` | `VAULT_SYNC_BLOB_UPLOAD_RECLAIM_IDLE` |
| `config.server.blob.gcGrace` | `VAULT_SYNC_BLOB_GC_GRACE` |
| `config.server.retention.keepAll` | `VAULT_SYNC_RETENTION_KEEP_ALL` |
| `config.server.retention.keepDaily` | `VAULT_SYNC_RETENTION_KEEP_DAILY` |
| `config.server.retention.purgeMarkerHorizon` | `VAULT_SYNC_RETENTION_PURGE_MARKER_HORIZON` |
| `config.server.retention.overrideMinKeepAll` | `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL` (read only by `retention set`, see [Per-vault retention](#per-vault-retention)) |
| `config.server.retention.overrideMinKeepDaily` | `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY` (likewise) |
| `config.server.realtime.maxConnections` | `VAULT_SYNC_REALTIME_MAX_CONNECTIONS` |
| `config.server.realtime.maxConnectionsPerUser` | `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER` |
| `config.server.realtime.maxSubscriptions` | `VAULT_SYNC_REALTIME_MAX_SUBSCRIPTIONS` |
| `config.server.escrow.recipient` | `VAULT_SYNC_ESCROW_RECIPIENT` (the escrow public key; the private key goes into `config.export.escrow` only) |
| `config.server.escrow.signingKey` | `VAULT_SYNC_ESCROW_SIGNING_KEY` (the escrow signing public key) |
| `config.server.escrow.default` | `VAULT_SYNC_ESCROW_DEFAULT` |
| `config.server.escrow.retiringKeyIds` | `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS` (comma-separated) |
| `config.server.metrics.serviceWide.interval` | `VAULT_SYNC_SERVICE_METRICS_INTERVAL` |

| Value | Default | Description |
|---|---|---|
| `config.server.metrics.serviceMonitor.enabled` | `false` | Create a prometheus-operator ServiceMonitor scraping `/metrics` on port `metrics` of the Service. Needs the `monitoring.coreos.com` CRDs. |
| `config.server.metrics.serviceMonitor.interval` | `1m` | Scrape interval. |
| `config.server.metrics.serviceMonitor.scrapeTimeout` | `10s` | Scrape timeout. |
| `config.server.metrics.serviceWide.enabled` | `false` | Add a second ServiceMonitor endpoint scraping the service-wide `/metrics` on port `service-metrics`, with the same interval and timeout. Needs `config.server.metrics.serviceMonitor.enabled`. Every replica serves the same values; to scrape only one replica, configure that in your scraper. |

### Export

| Value | Default | Description |
|---|---|---|
| `config.export.enabled` | `false` | Render the export CronJob (recommended: it is the plaintext disaster-recovery copy). |
| `config.export.schedule` | `0 3 * * *` | Cron schedule. |
| `config.export.timeZone` | empty | IANA time zone of the schedule. |
| `config.export.activeDeadlineSeconds` | `21600` | Upper bound, in seconds, on one export run (the Job's `activeDeadlineSeconds`); must be positive. |
| `config.export.output.persistence` | `{}` | The output volume, as a bjw-s persistence item (`type`, `existingClaim`, `server`/`path` for `nfs`, ...). Required while the export is enabled. Mounted at `/export` in the export job only. |
| `config.export.output.directory` | `vaults` | Directory inside the volume, a single name; the job runs `export -out /export/<directory>`. |
| `config.export.database.url.value` | empty | The export's own `VAULT_SYNC_DATABASE_URL`; empty uses the server's. Exclusive with `config.export.database.url.secretKeyRef`. |
| `config.export.database.url.secretKeyRef.name` | empty | Secret holding the export's database URL. |
| `config.export.database.url.secretKeyRef.key` | empty | Key of that Secret. |
| `config.export.database.tls.clientCertificate.secretName` | empty | The export's own PostgreSQL client certificate Secret, mounted at `/etc/vault-sync/export-database-client-cert`; empty uses the server's. |
| `config.export.database.tls.clientCertificate.certKey` | `tls.crt` | Key of the certificate. |
| `config.export.database.tls.clientCertificate.keyKey` | `tls.key` | Key of the private key. |
| `config.export.s3.credentials.secretName` | empty | The export's own S3 credentials Secret, mounted at `/etc/vault-sync/export-s3-credentials`; empty uses `config.s3.credentials`. |
| `config.export.s3.credentials.accessKeyIdKey` | `AWS_ACCESS_KEY_ID` | Key of the access key id. |
| `config.export.s3.credentials.secretAccessKeyKey` | `AWS_SECRET_ACCESS_KEY` | Key of the secret access key. |
| `config.export.escrow.secretName` | empty | Secret holding the escrow private key, mounted read-only at `/etc/vault-sync/escrow` in the export job only, never in the server. Not read until Phase 4. |

### Route

`config.route` renders a Gateway API HTTPRoute (bjw-s `route.main`) that sends its hostnames to port `http` of the Service. The chart sets the backend and the timeouts; `resources.route.main` overrides any of it.

| Value | Default | Description |
|---|---|---|
| `config.route.enabled` | `false` | Render the HTTPRoute. |
| `config.route.hostnames` | `[]` | Hostnames it matches, for example `[sync.example.com]`. |
| `config.route.parentRefs` | `[]` | The Gateway (and listener) to attach to, as Gateway API `parentRefs` (`name`, `namespace`, `sectionName`, ...). |
| `config.route.annotations` | `{}` | Annotations of the HTTPRoute. |
| `config.route.labels` | `{}` | Labels of the HTTPRoute. |

The route has two rules, both to port `http`:

- `/v1/realtime`: `timeouts.request` and `timeouts.backendRequest` of `0s`, which disables them. It is a long-lived WebSocket, kept alive by the server's pings every 30 seconds, and a gateway's default request timeout would cut it off.
- `/` (everything else): `timeouts.request` and `timeouts.backendRequest` of `15m`. A `CommitBlob` response starts only once the server has composed the whole blob, which may take up to 10 minutes (SPEC.md §6.2), and its response may then take up to `VAULT_SYNC_WRITE_TIMEOUT` (2 minutes by default) to write. Raise it with `resources.route.main.rules` if you raise the write timeout.

### Grafana dashboards

`config.grafana.dashboards` installs the [dashboards](#monitoring) as grafana-operator `GrafanaDashboard`s, as ConfigMaps for the Grafana chart's dashboard sidecar, or both. Both are off by default.

| Value | Default | Description |
|---|---|---|
| `config.grafana.dashboards.enabled` | `false` | Render one `GrafanaDashboard` (`grafana.integreatly.org/v1beta1`) per dashboard, named `<release>-dashboard-<name>`. Needs the grafana-operator CRDs. |
| `config.grafana.dashboards.instanceSelector` | `{}` | Label selector of the `Grafana` resources to import into, for example `{matchLabels: {dashboards: grafana}}`. Required while `config.grafana.dashboards.enabled`. |
| `config.grafana.dashboards.folder` | empty | Title of the Grafana folder to put the dashboards in. At most one of `folder`, `folderRef` and `folderUID`; setting more fails the render. |
| `config.grafana.dashboards.folderRef` | empty | Name of a `GrafanaFolder` in the release namespace to put the dashboards in. |
| `config.grafana.dashboards.folderUID` | empty | UID of an existing Grafana folder to put the dashboards in. |
| `config.grafana.dashboards.resyncPeriod` | null (the operator's default) | How often the operator re-applies the dashboards, for example `10m`. |
| `config.grafana.dashboards.allowCrossNamespaceImport` | null (`false`) | Let `Grafana` instances in other namespaces import the dashboards. |
| `config.grafana.dashboards.labels` | `{}` | Extra labels of each `GrafanaDashboard`. |
| `config.grafana.dashboards.configMaps.enabled` | `false` | Render each dashboard as a ConfigMap `<release>-dashboard-<name>` holding `<name>.json`, for the Grafana chart's dashboard sidecar. Independent of `config.grafana.dashboards.enabled`. |
| `config.grafana.dashboards.configMaps.label` | `grafana_dashboard` | Label the sidecar watches (the Grafana chart's `sidecar.dashboards.label`). |
| `config.grafana.dashboards.configMaps.labelValue` | `"1"` | Value of that label (`sidecar.dashboards.labelValue`). |
| `config.grafana.dashboards.configMaps.annotations` | `{}` | Annotations of each ConfigMap, for example the sidecar's `folderAnnotation` to choose a folder. |
### Alerts

`config.alerts` renders the packaged alerting rules (`deploy/charts/vault-sync/alerts/vault-sync.rules.yaml`) as a prometheus-operator `PrometheusRule` (`monitoring.coreos.com/v1`). [alerts.md](alerts.md) lists every alert with its threshold, the reasoning behind it, and a runbook section saying what to check and what to do; each alert's `runbook_url` points there. To enable the rules:

```yaml
config:
  server:
    metrics:
      serviceMonitor: {enabled: true}
      serviceWide: {enabled: true}
  alerts:
    prometheusRule:
      enabled: true
      labels:
        release: kube-prometheus-stack   # whatever your Prometheus's ruleSelector matches
```

The service-wide alerts (retention, export, backlogs) read the service-wide metrics, so scrape port `service-metrics` too (`config.server.metrics.serviceWide.enabled`, or your own scrape config); without it they never fire. Every expression matches this release's namespace and job, so two releases in one Prometheus do not mix; with a scraper that labels series differently, set `config.alerts.prometheusRule.selector`.

| Value | Default | Description |
|---|---|---|
| `config.alerts.prometheusRule.enabled` | `false` | Render the PrometheusRule. Needs the `monitoring.coreos.com` CRDs. |
| `config.alerts.prometheusRule.labels` | `{}` | Extra labels of the PrometheusRule, for example the ones your Prometheus's `ruleSelector` matches. |
| `config.alerts.prometheusRule.annotations` | `{}` | Annotations of the PrometheusRule. |
| `config.alerts.prometheusRule.selector.namespace` | `null` | The `namespace` matcher added to every expression. `null` uses the release namespace; an empty string leaves the matcher out. |
| `config.alerts.prometheusRule.selector.job` | `null` | The `job` matcher added to every expression that reads vault-sync's own metrics. `null` uses the Service name (the release name, the ServiceMonitor's `job` label); an empty string leaves the matcher out. The kube-state-metrics alerts match the namespace and the Deployment name instead. |
| `config.alerts.runbookUrlBase` | `https://github.com/solidDoWant/vault-sync/blob/master/docs/alerts.md` | Each alert's `runbook_url` annotation is this followed by `#` and the alert's name in lower case. Empty leaves `runbook_url` out. |
| `config.alerts.rules` | `{}` | Per-alert overrides keyed by alert name, each with `enabled`, `for` (a Prometheus duration), `severity` (`critical` or `warning`) and `threshold` (for alerts that have one; see [alerts.md](alerts.md)). A disabled alert is dropped from the rendered rules, and an unknown name fails the render. `VaultSyncNoReplicaReady` and `VaultSyncReplicasUnavailable` need kube-state-metrics and are off unless enabled here; `VaultSyncExportNotSucceeding` is on while `config.export.enabled`. |

For example, to page on slow syncs only after 30 minutes above 5 seconds, and to turn on the kube-state-metrics alerts:

```yaml
config:
  alerts:
    rules:
      VaultSyncSyncLatencyHigh: {threshold: 5, for: 30m}
      VaultSyncNoReplicaReady: {enabled: true}
      VaultSyncReplicasUnavailable: {enabled: true}
```

### Overriding the computed resources

Under `resources`, the chart computes these bjw-s entries; your values are merged over them and win:

| Entry | What the chart sets |
|---|---|
| `resources.controllers.main` | The server Deployment, named after the release: `replicas: 2`, `RollingUpdate` with `maxUnavailable: 0` and `maxSurge: 1`, `terminationGracePeriodSeconds` of `config.server.shutdownDelay` plus `config.server.shutdownTimeout` plus 10 seconds (at least 45; 45 with the defaults), `automountServiceAccountToken: false`, a startup probe (`/healthz`, up to 10 minutes, so long migrations are not killed), a liveness probe (`/healthz`) and a readiness probe (`/readyz`, every 2 s) on the metrics port. |
| `resources.controllers.export` | The export CronJob `<release>-export`: `concurrencyPolicy: Forbid`, `backoffLimit: 2` and 3 successful and 3 failed Jobs kept. |
| both controllers | Container `main`, image `ghcr.io/soliddowant/vault-sync` at the chart's `appVersion`, user and group `65532` (`runAsNonRoot`, `fsGroup` 65532), a read-only root filesystem, no privilege escalation, all capabilities dropped and the `RuntimeDefault` seccomp profile. |
| `resources.service.main` | One ClusterIP Service with ports `http` (8080, primary), `metrics` (9090) and `service-metrics` (9091). |
| `resources.serviceMonitor.main` | The ServiceMonitor, when enabled. |
| `resources.route.main` | The HTTPRoute, when `config.route.enabled`. |
| `resources.persistence.*` | `database-client-cert`, `database-ca`, `s3-credentials`, `s3-ca`, `export-database-client-cert`, `export-s3-credentials`, `escrow` (read-only Secrets, mode `0440`) and `export` (the output volume). |

The chart sets no scheduling or capacity policy, because a caller could change but not remove anything it set: no PodDisruptionBudget, no container resources and no topology spread constraints (a pod that declares any opts out of the cluster's default spreading). Set them under `resources`, for example `resources.controllers.main.replicas: 3`, `resources.controllers.main.podDisruptionBudget.maxUnavailable: 1`, `resources.controllers.main.containers.main.resources.requests.memory: 128Mi`, `resources.controllers.export.containers.main.resources.limits.memory: 1Gi` or `resources.controllers.main.containers.main.image.tag: 1.2.3`. As a starting point for sizing, earlier chart versions requested 100m CPU and 128Mi memory for both, with limits of 1 CPU and 512Mi memory for the server and 1Gi for the export; a server's memory grows with concurrent requests, each holding up to `VAULT_SYNC_MAX_REQUEST_BYTES`. Do not give the server a volume it writes to: replicas must keep no state of their own (SPEC.md §12).

## High availability

The defaults follow the recommended settings in [configuration.md](configuration.md#high-availability-deployment) that the server needs to run correctly: two replicas, readiness on `/readyz` with a short period, liveness on `/healthz`, a grace period above `VAULT_SYNC_SHUTDOWN_DELAY` plus `VAULT_SYNC_SHUTDOWN_TIMEOUT`, and rolling updates that start a new pod before stopping an old one. The grace period follows `config.server.shutdownDelay` and `config.server.shutdownTimeout`; if you set `resources.controllers.main.pod.terminationGracePeriodSeconds` yourself, the chart refuses to render unless it is larger than the delay plus the timeout. Scale with `resources.controllers.main.replicas`; nothing else changes. Spreading replicas across nodes is left to the cluster's default topology spread (or your own `resources.controllers.main.pod.topologySpreadConstraints`), and a PodDisruptionBudget to you, for example:

```yaml
resources:
  controllers:
    main:
      podDisruptionBudget:
        maxUnavailable: 1   # or minAvailable: 1, not both
```

## Monitoring

The server exposes per-instance metrics on port `metrics` (9090) and service-wide metrics on port `service-metrics` (9091), listed in [configuration.md](configuration.md#metrics). `config.server.metrics.serviceMonitor.enabled` scrapes the first with a prometheus-operator ServiceMonitor, and `config.server.metrics.serviceWide.enabled` adds the second (see [Server](#server)).

The chart ships three Grafana dashboards (JSON in `deploy/charts/vault-sync/dashboards/`, packaged with the chart). Links in each lead to the others; their UIDs are stable, so links and bookmarks survive upgrades:

| Dashboard | UID | What it is for |
|---|---|---|
| vault-sync / Overview | `vault-sync-overview` | The service-wide view: a row of alert states (stale service-wide metrics, commit listeners down, retention and OIDC key failures, RPC error ratio, S3 errors), users, devices and vaults (by encryption and sharing), stored blobs and bytes and their daily growth, documents and revisions, the upload, garbage collection, E2EE re-key and escrow re-wrap backlogs, the schema version, and when retention, the export and the service-wide metrics last succeeded. Needs the service-wide metrics. |
| vault-sync / Server | `vault-sync-server` | Per instance (`pod` variable): RPC rate, errors by code and p50, p95 and p99 latency by procedure, RPCs and users in flight and per-user concurrency rejections, realtime connections, refused upgrades, disconnects, notifications and the commit listener's status and reconnects, blob transfer, retention work, and Go runtime and process memory, CPU, goroutines and file descriptors. |
| vault-sync / Dependencies | `vault-sync-dependencies` | Per instance: PostgreSQL pool usage, acquire latency and query errors, the commit listener, S3 operation rates, outcomes and latency, and OIDC key set refresh failures and age. |

Every dashboard has a `datasource` variable (any Prometheus data source) and `namespace` and `job` variables (the job is the Service name, which is the release name, for both endpoints of the ServiceMonitor), so one copy serves any release name and several deployments. Service-wide panels take the `max` over replicas, so they are right whether one replica or all of them are scraped.

**With grafana-operator**, set `config.grafana.dashboards.enabled` and an `instanceSelector` matching your `Grafana` resource's labels; the operator imports one `GrafanaDashboard` per dashboard:

```yaml
config:
  grafana:
    dashboards:
      enabled: true
      instanceSelector:
        matchLabels:
          dashboards: grafana
      folder: vault-sync
      # allowCrossNamespaceImport: true   # when Grafana runs in another namespace
```

**With the Grafana chart's sidecar** (no operator), set `config.grafana.dashboards.configMaps.enabled`; the chart renders one ConfigMap per dashboard with the label the sidecar watches (`grafana_dashboard: "1"`, its default). If your sidecar searches only its own namespace, set its `sidecar.dashboards.searchNamespace` to `ALL` or to the release namespace:

```yaml
config:
  grafana:
    dashboards:
      configMaps:
        enabled: true
        # label: grafana_dashboard
        # labelValue: "1"
```

The dashboards come from the chart's own files. To import them by hand, upload the JSON files and pick the Prometheus data source in the `datasource` variable.

## Releasing

Releases are cut from a clean checkout of `master` with the GitHub CLI signed in. `VERSION` is a semantic version without a `v` (`1.2.3`, or `1.2.3-beta.1` for a pre-release):

```sh
nix develop -c make release VERSION=1.2.3                # dry run: builds the plugin, prints what it would tag and release
nix develop -c make release VERSION=1.2.3 PUSH_ALL=true  # releases
```

**Release notes come from `CHANGELOG.md`.** The body of the GitHub release is the `## <VERSION>` section of `CHANGELOG.md` in the released checkout, without its heading, so write and merge that section before releasing. `make release` refuses a version whose section is missing or empty, in a dry run too, before anything is built or pushed; a dry run prints the notes it would publish.

`make release` checks the version, `gh auth status` and the `CHANGELOG.md` section first (and, for a real release, that the tree is clean, that `HEAD` is the published `master` (`origin/master`, fetched first) and that the tag is new), then runs:

1. `make plugin-release-assets`: builds the plugin and collects `main.js`, `manifest.json` (its `version` set to `<VERSION>`) and `styles.css` in `bin/release/`, and checks them, so a broken asset stops the release before anything is tagged.
2. Tags `HEAD` as `<VERSION>`, pushes the tag and creates the GitHub release `<VERSION>` with that `CHANGELOG.md` section as its notes (written to `bin/release/release-notes.md`) and the three plugin files attached (a version with `-` is marked as a pre-release and never as the latest release). In a dry run these commands are only printed.

`make release` needs no registry credentials: pushing the tag starts the `release` workflow (`.github/workflows/release.yml`), which publishes the server image and the chart with the workflow's `GITHUB_TOKEN` (`packages: write`). It runs on every pushed tag of the form `X.Y.Z` or `X.Y.Z-…` and, through `scripts/publish-release.sh`:

1. `make build-images PUSH_ALL=true`: builds the image with Nix, runs `govulncheck -mode=binary` on its binary (a known vulnerability fails the run), and pushes `ghcr.io/soliddowant/vault-sync:<VERSION>`, plus `:latest` unless the version is a pre-release.
2. `make helm PUSH_ALL=true`: packages the chart as version `<VERSION>` and pushes it to `oci://ghcr.io/soliddowant/charts`.
3. Checks that both resolve (`docker manifest inspect ghcr.io/soliddowant/vault-sync:<VERSION>`, `helm show chart oci://ghcr.io/soliddowant/charts/vault-sync --version <VERSION>`).

The GitHub release therefore exists a few minutes before its image and chart: a release is complete once its `release` workflow run has passed (`gh run list --workflow release.yml --branch <VERSION>`). If the run fails, fix the cause and re-run it (`gh run rerun <run-id>`); never move the tag. If tagging, the tag push or `gh release create` fails, finish by hand from the same checkout with the commands of step 2 (`git tag -a <VERSION> -m "Release <VERSION>"`, `git push origin refs/tags/<VERSION>`, `gh release create <VERSION> --verify-tag --title <VERSION> --notes-file bin/release/release-notes.md bin/release/main.js bin/release/manifest.json bin/release/styles.css`, adding `--prerelease --latest=false` for a pre-release), skipping any that already succeeded. Rerunning `make release` instead stops at the preflight once the tag exists.

To build the image and chart locally without the workflow, `make build-images helm VERSION=<VERSION>` builds both without pushing; with `PUSH_ALL=true` they are pushed, which needs credentials for `ghcr.io` in the Docker daemon (`docker login ghcr.io`) and for Helm (`helm registry login ghcr.io`).

The tag has no `v` because Obsidian and BRAT require the release tag, the release name and the released `manifest.json` version to be the same string. The plugin is installed from these releases with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the beta plugin `solidDoWant/vault-sync`, and BRAT downloads the three files from the latest release.

**Agent releases.** The `release-manager` agent (`.claude/agents/release-manager.md`) cuts a release (`0.N.0` when phase *N* closes, patch versions for fixes, `-rc.K` candidates when asked) on a `/pm release` instruction or when a phase closes, after its own gate checks (milestone, open critical/high bugs, CI, integration/upgrade tests, vulncheck, a dry run). `1.0.0` and above need an explicit `/pm` instruction.

**The Go vendor hash.** `nix/server.nix` pins a hash of the Go module dependencies. After a change to `go.mod` or `go.sum`, `make build-images` fails with a hash mismatch until `vendorHash` is updated. Run `make update-vendor-hash` (needs network access): it builds the vendored modules with a placeholder hash, writes the hash Nix reports into `nix/server.nix` and checks that the modules build with it; commit the change with the `go.mod`/`go.sum` change. `make update-dependencies` runs it too. On Renovate's pull requests the `renovate-fixups` workflow runs it and pushes the result.
