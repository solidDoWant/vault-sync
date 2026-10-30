# PostgreSQL and S3

For: admins. You run PostgreSQL (the examples use CloudNativePG) and an S3-compatible object store (the examples use Ceph RGW with Rook). You install the server with the Helm chart.

The server keeps all its data in one PostgreSQL database and one S3 bucket. The replicas keep no data of their own. This page tells you how to set up the database and the bucket, how to protect the connections with TLS, and which permissions the server needs. The Helm chart creates no database, bucket or Secret. You create them and give their names to the chart. The chart values are in [Chart values](../deployment.md#chart-values), and the environment variables are in the [configuration reference](configuration-reference.md).

## What lives where

PostgreSQL holds everything except the contents of files: users, vaults, memberships, devices, documents, their revisions and the upload sessions. The server creates its own tables when it starts. [Upgrades](upgrades.md#migrations) tells you how it changes them in a new release.

The S3 bucket holds the contents of files. Each file version is stored once, as one object, at `vaults/<vault_id>/blobs/<hex(blob_id)>`. A blob is the stored content of one file version. A client uploads a blob in chunks. The server stores each chunk as its own object under `vaults/<vault_id>/uploads/<upload_id>/`. When the upload is complete, `CommitBlob` copies the chunks into the object of the blob. For a vault without end-to-end encryption, the server first makes sure that the SHA-256 of the content is correct. No content becomes visible before that.

Every 5 minutes, a cleanup routine removes old uploads:

- It removes upload sessions that were idle for longer than `VAULT_SYNC_BLOB_UPLOAD_TTL`, or that were reclaimed, and it deletes their chunk objects.
- It aborts multipart uploads under `vaults/` that are older than the TTL and whose blob has no upload session that was active within the TTL. An interrupted commit leaves these uploads behind. Without the cleanup, S3 keeps them forever, and you do not see them in the bucket.
- Each run removes at most 100 sessions and 10,000 objects. A large backlog takes several runs.

Every replica runs the cleanup on the same schedule. Runs at the same time on different replicas are safe. If another replica already removed an upload or an object, that is not an error. If a run still continues when the next run must start (for example because the object store stopped answering), the server stops the run and logs it as a failure. The next run starts on schedule, and later runs do the work that remains.

The retention job deletes blobs that no revision uses any more. See [Retention and history](history-and-retention.md#the-retention-policy).

## PostgreSQL

The server needs PostgreSQL 14 or later (see [Requirements](requirements.md)). Give it its own database and its own role. With CloudNativePG, for example:

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

The role owns the database, so it can create the tables. The export job can use its own role. [Plaintext export](backup-and-restore.md#configuration-and-permissions) lists the grants that role needs.

### Client certificates

With the `pg_hba` rule above, CloudNativePG authenticates the role with a client certificate. The client CA of the cluster signs that certificate. Create a certificate for the role of the server. If the export uses its own role, create one for that role too:

```sh
kubectl cnpg certificate vault-sync-postgres-client --cnpg-cluster vault-sync-postgres --cnpg-user vault_sync
```

The command creates a `kubernetes.io/tls` Secret with the keys `tls.crt` and `tls.key`. Then set these chart values:

1. Set `config.database.tls.clientCertificate.secretName` to the name of the Secret.
2. If your Secret uses other key names (for example a Secret from cert-manager), set `config.database.tls.clientCertificate.certKey` and `config.database.tls.clientCertificate.keyKey`.
3. Set `config.database.tls.caCert.secretKeyRef` to the server CA of the cluster: the `<cluster>-ca` Secret, key `ca.crt`.

The server reads the three files again for every new connection. When CloudNativePG or cert-manager rotates a certificate, the server uses the new one without a restart. The chart mounts only the named keys of each Secret, so the `ca.key` in `<cluster>-ca` never gets into a pod. The chart never mounts them with `subPath`, so rotated files get into the pod.

### The connection string

Use the read-write service and full verification. The name of the read-write service is in the server certificate:

```
host=vault-sync-postgres-rw dbname=vault_sync user=vault_sync sslmode=verify-full
```

With certificate authentication, the string contains no password, so you can put it in `config.database.url.value`. If the string contains a password, put it in a Secret and use `config.database.url.secretKeyRef` (`name` and `key`). You must set exactly one of the two. Do not put `sslcert` or `sslkey` in the string. Use the TLS file variables (`VAULT_SYNC_DATABASE_TLS_*`) instead, which the chart sets for you. See [PostgreSQL connection](configuration-reference.md#postgresql-connection).

### PostgreSQL TLS

The `sslmode` of the connection string turns on TLS. Use `require`, `verify-ca` or `verify-full`.

- If you set one of the TLS file variables and the first connection attempt of the string is plaintext (`sslmode=disable` or `allow`), the server refuses to start.
- With `sslmode=prefer` (the libpq default when the string has no `sslmode`) and a TLS file set, the server removes the plaintext fallback. The connection never changes to plaintext without telling you.
- If you set `VAULT_SYNC_DATABASE_TLS_CA_FILE`, the server always does full verification. It checks the certificate chain of the server against the CA bundle, and the host name in the string must match the certificate. This is also true when the string says `sslmode=require` or `sslmode=verify-ca`. So the host in the string must be a name (or IP) that is in the certificate of the PostgreSQL server. With CloudNativePG, use the `<cluster>-rw` service name, which the operator puts in the certificate.

### Poolers and realtime

The server tells clients about new changes through PostgreSQL `LISTEN/NOTIFY`. `LISTEN` needs a session that stays open. So `VAULT_SYNC_DATABASE_URL` must point at PostgreSQL directly, or at a pooler in session mode. Do not use a pooler in transaction or statement mode (for example PgBouncer with `pool_mode = transaction`). Notifications then stop, and the server does not report an error. Clients still sync on their own schedule, but changes arrive late. The [Realtime channel](../configuration.md#realtime-channel) section tells you more about the connection that each replica keeps for this.

### Switchover and restarts

The server continues to work through a CloudNativePG switchover or a restart of PostgreSQL. It checks each connection before it uses it. If the database closed a connection while the connection was idle, the server replaces it, and the request does not see a failure. If a query was already running when its connection broke, the request fails and the client sends it again. You manage the failover of the database itself, for example with CloudNativePG.

Some migrations block commits for a short time while they run. [Upgrades](upgrades.md#migrations-that-pause-sync) lists them.

## S3

The server stores file contents in one bucket. The bucket must exist before the server starts. At startup, the server makes sure that it can reach the bucket.

### The bucket and its credentials

With Rook, an ObjectBucketClaim creates the bucket and a Secret with the keys `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. These are the default key names of the chart:

```yaml
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: vault-sync
spec:
  generateBucketName: vault-sync
  storageClassName: ceph-bucket
```

Then set these chart values:

1. Set `config.s3.bucket` to the name of the bucket. The ConfigMap of the claim has it as `BUCKET_NAME`.
2. Set `config.s3.endpoint` to the URL of RGW, for example `https://rgw.example.com`, or the in-cluster `http://rook-ceph-rgw-objectstore.rook-ceph.svc`.
3. Set `config.s3.credentials.secretName` to the Secret.
4. If the Secret uses other key names, set `config.s3.credentials.accessKeyIdKey` and `config.s3.credentials.secretAccessKeyKey`.

The chart mounts the credentials as files. The server reads them again every 10 seconds, so it uses a rotated Secret without a restart.

### Region, addressing and TLS

RGW accepts any region, so you can leave `config.s3.region` empty. RGW needs path-style addressing, which is the default (`config.s3.forcePathStyle` empty or `"true"`). If a private CA signs the certificate of RGW, set `config.s3.caCert.secretKeyRef` to a Secret key that holds the CA. `config.s3.idleTimeout` sets how long a connection to RGW can be silent before the request on it fails. See [Object store (S3)](configuration-reference.md#object-store-s3) for each variable.

### Permissions

The server needs these permissions on the bucket. The owner of the bucket has all of them:

- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`
- `s3:ListBucket`
- `s3:ListBucketMultipartUploads`
- `s3:AbortMultipartUpload`

The export job needs only `s3:GetObject` and `s3:ListBucket`. To give it read-only credentials, create an RGW user with a read-only bucket policy. Then set `config.export.s3.credentials.secretName`, with `config.export.s3.credentials.accessKeyIdKey` and `config.export.s3.credentials.secretAccessKeyKey`.

## Page sizes and response limits

The revisions need no configuration other than the database. The page sizes are fixed:

- `ListChanges` returns at most 1000 revisions in one call, or 500 if the client asks for no page size.
- `GetDocumentHistory` returns at most 1000 revisions, or 100 by default.
- If a client asks for a larger page, the server makes the page smaller. It does not refuse the request.

`VAULT_SYNC_MAX_REQUEST_BYTES` limits requests, and it also limits responses. A page ends early when its encoding (binary protobuf or JSON, as the client uses) comes near that limit. With 4096-byte paths, about 240 revisions fit in the default 1 MiB in binary protobuf, and about 175 in JSON. Such a page tells the client that more revisions follow, and the client continues where the page stopped. A page always holds at least one revision when there is one. See [Listeners, request limits, shutdown and logging](configuration-reference.md#listeners-request-limits-shutdown-and-logging).
