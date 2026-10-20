# Deploying vault-sync

This guide deploys the vault-sync server and its plaintext export job on Kubernetes with the Helm chart in `deploy/charts/vault-sync`, on the infrastructure vault-sync is built for (SPEC.md §3): PostgreSQL run by CloudNativePG, Ceph RGW for S3, Authentik for sign-in, and an Istio gateway with a Coraza WAF in front. Every server variable the chart sets is described in [configuration.md](configuration.md), the export in [export.md](export.md), and the plugin side in [plugin.md](plugin.md).

What you deploy:

- **The server**, a Deployment of two or more identical replicas behind one Service. It is the only internet-facing part. Replicas share one PostgreSQL database and one S3 bucket and keep no state of their own, so any replica can be stopped at any time (configuration.md, High-availability deployment).
- **The export job**, a CronJob running `vault-sync-server export`, which writes a plaintext copy of every vault to a volume your tape-archival tooling reads. It has its own credentials and is the only part that may ever hold the escrow private key.
- **Nothing else.** The chart creates no database, bucket, Secret or identity-provider client: it references the ones you create below.

## The image

`ghcr.io/soliddowant/vault-sync:<version>` holds one static binary, `/bin/vault-sync-server`, and CA roots: no shell and no package manager. It runs as user and group `65532` and needs no writable path except, for the export, its output volume. The same image runs the server (no arguments) and the export (`export -out DIR`).

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

- Route the host to the `main` Service, port `http` (8080), for example with `resources.route` (Gateway API) or `resources.ingress`. Never expose the `metrics` Service (port 9090).
- Allow WebSocket upgrades on `/v1/realtime`, and do not time out idle connections faster than every 30 seconds (the server pings every 30). The WAF must not log the `Sec-WebSocket-Protocol` header, which carries the access token.
- The server sends CORS headers for Obsidian's app origins itself; do not strip them.

## The export job

The CronJob runs `vault-sync-server export -out /export/<directory>` on `config.export.schedule` (a cron expression, daily at 03:00 by default; `config.export.timeZone` sets an IANA time zone, otherwise the cluster's default applies). It writes every plaintext vault as a browsable tree with a manifest, replacing the previous export atomically ([export.md](export.md) describes the layout and how to verify it). Runs never overlap (`concurrencyPolicy: Forbid`), each run is stopped after `config.export.activeDeadlineSeconds` (6 hours by default, so a hung run, for example on a stalled NFS volume, cannot block every later one), a failed run is retried twice, and the job exits non-zero when anything failed or was missing, so alert on failed Jobs.

- **Output volume.** `config.export.output.persistence` is the volume it writes to, as a bjw-s persistence item, for example `{type: persistentVolumeClaim, existingClaim: vault-sync-export}` or an `nfs` volume shared with your tape tooling. It is required while `config.export.enabled` is true and mounted at `/export` in the export job only. `config.export.output.directory` is the directory inside it (`vaults` by default); the export also keeps a lock file and a staging directory next to it, so the volume's top level must be writable. Files are created `0640` and directories `0750`, owned by user and group `65532` (the pod's `fsGroup`), so give your tape tooling that group.
- **Own credentials.** By default the export uses the server's database and S3 settings. Give it a read-only database role (`SELECT` on `vaults`, `documents`, `revisions` and `blobs`) with `config.export.database.url` (`value` or `secretKeyRef`) and `config.export.database.tls.clientCertificate.secretName` (`config.export.database.tls.clientCertificate.certKey` and `config.export.database.tls.clientCertificate.keyKey` name the keys), and read-only S3 credentials as above. Empty fields fall back to the server's; the CA certificates are shared. Its sessions are read-only in any case.
- **Escrow.** `config.export.escrow.secretName` names the Secret holding the escrow private key (SPEC.md §9.4). It is mounted read-only at `/etc/vault-sync/escrow` in the export job and never into the server: the chart refuses to render if any value (a persistence entry, an env var, `envFrom`, default pod options) would put it into the server, and `make chart-lint` checks that the rendered server Deployment never names it. The export does not read the key until end-to-end encryption ships (Phase 4), so setting it today only prepares the mount.
- `config.export.enabled: false` drops the CronJob and all of its mounts.

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
    output:
      persistence:
        type: persistentVolumeClaim
        existingClaim: vault-sync-export
resources:
  route:
    main:
      parentRefs:
        - name: public-gateway
          namespace: istio-ingress
      hostnames:
        - sync.example.com
      rules:
        - backendRefs:
            - identifier: main
              port: 8080
