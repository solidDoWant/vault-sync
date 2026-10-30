# Deploying vault-sync

This introduction moved to [Requirements](admin/requirements.md#the-reference-setup) and [Install](admin/install.md#what-you-deploy).

## The image

This section moved to [Install](admin/install.md#the-image).

## PostgreSQL (CloudNativePG)

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#postgresql).

## S3 (Ceph RGW)

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#s3).

## Authentik (the device-flow application)

This section moved to [Identity provider](admin/identity-provider.md#example-authentik).

## The WAF body limit (Istio and Coraza)

The Coraza WAF in front of the server rejects inspected request bodies above 1 MiB. vault-sync never sends a larger request: files are uploaded in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES` (768 KiB by default) and every request is at most `VAULT_SYNC_MAX_REQUEST_BYTES` (1 MiB by default). Keep it that way:

- Leave `config.server.maxRequestBytes` at or below the WAF's limit. The server refuses to start if a chunk (`config.server.blob.maxChunkBytes`) plus 1024 bytes does not fit in it.
- Responses are bounded by the same `VAULT_SYNC_MAX_REQUEST_BYTES`. If the WAF also inspects response bodies, its response limit must be at least as large.
- Request bodies are read before the bearer token is checked, so keep the limit low: it is also what an unauthenticated caller can make the server read per request.

The rest of the ingress moved to [Install](admin/install.md#the-ingress).

## The export job

This section moved to [Backup and restore](admin/backup-and-restore.md#the-export-job).

## Installing the chart

This section moved to [Install](admin/install.md#install-the-chart).

## Upgrading

This section moved to [Upgrades and high availability](admin/upgrades.md#upgrade-the-server).

## Per-vault retention

This section moved to [History and retention](admin/history-and-retention.md#per-vault-overrides).

## Undeleting a vault

This section moved to [Backup and restore](admin/backup-and-restore.md#undelete-a-vault).

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
| `config.export.escrow.key` | `escrow.key` | Key of that Secret; it holds the identity file (`age-keygen -pq` output), which the export job reads as `VAULT_SYNC_ESCROW_IDENTITY_FILE`. The chart refuses to render if any value would put it into the server. |
| `config.escrowJobToken.secretName` | empty | Secret holding the static bearer token of the escrow rotation endpoint (`VAULT_SYNC_ESCROW_JOB_TOKEN_FILE`), mounted read-only at `/etc/vault-sync/escrow-job-token` into the server, which checks it, and the export job, which presents it, and into nothing else. Empty leaves the endpoint off. |
| `config.escrowJobToken.key` | `token` | Key of that Secret; it holds one line of at least 32 characters, for example `openssl rand -base64 32`. |

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

`config.alerts` renders the packaged alerting rules (`deploy/charts/vault-sync/alerts/vault-sync.rules.yaml`) as a prometheus-operator `PrometheusRule` (`monitoring.coreos.com/v1`). [admin/alerts.md](admin/alerts.md) lists every alert with its threshold, the reasoning behind it, and a runbook section saying what to check and what to do; each alert's `runbook_url` points there. To enable the rules:

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
| `config.alerts.runbookUrlBase` | `https://github.com/solidDoWant/vault-sync/blob/master/docs/admin/alerts.md` | Each alert's `runbook_url` annotation is this followed by `#` and the alert's name in lower case. Empty leaves `runbook_url` out. |
| `config.alerts.rules` | `{}` | Per-alert overrides keyed by alert name, each with `enabled`, `for` (a Prometheus duration), `severity` (`critical` or `warning`) and `threshold` (for alerts that have one; see [admin/alerts.md](admin/alerts.md)). A disabled alert is dropped from the rendered rules, and an unknown name fails the render. `VaultSyncNoReplicaReady` and `VaultSyncReplicasUnavailable` need kube-state-metrics and are off unless enabled here; `VaultSyncExportNotSucceeding` is on while `config.export.enabled`. |

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

This section moved to [Upgrades and high availability](admin/upgrades.md#high-availability).

## Monitoring

The server exposes per-instance metrics on port `metrics` (9090) and service-wide metrics on port `service-metrics` (9091), listed in [metrics-reference.md](admin/metrics-reference.md). `config.server.metrics.serviceMonitor.enabled` scrapes the first with a prometheus-operator ServiceMonitor, and `config.server.metrics.serviceWide.enabled` adds the second (see [Server](#server)).

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

How a release is made is in [`dev/releasing.md`](dev/releasing.md).

