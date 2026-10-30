# Troubleshooting

For: admins who run the server. This page lists the reasons why the server does not start, and common faults when it runs. Each entry says what you see, what it means and what to do. [Alerts](alerts.md) has one runbook per alert. Users find the plugin's messages in [Troubleshooting](../user/troubleshooting.md).

## The server does not start

The server logs JSON records to standard error. When it cannot start, it logs one record at level `ERROR` and exits with status 1. Read the `msg` field and the `error` (or `problems`) field of that record. With the Helm chart, read the logs of a pod:

```sh
kubectl -n vault-sync logs deployment/vault-sync
```

The server does these steps in this order, and stops at the first one that fails.

### invalid configuration; see docs/admin/configuration.md

A required variable is missing, or a value is not valid. The `problems` field names each variable that is wrong. The log never shows secret values. Fix the variables and start the server again. [Validation and exit status](configuration.md#validation-and-exit-status) lists the required variables, and the [configuration reference](configuration-reference.md) lists the allowed values.

### cannot open database

The server cannot connect to PostgreSQL. Do these checks:

- Make sure that `VAULT_SYNC_DATABASE_URL` names the right host, port, database and role.
- Make sure that the TLS files are mounted, and that the CA bundle matches the certificate of the database server ([PostgreSQL TLS](postgresql-and-s3.md#postgresql-tls)).
- Make sure that no network policy or firewall blocks the pod.

### cannot migrate database

The server connected, but the schema migrations failed. The server needs PostgreSQL 14 or newer. On an older version, the migrations fail. Also make sure that the role of the server owns its database and can create tables ([PostgreSQL](postgresql-and-s3.md#postgresql)). [Migrations](upgrades.md#migrations) explains how migrations run during an upgrade.

### cannot use the escrow chain

The escrow configuration of the server does not match the escrow chain in PostgreSQL. The `error` field says which part failed:

- `the configured escrow recipient and signing key are not the chain's head`: you rotated or reset the escrow key in the chain, but `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY` still name the old bundle. Or the opposite: you changed the variables before you ran `export rotate-escrow`. Set the variables to the bundle at the head of the chain ([The order of steps](encryption.md#the-order-of-steps)). If you did not make the newest reset point, read [A reset point that you did not make](encryption.md#a-reset-point-that-you-did-not-make).
- `configured bundle`: the values of `VAULT_SYNC_ESCROW_RECIPIENT` or `VAULT_SYNC_ESCROW_SIGNING_KEY` are not valid. Copy them again ([Generate and install the escrow key](encryption.md#generate-and-install-the-escrow-key)).
- `the stored root bundle is malformed`, `has a malformed bundle` or `the stored chain does not link`: the chain in PostgreSQL is damaged. Do not edit the chain by hand. Restore the database from a backup ([Restore a server](backup-and-restore.md#restore-a-server)).

### cannot use the S3 object store

At startup the server makes sure that the bucket is reachable (`HeadBucket`, with a 30-second limit). The error names the bucket. Make sure that the bucket exists, and that the endpoint, the region, the addressing style, the credentials and the CA bundle are right ([S3](postgresql-and-s3.md#s3)).

### server stopped with an error

The server started, but a listener failed. If the error starts with `listen for API`, `listen for metrics` or `listen for service-wide metrics`, the server cannot open that address. Another process uses the port, or two of the three listener addresses are the same ([Endpoints](configuration.md#endpoints)).

## Pods do not become ready

A replica is ready only after it connected to PostgreSQL, applied the migrations and reached the bucket. After that, `/readyz` returns 503 when PostgreSQL does not answer a ping within 2 seconds, and while the replica shuts down ([Health checks and metrics endpoints](monitoring.md#health-checks-and-metrics-endpoints)). If no replica is ready, look at the load and the connections of PostgreSQL. A long migration can also delay the first ready replica after an upgrade ([Migrations that pause sync](upgrades.md#migrations-that-pause-sync)).

## Every sign-in fails

Every request gets `unauthenticated` (HTTP 401). The response gives no reason. To see the reason, set `VAULT_SYNC_LOG_LEVEL` to `debug`. The server then logs the reason for each rejected token. It never logs the token.

Common causes:

- `VAULT_SYNC_OIDC_ISSUER_URL` does not match the `iss` claim of the tokens exactly.
- `VAULT_SYNC_OIDC_AUDIENCE` is not in the `aud` claim of the access token.
- The clock of the server or of the provider is wrong. The server allows no clock skew on `exp`.
- The server cannot fetch the discovery document or the keys, for example because the provider redirects to another host. Before its first successful fetch, the server rejects every token.

[What the provider must offer](identity-provider.md#what-the-provider-must-offer) lists every check. [Where the server gets the signing keys](identity-provider.md#where-the-server-gets-the-signing-keys) explains the fetch.

## Changes arrive late on other devices

A change reaches the other devices only when they pull on their schedule (about 30 seconds), not within seconds. Two causes are common:

- The ingress does not pass WebSocket upgrades on `/v1/realtime` ([The ingress](install.md#the-ingress)).
- `VAULT_SYNC_DATABASE_URL` points at a pooler in transaction or statement mode. Notifications then stop, and the server does not report an error ([Poolers and realtime](postgresql-and-s3.md#poolers-and-realtime)).

The `vault_sync_realtime_*` metrics and the commit listener panels of the Server dashboard show which one it is ([Grafana dashboards](monitoring.md#grafana-dashboards)).

## Uploads of large files fail

If a WAF in front of the server rejects request bodies above its limit, uploads fail when a chunk plus its framing does not fit. Keep the request and chunk limits of the server under the limit of the WAF ([Request size and the WAF](security.md#request-size-and-the-waf)). Files above `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` are refused by the server itself ([Blob uploads](configuration-reference.md#blob-uploads)).

## A user reaches a limit

Some limits are fixed, for example 100 devices for each user and 10 wrong passphrases in one hour. You cannot raise them and there is nothing to reset. [Fixed limits](security.md#fixed-limits) lists them, with what the user can do.