```

```sh
helm install vault-sync oci://ghcr.io/soliddowant/charts/vault-sync --version <version> -n vault-sync -f values.yaml
```

The chart then renders: the server Deployment and its PodDisruptionBudget, the export CronJob, the `main` (8080) and `metrics` (9090) Services, a ServiceMonitor, and a ServiceAccount without an API token. It creates no Secrets.

## Chart values

The chart has two top-level keys. `config` is the chart's own interface, described below; every empty value leaves its variable unset, so the server's default applies. `resources` is passed to the [bjw-s common library chart](https://github.com/bjw-s-labs/helm-charts/tree/main/charts/library/common) (5.3.0) and deep-merged over what the chart computes, so anything that library supports can be overridden or added there (see [Overriding the computed resources](#overriding-the-computed-resources)).

### Shared settings

| Value | Default | Description |
|---|---|---|
| `config.logLevel` | empty (`info`) | `VAULT_SYNC_LOG_LEVEL` for the server and the export: `debug`, `info`, `warn` or `error`. |

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
| `config.s3.endpoint` | empty (AWS S3) | `VAULT_SYNC_S3_ENDPOINT`, for example the RGW URL. |
| `config.s3.region` | empty (`us-east-1`) | `VAULT_SYNC_S3_REGION`. |
| `config.s3.forcePathStyle` | empty (`true`) | `VAULT_SYNC_S3_FORCE_PATH_STYLE`: `"true"` or `"false"`. |
| `config.s3.idleTimeout` | empty (`2m`) | `VAULT_SYNC_S3_IDLE_TIMEOUT`, a Go duration. |
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
| `config.oidc.clientId` | empty | `VAULT_SYNC_OIDC_CLIENT_ID`, the client the plugin signs in as when it differs from the audience. Empty leaves it unset. |

### Server

The listen addresses are fixed by the chart: `VAULT_SYNC_LISTEN_ADDRESS` is `:8080` (port `http`) and `VAULT_SYNC_METRICS_LISTEN_ADDRESS` is `:9090` (port `metrics`, which the probes and the ServiceMonitor use). Every value below sets the variable named, documented in configuration.md; empty uses the server's default.

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
| `config.server.realtime.maxConnections` | `VAULT_SYNC_REALTIME_MAX_CONNECTIONS` |
| `config.server.realtime.maxConnectionsPerUser` | `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER` |
| `config.server.realtime.maxSubscriptions` | `VAULT_SYNC_REALTIME_MAX_SUBSCRIPTIONS` |

| Value | Default | Description |
|---|---|---|
| `config.server.metrics.serviceMonitor.enabled` | `true` | Create a prometheus-operator ServiceMonitor for `/metrics` on the `metrics` Service. Needs the `monitoring.coreos.com` CRDs; set `false` without them. |
| `config.server.metrics.serviceMonitor.interval` | `1m` | Scrape interval. |
| `config.server.metrics.serviceMonitor.scrapeTimeout` | `10s` | Scrape timeout. |

### Export

| Value | Default | Description |
|---|---|---|
| `config.export.enabled` | `true` | Render the export CronJob. |
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

### Overriding the computed resources

Under `resources`, the chart computes these bjw-s entries; your values are merged over them and win:

| Entry | What the chart sets |
|---|---|
| `resources.controllers.main` | The server Deployment: `replicas: 2`, `RollingUpdate` with `maxUnavailable: 0` and `maxSurge: 1`, a PodDisruptionBudget with `maxUnavailable: 1` while replicas are more than 1, a topology spread over `kubernetes.io/hostname`, `terminationGracePeriodSeconds` of `config.server.shutdownDelay` plus `config.server.shutdownTimeout` plus 10 seconds (at least 45; 45 with the defaults), `automountServiceAccountToken: false`, a startup probe (`/healthz`, up to 10 minutes, so long migrations are not killed), a liveness probe (`/healthz`) and a readiness probe (`/readyz`, every 2 s) on the metrics port, and requests/limits of 100m/1 CPU and 128Mi/512Mi memory. |
| `resources.controllers.export` | The export CronJob: `concurrencyPolicy: Forbid`, `backoffLimit: 2`, 3 successful and 3 failed Jobs kept, and requests/limits of 100m/1 CPU and 128Mi/1Gi memory. |
| both controllers | Container `main`, image `ghcr.io/soliddowant/vault-sync` at the chart's `appVersion`, user and group `65532` (`runAsNonRoot`, `fsGroup` 65532), a read-only root filesystem, no privilege escalation, all capabilities dropped and the `RuntimeDefault` seccomp profile. |
| `resources.service.main`, `resources.service.metrics` | ClusterIP Services on ports 8080 (`http`) and 9090 (`metrics`). |
| `resources.serviceMonitor.main` | The ServiceMonitor, when enabled. |
| `resources.persistence.*` | `database-client-cert`, `database-ca`, `s3-credentials`, `s3-ca`, `export-database-client-cert`, `export-s3-credentials`, `escrow` (read-only Secrets, mode `0440`) and `export` (the output volume). |

For example `resources.controllers.main.replicas: 3`, `resources.controllers.main.containers.main.resources.limits.memory: 1Gi` or `resources.controllers.main.containers.main.image.tag: 1.2.3`. Do not give the server a volume it writes to: replicas must keep no state of their own (SPEC.md §12).

## High availability

The defaults follow the recommended settings in [configuration.md](configuration.md#high-availability-deployment): at least two replicas spread across nodes, a PodDisruptionBudget, readiness on `/readyz` with a short period, liveness on `/healthz`, a grace period above `VAULT_SYNC_SHUTDOWN_DELAY` plus `VAULT_SYNC_SHUTDOWN_TIMEOUT`, and rolling updates that start a new pod before stopping an old one. The grace period follows `config.server.shutdownDelay` and `config.server.shutdownTimeout`; if you set `resources.controllers.main.pod.terminationGracePeriodSeconds` yourself, the chart refuses to render unless it is larger than the delay plus the timeout. Scale with `resources.controllers.main.replicas`; nothing else changes.

## Releasing

Releases are cut from a clean checkout of `master` with the GitHub CLI signed in. `VERSION` is a semantic version without a `v` (`1.2.3`, or `1.2.3-beta.1` for a pre-release):

```sh
nix develop -c make release VERSION=1.2.3                # dry run: builds everything, prints what it would publish
nix develop -c make release VERSION=1.2.3 PUSH_ALL=true  # releases
```

`make release` checks the version and `gh auth status` first (and, for a real release, that the tree is clean, that `HEAD` is the published `master` (`origin/master`, fetched first) and that the tag is new), then runs:

1. `make plugin-release-assets`: builds the plugin and collects `main.js`, `manifest.json` (its `version` set to `<VERSION>`) and `styles.css` in `bin/release/`, and checks them, so a broken asset stops the release before anything is pushed.
2. `make build-images`: builds the image with Nix, runs `govulncheck -mode=binary` on its binary (a known vulnerability fails the build), loads it into Docker and tags it `ghcr.io/soliddowant/vault-sync:<VERSION>`; with `PUSH_ALL=true` pushes it, and also tags and pushes `:latest` unless the version is a pre-release.
3. `make helm`: packages the chart as version `<VERSION>` into `bin/helm/`; with `PUSH_ALL=true` pushes it to `oci://ghcr.io/soliddowant/charts`.
4. Tags `HEAD` as `<VERSION>`, pushes the tag and creates the GitHub release `<VERSION>` with generated notes and the three plugin files attached (a version with `-` is marked as a pre-release and never as the latest release). In a dry run these commands are only printed.

