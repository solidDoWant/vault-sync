# Alerts

The Helm chart ships alerting rules for vault-sync as a prometheus-operator `PrometheusRule`, off by default. [deployment.md](deployment.md#alerts) explains how to enable them and override single alerts (`config.alerts.rules.<AlertName>`: `enabled`, `for`, `severity`, `threshold`). The rules live in `deploy/charts/vault-sync/alerts/vault-sync.rules.yaml`; every alert is unit-tested with `promtool test rules` (`make chart-lint`).

There are two severities:

- `critical`: users cannot sync, or data is at risk. Act now.
- `warning`: the service is degraded or a backlog is building. Act within working hours.

The metrics are described in [configuration.md](configuration.md#metrics) (per replica, port `metrics`) and [configuration.md](configuration.md#service-wide-metrics) (service-wide, port `service-metrics`). Service-wide alerts aggregate with `by ()`, so they fire once whether Prometheus scrapes one replica or all of them, and they need the service-wide endpoint scraped (`config.server.metrics.serviceWide.enabled`). Per-replica alerts fire once per affected replica and carry its `instance` label.

The thresholds come from the server's own schedules and defaults (retention runs hourly, the upload TTL is 24 hours, the blob GC grace is 24 hours, the service-wide refresh runs every minute) and from what the e2e and load runs show a healthy deployment does: no server errors and sync RPCs well under a second. Each section says why its threshold is what it is; if you change the matching server setting, change the threshold with it.

The rules do not alert on replicas running different schema versions: `vault_sync_service_schema_version` is read from the shared database, so every replica reports the same value, and the server exports no per-replica version to compare. A stuck rolling upgrade shows up as `VaultSyncReplicasUnavailable` instead.

## Availability

### VaultSyncNoReplicaReady

`critical`, after 5 minutes. Needs kube-state-metrics (off unless `config.alerts.rules.VaultSyncNoReplicaReady.enabled`): `kube_deployment_status_replicas_available` of the server Deployment is 0. Nobody can sync.

Check: `kubectl get pods` and `kubectl describe pod` for the server Deployment; the logs of a failing pod (`kubectl logs --previous`). The readiness probe (`/readyz`) fails while PostgreSQL does not answer, so look at PostgreSQL too. Do: fix the cause the pod events or logs name (image pull, crash on a configuration error, a dependency down); roll back a bad release with `helm rollback`.

### VaultSyncReplicasUnavailable

`warning`, after 15 minutes. Needs kube-state-metrics (off unless enabled): the Deployment has fewer available replicas than it wants. 15 minutes is longer than a rolling upgrade takes, so a rollout alone does not fire it.

Check: pending pods (resources, node selectors, a PodDisruptionBudget blocking), crash-looping pods, a rollout stuck on a pod that never becomes ready (`kubectl rollout status`). Do: free capacity or fix the failing pod; a rollout stuck on a new version is a reason to roll back.

### VaultSyncRPCErrorRatioHigh

`critical`, after 10 minutes above 5% (threshold `0.05`): the share of RPCs, over every replica, that ended with `internal`, `unavailable` or `unknown`. Client errors (`not_found`, `failed_precondition`, `resource_exhausted`, ...) do not count. A healthy deployment has none, so 5% for 10 minutes means many users' syncs fail.

Check: `vault_sync_rpc_requests_total` by `procedure` and `code` to see which RPCs fail; the server logs (`level=ERROR`) for the cause; the dependency alerts below (PostgreSQL pool, S3 errors). Do: fix the failing dependency; if it started with a release, roll back.

### VaultSyncSyncLatencyHigh

`warning`, after 15 minutes above 2 seconds (threshold `2`): the 95th percentile, over every replica, of `ListChanges`, `GetRevision` and `CommitRevision`. Blob transfers are excluded: their time grows with file size. These three are small requests that answer in well under a second when PostgreSQL is healthy; 2 seconds leaves room for large change pages.

Check: `vault_sync_db_pool_acquire_duration_seconds` and `vault_sync_db_pool_waiting_acquires` (waiting for a connection), PostgreSQL's own load and slow-query log, CPU throttling of the server pods. Do: give PostgreSQL or the pods more resources, or add replicas.

### VaultSyncRealtimeListenerDown

`warning`, per replica, after 5 minutes: `vault_sync_realtime_listener_up` is 0, so that replica's commit listener (PostgreSQL `LISTEN`) has been reconnecting for 5 minutes. Its realtime clients get no change notifications; they still sync on their own schedule, so nothing is lost, but changes arrive late.

Check: the replica's logs for the listener's reconnect errors, `vault_sync_realtime_listener_reconnects_total`, PostgreSQL's connection limit and whether a pooler in front of PostgreSQL supports `LISTEN` (PgBouncer in transaction mode does not). Do: fix the connection; restarting the pod moves its clients to a healthy replica.

### VaultSyncConcurrencyRejections

`warning`, after 30 minutes of rejections (threshold `0` per second): RPCs rejected with `resource_exhausted` because a user already had `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` calls in flight on a replica, sustained over every 10-minute window for half an hour. A short burst is normal (a client catching up); sustained rejections mean the limit is too low for how users sync, or a client is misbehaving.

Check: `vault_sync_rpc_concurrency_rejections_total` by `procedure`, and the server logs for which user is rejected. Do: raise `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` (`config.server.maxConcurrentRpcsPerUser`) if many users hit it; contact the user or remove the device (`RemoveDevice`) if one client loops.

### VaultSyncRealtimeRefusals

`warning`, after 30 minutes of refusals (threshold `0` per second): realtime upgrades refused for `user_limit` or `instance_limit`, sustained like the previous alert. Other reasons (`origin`, `unauthenticated`, `draining`, ...) are expected and do not count.

Check: `vault_sync_realtime_refused_upgrades_total` by `reason` and `vault_sync_realtime_connections` per replica. Do: for `instance_limit`, raise `VAULT_SYNC_REALTIME_MAX_CONNECTIONS` or add replicas; for `user_limit`, raise `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER` or find the client opening connections in a loop.

## Dependencies

### VaultSyncDatabasePoolExhausted

`warning`, per replica, after 10 minutes: requests have been waiting for a PostgreSQL connection (`vault_sync_db_pool_waiting_acquires` above 0) with no idle connection in the pool. Requests slow down and then time out.

Check: `vault_sync_db_pool_acquired_connections` against the pool size (pgx's `pool_max_conns` parameter of `VAULT_SYNC_DATABASE_URL`), PostgreSQL's slow queries and locks, `max_connections`. Do: raise `pool_max_conns` (within PostgreSQL's `max_connections` for every replica), or fix what makes queries slow.

### VaultSyncS3ErrorRatioHigh

`critical`, after 10 minutes above 5% (threshold `0.05`): the share of S3 operations, over every replica, with outcome `error` (`not_found` is expected and does not count). Uploads and downloads of attachments fail.

Check: `vault_sync_s3_requests_total` by `operation`, the server logs for the S3 error, the object store's health, the credentials (rotated or expired) and the CA bundle. Do: fix the object store or the credentials Secret; the server picks up a rotated Secret without a restart.

### VaultSyncOIDCKeyRefreshFailing

`warning`, per replica, after 15 minutes: the replica failed to fetch the OIDC issuer's key set within the last 30 minutes and its keys are more than 2 hours old (threshold `7200` seconds). Keys are fetched at most hourly, so 2 hours means at least one refresh was missed. The replica keeps using its keys, but tokens signed with a new key are rejected after a rotation, signing every user out.

Check: the replica's logs for the fetch error, that the pods can reach `VAULT_SYNC_OIDC_ISSUER_URL` (DNS, network policy, egress proxy, the issuer's TLS certificate). Do: restore the connection to the issuer.

## Data safety and backlog

These read the service-wide metrics and fire once for the deployment.

### VaultSyncRetentionNotSucceeding

`warning`, after 30 minutes with the last error-free retention run more than 3 hours ago (threshold `10800` seconds). Every replica runs retention hourly, so three missed hours is not a single failed run. History is not purged and storage grows, and deleted vaults are not removed.

Check: the server logs for `retention run failed` and `vault_sync_retention_run_failures_total`. A run fails in part when PostgreSQL or S3 errors; the next run retries. Do: fix the error the log names.

### VaultSyncExportNotSucceeding

`warning`, after an hour with the last export with status `ok` more than 36 hours ago (threshold `129600` seconds). On while `config.export.enabled`. With the default daily schedule, 36 hours means a run was missed or failed; the plaintext disaster-recovery copy ([export.md](export.md)) is out of date. It also fires on a new install until the first export finishes, since the timestamp is 0 until then.

Check: the export CronJob's last Jobs (`kubectl get jobs`), their logs and summary (`partial` or `failed`), the export volume (full, not mounted). Do: fix the cause and run the export once by hand (`kubectl create job --from=cronjob/<release>-export`).

### VaultSyncUploadSessionsNotExpiring

`warning`, after an hour with the oldest open upload session more than 48 hours old (threshold `172800` seconds). The cleanup runs every 5 minutes and removes sessions idle longer than `VAULT_SYNC_BLOB_UPLOAD_TTL` (24 hours), so a session twice that old means the cleanup is not running or keeps failing, and staged S3 objects pile up. Raise the threshold with the TTL.

Check: the server logs for upload cleanup errors, `vault_sync_service_upload_sessions` and `vault_sync_service_upload_session_reserved_bytes`. Do: fix the error the log names (usually PostgreSQL or S3).

### VaultSyncBlobGCStalled

`warning`, after 24 hours in which blobs await garbage collection (`vault_sync_service_gc_pending_blobs` above 0) and no replica collected one in the 6 hours before. A blob waits `VAULT_SYNC_BLOB_GC_GRACE` (24 hours) plus at most an hour for the next retention run, so 30 hours without a collection while blobs are pending means the collector is stuck. Released storage is not freed. Raise the `for` with the grace period.

Check: the server logs for retention errors (the collector runs inside the retention job), `VaultSyncRetentionNotSucceeding`, `vault_sync_retention_blobs_collected_total`. Do: fix the error the log names.

### VaultSyncRekeyBacklogNotShrinking

`warning`, after an hour with stale-epoch revisions (`vault_sync_service_stale_epoch_revisions`) above 0 and no fewer than 24 hours earlier. Re-encryption after a key rotation is done by the vault members' clients, so a backlog that has not moved for a day means no member's client is re-encrypting: the old epoch's key cannot be retired.

Check: `vault_sync_service_rekey_vaults` for how many vaults are affected, whether the members' devices have synced recently. Do: ask a member to open the vault in Obsidian with the plugin unlocked; it continues the re-key.

### VaultSyncEscrowRewrapStuck

`warning`, after an hour with escrow key slots that still name a retiring escrow key id (`vault_sync_service_escrow_rewrap_slots`) above 0 and no fewer than 48 hours earlier. During an escrow key rotation the export job re-wraps these slots ([export.md](export.md)); with a daily export, two days without progress means the re-wrap is failing. It is 0 without `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`.

Check: the export job's logs for re-wrap errors, that it has both escrow identities and the job token (`config.escrowJobToken`). Do: fix the export job's configuration and run it by hand; do not remove the retiring key id before the backlog is 0.

### VaultSyncServiceMetricsStale

`warning`, after 10 minutes with no replica's service-wide refresh succeeding for more than 10 minutes (threshold `600` seconds). The refresh runs every minute (`VAULT_SYNC_SERVICE_METRICS_INTERVAL`), and every other alert in this section reads its values, so they cannot be trusted while it is stale. Raise the threshold with the interval.

Check: the server logs for service-wide metrics query errors, PostgreSQL's load and statement timeouts. Do: fix the failing query's cause (often a slow or overloaded PostgreSQL).
