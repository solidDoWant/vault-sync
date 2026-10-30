# Upgrades and high availability

For: admins. You run the server with the Helm chart and know Kubernetes Deployments, probes and PodDisruptionBudgets.

This page tells you how to upgrade the server, what happens to the database during an upgrade, how a replica stops, and how to run several replicas so that users see no interruption.

## Upgrade the server

Upgrade with `helm upgrade` and the new chart version. Kubernetes replaces the replicas one at a time. Each new replica applies the migrations of the new release when it starts. A migration is a change to the database tables. The migrations of a release are backward-compatible with the previous release, so both releases serve users at the same time during the rollout.

Before you upgrade:

1. Read the release notes in `CHANGELOG.md`.
2. Look in [Migrations that pause sync](#migrations-that-pause-sync) for the migrations of the new release. If one pauses sync, plan the upgrade for a quiet time.
3. Upgrade the server before the plugin, or at the same time. See [Upgrade the server before the plugin](#upgrade-the-server-before-the-plugin).

If the new release does not become ready, roll it back with `helm rollback`. Read [Rules that hold only after the rollout](#rules-that-hold-only-after-the-rollout) first, because a rollback across some migrations has effects.

## Migrations

When the server starts, it does these steps in this order:

1. It connects to PostgreSQL.
2. It applies the migrations that are not in the database yet.
3. If an object store is configured, it makes sure that it can reach the bucket.
4. It starts to accept requests.

The server needs PostgreSQL 14 or later. On an older version, the migrations fail and the server stops. See [Requirements](requirements.md).

Migrations run behind a PostgreSQL advisory lock, so replicas that start at the same time are safe. Only one of them applies the migrations. You do not run migrations by hand.

### Migrations that pause sync

Some migrations lock a table until they are complete. The lock blocks every replica, of both releases, on that table. Clients try again and no data is lost, but sync stops while the migration runs.

- **0003** rebuilds the unique index on live document paths. It holds an exclusive lock on the `documents` table, so commits and reads of documents stop on every replica for a short time. The time grows with the number of documents.
- **0004** builds an index over the folders of live document paths. It blocks commits, but not reads, on every replica. The time grows with the number of documents and the depth of their paths.
- **0005** builds two indexes on `revisions`. They block commits, but not reads, on every replica. The time grows with the number of revisions.
- **0006** gives every revision an anchor in one transaction. It holds an exclusive lock on `revisions` the whole time, so commits and pulls (and everything else that reads or writes revisions) stop on every replica of both releases. It rewrites every row of `revisions`, so the time grows with the number of revisions. As a rough guide, it takes about as long as an `UPDATE` of every row of that table on your database. This is the longest pause.
- **0010** (per-vault retention overrides) adds a table and a column to the one-row `retention_scans` table. It blocks only the retention job, for a short time.
- **0011** (device removal) only adds a column. It does not pause sync.

## Rules that hold only after the rollout

During a rollout, replicas of the previous release still serve requests. A rule that the new release adds holds only when every replica runs the new release.

- Replicas of a release before migration 0004 accept a file and a folder with the same name (`notes` and `notes/c.md`) until the rollout is complete. Pairs that were committed before then stay.
- Until every replica runs the release with migration 0012, a device registration that a client sends again can use a second place under the device limit.

### Per-vault retention overrides

Set per-vault retention overrides only when every replica runs a release that has them (migration 0010). During a rollout, replicas of the previous release still purge every vault under the deployment-wide policy. So an override that is longer than that policy does not protect the history of the vault until those replicas are gone.

During a rollout, retention runs of the previous release can also record their scans as complete under the overrides of the new release. The only effect is that a newly shortened override can purge less than it allows until the next full scan. It never purges anything that the policy keeps.

Do not roll back to a release before migration 0010 after you set overrides, unless you prepare the release first. The old release purges every vault with an override under the deployment-wide policy again. It purges the history that a longer override kept. To keep that history, give the release that you roll back to a `VAULT_SYNC_RETENTION_KEEP_ALL` and a `VAULT_SYNC_RETENTION_KEEP_DAILY` that are at least as long as the longest override. See [Retention and history](../configuration.md#retention-and-history).

### Removing devices

Remove devices only when every replica runs a release that can remove them. Migration 0011 adds device removal (`RemoveDevice`). Replicas of the previous release do not know about it. During a rollout, they still accept commits from a removed device, and they still count removed devices toward the limit of 100 devices.

If you roll back to a release before migration 0011, every removed device comes back, both in the limit and for commits.

Server builds from before release 0.3.0 handle removed devices differently in two ways:

- They refuse a commit from a removed device without the reason that the plugin recognizes. The plugin shows a plain error and tries again. It recognizes the removal when its retry gets to an upgraded replica.
- They refuse with `invalid_argument` a retry of a commit that landed before the removal, when the retry comes from the device that registered again.

So remove devices only when every replica runs 0.3.0 or later.

### Renaming devices

Rename devices only when every replica runs a release that can rename them. `RenameDevice` needs no migration. Replicas of the previous release answer it with `unimplemented`. They also refuse, with `already_exists`, a `RegisterDevice` retry whose name is not the current name of the device. The new release returns the device with its current name. A plugin that gets `already_exists` drops its saved registration id and registers again. Nothing is lost, but the retry can use one more place under the device limit.

### Upgrade the server before the plugin

Users update the Obsidian plugin themselves, so a plugin can run against an older server. The sync engine of the plugin needs the purge markers of the server. A purge marker is the record that the server keeps when retention deletes an old revision.

A plugin that is newer than the server, against a server from before purge markers, sees each retention purge of a revision that a device last synced as a restore of the server. It then merges every note that it holds with the version on the server. Nothing is lost, but there are two effects until you upgrade the server:

- A note that another device deleted can come back, because an edit wins over a delete.
- A note whose merge base was purged gets a conflict copy instead of a merge.

So upgrade the server first, and then tell users to update the plugin. Developers find the reasons in `SPEC.md` §6.1 and §11.

## Graceful shutdown

When a replica gets `SIGTERM` or `SIGINT`, it stops in this order:

1. `/readyz` returns 503 at once.
2. For `VAULT_SYNC_SHUTDOWN_DELAY`, the API continues to accept and serve requests. But it closes the connection after each response, so clients and proxies connect again, through the load balancer, to another replica. Connections that are idle at the signal stay open until the delay ends. So a request that a client sends on one of them at that moment is served, not reset.
3. The API stops accepting connections. Requests that are still running get up to `VAULT_SYNC_SHUTDOWN_TIMEOUT` to finish. The replica closes open realtime WebSockets at this step with close code 1001 ("going away"). Clients connect to another replica and subscribe again.
4. The process exits with status 0 after a clean drain, or with status 1 if the timeout forced connections closed.

The background jobs (the blob upload cleanup and the hourly retention job) stop at the signal. The next run, on any replica, finishes the work that they left.

The defaults are 5 seconds for the delay and 30 seconds for the timeout. See [Listeners, request limits, shutdown and logging](configuration-reference.md#listeners-request-limits-shutdown-and-logging).

## High availability

Run the server as several identical replicas behind one Service. They share one PostgreSQL database and one S3 bucket. You can stop any replica at any time, for example to drain a node, and clients see no effect:

- A replica keeps no state for a client, except open realtime connections. A client creates its subscriptions again when it connects to any replica. Upload sessions, memberships and users are in PostgreSQL, and file contents are in S3. So any replica can serve any request, also different chunks of one upload and its commit. Each replica builds its own caches (the OIDC key set, the S3 credentials).
- The background jobs run on every replica. They coordinate only through PostgreSQL, so runs at the same time have the same effect as one run.
- If a replica stops without warning (`SIGKILL`, a node crash), it loses only the requests that it was serving. A client can send every RPC again to another replica. Everything that the server acknowledged stays.
- During a rolling upgrade, the previous release and the new release run at the same time (see [Upgrade the server](#upgrade-the-server)). An integration test runs both releases against one database.

Developers find the rules that every replica must obey in `SPEC.md` §12.

### What the chart sets

The chart sets the replicas, the probes, the grace period and the rolling-update strategy for you. Spreading the replicas and the PodDisruptionBudget are cluster policy, so the chart leaves them to you.

| Setting | What the chart does | What you do |
|---|---|---|
| Replicas | 2 replicas. | Set `resources.controllers.main.replicas` to scale. Keep at least 2. Nothing else changes. |
| Readiness probe | `/readyz` on the metrics port, every 2 seconds. | Nothing. With `VAULT_SYNC_SHUTDOWN_DELAY`, endpoints and proxies (Istio) stop sending traffic before the replica refuses connections, so you need no `preStop` hook. If you add a `preStop` sleep, it runs before the signal and adds to the delay. |
| Liveness probe | `/healthz`. | Never point the liveness probe at `/readyz`. |
| Grace period | `terminationGracePeriodSeconds` follows `config.server.shutdownDelay` plus `config.server.shutdownTimeout` plus 10 seconds, and is at least 45. | If you set `resources.controllers.main.pod.terminationGracePeriodSeconds` yourself, it must be larger than the delay plus the timeout, or the chart refuses to render. |
| Rolling update | `maxUnavailable: 0` and `maxSurge: 1`, so a new pod is ready before an old one gets the signal to stop. | Nothing. |
| Spread | Nothing. | Spread the replicas across nodes, with the default topology spread of the cluster or with your own `resources.controllers.main.pod.topologySpreadConstraints` on `kubernetes.io/hostname`. |
| PodDisruptionBudget | Nothing. | Add one with `maxUnavailable: 1` (or `minAvailable: 1`), so a node drain never evicts every replica at once. |

For example, this PodDisruptionBudget lets at most one replica stop at a time:

```yaml
resources:
  controllers:
    main:
      podDisruptionBudget:
        maxUnavailable: 1   # or minAvailable: 1, not both
```

The other chart values are in [Chart values](../deployment.md#chart-values).
