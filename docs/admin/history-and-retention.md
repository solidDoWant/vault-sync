# History and retention

For: admins. You run the server with the Helm chart and can run `kubectl` against its namespace.

The server keeps every saved version of a file. A saved version is a revision. Users browse the revisions of a file and restore an old one ([Conflicts and history](../user/conflicts-and-history.md) is their view). The retention job removes old revisions by a policy, so that history does not grow without end. This page tells you what the policy keeps, how to change it for the whole server or for one vault, and how much storage history uses. For how the job chooses revisions, see `SPEC.md` §11.

## The retention policy

Every replica runs the retention job once an hour, starting at startup, when an object store is configured. One policy applies to every vault, unless you set an override for a vault (see [Per-vault overrides](#per-vault-overrides)). The policy has three zones by the age of a revision:

1. Every revision younger than `VAULT_SYNC_RETENTION_KEEP_ALL` (90 days by default) is kept.
2. Older revisions are thinned to the newest revision of each document per UTC day, until they are older than `VAULT_SYNC_RETENTION_KEEP_DAILY` (a year by default).
3. After that, they are thinned to the newest revision of each document per ISO week (from Monday, UTC).

The job never purges the current revision of a document (its head revision), however old it is. This includes the tombstone of a deleted document, which is the revision that records the delete. So deleted documents stay findable and restorable. A device that was offline for longer than the policy still learns of the delete.

A purge cannot be undone. To keep every revision forever, set `VAULT_SYNC_RETENTION_KEEP_ALL` very high, for example `876000h`.

### What a purge means for devices

A purged revision disappears from history (`GetDocumentHistory`), from the change feed (`ListChanges`) and from `GetRevision`, which then returns `not_found`. Users cannot restore it any more.

A device can come back with unsynced edits to a file whose revision it last synced was purged in the meantime. Then it cannot merge its edits line by line. It keeps the version of the server in place and its own version next to it as a conflict copy. So the shorter `VAULT_SYNC_RETENTION_KEEP_ALL` is, the sooner a device that was offline for a long time gets conflict copies instead of merges.

### Purge markers

For each purged revision, the job keeps a small purge marker in the `purged_revisions` table. A device whose last synced revision was purged uses the marker to prove its position to the server, and then pulls on as usual. Only a device that did not pull since the purge needs a marker.

Markers are kept for `VAULT_SYNC_RETENTION_PURGE_MARKER_HORIZON` (365 days by default) after their purge. A device that comes back after a longer time, with its position on a revision whose marker is gone, resyncs once. Nothing is lost, but there are three effects:

- It takes the version of the server for every note that it did not change since it last pulled it, and merges every other note with the version of the server.
- A note that it last committed itself, and that another device deleted in the meantime, comes back.
- A note whose merge base was purged gets a conflict copy.

A longer horizon spares devices that were offline for longer, but keeps more rows. A shorter horizon keeps the table smaller.

Revisions purged before the release that added purge markers have no marker. Revisions purged by the previous release during a rolling upgrade to that release have none either. A device whose position was on one of them resyncs once, in the same way.

## Settings

The settings of the policy are in [Retention and history](configuration-reference.md#retention-and-history) in the configuration reference. The chart sets them from the values under `config.server.retention` and `config.server.blob.gcGrace` (see [Chart values](../deployment.md#chart-values)). [Which variables each command reads](configuration.md#which-variables-each-command-reads) tells you which command reads each one.

If you change `VAULT_SYNC_RETENTION_KEEP_ALL` or `VAULT_SYNC_RETENTION_KEEP_DAILY`, the next run reads more of the database (see [Storage growth](#storage-growth)).

## Per-vault overrides

You can give one vault its own policy. An override replaces `VAULT_SYNC_RETENTION_KEEP_ALL` and `VAULT_SYNC_RETENTION_KEEP_DAILY` for that vault only. Every other vault keeps the policy of the server. No policy purges the head revisions of a vault.

Set an override only when every replica runs a release that has them. See [Per-vault retention overrides](upgrades.md#per-vault-retention-overrides) in Upgrades, which also tells you what to do before you roll back.

Overrides are stored in PostgreSQL, in the `vault_retention` table. The chart has no values for them. Every replica applies them from its next hourly run. Only the `retention` subcommand of the server binary manages them. No API call or plugin setting reads or changes them, so nobody except you can shorten the history of a vault.

The subcommand reads the database variables of the server (`VAULT_SYNC_DATABASE_URL` and the `VAULT_SYNC_DATABASE_TLS_*` files). It needs a role that can write `vault_retention`, so the read-only role of the export cannot set overrides. The easy way is to run it in a running server pod. The image has no shell, so call the binary directly. This example uses the Deployment of a release named `vault-sync`:

```sh
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention set -vault 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 -keep-all 4320h -keep-daily 17520h
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention list
kubectl exec deploy/vault-sync -- /bin/vault-sync-server retention unset -vault 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12
```

The three commands do this:

- `vault-sync-server retention set -vault ID -keep-all DURATION -keep-daily DURATION` sets or replaces the override of vault `ID`. Both values are Go durations, like the variables that they replace. The example keeps everything for 180 days and daily versions for two years.
- `vault-sync-server retention unset -vault ID` removes the override. From the next run, the vault follows the policy of the server again. If the vault had no override, the command prints `"removed": false`.
- `vault-sync-server retention list` prints every override, in vault id order, with the time it was last set.

The subcommand prints one JSON object per line. It exits 0 on success, 1 on a refusal or a failure, and 2 on a usage error.

`retention set` refuses these values, and then stores nothing:

- An unknown vault.
- A keep-all below `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_ALL` (`24h` by default, and never lower).
- A keep-daily below `VAULT_SYNC_RETENTION_OVERRIDE_MIN_KEEP_DAILY`, if you set it.
- A keep-daily below its keep-all.

Set the two minimums where you run the subcommand, so that a typo cannot shorten the history of a vault. In the chart, set `config.server.retention.overrideMinKeepAll` and `config.server.retention.overrideMinKeepDaily`. They put the two variables into the environment of the server pod, where the subcommand reads them. The server itself ignores them.

If you shorten the policy of a vault, the next runs purge the revisions that became purgeable. If you lengthen it, it keeps only what was not purged yet.

## Storage growth

History is most of the storage of a vault. These parts of it change with the settings:

- Revisions. Each one is a row in PostgreSQL, and most have a blob in S3. A blob is the stored content of one file version.
- Purge markers. Each one is a small row, about 60 bytes. Each run deletes the markers older than the horizon, at most 100,000 per run. So the table holds about one horizon of purges, while purges stay below about 100,000 revisions per hour per replica on average. That is far above the expected scale.
- Blobs that no revision references. After a purge removed the last revision that references a blob, the blob is kept for `VAULT_SYNC_BLOB_GC_GRACE` (24 hours by default). Then the job deletes it from PostgreSQL and S3. The grace period lets a client that just listed the purged revision restore its content. A blob that a client uploaded but never used in a revision is deleted the same way, after the grace period from its upload. If a client commits after that, it uploads the content again.

Each run purges at most 1,000 documents, with up to 1,000 revisions each. It deletes at most 1,000 blobs and their objects. So a backlog, such as the first run on a long history, takes several hours. If a run still continues when the next one must start, the server stops it and logs it as a failure. Later runs do the work that remains.

Most runs only look at documents with revisions that became older than a keep-all or keep-daily age since the last complete scan. A full scan reads every revision older than the shortest keep-all in force. An override can set that as low as `24h`, and then a full scan reads nearly all of the `revisions` table. The job runs a full scan in these cases:

- On its first run.
- After a run that did not complete. For example, it found as many documents as its bound, or it left one partly purged or failed.
- After you change `VAULT_SYNC_RETENTION_KEEP_ALL` or `VAULT_SYNC_RETENTION_KEEP_DAILY`.
- After any `retention set` or `retention unset` that changes the overrides.

Size the database for a full scan before you change the policy or an override.

The retention job also removes vaults that were deleted more than 30 days ago. See [Backup and restore](backup-and-restore.md).

## Monitoring

A run that changed anything logs `applied the retention policy` with the numbers of revisions, blobs and objects that it deleted. A run that failed in part logs `retention run failed`. The next run tries again.

The metrics of the job are named `vault_sync_retention_*`, and the service-wide metrics include `vault_sync_service_retention_last_success_timestamp_seconds` and `vault_sync_service_gc_pending_blobs`. See the [metrics reference](metrics-reference.md). If `vault_sync_retention_purge_markers_pruned_total` grows by 100,000 every run, pruning falls behind and the table of purge markers grows.

Two alerts watch the job. Each has a runbook:

- [VaultSyncRetentionNotSucceeding](alerts.md#vaultsyncretentionnotsucceeding): no run finished without errors for 3 hours.
- [VaultSyncBlobGCStalled](alerts.md#vaultsyncblobgcstalled): blobs wait for deletion, but no replica deleted one.
