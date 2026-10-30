# Alerts

For: admins. You run the server with the Helm chart and use Prometheus with the prometheus-operator.

The Helm chart ships alerting rules as a prometheus-operator `PrometheusRule`. They are off by default. [deployment.md](../deployment.md#alerts) tells you how to turn them on and how to change one alert (`config.alerts.rules.<AlertName>`: `enabled`, `for`, `severity`, `threshold`). The rules are in `deploy/charts/vault-sync/alerts/vault-sync.rules.yaml`. This page has one runbook per alert.

## How the alerts work

There are two severities:

- `critical`: Users cannot sync, or data is at risk. Act now.
- `warning`: The service is degraded, or a backlog grows. Act within working hours.

[Per-replica metrics](metrics-reference.md#per-replica-metrics) come from port `metrics`. A per-replica alert fires once for each affected replica, with its `instance` label. [Service-wide metrics](metrics-reference.md#service-wide-metrics) come from port `service-metrics`. Service-wide alerts aggregate with `by ()`, so they fire once, whether Prometheus scrapes one replica or all of them. They need a scrape of the service-wide port (`config.server.metrics.serviceWide.enabled`).

The thresholds come from the server's schedules and defaults: retention runs every hour, the upload TTL is 24 hours, the blob GC grace is 24 hours, and the service-wide refresh runs every minute. They also come from what a healthy deployment does in the e2e and load runs: no server errors, and sync RPCs well under a second. Each runbook says why its threshold has its value. If you change the matching server setting, change the threshold with it.

No alert compares schema versions between replicas. `vault_sync_service_schema_version` comes from the shared database, so every replica reports the same value, and the server exports no version for each replica. A rolling upgrade that is stuck shows up as `VaultSyncReplicasUnavailable`.

## Availability

### VaultSyncNoReplicaReady

`critical`, after 5 minutes. `kube_deployment_status_replicas_available` of the server Deployment is 0. Nobody can sync. The alert needs kube-state-metrics and is off unless you set `config.alerts.rules.VaultSyncNoReplicaReady.enabled`.

Check: Run `kubectl get pods` and `kubectl describe pod` for the server Deployment. Read the logs of a failing pod (`kubectl logs --previous`). The readiness probe (`/readyz`) fails while PostgreSQL does not answer, so look at PostgreSQL too.

Do: Fix the cause that the pod events or logs name, for example an image pull, a crash on a configuration error, or a dependency that is down. Roll back a bad release with `helm rollback`.

### VaultSyncReplicasUnavailable

`warning`, after 15 minutes. The Deployment has fewer available replicas than it wants. A rolling upgrade takes less than 15 minutes, so a rollout alone does not fire it. The alert needs kube-state-metrics and is off unless you turn it on.

Check: Look for pending pods (resources, node selectors, a PodDisruptionBudget that blocks) and for pods in a crash loop. Run `kubectl rollout status` to find a rollout stuck on a pod that never becomes ready.

Do: Free capacity or fix the failing pod. If a rollout of a new version is stuck, roll it back.

### VaultSyncRPCErrorRatioHigh

`critical`, after 10 minutes above 5% (threshold `0.05`). This is the share of RPCs, over all replicas, that ended with `internal`, `unavailable` or `unknown`. Client errors (`not_found`, `failed_precondition`, `resource_exhausted`, and others) do not count. A healthy deployment has none, so 5% for 10 minutes means that the syncs of many users fail.

Check: Group `vault_sync_rpc_requests_total` by `procedure` and `code` to find the failing RPCs. Read the server logs (`level=ERROR`) for the cause. Look at the dependency alerts below (PostgreSQL pool, S3 errors).

Do: Fix the failing dependency. If the errors started with a release, roll it back.

### VaultSyncSyncLatencyHigh

`warning`, after 15 minutes above 2 seconds (threshold `2`). This is the 95th percentile, over all replicas, of `ListChanges`, `GetRevision` and `CommitRevision`. Blob transfers do not count, because their time grows with the file size. These three are small requests that answer in well under a second when PostgreSQL is healthy. The 2 seconds leave room for large pages of changes.

Check: `vault_sync_db_pool_acquire_duration_seconds` and `vault_sync_db_pool_waiting_acquires` show waits for a connection. Look at the load and the slow-query log of PostgreSQL, and at CPU throttling of the server pods.

Do: Give PostgreSQL or the pods more resources, or add replicas.

### VaultSyncRealtimeListenerDown

`warning`, for each replica, after 5 minutes. `vault_sync_realtime_listener_up` is 0: the commit listener of the replica (PostgreSQL `LISTEN`) tried to reconnect for 5 minutes. Its realtime clients get no change notifications. They still sync on their own schedule, so nothing is lost, but changes arrive late.

Check: Read the logs of the replica for the reconnect errors, and look at `vault_sync_realtime_listener_reconnects_total`. Look at the connection limit of PostgreSQL. If a pooler is in front of PostgreSQL, make sure that it supports `LISTEN`. PgBouncer in transaction mode does not.

Do: Fix the connection. A restart of the pod moves its clients to a healthy replica.

### VaultSyncConcurrencyRejections

`warning`, after 30 minutes of rejections (threshold `0` per second). RPCs were rejected with `resource_exhausted` because a user already had `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` calls in progress on a replica. The rejections continued in every 10-minute window for half an hour. A short burst is normal, for example a client that catches up. Rejections that continue mean that the limit is too low for how your users sync, or that a client misbehaves.

Check: Group `vault_sync_rpc_concurrency_rejections_total` by `procedure`. The server logs name the rejected user.

Do: If many users hit the limit, raise `VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER` (`config.server.maxConcurrentRpcsPerUser`). If one client loops, contact the user or remove the device (`RemoveDevice`).

### VaultSyncRealtimeRefusals

`warning`, after 30 minutes of refusals (threshold `0` per second), counted like the previous alert. Realtime upgrades were refused for `user_limit` or `instance_limit`. Other reasons (`origin`, `unauthenticated`, `draining`, and others) are expected and do not count.

Check: Group `vault_sync_realtime_refused_upgrades_total` by `reason`. Look at `vault_sync_realtime_connections` for each replica.

Do: For `instance_limit`, raise `VAULT_SYNC_REALTIME_MAX_CONNECTIONS` or add replicas. For `user_limit`, raise `VAULT_SYNC_REALTIME_MAX_CONNECTIONS_PER_USER` or find the client that opens connections in a loop.

## Dependencies

### VaultSyncDatabasePoolExhausted

`warning`, for each replica, after 10 minutes. Requests waited for a PostgreSQL connection (`vault_sync_db_pool_waiting_acquires` above 0), and the pool had no idle connection. Requests slow down and then time out.

Check: Compare `vault_sync_db_pool_acquired_connections` with the pool size, which is the pgx parameter `pool_max_conns` of `VAULT_SYNC_DATABASE_URL`. Look at slow queries, locks and `max_connections` in PostgreSQL.

Do: Raise `pool_max_conns`, but keep the pools of all replicas within `max_connections`. Or fix what makes the queries slow.

### VaultSyncS3ErrorRatioHigh

`critical`, after 10 minutes above 5% (threshold `0.05`). This is the share of S3 operations, over all replicas, with the outcome `error`. The outcome `not_found` is expected and does not count. Uploads and downloads of attachments fail.

Check: Group `vault_sync_s3_requests_total` by `operation`. Read the server logs for the S3 error. Look at the health of the object store, the credentials (rotated or expired) and the CA bundle.

Do: Fix the object store or the credentials Secret. The server reads a rotated Secret without a restart.

### VaultSyncOIDCKeyRefreshFailing

`warning`, for each replica, after 15 minutes. The replica failed to get the key set of the OIDC issuer within the last 30 minutes, and its keys are more than 2 hours old (threshold `7200` seconds). Keys are fetched at most once an hour, so 2 hours means that at least one refresh was missed. The replica keeps its old keys. But after the issuer rotates its key, the replica rejects tokens signed with the new key, and every user is signed out.

Check: Read the logs of the replica for the error. Make sure that the pods can reach `VAULT_SYNC_OIDC_ISSUER_URL`: DNS, network policy, egress proxy, and the TLS certificate of the issuer.

Do: Restore the connection to the issuer.

## Data safety and backlog

These alerts read the service-wide metrics and fire once for the deployment.

### VaultSyncRetentionNotSucceeding

`warning`, after 30 minutes. The last retention run without errors was more than 3 hours ago (threshold `10800` seconds). Every replica runs retention every hour, so 3 missed hours are more than one failed run. History is not purged, storage grows, and deleted vaults are not removed.

Check: Search the server logs for `retention run failed`, and look at `vault_sync_retention_run_failures_total`. A run fails in part when PostgreSQL or S3 returns an error. The next run tries again.

Do: Fix the error that the log names.

### VaultSyncExportNotSucceeding

`warning`, after an hour. The last export with the status `ok` was more than 36 hours ago (threshold `129600` seconds). The alert is on while `config.export.enabled` is set. With the default daily schedule, 36 hours means that a run was missed or failed, so the plaintext copy for disaster recovery ([export.md](backup-and-restore.md#the-export-job)) is out of date. The alert also fires on a new install until the first export finishes, because the timestamp is 0 until then.

Check: Find the last Jobs of the export CronJob (`kubectl get jobs`). Read their logs and their summary (`partial` or `failed`). Look at the export volume: it can be full or not mounted.

Do: Fix the cause. Then run the export once by hand (`kubectl create job --from=cronjob/<release>-export`).

### VaultSyncUploadSessionsNotExpiring

`warning`, after an hour. The oldest open upload session is more than 48 hours old (threshold `172800` seconds). A cleanup runs every 5 minutes and removes sessions idle for longer than `VAULT_SYNC_BLOB_UPLOAD_TTL` (24 hours). A session twice that old means that the cleanup does not run or keeps failing, and staged S3 objects pile up. If you raise the TTL, raise the threshold with it.

Check: Read the server logs for upload cleanup errors. Look at `vault_sync_service_upload_sessions` and `vault_sync_service_upload_session_reserved_bytes`.

Do: Fix the error that the log names, usually PostgreSQL or S3.

### VaultSyncBlobGCStalled

`warning`, after 24 hours. Blobs wait for garbage collection (`vault_sync_service_gc_pending_blobs` above 0), and no replica collected one in the 6 hours before. A blob waits `VAULT_SYNC_BLOB_GC_GRACE` (24 hours), plus at most an hour for the next retention run. So 30 hours with no collection while blobs wait means that the collector is stuck, and released storage is not freed. If you raise the grace period, raise the `for` with it.

Check: The collector runs inside the retention job, so read the server logs for retention errors and look at `VaultSyncRetentionNotSucceeding`. Look at `vault_sync_retention_blobs_collected_total`.

Do: Fix the error that the log names.

### VaultSyncRekeyBacklogNotShrinking

`warning`, after an hour. Revisions in a stale epoch (`vault_sync_service_stale_epoch_revisions`) are above 0, and not fewer than 24 hours earlier. After a key rotation, the clients of the vault members re-encrypt the old revisions. A backlog that did not move for a day means that no member's client re-encrypts, so the key of the old epoch cannot be retired. [Re-encrypting history](encryption.md#re-encrypting-history) explains the job.

Check: `vault_sync_service_rekey_vaults` shows how many vaults are affected. Find out if the devices of the members synced recently.

Do: Ask a member to open the vault in Obsidian with the plugin unlocked. The plugin continues the re-key.

### VaultSyncEscrowRewrapStuck

`warning`, after an hour. Escrow key slots that still name a retiring escrow key id (`vault_sync_service_escrow_rewrap_slots`) are above 0, and not fewer than 48 hours earlier. During an escrow key rotation, only the `export rotate-escrow` command re-wraps these slots ([Rotate the escrow key](encryption.md#rotate-the-escrow-key)). The daily export job does not. Two days with no progress mean that no `export rotate-escrow` run finished, or that its runs fail for some slots. The metric is 0 without `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`.

Check: Read the JSON summary of your last `export rotate-escrow` run ([The rotate-escrow command](encryption.md#the-rotate-escrow-command)). Look at `old_key_slots`, `failed_slots` and the `reason` of each entry in `failures`, and read the logs of that run. Make sure that the identity file holds every old identity whose slots are still to be moved, and that the run has the job token (`config.escrowJobToken`).

Do: Fix the cause and run `export rotate-escrow` again until it reports `"old_key_slots": 0` and exits `0`. Do not remove the retiring key id before the backlog is 0.

### VaultSyncServiceMetricsStale

`warning`, after 10 minutes. No replica refreshed the service-wide metrics for more than 10 minutes (threshold `600` seconds). The refresh runs every minute (`VAULT_SYNC_SERVICE_METRICS_INTERVAL`). Every other alert in this section reads these metrics, so you cannot trust them while they are stale. If you raise the interval, raise the threshold with it.

Check: Read the server logs for query errors of the service-wide metrics. Look at the load and the statement timeouts of PostgreSQL.

Do: Fix the cause of the failing query. Often PostgreSQL is slow or overloaded.