The image and chart are pushed before the tag. If tagging, the tag push or `gh release create` fails after that, the registry holds `<VERSION>` with no matching release: fix the cause and finish by hand from the same checkout with the commands of step 4 (`git tag -a <VERSION> -m "Release <VERSION>"`, `git push origin refs/tags/<VERSION>`, `gh release create <VERSION> --verify-tag --title <VERSION> --generate-notes bin/release/main.js bin/release/manifest.json bin/release/styles.css`, adding `--prerelease --latest=false` for a pre-release), skipping any that already succeeded. Rerunning `make release` instead stops at the preflight once the tag exists, and otherwise builds and pushes the image and chart again.

The tag has no `v` because Obsidian and BRAT require the release tag, the release name and the released `manifest.json` version to be the same string. The plugin is installed from these releases with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the beta plugin `solidDoWant/vault-sync`, and BRAT downloads the three files from the latest release.

**Agent releases.** The `release-manager` agent (`.claude/agents/release-manager.md`) cuts a release (`0.N.0` when phase *N* closes, patch versions for fixes, `-rc.K` candidates when asked) on a `/pm release` instruction or when a phase closes, after its own gate checks (milestone, open critical/high bugs, CI, a long simulation, integration/upgrade tests, vulncheck, a dry run). `1.0.0` and above need an explicit `/pm` instruction.

Pushing needs credentials for `ghcr.io` in the Docker daemon (`docker login ghcr.io`) and for Helm (`helm registry login ghcr.io`).

**The Go vendor hash.** `nix/server.nix` pins a hash of the Go module dependencies. After a change to `go.mod` or `go.sum`, `make build-images` fails with a hash mismatch until `vendorHash` is updated. Run `make update-vendor-hash` (needs network access): it builds the vendored modules with a placeholder hash, writes the hash Nix reports into `nix/server.nix` and checks that the modules build with it; commit the change with the `go.mod`/`go.sum` change. `make update-dependencies` runs it too.
